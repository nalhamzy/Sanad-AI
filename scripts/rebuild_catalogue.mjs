// Rebuild service_catalog from scratch using ONLY the seven scraped ministry
// CSVs (no master CSV). Wipes existing rows + FTS index, re-imports all 453
// rows with the full v2 schema (description, docs JSON, fees, search_blob),
// then triggers Qwen embeddings until the cache is warm.
//
// Run after `npm run normalize && node scripts/enrich_scraped.mjs`.
//
// Output: data/sanad.db (or whatever DB_URL points to) with exactly the
// scraped catalogue, fully embedded, ready for hybrid search.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { db, migrate } from '../lib/db.js';
import { embedPending } from '../lib/embeddings.js';

const MINISTRY_CSVS = [
  'scripts/mm_scrape/mm_services.csv',
  'scripts/moc_scrape/moc_services.csv',
  'scripts/moh_scrape/moh_services.csv',
  'scripts/mohup_scrape/mohup_services.csv',
  'scripts/mol_scrape/mol_services.csv',
  'scripts/mtcit_scrape/mtcit_services.csv',
  'scripts/rop_scrape/rop_services.csv'
];

// ─── CSV helpers (mirror autoImportCatalog parsers) ────────────
// Documents text → array of {code, label_en, label_ar, accept}.
function _splitDocs(txt) {
  if (!txt) return [];
  return txt
    .split(/\s+\.\s+|•|·|;|—|\r?\n/g)
    .map(s => s.replace(/^[\-\s,]+|[\-\s,]+$/g, '').trim())
    .filter(s => s.length >= 2 && s.length < 200);
}
function _slug(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

// Parse fee text → numeric OMR if extractable.
function _parseFee(en, ar) {
  const s = (en || ar || '').toLowerCase();
  if (/no fees?|free|لا يوجد|مجان/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(omr|ريال)/);
  return m ? Number(m[1]) : null;
}

// Steps "[1] foo || [2] bar" → array of {n, en, ar}.
function _parseProcessSteps(en, ar) {
  const split = (raw) => (raw || '').split(/\s*\|\|\s*/g).map(s => s.trim()).filter(Boolean);
  const enParts = split(en); const arParts = split(ar);
  const total = Math.max(enParts.length, arParts.length);
  const steps = [];
  for (let i = 0; i < total; i++) {
    const rawEn = enParts[i] || ''; const rawAr = arParts[i] || '';
    const nMatch = rawEn.match(/^\[(\d+)\]\s*/) || rawAr.match(/^\[(\d+)\]\s*/);
    const n = nMatch ? Number(nMatch[1]) : i + 1;
    steps.push({
      n,
      en: rawEn.replace(/^\[\d+\]\s*/, '').trim(),
      ar: rawAr.replace(/^\[\d+\]\s*/, '').trim()
    });
  }
  return steps;
}

function _normalizeChannels(en, ar) {
  const merged = [(en || ''), (ar || '')].join(' , ').toLowerCase();
  const tokens = new Set();
  if (/web\s?site|website|الموقع|الكتروني|إلكتروني|بوابة|portal/.test(merged)) tokens.add('web');
  if (/app|تطبيق/.test(merged)) tokens.add('app');
  if (/kiosk|كشك/.test(merged)) tokens.add('kiosk');
  if (/counter|كاونتر|مركز خدمة|مكتب/.test(merged)) tokens.add('counter');
  if (/phone|call|هاتف|اتصال/.test(merged)) tokens.add('phone');
  if (/email|بريد/.test(merged)) tokens.add('email');
  return [...tokens].join(',');
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

// Mirror lib/db.js LAUNCH_MATCHERS — these tag the 5 curated citizen flows.
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

// Pair each doc text with its AR twin where positions match. The
// normalize_scraped script aligns AR/EN doc lists by separator-split, so
// the i-th item of each list refers to the same document.
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
      label_en: en,
      label_ar: ar,
      accept: ['image', 'pdf']
    });
  }
  return out;
}

async function readAll() {
  const all = [];
  for (const p of MINISTRY_CSVS) {
    let raw;
    try { raw = await fs.readFile(p, 'utf8'); } catch { continue; }
    const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
    for (const r of rows) all.push(r);
    console.log(`  · ${path.basename(p)}: ${rows.length}`);
  }
  return all;
}

async function wipeCatalog() {
  // Disable FK enforcement for the swap. citizen `request` rows reference
  // service_catalog.id and will become orphans after the wipe — that's an
  // accepted consequence of "delete all the catalog and insert the new list".
  // Operators can clean orphans later via a follow-up query.
  console.log('▶ wiping service_catalog (foreign keys disabled for the swap)…');
  await db.execute(`PRAGMA foreign_keys = OFF`);
  try {
    await db.execute(`DELETE FROM service_catalog`);
    try { await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('delete-all')`); } catch {}
  } finally {
    await db.execute(`PRAGMA foreign_keys = ON`);
  }
}

async function insertRow(r) {
  const id = Number(r.ServiceID);
  if (!id) return false;

  const docsList = buildDocsList(r.RequiredDocumentsEn, r.RequiredDocumentsAr);
  const fee = _parseFee(r.FeesEn, r.FeesAr);
  const steps = _parseProcessSteps(r.ProcessStepsEn, r.ProcessStepsAr);
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
    fees_text: (r.FeesEn || '').trim().slice(0, 200),
    payment_method: (r.PaymentMethod || '').trim().slice(0, 60),
    avg_time_en: (r.AvgTimeTakenEn || '').trim().slice(0, 120),
    avg_time_ar: (r.AvgTimeTakenAr || '').trim().slice(0, 120),
    working_time_en: (r.WorkingTimeEn || '').trim().slice(0, 120),
    working_time_ar: (r.WorkingTimeAr || '').trim().slice(0, 120),
    channels
  };
  const numSteps = Number(r.NumSteps) || steps.length || 0;
  const isLaunch = isLaunchFlow(payload.name_en, payload.name_ar);

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
                   ?,?, 1,1,?,?, ?, NULL, NULL)`,
    args: [
      id, payload.entity_en, payload.entity_ar, payload.name_en, payload.name_ar,
      payload.entity_dept_en, payload.entity_dept_ar, payload.beneficiary, payload.main_service,
      payload.description_en, payload.description_ar,
      payload.special_conditions_en, payload.special_conditions_ar,
      payload.fees_text, fee, payload.payment_method,
      payload.avg_time_en, payload.avg_time_ar, payload.working_time_en, payload.working_time_ar,
      payload.channels, numSteps,
      JSON.stringify(docsList), JSON.stringify(steps),
      (r.ServiceURL || '').trim(), _searchBlob(payload),
      isLaunch
    ]
  });
  return true;
}

// ─── Embeddings warmup ──────────────────────────────────────────
async function warmEmbeddings() {
  console.log('▶ computing embeddings (Qwen text-embedding-v3, 1024-dim)…');
  let total = 0, cycles = 0;
  while (true) {
    const n = await embedPending({ batchSize: 32, maxRows: 200 });
    if (n === 0) break;
    total += n;
    cycles++;
    console.log(`  cycle ${cycles}: +${n}  (running total: ${total})`);
  }
  console.log(`✓ embeddings done — ${total} rows embedded across ${cycles} cycles`);
  return total;
}

// ─── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const skipEmbed = args.includes('--no-embed');
const force = args.includes('--force');

console.log('▶ reading scraped CSVs');
const all = await readAll();
console.log(`  total rows: ${all.length}`);

if (!force) {
  console.log('\n⚠  This will DELETE every row in service_catalog and re-insert');
  console.log(`   ${all.length} scraped rows. Re-run with --force to confirm.`);
  process.exit(1);
}

await migrate();
await wipeCatalog();

console.log(`▶ inserting ${all.length} rows`);
let inserted = 0, skipped = 0;
for (const r of all) {
  const ok = await insertRow(r);
  if (ok) inserted++; else skipped++;
  if (inserted % 100 === 0 && inserted > 0) console.log(`  ${inserted}/${all.length}…`);
}
console.log(`✓ inserted ${inserted}, skipped ${skipped}`);

// Rebuild FTS with the new content.
console.log('▶ rebuilding FTS5 index');
await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
console.log('✓ FTS5 rebuilt');

// Sanity counts
const { rows: cnt } = await db.execute('SELECT COUNT(*) AS n FROM service_catalog');
const { rows: ftsCnt } = await db.execute('SELECT COUNT(*) AS n FROM service_catalog_fts');
console.log(`  service_catalog rows: ${cnt[0].n}`);
console.log(`  service_catalog_fts rows: ${ftsCnt[0].n}`);

if (skipEmbed) {
  console.log('\n(--no-embed: skipping embeddings warmup)');
} else {
  await warmEmbeddings();
}

process.exit(0);
