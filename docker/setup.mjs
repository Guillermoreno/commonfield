import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { diagnostic } from './diagnostic.mjs';
try {
  await mkdir('/state', {recursive:true, mode:0o700});
  const names = ['admin_password','app_password','writer_password','migration_password','invitation_key'];
  const retained = await Promise.all(names.map(async name => {
    try { return await readFile(`/state/${name}`, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }));
  const count = retained.filter(value => value !== null).length;
  // A damaged/partial restore must never silently mint replacement credentials.
  if (count !== 0 && count !== names.length) throw new Error('partial_retained_secret_set');
  if (count === names.length) {
    if (retained.some(value => !/^[a-f0-9]{64}\n?$/.test(value))) throw new Error('invalid_retained_secret');
  } else {
    for (const name of names) {
      await writeFile(`/state/${name}`, randomBytes(32).toString('hex')+'\n', {flag:'wx',mode:0o444});
    }
  }
  console.log('Commonfield setup ready; retained secrets unchanged.');
} catch(e) { await diagnostic('setup',e,'uncertain','/state'); process.exit(1); }
