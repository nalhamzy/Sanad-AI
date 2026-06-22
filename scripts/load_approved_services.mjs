// Load office-APPROVED services into service_catalog as the verified set.
//
// Usage:
//   node scripts/load_approved_services.mjs           # DRY RUN — report only, no writes
//   node scripts/load_approved_services.mjs --apply   # write to the DB
//
// Idempotent: each service is keyed by source_url='approved:<key>', so re-running
// UPDATES the same row instead of duplicating. On apply it sets:
//   verification_status='office_approved', verification_source='office', verified_at
//   office_fee_omr = the office commission;  fee_omr = NULL + gov_fee_tbd=1 (gov fee
//     unknown — office enters it before billing)
//   required_documents_json = the typed field list (file/text/date/number)
//   a 'validated' service_validation row (system annotator) so it shows verified in
//   the annotator tool.
//
// It also fuzzy-matches each approved service against the existing SCRAPED rows and
// flags likely duplicates so the team can deactivate/merge them (we never overwrite
// a scraped row — approved services are inserted fresh).

import { db, migrate } from '../lib/db.js';
import { normalize } from '../lib/catalogue.js';
import { APPROVED_SERVICES, APPROVED_ENTITY } from '../data/approved_services.mjs';

const DUP_THRESHOLD = 0.5;

function tokenSet(s) {
  return new Set(normalize(s).split(/\s+/).filter(t => t.length >= 2));
}
function overlap(a, b) {
  const ta = tokenSet(a), tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}
function searchBlob(svc) {
  return [svc.name_en, svc.name_ar, APPROVED_ENTITY.entity_en, APPROVED_ENTITY.entity_ar]
    .filter(Boolean).join(' ').toLowerCase();
}

async function ensureSystemAnnotator() {
  const { rows } = await db.execute({ sql: `SELECT id FROM annotator WHERE email=? LIMIT 1`, args: ['import@saned.ai'] });
  if (rows[0]?.id) return rows[0].id;
  const r = await db.execute({ sql: `INSERT INTO annotator(name,email) VALUES (?,?)`, args: ['Office Approved (import)', 'import@saned.ai'] });
  return Number(r.lastInsertRowid);
}

// Load the approved set. Returns a report array (one entry per service).
// Does NOT call migrate() — the caller must ensure the schema exists.
export async function loadApprovedServices({ apply = false } = {}) {
  // Scraped candidates for dup detection (everything not already office-approved).
  const { rows: candidates } = await db.execute({
    sql: `SELECT id, name_ar, name_en FROM service_catalog
           WHERE verification_source IS NULL OR verification_source <> 'office'`
  });

  const annotatorId = apply ? await ensureSystemAnnotator() : null;
  const report = [];

  for (const svc of APPROVED_SERVICES) {
    const naturalKey = 'approved:' + svc.key;

    // Best fuzzy match among scraped rows (dedup review only — not overwritten).
    let best = null;
    for (const c of candidates) {
      const score = Math.max(overlap(svc.name_ar, c.name_ar || ''), overlap(svc.name_en, c.name_en || ''));
      if (!best || score > best.score) best = { id: c.id, name_ar: c.name_ar, score };
    }
    const dup = best && best.score >= DUP_THRESHOLD ? best : null;

    const { rows: ex } = await db.execute({ sql: `SELECT id FROM service_catalog WHERE source_url=? LIMIT 1`, args: [naturalKey] });
    const existingId = ex[0]?.id || null;
    const action = existingId ? 'update' : 'insert';

    const docsJson = JSON.stringify(svc.documents);
    const blob = searchBlob(svc);

    report.push({ key: svc.key, name_ar: svc.name_ar, commission: svc.office_fee_omr, fields: svc.documents.length, action, dup });

    if (!apply) continue;

    let serviceId = existingId;
    if (existingId) {
      await db.execute({
        sql: `UPDATE service_catalog SET
                 entity_en=?, entity_ar=?, name_en=?, name_ar=?,
                 required_documents_json=?, fee_omr=NULL, office_fee_omr=?, gov_fee_tbd=1,
                 verification_status='office_approved', verification_source='office',
                 verified_at=datetime('now'), is_active=1, is_launch=0,
                 search_blob=?, version=COALESCE(version,1)+1, updated_at=datetime('now')
               WHERE id=?`,
        args: [APPROVED_ENTITY.entity_en, APPROVED_ENTITY.entity_ar, svc.name_en, svc.name_ar, docsJson, svc.office_fee_omr, blob, existingId]
      });
    } else {
      const r = await db.execute({
        sql: `INSERT INTO service_catalog
                (entity_en,entity_ar,name_en,name_ar,required_documents_json,
                 fee_omr,office_fee_omr,gov_fee_tbd,
                 verification_status,verification_source,verified_at,
                 is_active,is_launch,version,search_blob,source_url,updated_at)
              VALUES (?,?,?,?,?, NULL,?,1, 'office_approved','office',datetime('now'),
                      1,0,1,?,?,datetime('now'))`,
        args: [APPROVED_ENTITY.entity_en, APPROVED_ENTITY.entity_ar, svc.name_en, svc.name_ar, docsJson, svc.office_fee_omr, blob, naturalKey]
      });
      serviceId = Number(r.lastInsertRowid);
      try {
        await db.execute({
          sql: `INSERT INTO service_catalog_fts(rowid,name_en,name_ar,description_en,description_ar,entity_en,entity_ar)
                VALUES (?,?,?,?,?,?,?)`,
          args: [serviceId, svc.name_en, svc.name_ar, '', '', APPROVED_ENTITY.entity_en, APPROVED_ENTITY.entity_ar]
        });
      } catch { /* contentless FTS — safe to ignore */ }
    }

    // Validated row for the annotator UI (replace any prior from this importer).
    await db.execute({ sql: `DELETE FROM service_validation WHERE service_id=? AND annotator_id=?`, args: [serviceId, annotatorId] });
    await db.execute({
      sql: `INSERT INTO service_validation(service_id,annotator_id,status,notes) VALUES (?,?, 'validated', ?)`,
      args: [serviceId, annotatorId, 'Office-approved import (Qurm office, 2026-06-22)']
    });
    report[report.length - 1].id = serviceId;
  }

  return report;
}

function printReport(report, apply) {
  console.log(`\n${apply ? '✅ APPLIED' : '🔍 DRY RUN'} — ${report.length} office-approved services\n`);
  for (const r of report) {
    const tag = r.action === 'insert' ? 'INSERT' : 'UPDATE';
    const dup = r.dup ? `   ⚠ possible dup of scraped #${r.dup.id} (${Math.round(r.dup.score * 100)}%)` : '';
    console.log(`  [${tag}] ${r.name_ar}  ·  ${r.commission} OMR  ·  ${r.fields} fields${dup}`);
  }
  const ins = report.filter(r => r.action === 'insert').length;
  const upd = report.filter(r => r.action === 'update').length;
  const dups = report.filter(r => r.dup).length;
  console.log(`\n  ${ins} insert · ${upd} update · ${dups} flagged as a possible scraped duplicate (review to deactivate)\n`);
  if (!apply) console.log('  Nothing written. Re-run with --apply to load.\n');
}

// CLI entry (skipped when imported by a test).
const _isCli = process.argv[1] && process.argv[1].endsWith('load_approved_services.mjs');
if (_isCli) {
  const apply = process.argv.includes('--apply');
  migrate()
    .then(() => loadApprovedServices({ apply }))
    .then((report) => { printReport(report, apply); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
