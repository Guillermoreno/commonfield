import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import https from 'node:https';
import {createRequire} from 'node:module';
import {diagnostic} from './diagnostic.mjs';
const require=createRequire(import.meta.url);
const WebSocket=createRequire(require.resolve('@fastify/websocket'))('ws');
const origin=process.env.PUBLIC_ORIGIN ?? 'http://localhost:8080';
const proxyQA=process.env.COMMONFIELD_HTTPS_QA==='1';
const target=proxyQA?'https://qa-proxy:8443':'http://127.0.0.1:4173';
// Self-signed acceptance is restricted to this explicit disposable QA path.
const transport=proxyQA?async(url,options)=>new Promise((resolve,reject)=>{
 const req=https.request(url,{...options,servername:"localhost",headers:{...options.headers,host:"localhost:8443"},rejectUnauthorized:false},res=>{
   let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>Array.isArray(res.headers[name])?res.headers[name][0]:res.headers[name]},text:async()=>body,json:async()=>JSON.parse(body)}));
 });req.on('error',reject);req.end(options.body);
}):fetch;
let cookie='',csrf='';
const request=async(path,method='GET',body,foreign=false)=>{
 const response=await transport(target+path,{method,headers:{origin:foreign?'https://foreign.example':origin,'content-type':'application/json',...(cookie?{cookie,'x-csrf-token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return response;
};
try {
 assert.equal((await request('/api/ready')).status,200);
 assert.match(await (await request('/bootstrap')).text(),/<div id="root">/);
 assert.equal((await request('/api/nonexistent')).status,404);
 assert.equal((await request('/missing.js')).status,404);
 const owner={displayName:'Install QA',email:`qa-${randomUUID()}@example.test`,teamName:'Install QA',password:randomBytes(24).toString('hex')};
 assert.equal((await request('/api/bootstrap','POST',owner,true)).status,403);
 const created=await request('/api/bootstrap','POST',owner);
 assert.equal(created.status,201,'smoke requires a fresh disposable installation');
 assert.equal((await request('/api/bootstrap','POST',owner)).status,409);
 const login=await request('/api/login','POST',{email:owner.email,password:owner.password});
 assert.equal(login.status,200);
 cookie=login.headers.get('set-cookie').split(';')[0];
 assert.match(cookie,/^commonfield_session=/);
 assert.equal(/; Secure/i.test(login.headers.get('set-cookie')),origin.startsWith('https://'));
 const session=await login.json();csrf=session.csrf;
 const renewed=await request('/api/session');assert.equal(renewed.status,200);csrf=(await renewed.json()).csrf;
 const board=await request(`/api/boards/${session.boardId}`);assert.equal(board.status,200);
 const payload={operationId:randomUUID(),text:'Portable install smoke',expectedVersion:0,x:100,y:100,color:'blue'};
 assert.equal((await request(`/api/boards/${session.boardId}/stickies`,'POST',payload,true)).status,403);
 const sticky=await request(`/api/boards/${session.boardId}/stickies`,'POST',payload);assert.equal(sticky.status,201);
 const saved=await sticky.json();assert.ok(JSON.stringify(saved).includes('Portable install smoke'));
 const wsResult=(offered)=>new Promise((resolve,reject)=>{
   const ws=new WebSocket(`${target.replace(/^http/,'ws')}/ws/boards/${session.boardId}`,[`commonfield-csrf.${csrf}`],{...(proxyQA?{rejectUnauthorized:false,servername:"localhost"}:{}),headers:{cookie,origin:offered,...(proxyQA?{host:"localhost:8443"}:{})}});
   const timer=setTimeout(()=>{ws.terminate();reject(new Error('socket_timeout'));},5000);
   ws.once('message',data=>{clearTimeout(timer);resolve(JSON.parse(data.toString()).type);ws.close();});
   ws.once('close',code=>{clearTimeout(timer);resolve(code);});ws.once('error',reject);
 });
 assert.equal(await wsResult(origin),'subscription.ready');
 assert.equal(await wsResult('https://foreign.example'),4403);
 const invite=await request(`/api/teams/${session.teamId}/invitations`,'POST',{email:'capture-only@example.test',role:'member'});
 assert.equal(invite.status,201);
 const invitation=await invite.json();
 assert.ok(invitation.invitationUrl?.startsWith(origin+'/invitations/accept#token='));
 assert.equal((await request(`/api/invitations/${invitation.invitationId}/delivery-attempts`,'POST',{})).status,200);
 const listed=await request(`/api/teams/${session.teamId}/invitations`);assert.equal(listed.status,200);
 const list=await listed.json();assert.ok(JSON.stringify(list).includes(invitation.invitationUrl));
 console.log('PASS fresh install: readiness, SPA/errors, one-time bootstrap, login/session, board write, exact-origin CSRF/WS, retained invitation URL and capture delivery.');
} catch(e) {await diagnostic('smoke',e);process.exitCode=1;}
