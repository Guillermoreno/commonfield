import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {diagnostic} from './diagnostic.mjs';
let pool;
try {
 for(const role of ['app','writer']) {
  pool=new pg.Pool({host:'postgres',database:'commonfield',user:`commonfield_${role}`,password:(await readFile(`/run/secrets/${role}_password`,'utf8')).trim()});
  const flags=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(Object.values(flags).every(v=>v===false));
  const rights=(await pool.query(`SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl, has_table_privilege(current_user,'users','SELECT') AS users, has_table_privilege(current_user,'writer_epoch','UPDATE') AS epoch, has_table_privilege(current_user,'schema_migrations','UPDATE') AS ledger`)).rows[0];
  assert.equal(rights.ddl,false);assert.equal(rights.ledger,false);
  assert.equal(rights.users,role==='app');assert.equal(rights.epoch,role==='writer');
  await assert.rejects(pool.query('CREATE TABLE portable_permission_probe(id integer)'),e=>e.code==='42501');
  await pool.end();pool=null;
 }
 console.log('PASS database least privilege: no superuser/role/database/schema creation; app/writer fencing and migration ledger separation.');
} catch(e){await diagnostic('database-test',e);process.exitCode=1;}
finally {await pool?.end();}
