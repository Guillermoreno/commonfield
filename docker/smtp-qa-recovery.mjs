import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {diagnostic} from './diagnostic.mjs';
const phase=process.argv[2];let pool;
try {
 if(process.env.COMMONFIELD_SMTP_QA!=='1'||process.env.SMTP_HOST!=='smtp-fixture')throw new Error('disposable_fixture_required');
 if(!['before-restart','after-restart','capture'].includes(phase))throw new Error('qa_phase_invalid');
 pool=new pg.Pool({host:'postgres',database:'commonfield',user:'commonfield_app',password:(await readFile('/run/secrets/app_password','utf8')).trim()});
 const fixtureCount=async()=>(await (await fetch('http://smtp-fixture:1080/messages')).json()).length;
 const rows=await pool.query("SELECT i.status lifecycle,i.delivery_status,a.status attempt,a.transport FROM invitations i JOIN invitation_delivery_attempts a ON a.id=i.current_delivery_attempt_id WHERE i.email LIKE 'qa-restart-%'");
 assert.equal(rows.rowCount,2);
 if(phase==='before-restart'){
  assert.ok(rows.rows.every(r=>r.attempt==='sending'));
  const epoch=await pool.query('SELECT generation FROM writer_epoch');
  const {recoverInvitationDeliveries}=await import('../dist/server/access-control/delivery-recovery.js');
  await assert.rejects(recoverInvitationDeliveries(pool,BigInt(epoch.rows[0].generation),'00000000-0000-4000-8000-000000000000'),/writer_ownership_lost/);
  const count=await pool.query("SELECT count(*) FROM invitation_delivery_attempts WHERE status='sending'");assert.equal(count.rows[0].count,'2');
  console.log('PASS live PostgreSQL stale-nonce recovery refused; both stranded attempts remain untouched.');
 } else {
  assert.ok(rows.rows.every(r=>r.attempt==='uncertain' && r.transport==='smtp'));
  assert.equal(rows.rows.find(r=>r.lifecycle==='pending').delivery_status,'uncertain');
  assert.equal(rows.rows.find(r=>r.lifecycle==='revoked').delivery_status,'queued');
  // Five DATA submissions before restart: acceptance, rejection, uncertain,
  // confirmed resend, and one concurrent winner. No recovery sends.
  assert.equal(await fixtureCount(),5);
  if(phase==='after-restart')console.log('PASS real restart: fenced recovery marks stranded attempts uncertain, preserves terminal lifecycle and sends nothing.');
  else {
   const admin=await pool.query("SELECT user_id,team_id FROM memberships WHERE role='administrator' AND status='active' LIMIT 1");
   const secret=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');const digest=v=>createHash('sha256').update(v).digest();
   await pool.query("INSERT INTO sessions(id_digest,user_id,csrf_digest,absolute_expires_at,idle_expires_at) VALUES($1,$2,$3,now()+interval '5 minutes',now()+interval '5 minutes')",[digest(secret),admin.rows[0].user_id,digest(csrf)]);
   const req=(path,method='GET',body)=>fetch('http://127.0.0.1:4173'+path,{method,headers:{origin:process.env.PUBLIC_ORIGIN,cookie:`commonfield_session=${secret}`,'x-csrf-token':csrf,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   const session=await (await req('/api/session')).json();assert.equal(session.deliveryTransport,'local_capture');
   assert.ok(session.invitations.some(i=>i.deliveryStatus==='sent'&&i.deliveryTransport==='smtp'));
   // Session read rotates CSRF, so fetch a fresh test-owned session for mutation.
   await pool.query('UPDATE sessions SET csrf_digest=$2 WHERE id_digest=$1',[digest(secret),digest(csrf)]);
   const created=await req(`/api/teams/${admin.rows[0].team_id}/invitations`,'POST',{email:'capture-qa@example.test',role:'member'});assert.equal(created.status,201);const invitation=await created.json();
   const sent=await req(`/api/invitations/${invitation.invitationId}/delivery-attempts`,'POST',{});assert.equal(sent.status,200);assert.deepEqual(await sent.json(),{deliveryStatus:'sent',deliveryTransport:'local_capture'});
   const captures=await (await fetch('http://mailpit:8025/api/v1/messages')).json();assert.equal(captures.total,1);
   const content=await (await fetch(`http://mailpit:8025/api/v1/message/${captures.messages[0].ID}`)).json();assert.equal(content.To[0].Address,'capture-qa@example.test');assert.ok(content.Text.includes(invitation.invitationUrl));assert.ok(content.HTML.includes(invitation.invitationUrl));
   assert.equal(await fixtureCount(),5);
   const persisted=await pool.query('SELECT transport FROM invitation_delivery_attempts WHERE invitation_id=$1',[invitation.invitationId]);assert.equal(persisted.rows[0].transport,'local_capture');
   await pool.query('DELETE FROM sessions WHERE id_digest=$1',[digest(secret)]);
   console.log('PASS capture mode: SMTP history retained, new local_capture attempt read back in Mailpit with text/HTML and recipient-bound URL; fixture received nothing new.');
  }
 }
} catch(e){await diagnostic(`smtp_qa_${['before-restart','after-restart','capture'].includes(phase)?phase:'invalid'}`,e);process.exitCode=1;}
finally{await pool?.end();}
