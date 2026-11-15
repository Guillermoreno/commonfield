// Fresh disposable database only. Suppress recipients, cookies and invitation links.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {diagnostic} from './diagnostic.mjs';
const origin=process.env.PUBLIC_ORIGIN;
const target='http://127.0.0.1:4173';
let cookie='',csrf='',phase='smtp_qa_start',pool;
const req=(path,method='GET',body,foreign=false)=>fetch(target+path,{method,headers:{origin:foreign?'https://foreign.example':origin,'content-type':'application/json',...(cookie?{cookie,'x-csrf-token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
const control=async mode=>{assert.equal((await fetch(`http://smtp-fixture:1080/${mode}`,{method:'POST'})).status,200);};
const messages=async()=>{const r=await fetch('http://smtp-fixture:1080/messages');assert.equal(r.status,200);return r.json();};
try {
 if(process.env.COMMONFIELD_SMTP_QA!=='1'||process.env.SMTP_HOST!=='smtp-fixture')throw new Error('disposable_fixture_required');
 assert.equal((await req('/api/ready')).status,200);
 assert.equal((await messages()).length,0,'no automatic startup send');
 const owner={displayName:'SMTP QA',email:`owner-${randomUUID()}@example.test`,teamName:'SMTP QA',password:randomBytes(24).toString('hex')};
 phase='smtp_qa_bootstrap';assert.equal((await req('/api/bootstrap','POST',owner)).status,201,'fresh isolated database required');
 const login=await req('/api/login','POST',{email:owner.email,password:owner.password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];const session=await login.json();csrf=session.csrf;
 const create=async suffix=>{const response=await req(`/api/teams/${session.teamId}/invitations`,'POST',{email:`qa-${suffix}-${randomUUID()}@example.test`,role:'member'});assert.equal(response.status,201);return response.json();};
 const send=(i,body={})=>req(`/api/invitations/${i.invitationId}/delivery-attempts`,'POST',body);
 const accepted=await create('accepted');
 phase='smtp_qa_authorization';assert.equal((await req(`/api/invitations/${accepted.invitationId}/delivery-attempts`,'POST',{},true)).status,403);
 assert.equal((await send(accepted,{to:'spoof@example.test'})).status,422);assert.equal((await messages()).length,0);
 phase='smtp_qa_acceptance';const result=await send(accepted);assert.equal(result.status,200);assert.deepEqual(await result.json(),{deliveryStatus:'sent',deliveryTransport:'smtp'});
 let captured=await messages();assert.equal(captured.length,1);const raw=captured[0];
 assert.match(raw,/multipart\/alternative/);assert.match(raw,/text\/plain/);assert.match(raw,/text\/html/);assert.match(raw,/From: Commonfield <invites@example.test>/);assert.ok(raw.replace(/=\r\n/g,'').replaceAll('=3D','=').includes(accepted.invitationUrl));
 const inventory=await (await req(`/api/teams/${session.teamId}/invitations`)).json();assert.equal(inventory.invitations.find(i=>i.invitationId===accepted.invitationId).deliveryTransport,'smtp');
 pool=new pg.Pool({host:'postgres',database:'commonfield',user:'commonfield_app',password:(await readFile('/run/secrets/app_password','utf8')).trim()});
 const persisted=await pool.query('SELECT recipient_email,transport,status,id FROM invitation_delivery_attempts WHERE invitation_id=$1',[accepted.invitationId]);assert.equal(persisted.rowCount,1);assert.equal(persisted.rows[0].transport,'smtp');assert.equal(persisted.rows[0].status,'sent');assert.ok(raw.includes(`To: ${persisted.rows[0].recipient_email}`));assert.ok(raw.includes(`Message-ID: <${persisted.rows[0].id}@example.test>`));assert.equal((await send(accepted)).status,409);
 phase='smtp_qa_rejections';await control('reject');const rejected=await create('rejected');assert.equal((await (await send(rejected)).json()).deliveryStatus,'failed');
 phase='smtp_qa_uncertainty';await control('disconnect');const uncertain=await create('uncertain');assert.equal((await (await send(uncertain)).json()).deliveryStatus,'uncertain');const before=(await messages()).length;assert.equal((await send(uncertain)).status,409);assert.equal((await messages()).length,before);
 await control('accept');assert.equal((await (await send(uncertain,{uncertainResendConfirmed:true})).json()).deliveryStatus,'sent');
 phase='smtp_qa_terminal';const revoked=await create('revoked');assert.equal((await req(`/api/invitations/${revoked.invitationId}/revoke`,'POST',{})).status,204);assert.equal((await send(revoked)).status,409);
 const expired=await create('expired');await pool.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.invitationId]);assert.equal((await send(expired)).status,409);
 phase='smtp_qa_concurrency';const concurrent=await create('concurrent');const start=(await messages()).length;const responses=await Promise.all([send(concurrent),send(concurrent)]);const statuses=responses.map(r=>r.status).sort();assert.deepEqual(statuses,[200,409]);assert.equal((await messages()).length,start+1);
 phase='smtp_qa_recovery_seed';const stranded=await create('restart');const terminal=await create('restart-terminal');
 for(const item of [stranded,terminal]){const id=randomUUID();await pool.query("INSERT INTO invitation_delivery_attempts(id,invitation_id,generation,status,recipient_email,selected_role,transport) SELECT $1,id,1,'sending',email,role,'smtp' FROM invitations WHERE id=$2",[id,item.invitationId]);await pool.query("UPDATE invitations SET delivery_status='queued',delivery_attempts=1,current_delivery_attempt_id=$2 WHERE id=$1",[item.invitationId,id]);}
 await pool.query("UPDATE invitations SET status='revoked' WHERE id=$1",[terminal.invitationId]);
 console.log('PASS SMTP Docker: authenticated verified STARTTLS, MIME text/HTML, recipient-bound URL, durable transport/identity, authorization, explicit rejection, DATA disconnect uncertainty, manual resend guard, terminal/expiry guards, concurrent single send. Restart canaries seeded; no real email sent.');
} catch(e){await diagnostic(phase,e);process.exitCode=1;}
finally{await pool?.end();}
