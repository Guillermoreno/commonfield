import {writeFile,readFile} from 'node:fs/promises';
import {diagnostic} from './diagnostic.mjs';
const dir=process.env.COMMONFIELD_SECRET_DIR ?? '/state';
let mutation='not_started';
try {
 const name=process.argv[2];
 if(!['smtp_username','smtp_password'].includes(name)) throw new Error('secret_name_invalid');
 let value='';process.stdin.setEncoding('utf8');
 for await(const chunk of process.stdin) {value+=chunk;if(value.length>4096) throw new Error('secret_too_large');}
 value=value.replace(/\r?\n$/,'');
 if(!value.trim()||/[\r\n\0]/.test(value))throw new Error('secret_invalid');
 mutation='started';
 await writeFile(`${dir}/${name}`,value,{mode:0o444,flag:'wx'});
 if(await readFile(`${dir}/${name}`,'utf8')!==value)throw new Error('secret_readback_failed');
 mutation='verified';
 console.log('SMTP secret file created; value not displayed.');
} catch(error) {await diagnostic('smtp_secret_setup',error,mutation,dir);process.exitCode=1;}
