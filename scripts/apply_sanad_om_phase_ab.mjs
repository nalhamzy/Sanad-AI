// Phase A + B of the sanad.om reconciliation:
//   A. delete the 62 junk rows from service_catalog (FAQs, employee tools,
//      info pages, scraper artifacts identified by reconcile_sanad_om.mjs)
//   B. update fee_omr on the 43 matched services to the official sanad.om
//      submit-action fee
//
// Phase C (insert 210 new rows) is handled by the enrich + normalize +
// sanad_om_apply scripts. This file only handles A + B because they are
// surgical, low-risk, and don't depend on Claude.
//
// Usage:
//   node scripts/apply_sanad_om_phase_ab.mjs              # dry-run
//   node scripts/apply_sanad_om_phase_ab.mjs --force      # actually apply

import 'dotenv/config';
import fs from 'node:fs/promises';
import { createClient } from '@libsql/client';

const DB_URL = process.env.DB_URL || 'file:./data/sanad.db';
const RECON = './sanad_reconciliation.json';
const force = process.argv.includes('--force');

const db = createClient({ url: DB_URL });
const recon = JSON.parse(await fs.readFile(RECON, 'utf8'));

console.log(`▶ Reconciliation source: ${recon.generated_at}`);
console.log(`  catalogue rows: ${recon.catalogue_rows}`);
console.log(`  matches: ${recon.details.matches.length}`);
console.log(`  junk_in_us: ${recon.details.junk_in_us.length}`);
console.log(`  fee_discrepancies: ${recon.details.fee_discrepancies.length}`);
console.log(`  mode: ${force ? 'APPLY' : 'DRY-RUN (re-run with --force to commit)'}`);

// ─── Phase A: delete junk rows ─────────────────────────────────
console.log(`\n--- Phase A: delete ${recon.details.junk_in_us.length} junk rows ---`);
const junkIds = recon.details.junk_in_us.map(j => j.id);

if (force) {
  // FK enforcement: request rows reference these. Disable FKs for the swap;
  // any orphaned request rows can be cleaned up by cleanup_orphans.mjs.
  await db.execute(`PRAGMA foreign_keys = OFF`);
  try {
    const placeholders = junkIds.map(() => '?').join(',');
    // Wipe dependents first to keep the request-side query consistent.
    await db.execute({ sql: `DELETE FROM message WHERE request_id IN (SELECT id FROM request WHERE service_id IN (${placeholders}))`, args: junkIds });
    await db.execute({ sql: `DELETE FROM request_document WHERE request_id IN (SELECT id FROM request WHERE service_id IN (${placeholders}))`, args: junkIds });
    await db.execute({ sql: `DELETE FROM request WHERE service_id IN (${placeholders})`, args: junkIds });
    const result = await db.execute({ sql: `DELETE FROM service_catalog WHERE id IN (${placeholders})`, args: junkIds });
    console.log(`  ✓ deleted ${result.rowsAffected} service_catalog rows`);
  } finally {
    await db.execute(`PRAGMA foreign_keys = ON`);
  }
} else {
  console.log(`  (would delete) sample:`);
  for (const j of recon.details.junk_in_us.slice(0, 8)) {
    console.log(`    #${j.id}  ${(j.name_en || j.name_ar || '?').slice(0, 55)}  · ${j.reason}`);
  }
}

// ─── Phase B: update fee_omr on matched services ───────────────
console.log(`\n--- Phase B: reconcile fees on the ${recon.details.matches.length} matched services ---`);
let updates = 0, skipped = 0;
const updateLog = [];
for (const m of recon.details.matches) {
  // Use the "تقديم" (submit) action fee — that's what the citizen pays to
  // start a new request through a Sanad office. If no submit action, take
  // the first listed fee.
  const submit = m.sanad_actions.find(a => /تقديم/.test(a.action)) || m.sanad_actions[0];
  if (!submit || submit.fee_omr == null) { skipped++; continue; }
  const before = m.our_fee_omr;
  const after = submit.fee_omr;
  if (before === after) { skipped++; continue; }
  updateLog.push({ id: m.our_id, name_ar: m.our_name_ar, before, after, sanad_service: m.sanad_service_ar });
  if (force) {
    await db.execute({
      sql: `UPDATE service_catalog SET fee_omr = ?, fees_text = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [after, `${after} OMR (per Sanad price list)`, m.our_id]
    });
  }
  updates++;
}
console.log(`  ${force ? '✓' : '(would)'} update ${updates} fees, ${skipped} unchanged or null`);
for (const u of updateLog.slice(0, 10)) {
  console.log(`    #${u.id}  ${(u.name_ar || '').slice(0, 35)}  ·  ${u.before ?? 'null'} → ${u.after} OMR  (sanad: "${u.sanad_service.slice(0,35)}")`);
}
if (updateLog.length > 10) console.log(`    … and ${updateLog.length - 10} more`);

// ─── Final state ───────────────────────────────────────────────
if (force) {
  const { rows: after } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
  console.log(`\n✓ service_catalog now has ${after[0].n} rows  (was ${recon.catalogue_rows})`);
} else {
  console.log(`\nDry-run complete. Re-run with --force to apply.`);
}

// Also rebuild FTS to reflect the deletes/updates so search stays accurate.
if (force) {
  try {
    await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
    console.log('✓ FTS5 rebuilt');
  } catch (e) {
    console.warn('  ⚠ FTS rebuild failed (non-fatal):', e.message);
  }
}

process.exit(0);
