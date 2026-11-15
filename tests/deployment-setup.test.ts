import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('portable retained-secret setup and diagnostics',()=>{
  it('refuses a partial retained-secret set without generating replacements',()=>{
    const root=mkdtempSync(join(tmpdir(),'commonfield-partial-setup-'));
    try {
      const state=join(root,'state');mkdirSync(state,{mode:0o700});
      writeFileSync(join(root,'diagnostic.mjs'),readFileSync('docker/diagnostic.mjs'));
      writeFileSync(join(root,'setup.mjs'),readFileSync('docker/setup.mjs','utf8').replaceAll('/state',state));
      const retained='a'.repeat(64)+'\n';
      writeFileSync(join(state,'admin_password'),retained);
      const result=spawnSync(process.execPath,[join(root,'setup.mjs')],{encoding:'utf8'});
      expect(result.status).toBe(1);
      expect(readFileSync(join(state,'admin_password'),'utf8')).toBe(retained);
      expect(readdirSync(state).filter(n=>!n.endsWith('.json'))).toEqual(['admin_password']);
      expect(result.stdout+result.stderr).not.toContain(retained.trim());
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it('generates unique secrets, preserves them on repeat and fails closed without logging malformed retained values',()=>{
    const root=mkdtempSync(join(tmpdir(),'commonfield-setup-'));
    try {
      const state=join(root,'state');mkdirSync(state,{mode:0o700});
      writeFileSync(join(root,'diagnostic.mjs'),readFileSync('docker/diagnostic.mjs'));
      // Relocate only the mount path; exercise the actual shipping setup script.
      writeFileSync(join(root,'setup.mjs'),readFileSync('docker/setup.mjs','utf8').replaceAll('/state',state));
      const run=()=>spawnSync(process.execPath,[join(root,'setup.mjs')],{encoding:'utf8'});
      expect(run().status).toBe(0);
      const names=['admin_password','app_password','writer_password','migration_password','invitation_key'];
      const original=names.map(n=>readFileSync(join(state,n),'utf8'));
      expect(new Set(original).size).toBe(5);
      for(const secret of original) expect(secret.trim()).toMatch(/^[a-f0-9]{64}$/);
      expect(run().status).toBe(0);
      expect(names.map(n=>readFileSync(join(state,n),'utf8'))).toEqual(original);
      // Atomic replacement simulates a damaged restore, without weakening file permissions.
      rmSync(join(state,'invitation_key'));
      writeFileSync(join(state,'invitation_key'),'private-value-never-log');
      const failed=run();expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('sanitized diagnostic:');
      const report=JSON.parse(readFileSync(join(state,readdirSync(state).find(n=>n.endsWith('.json'))!),'utf8'));
      expect(report.phase).toBe('setup');expect(report.mutation).toBe('uncertain');
      expect(report.exitStatus).toBe(1);expect(report.stackLocations.length).toBeGreaterThan(0);
      expect(JSON.stringify(report)+failed.stderr+failed.stdout).not.toContain('private-value-never-log');
      expect(names.slice(0,4).map(n=>readFileSync(join(state,n),'utf8'))).toEqual(original.slice(0,4));
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
