import { diagnostic } from './diagnostic.mjs';
try { await import('../dist/server/server/index.js'); }
catch(e) { await diagnostic('startup',e); process.exit(1); }
