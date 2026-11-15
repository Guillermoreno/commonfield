import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {diagnostic} from './diagnostic.mjs';
try {
 for(const name of ['smtp_username','smtp_password'])await writeFile(`/fixture/${name}`,randomBytes(24).toString('hex'),{mode:0o444,flag:'wx'});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','/fixture/key.pem','-out','/fixture/cert.pem','-days','1','-subj','/CN=smtp-fixture','-addext','subjectAltName=DNS:smtp-fixture'],{stdio:'ignore'});
 console.log('Disposable SMTP credentials and test CA created (values suppressed).');
} catch(e){await diagnostic('smtp_qa_init',e,'uncertain','/fixture');process.exitCode=1;}
