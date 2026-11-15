// Disposable QA only: no relay, no real recipient delivery. No ports published.
import {SMTPServer} from 'smtp-server';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {diagnostic} from './diagnostic.mjs';
try {
 const password=(await readFile('/fixture/smtp_password','utf8')).trim();
 const username=(await readFile('/fixture/smtp_username','utf8')).trim();
 const messages=[];let mode='accept';
 const server=new SMTPServer({key:await readFile('/fixture/key.pem'),cert:await readFile('/fixture/cert.pem'),logger:false,
  onAuth(auth,_session,cb){cb(auth.username===username && auth.password===password?null:new Error('rejected'),{user:'qa'});},
  onData(stream,_session,cb){let data='';stream.on('data',c=>data+=c);stream.on('end',()=>{
   messages.push(data);
   if(mode==='reject')cb(Object.assign(new Error('rejected'),{responseCode:554}));
   else if(mode==='disconnect')for(const connection of server.connections)connection.close();
   else if(mode==='accept')cb(); // hold mode deliberately omits acknowledgment
  });}
 });
 server.on('error',async e=>{await diagnostic('smtp_fixture',e);process.exitCode=1;});
 server.listen(1025,'0.0.0.0');
 createServer((req,res)=>{
  if(req.method==='GET' && req.url==='/messages'){res.setHeader('content-type','application/json');res.end(JSON.stringify(messages));return;}
  if(req.method==='POST' && ['/accept','/reject','/disconnect','/hold'].includes(req.url)){mode=req.url.slice(1);res.end('ok');return;}
  res.statusCode=404;res.end();
 }).listen(1080,'0.0.0.0');
 console.log('Disposable authenticated TLS SMTP fixture ready (no relay).');
} catch(e){await diagnostic('smtp_fixture',e,'not_started');process.exitCode=1;}
