// Normalize scraped ministry CSVs in place so they are safe to import into
// service_catalog. Idempotent.
//
//   node scripts/normalize_scraped.mjs                    # all six
//   node scripts/normalize_scraped.mjs --ministry rop     # one only
//
// Per-cell transforms applied to every cell of every row:
//   1. NOTE strip       — cells containing the "field not auto-extracted"
//      placeholder (AR or EN, any of the three known variants) are blanked.
//   2. JS leak strip    — cells containing the leaked readspeaker <script>
//      block (MOC) are blanked.
//   3. Phone normalize  — CustomerCarePhone → "+968 XXXXXXXX" (last 8 digits).
//   4. List separator   — for Documents/Conditions cells that look like a
//      ", "-joined enumeration, swap to "; " so _splitDocs() picks them up.
//   5. ROP step format  — wrap a single non-empty step prose as "[1] {prose}"
//      so _parseProcessSteps() yields a clean 1-step JSON.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const MINISTRIES = [
  { code: 'mm',    dir: 'scripts/mm_scrape',    csv: 'mm_services.csv',    entityId: 119 },
  { code: 'moc',   dir: 'scripts/moc_scrape',   csv: 'moc_services.csv',   entityId: 110 },
  { code: 'moh',   dir: 'scripts/moh_scrape',   csv: 'moh_services.csv',   entityId: 122 },
  { code: 'mohup', dir: 'scripts/mohup_scrape', csv: 'mohup_services.csv', entityId: 2210 },
  { code: 'mol',   dir: 'scripts/mol_scrape',   csv: 'mol_services.csv',   entityId: 124 },
  { code: 'mtcit', dir: 'scripts/mtcit_scrape', csv: 'mtcit_services.csv', entityId: 127 },
  { code: 'rop',   dir: 'scripts/rop_scrape',   csv: 'rop_services.csv',   entityId: 91 }
];

// NOTE substrings that signal "field not auto-extracted" placeholders.
// Substring (not whole-cell) match so trimming/whitespace differences are tolerated.
const NOTE_PATTERNS = [
  'لم يُستخرج هذا الحقل تلقائياً',  // AR — covers all three known variants
  'Not auto-extracted'              // EN — covers all three known variants
];

// Substrings that flag leaked <script> content from the MOC scraper.
const JS_LEAK_PATTERNS = [
  'readspeakerButton',
  "document.getElementById(",
  'document.querySelector('
];

const HEADERS = [
  'ServiceID','ServiceNameAr','ServiceNameEn','EntityAr','EntityEn','EntityID',
  'EntityDepartmentAr','EntityDepartmentEn','Beneficiary','MainService',
  'DescriptionAr','DescriptionEn','SpecialConditionsAr','SpecialConditionsEn',
  'RequiredDocumentsAr','RequiredDocumentsEn','FeesAr','FeesEn','PaymentMethod',
  'AvgTimeTakenAr','AvgTimeTakenEn','WorkingTimeAr','WorkingTimeEn',
  'Channels','InputChannelOthers','CustomerCarePhone','Website',
  'ProcessStepsAr','ProcessStepsEn','NumSteps','AudienceVisitCount','ServiceURL'
];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i]));

const containsAny = (s, list) => {
  if (!s) return false;
  for (const p of list) if (s.includes(p)) return true;
  return false;
};

function stripNote(cell) {
  return containsAny(cell, NOTE_PATTERNS) ? '' : cell;
}
function stripJsLeak(cell) {
  return containsAny(cell, JS_LEAK_PATTERNS) ? '' : cell;
}

function normalizePhone(cell) {
  if (!cell) return '';
  const digits = String(cell).replace(/\D/g, '');
  if (digits.length < 8) return ''; // garbage (e.g. text in phone column)
  return '+968 ' + digits.slice(-8);
}

// Convert ", " enumerations to "; " so _splitDocs picks them up.
// Only act when the cell looks like an enumeration: ≥2 commas and no other
// supported separator already present.
function normalizeListSeparators(cell) {
  if (!cell) return '';
  const commas = (cell.match(/,/g) || []).length;
  if (commas < 2) return cell;
  if (/[;•·—\n]/.test(cell)) return cell;
  return cell.replace(/,\s*/g, '; ');
}

// Wrap single-prose ROP steps as "[1] {prose}" so _parseProcessSteps yields
// a 1-step array. Only run on ROP rows (EntityID === 91) and only when the
// cell is non-empty and lacks the "||" multi-step delimiter.
function normalizeRopSteps(cell, entityId) {
  if (entityId !== 91) return cell;
  if (!cell) return '';
  if (cell.includes('||')) return cell;
  if (/^\s*\[\d+\]/.test(cell)) return cell;
  return `[1] ${cell.trim()}`;
}

// ─── CSV writer (mirrors the per-scraper helper) ────────────────
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (arr) => arr.map(csvCell).join(',');

async function normalizeOne({ code, dir, csv, entityId }) {
  const csvPath = path.join(dir, csv);
  let raw;
  try { raw = await fs.readFile(csvPath, 'utf8'); }
  catch { console.log(`  · ${code}: ${csvPath} not found, skipping`); return null; }

  const rows = parse(raw, { columns: false, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  if (!rows.length) { console.log(`  · ${code}: empty CSV`); return null; }

  // Drop the existing header — we always re-emit ours so any drift is fixed.
  if (rows[0][0] === 'ServiceID') rows.shift();

  const stats = { total: rows.length, noteStripped: 0, jsStripped: 0, phoneFixed: 0, listFixed: 0, ropSteps: 0, malformed: 0 };

  const out = [HEADERS.join(',')];
  for (const r of rows) {
    if (r.length !== 32) {
      stats.malformed++;
      // Pad/truncate to 32 columns rather than dropping; the scrapers always
      // emit 32 columns, so a length mismatch is usually a CSV-quoting bug.
      while (r.length < 32) r.push('');
      r.length = 32;
    }

    const cleaned = r.map((cell, idx) => {
      let v = String(cell ?? '');
      const before = v;

      const beforeNote = v;
      v = stripNote(v);
      if (v !== beforeNote) stats.noteStripped++;

      const beforeJs = v;
      v = stripJsLeak(v);
      if (v !== beforeJs) stats.jsStripped++;

      if (idx === COL.CustomerCarePhone) {
        const before = v;
        v = normalizePhone(v);
        if (v !== before) stats.phoneFixed++;
      }

      if (idx === COL.RequiredDocumentsAr || idx === COL.RequiredDocumentsEn ||
          idx === COL.SpecialConditionsAr || idx === COL.SpecialConditionsEn) {
        const before = v;
        v = normalizeListSeparators(v);
        if (v !== before) stats.listFixed++;
      }

      if (idx === COL.ProcessStepsAr || idx === COL.ProcessStepsEn) {
        const before = v;
        v = normalizeRopSteps(v, entityId);
        if (v !== before) stats.ropSteps++;
      }

      return v;
    });

    out.push(csvRow(cleaned));
  }

  await fs.writeFile(csvPath, out.join('\n') + '\n', 'utf8');
  return { code, csvPath, ...stats };
}

// ─── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
let target = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ministry') target = args[i + 1];
}
const list = target ? MINISTRIES.filter(m => m.code === target) : MINISTRIES;
if (!list.length) {
  console.error(`No ministry matches "${target}". Known: ${MINISTRIES.map(m => m.code).join(', ')}`);
  process.exit(1);
}

console.log(`▶ normalizing ${list.length} ministry CSV(s)`);
const results = [];
for (const m of list) {
  const r = await normalizeOne(m);
  if (r) results.push(r);
}

console.log(`\n=== Per-ministry stats ===`);
console.log('  code   rows   note   js   phone   list   rop    malformed');
for (const r of results) {
  const pad = (s, n) => String(s).padStart(n);
  console.log(`  ${r.code.padEnd(6)} ${pad(r.total, 4)}  ${pad(r.noteStripped, 5)} ${pad(r.jsStripped, 4)}  ${pad(r.phoneFixed, 5)}  ${pad(r.listFixed, 5)}  ${pad(r.ropSteps, 4)}     ${pad(r.malformed, 3)}`);
}
console.log(`\n✓ normalized ${results.length} CSV(s) in place`);
