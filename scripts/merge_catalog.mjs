// Build oman_services_directory_v2.csv from the seven scraped ministry CSVs.
//
//   node scripts/merge_catalog.mjs              # scraped-only (default)
//   node scripts/merge_catalog.mjs --with-master  # also include the legacy
//                                                  oman_services_directory.csv
//
// By default the v2 file contains ONLY the scraped rows — this matches the
// production catalogue, where service_catalog was wiped and re-seeded from
// scratch with the scraped data. Pass --with-master to include the legacy
// 3,417-row master CSV (master wins on ServiceID collision).
//
// Output is read by autoImportCatalog and seed.js (both prefer v2 if present,
// fall back to v1).

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const MASTER_CSV = 'oman_services_directory.csv';
const OUT_CSV    = 'oman_services_directory_v2.csv';
const MINISTRY_CSVS = [
  'scripts/mm_scrape/mm_services.csv',
  'scripts/moc_scrape/moc_services.csv',
  'scripts/moh_scrape/moh_services.csv',
  'scripts/mohup_scrape/mohup_services.csv',
  'scripts/mol_scrape/mol_services.csv',
  'scripts/mtcit_scrape/mtcit_services.csv',
  'scripts/rop_scrape/rop_services.csv'
];
const EXPECTED_COLS = 32;

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (arr) => arr.map(csvCell).join(',');

async function readCsv(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch { return null; }
  const rows = parse(raw, { columns: false, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0], rows: rows.slice(1) };
}

const includeMaster = process.argv.includes('--with-master');

// Header always matches the canonical 32-column schema. We pull it from the
// master CSV when included, otherwise from the first scraped CSV (which all
// share the same schema).
const HEADER_FALLBACK = [
  'ServiceID','ServiceNameAr','ServiceNameEn','EntityAr','EntityEn','EntityID',
  'EntityDepartmentAr','EntityDepartmentEn','Beneficiary','MainService',
  'DescriptionAr','DescriptionEn','SpecialConditionsAr','SpecialConditionsEn',
  'RequiredDocumentsAr','RequiredDocumentsEn','FeesAr','FeesEn','PaymentMethod',
  'AvgTimeTakenAr','AvgTimeTakenEn','WorkingTimeAr','WorkingTimeEn',
  'Channels','InputChannelOthers','CustomerCarePhone','Website',
  'ProcessStepsAr','ProcessStepsEn','NumSteps','AudienceVisitCount','ServiceURL'
];
let HEADER = HEADER_FALLBACK;
const all = [];
const seen = new Set();
const stats = { master: 0, ministries: {}, dups: 0, malformed: 0 };

if (includeMaster) {
  const master = await readCsv(MASTER_CSV);
  if (!master) { console.error(`✗ master CSV not found at ${MASTER_CSV}`); process.exit(1); }
  if (master.header.length !== EXPECTED_COLS) {
    console.error(`✗ master CSV has ${master.header.length} columns, expected ${EXPECTED_COLS}`);
    process.exit(1);
  }
  HEADER = master.header;
  for (const r of master.rows) {
    if (r.length !== EXPECTED_COLS) { stats.malformed++; while (r.length < EXPECTED_COLS) r.push(''); r.length = EXPECTED_COLS; }
    const id = r[0];
    if (!id) continue;
    seen.add(id);
    all.push(r);
    stats.master++;
  }
} else {
  console.log('  · master CSV: skipped (use --with-master to include)');
}

for (const csvPath of MINISTRY_CSVS) {
  const code = path.basename(path.dirname(csvPath)).replace('_scrape', '');
  const data = await readCsv(csvPath);
  if (!data) { console.log(`  · ${code}: ${csvPath} not found, skipping`); continue; }
  let kept = 0, dup = 0;
  for (const r of data.rows) {
    if (r.length !== EXPECTED_COLS) { stats.malformed++; while (r.length < EXPECTED_COLS) r.push(''); r.length = EXPECTED_COLS; }
    const id = r[0];
    if (!id) continue;
    if (seen.has(id)) { dup++; continue; }
    seen.add(id);
    all.push(r);
    kept++;
  }
  stats.ministries[code] = kept;
  stats.dups += dup;
  if (dup) console.log(`  · ${code}: ${dup} duplicate ServiceID(s) skipped (master wins)`);
}

const lines = [csvRow(HEADER)];
for (const r of all) lines.push(csvRow(r));
await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');

const total = stats.master + Object.values(stats.ministries).reduce((a, b) => a + b, 0);
console.log(`\n=== Merge summary ===`);
console.log(`  master:     ${stats.master}`);
for (const [k, v] of Object.entries(stats.ministries)) console.log(`  ${k.padEnd(10)}${v}`);
console.log(`  duplicates: ${stats.dups} (skipped)`);
console.log(`  malformed:  ${stats.malformed} (padded/truncated to ${EXPECTED_COLS} cols)`);
console.log(`  total:      ${total}`);
console.log(`\n✓ wrote ${OUT_CSV} (${total + 1} lines including header)`);
