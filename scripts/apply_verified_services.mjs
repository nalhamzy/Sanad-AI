// Apply data/verified_services.json into the catalogue.
//
// For each verified service:
//   1. Try to find the catalogue row by id (if present in JSON), else by source_url.
//   2. If found → UPDATE required_documents_json, process_steps_json, fees_text,
//      avg_time_ar in place.
//   3. If NOT found → log it; do NOT auto-insert (catalogue inserts are reserved
//      for the seeder + scraper paths).
//
// Document JSON shape applied:
//   [{ code: 'doc_N', label_ar: 'البطاقة المدنية', label_en: '' }, ...]
// (label_en stays empty — verified data is Arabic-first; the bot's
// arabicLabelFor() picks label_ar with the catalogue dict as fallback.)
//
// Process steps JSON shape:
//   ['step 1 text', 'step 2 text', ...]
//
// Usage:
//   node scripts/apply_verified_services.mjs            # applies + writes report
//   node scripts/apply_verified_services.mjs --dry-run  # logs only, no DB writes
//
// IMPORTANT: applies to the LOCAL catalogue. To push to prod, the same
// JSON should be re-applied against the Render disk OR the verified
// data should be re-imported via the scraper rebuild path.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const DRY = process.argv.includes('--dry-run');

const path = join(projectRoot, 'data', 'verified_services.json');
const raw = JSON.parse(readFileSync(path, 'utf8'));
const services = raw.services || [];

const report = { applied: [], not_found: [], skipped: [], by_entity: {} };

for (const s of services) {
  const docs = (s.verified_docs_ar || []).map((d, i) => ({
    code: `doc_${i + 1}`,
    label_ar: d,
    label_en: ''
  }));
  const steps = s.verified_steps_ar || [];
  const fees_text = s.verified_fee_ar || null;
  const avg_time = s.verified_time_ar || null;

  // Find target row.
  let row = null;
  if (s.id != null) {
    const r = await db.execute({ sql: 'SELECT id, name_en, source_url FROM service_catalog WHERE id = ?', args: [s.id] });
    row = r.rows[0] || null;
  }
  if (!row && s.url) {
    // Catalogue stores URL-encoded form (percent-encoded Arabic); JSON often
    // has decoded form. Try both.
    const encoded = encodeURI(s.url);
    const decoded = (() => { try { return decodeURI(s.url); } catch { return s.url; } })();
    const r = await db.execute({
      sql: 'SELECT id, name_en, source_url FROM service_catalog WHERE source_url IN (?, ?, ?) LIMIT 1',
      args: [s.url, encoded, decoded]
    });
    row = r.rows[0] || null;
  }
  if (!row && s.name_en) {
    // Last-resort: name match within the same entity.
    const entityFull = entityFullName(s.entity);
    if (entityFull) {
      const r = await db.execute({
        sql: `SELECT id, name_en, source_url FROM service_catalog WHERE entity_en = ? AND name_en = ? LIMIT 1`,
        args: [entityFull, s.name_en]
      });
      row = r.rows[0] || null;
    }
  }

  if (!row) {
    report.not_found.push({ entity: s.entity, name_en: s.name_en, url: s.url, reason: 'no_catalogue_row' });
    report.by_entity[s.entity] = report.by_entity[s.entity] || { applied: 0, not_found: 0 };
    report.by_entity[s.entity].not_found += 1;
    continue;
  }

  // ONLY overwrite a JSON field when the new array is non-empty. Some
  // verified services have docs=0 (e.g. ROP says "no documents listed"
  // because the page doesn't enumerate them). In those cases we PRESERVE
  // the existing catalogue value rather than wipe it. Same for steps.
  // First apply attempt overwrote with "[]" and made some services LOSE
  // their existing data — caught by post-apply count check.
  const docsJson  = docs.length  ? JSON.stringify(docs)  : null;
  const stepsJson = steps.length ? JSON.stringify(steps) : null;
  const updateSql = `
    UPDATE service_catalog
       SET required_documents_json = COALESCE(?, required_documents_json),
           process_steps_json      = COALESCE(?, process_steps_json),
           fees_text               = COALESCE(?, fees_text),
           avg_time_ar             = COALESCE(?, avg_time_ar)
     WHERE id = ?`;
  const args = [docsJson, stepsJson, fees_text, avg_time, row.id];
  if (!DRY) {
    try {
      await db.execute({ sql: updateSql, args });
    } catch (e) {
      report.skipped.push({ entity: s.entity, id: row.id, error: e.message });
      continue;
    }
  }
  report.applied.push({ entity: s.entity, id: row.id, name_en: row.name_en, docs: docs.length, steps: steps.length });
  report.by_entity[s.entity] = report.by_entity[s.entity] || { applied: 0, not_found: 0 };
  report.by_entity[s.entity].applied += 1;
}

mkdirSync(join(projectRoot, 'data'), { recursive: true });
const reportPath = join(projectRoot, 'data', 'verify_apply_report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(DRY ? '\n=== DRY RUN — no DB writes ===\n' : '\n=== applied ===\n');
console.log(`total verified services: ${services.length}`);
console.log(`applied (or would-apply): ${report.applied.length}`);
console.log(`not_found in catalogue:   ${report.not_found.length}`);
console.log(`skipped (DB error):       ${report.skipped.length}`);
console.log('\nBy entity:');
for (const [e, c] of Object.entries(report.by_entity).sort()) {
  console.log(`  ${e}: applied=${c.applied}, not_found=${c.not_found}`);
}
console.log(`\nFull report → ${reportPath}`);
process.exit(0);

function entityFullName(tag) {
  return ({
    ROP: 'Royal Oman Police',
    MOC: 'Ministry of Commerce, Industry and Investment Promotion',
    MOL: 'Ministry of Labour',
    MM:  'Muscat Municipality',
    MOH: 'Ministry of Health',
    MOHUP: 'Ministry of Housing and Urban Planning'
  })[tag] || null;
}
