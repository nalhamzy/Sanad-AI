// ───────────────────────────────────────────────────────────────
// One-shot: build a FRESH libSQL/Turso database from the canonical
// sources — the exact same sequence server.js prepare() runs on boot,
// minus the HTTP server, watchers, and external calls. Safe to re-run
// (every step is idempotent).
//
// Target DB comes from env (set them to the NEW Turso before running):
//   DB_URL=libsql://…  DB_AUTH_TOKEN=…  node scripts/migrate_to_turso.mjs
//
// Builds: full schema · full CSV catalogue · approved set · curate
// (verified-only active) · demo offices/annotators. The 25 Qurm
// services + embeddings are seeded separately by
// scripts/seed_qurm_services.mjs (run it next with the same env).
// Bulk embeddings are intentionally NOT computed here — the live boot's
// embedPending() loop fills them in the background after cutover, and
// the lexical lane (likeSearch) works immediately without them.
// ───────────────────────────────────────────────────────────────
import 'dotenv/config';
import {
  db, migrate, autoImportCatalog, deactivateUnverifiedServices,
  seedDemoOffices, seedDemoAnnotators
} from '../lib/db.js';

const t0 = Date.now();
const target = process.env.DB_URL || '(local file)';
console.log(`→ target DB: ${target}`);
if (!/turso\.io|libsql:\/\//.test(target)) {
  console.warn('⚠  DB_URL does not look like a Turso/libSQL URL — refusing to run against a local file.');
  console.warn('   Set DB_URL + DB_AUTH_TOKEN to the new Turso, then re-run.');
  process.exit(2);
}

console.log('1/6 migrate (schema)…');
await migrate();

console.log('2/6 autoImportCatalog (CSV → service_catalog)…');
try {
  const imp = await autoImportCatalog();
  console.log('    imported:', imp?.imported ?? '(skipped — table not empty)');
} catch (e) { console.warn('    autoImportCatalog failed:', e.message); }

console.log('3/6 loadApprovedServices…');
try {
  const { loadApprovedServices } = await import('./load_approved_services.mjs');
  const rep = await loadApprovedServices({ apply: true });
  console.log('    approved rows:', Array.isArray(rep) ? rep.length : rep);
} catch (e) { console.warn('    loadApprovedServices failed:', e.message); }

console.log('4/6 deactivateUnverifiedServices (verified-only active)…');
try {
  const cur = await deactivateUnverifiedServices();
  console.log('   ', JSON.stringify(cur));
} catch (e) { console.warn('    curate failed:', e.message); }

console.log('5/6 demo offices + annotators…');
await seedDemoOffices();
await seedDemoAnnotators();

console.log('6/6 verify counts…');
const one = async (sql) => (await db.execute(sql)).rows[0].n;
const tables   = await one("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'");
const total    = await one('SELECT COUNT(*) n FROM service_catalog');
const active   = await one('SELECT COUNT(*) n FROM service_catalog WHERE is_active=1');
const offices  = await one('SELECT COUNT(*) n FROM office');
const officers = await one('SELECT COUNT(*) n FROM officer');
console.log(`    tables=${tables}  catalogue=${total}  active=${active}  offices=${offices}  officers=${officers}`);
console.log(`✓ schema + catalogue built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  NEXT: run  node scripts/seed_qurm_services.mjs  with the same DB_URL/DB_AUTH_TOKEN to add the 25 Qurm services + embeddings.');
process.exit(0);
