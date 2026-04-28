// Phase C + D: insert the 210 sanad.om-sourced services into service_catalog
// using the same parsers + transforms autoImportCatalog uses for the master.
//
// Reads scripts/sanad_om_scrape/sanad_om_services.csv (which the enrich step
// has filled with AR/EN names, descriptions, document lists) and INSERTs each
// row with the full v2 schema. New entities (Mazoon Electricity, Sanad Center
// Services, Public Prosecution, etc.) come along automatically — they're just
// new entity_en/entity_ar/entity_id values.
//
// Usage:
//   node scripts/apply_sanad_om_phase_cd.mjs              # dry-run summary
//   node scripts/apply_sanad_om_phase_cd.mjs --force      # actually insert

import 'dotenv/config';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@libsql/client';

const DB_URL = process.env.DB_URL || 'file:./data/sanad.db';
const CSV    = './scripts/sanad_om_scrape/sanad_om_services.csv';
const force  = process.argv.includes('--force');
const db = createClient({ url: DB_URL });

// ─── Parsers (mirror lib/db.js helpers) ────────────────────────
function _splitDocs(txt) {
  if (!txt) return [];
  return txt.split(/\s+\.\s+|•|·|;|—|\r?\n/g)
    .map(s => s.replace(/^[\-\s,]+|[\-\s,]+$/g, '').trim())
    .filter(s => s.length >= 2 && s.length < 200);
}
function _slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function _parseFee(en, ar) {
  const s = (en || ar || '').toLowerCase();
  if (/no fees?|free|لا يوجد|مجان/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(omr|ريال|ر\.?ع)/);
  return m ? Number(m[1]) : null;
}
function _normalizeChannels(en, ar) {
  const merged = [(en || ''), (ar || '')].join(' , ').toLowerCase();
  const t = new Set();
  if (/web\s?site|website|الموقع|الكتروني|إلكتروني|بوابة|portal|sanad/.test(merged)) t.add('web');
  if (/app|تطبيق/.test(merged)) t.add('app');
  if (/kiosk|كشك/.test(merged)) t.add('kiosk');
  if (/counter|كاونتر|مركز خدمة|مكتب|سند/.test(merged)) t.add('counter');
  if (/phone|call|هاتف|اتصال/.test(merged)) t.add('phone');
  if (/email|بريد/.test(merged)) t.add('email');
  return [...t].join(',');
}
function _searchBlob(s) {
  return [
    s.name_en, s.name_ar, s.entity_en, s.entity_ar,
    s.entity_dept_en, s.entity_dept_ar, s.beneficiary, s.main_service,
    s.description_en, s.description_ar,
    s.special_conditions_en, s.special_conditions_ar,
    s.fees_text, s.payment_method, s.channels
  ].filter(Boolean).join(' ').toLowerCase();
}
// Mirror LAUNCH_MATCHERS in lib/db.js so new sanad.om rows that match a
// curated launch flow get is_launch=1 set from the start.
const LAUNCH_MATCHERS = [
  /civil.*id.*renew|renew.*civil.*id|بطاق.*مدن.*تجدي|تجدي.*بطاق.*مدن/i,
  /renew.*passport|passport.*renew|تجدي.*جواز/i,
  /(driving|driver).*licen.*renew|renew.*(driving|driver).*licen|تجدي.*رخص.*(قياد|سياق)/i,
  /mulkiya.*renew|renew.*(vehicle|car).*registration|تجدي.*ملكي|ملكي.*مركب/i,
  /commercial.*registration.*(issue|issuance|new)|(issue|new).*commercial.*registration|سجل.*تجاري.*(إصدار|اصدار|جديد)/i
];
function isLaunchFlow(en, ar) {
  const hay = `${en || ''} ${ar || ''}`;
  return LAUNCH_MATCHERS.some(re => re.test(hay)) ? 1 : 0;
}

function buildDocsList(docsEnTxt, docsArTxt) {
  const enArr = _splitDocs(docsEnTxt);
  const arArr = _splitDocs(docsArTxt);
  const n = Math.max(enArr.length, arArr.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const en = (enArr[i] || '').slice(0, 200);
    const ar = (arArr[i] || '').slice(0, 200);
    out.push({
      code: _slug(en || ar).slice(0, 40),
      label_en: en, label_ar: ar,
      accept: ['image', 'pdf']
    });
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────
const raw = fs.readFileSync(CSV, 'utf8');
const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
console.log(`▶ ${CSV}: ${rows.length} rows`);
console.log(`  mode: ${force ? 'INSERT' : 'DRY-RUN'}`);

// Skip rows still missing both names (enrichment incomplete).
const insertable = rows.filter(r => (r.ServiceNameAr || '').trim() && (r.ServiceNameEn || '').trim());
console.log(`  insertable (have AR + EN names): ${insertable.length}`);
const incomplete = rows.length - insertable.length;
if (incomplete) console.log(`  skipping ${incomplete} rows that lack EN translation (re-run enrich for them)`);

// Detect collisions with existing IDs.
const incomingIds = insertable.map(r => Number(r.ServiceID)).filter(Boolean);
const placeholders = incomingIds.map(() => '?').join(',');
const { rows: existing } = await db.execute({
  sql: `SELECT id FROM service_catalog WHERE id IN (${placeholders})`,
  args: incomingIds
});
if (existing.length) {
  console.warn(`  ⚠ ${existing.length} of ${insertable.length} ServiceIDs already exist — INSERT OR REPLACE will overwrite them`);
}

// Per-entity counts for reporting.
const byEntity = {};
for (const r of insertable) {
  const k = `${r.EntityID} · ${r.EntityEn || r.EntityAr}`;
  byEntity[k] = (byEntity[k] || 0) + 1;
}
console.log(`\nPer-entity breakdown of services to insert:`);
for (const [k, n] of Object.entries(byEntity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} · ${k}`);
}

if (!force) { console.log(`\nDry-run complete. Re-run with --force to insert.`); process.exit(0); }

// ─── Insert ────────────────────────────────────────────────────
console.log(`\n▶ inserting ${insertable.length} rows…`);
let n = 0;
for (const r of insertable) {
  const id = Number(r.ServiceID);
  if (!id) continue;
  const docsList = buildDocsList(r.RequiredDocumentsEn, r.RequiredDocumentsAr);
  const fee = _parseFee(r.FeesEn, r.FeesAr);
  const channels = _normalizeChannels(r.Channels, r.Channels);
  const payload = {
    name_en: (r.ServiceNameEn || '').trim(),
    name_ar: (r.ServiceNameAr || '').trim(),
    entity_en: (r.EntityEn || '').trim(),
    entity_ar: (r.EntityAr || '').trim(),
    entity_dept_en: (r.EntityDepartmentEn || '').trim(),
    entity_dept_ar: (r.EntityDepartmentAr || '').trim(),
    beneficiary: (r.Beneficiary || '').trim().slice(0, 200),
    main_service: (r.MainService || '').trim().slice(0, 200),
    description_en: (r.DescriptionEn || '').trim().slice(0, 1000),
    description_ar: (r.DescriptionAr || '').trim().slice(0, 1000),
    special_conditions_en: (r.SpecialConditionsEn || '').trim().slice(0, 500),
    special_conditions_ar: (r.SpecialConditionsAr || '').trim().slice(0, 500),
    fees_text: (r.FeesEn || r.FeesAr || '').trim().slice(0, 200),
    payment_method: (r.PaymentMethod || '').trim().slice(0, 60),
    avg_time_en: (r.AvgTimeTakenEn || '').trim().slice(0, 120),
    avg_time_ar: (r.AvgTimeTakenAr || '').trim().slice(0, 120),
    working_time_en: (r.WorkingTimeEn || '').trim().slice(0, 120),
    working_time_ar: (r.WorkingTimeAr || '').trim().slice(0, 120),
    channels
  };

  await db.execute({
    sql: `INSERT OR REPLACE INTO service_catalog
           (id, entity_en, entity_ar, name_en, name_ar,
            entity_dept_en, entity_dept_ar, beneficiary, main_service,
            description_en, description_ar,
            special_conditions_en, special_conditions_ar,
            fees_text, fee_omr, payment_method,
            avg_time_en, avg_time_ar, working_time_en, working_time_ar,
            channels, num_steps,
            required_documents_json, process_steps_json,
            is_active, version, source_url, search_blob,
            is_launch, embedding_json, embedded_at)
           VALUES (?,?,?,?,?, ?,?,?,?, ?,?, ?,?, ?,?,?,
                   ?,?,?,?, ?,?,
                   ?,?, 1,1,?,?, 0, NULL, NULL)`,
    args: [
      id, payload.entity_en, payload.entity_ar, payload.name_en, payload.name_ar,
      payload.entity_dept_en, payload.entity_dept_ar, payload.beneficiary, payload.main_service,
      payload.description_en, payload.description_ar,
      payload.special_conditions_en, payload.special_conditions_ar,
      payload.fees_text, fee, payload.payment_method,
      payload.avg_time_en, payload.avg_time_ar, payload.working_time_en, payload.working_time_ar,
      payload.channels, 0,
      JSON.stringify(docsList), JSON.stringify([]),
      (r.ServiceURL || '').trim(), _searchBlob(payload)
    ]
  });
  // is_launch is hardcoded 0 in the INSERT for safety; flip it on if the
  // service name matches a curated launch-flow pattern.
  const lf = isLaunchFlow(payload.name_en, payload.name_ar);
  if (lf) await db.execute({ sql: `UPDATE service_catalog SET is_launch=1 WHERE id=?`, args: [id] });
  n++;
  if (n % 50 === 0) console.log(`  ${n}/${insertable.length}…`);
}
console.log(`✓ inserted ${n}`);

// Rebuild FTS5 so the new rows are searchable immediately.
try {
  await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
  console.log('✓ FTS5 rebuilt');
} catch (e) {
  console.warn('  ⚠ FTS rebuild failed (non-fatal):', e.message);
}

const { rows: after } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
console.log(`\n✓ service_catalog now has ${after[0].n} rows`);
process.exit(0);
