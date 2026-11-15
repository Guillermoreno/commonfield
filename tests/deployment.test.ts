import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isAllowedPublicOrigin, isRequestOriginAllowed } from '../src/server/public-origin.js';
import { buildInvitationUrl } from '../src/access-control/invitation-url.js';
const read = (name:string) => readFileSync(name,'utf8');
describe('portable deployment contract',()=>{
  it('accepts exact configurable HTTPS and loopback origins, not paths or wildcard matches',()=>{
    for(const origin of ['https://board.example.com','https://board.example.com:8443','http://localhost:8080','http://127.0.0.1:18846']) {
      expect(isAllowedPublicOrigin(origin)).toBe(true);
      expect(isRequestOriginAllowed(origin,origin)).toBe(true);
      expect(buildInvitationUrl(origin,'test-only')).toBe(`${origin}/invitations/accept#token=test-only`);
      expect(isRequestOriginAllowed(origin+'.evil.test',origin)).toBe(false);
    }
    for(const origin of ['http://board.example.com','https://board.example.com/','https://board.example.com/path','https://user@board.example.com','https://board.example.com?x=1','null','*']) expect(isAllowedPublicOrigin(origin)).toBe(false);
  });
  it('ships all ordered migrations and commits checksums with schema changes',()=>{
    expect(readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort().map(n=>n.slice(0,3))).toEqual(['001','002','003','004','005','006','007','008']);
    const runner=read('docker/migrate.mjs');
    expect(runner).toContain('migration_checksum_mismatch');
    expect(runner).toContain('pg_advisory_lock');
    expect(runner).toContain("await db.query('ROLLBACK')");
    expect(runner).toContain("tablename NOT IN ('schema_migrations','writer_epoch')");
    expect(runner).not.toContain('GRANT ALL');
  });
  it('keeps privileged credentials away from runtime and requires migration success',()=>{
    const compose=read('compose.yaml');
    const app=compose.split('  app:')[1]!.split('  mailpit:')[0]!;
    expect(app).toContain('service_completed_successfully');
    expect(app).not.toContain('admin_password');
    expect(app).not.toContain('migration_password');
    expect(compose.split('  postgres:')[1]!.split('  migrate:')[0]!).not.toContain('ports:');
    expect(read('Dockerfile')).toContain('USER 1000:1000');
    expect(read('src/server/index.ts')).toContain('secureCookies: publicOrigin.startsWith("https://")');
    expect(read('src/server/index.ts')).toContain('PostgresWriterAuthority');
    expect(read('docker/Caddyfile')).toContain('reverse_proxy app:4173');
    expect(read('docker/setup.mjs')).toContain("flag:'wx'");
  });
});
