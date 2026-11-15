import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { diagnostic } from './diagnostic.mjs';
let db;
try {
  db = new pg.Client({host:'postgres',database:'commonfield',user:'commonfield_migration',password:(await readFile('/run/secrets/migration_password','utf8')).trim()});
  await db.connect();
  await db.query('SELECT pg_advisory_lock(741920)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir('migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).sort()) {
    const source = await readFile(`migrations/${name}`,'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const existing = await db.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
    if(existing.rowCount) {
      if(existing.rows[0].sha256!==checksum) throw new Error('migration_checksum_mismatch');
      continue;
    }
    await db.query('BEGIN');
    try {
      await db.query(source.replace(/^BEGIN;\s*|^COMMIT;\s*/gm,''));
      await db.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,checksum]);
      await db.query('COMMIT');
    } catch(e) { await db.query('ROLLBACK'); throw e; }
    console.log(`Applied ${name}`);
  }
  // Application DML only; authority fencing state writable solely by writer role.
  const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','writer_epoch')");
  for (const {tablename} of tables.rows) {
    if(!/^[a-z_]+$/.test(tablename)) throw new Error('invalid_table');
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tablename} TO commonfield_app`);
  }
  await db.query('GRANT SELECT ON writer_epoch TO commonfield_app');
  await db.query('GRANT SELECT,UPDATE ON writer_epoch TO commonfield_writer');
  await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO commonfield_app');
  console.log('Commonfield migrations verified.');
} catch(e) {await diagnostic('migration',e);process.exitCode=1;}
finally {await db?.end();}
