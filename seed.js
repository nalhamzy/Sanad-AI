// One-shot importer: oman_services_directory.csv → service_catalog.
// Safe to re-run (uses ServiceID as primary key).

import 'dotenv/config';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { db, migrate } from './lib/db.js';

const CSV_PATH = './oman_services_directory.csv';

function splitDocs(txt) {
  if (!txt) return [];
  // The CSV uses " . " or newline-ish separators. Normalise.
  return txt
    .split(/\s+\.\s+|•|·|;|—/g)
    .map(s => s.replace(/^[\-\s,]+|[\-\s,]+$/g, '').trim())
    .filter(s => s.length >= 2 && s.length < 200);
}

function parseFee(en, ar) {
  const s = (en || ar || '').toLowerCase();
  if (/no fees?|free|لا يوجد/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(omr|ريال)/);
  return m ? Number(m[1]) : null;
}

function slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found at ${CSV_PATH}`);
    process.exit(1);
  }
  await migrate();

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  console.log(`Parsed ${rows.length} rows from CSV.`);

  let imported = 0;
  for (const r of rows) {
    const id = Number(r.ServiceID);
    if (!id) continue;
    const docsEn = splitDocs(r.RequiredDocumentsEn);
    const docsList = docsEn.map(d => ({ code: slug(d).slice(0, 40), label_en: d, label_ar: '', accept: ['image', 'pdf'] }));
    const fee = parseFee(r.FeesEn, r.FeesAr);
    await db.execute({
      sql: `INSERT OR REPLACE INTO service_catalog
             (id, entity_en, entity_ar, name_en, name_ar, description_en, description_ar,
              fees_text, fee_omr, required_documents_json, process_steps_json, is_active, version, source_url)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        (r.EntityEn || '').trim(), (r.EntityAr || '').trim(),
        (r.ServiceNameEn || '').trim(), (r.ServiceNameAr || '').trim(),
        (r.DescriptionEn || '').trim().slice(0, 1000),
        (r.DescriptionAr || '').trim().slice(0, 1000),
        (r.FeesEn || '').trim().slice(0, 200),
        fee,
        JSON.stringify(docsList),
        JSON.stringify([]),
        1, 1,
        (r.ServiceURL || '').trim()
      ]
    });
    imported++;
    if (imported % 200 === 0) console.log(`  ${imported}…`);
  }

  // Rebuild FTS
  await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
  console.log(`✓ Imported ${imported} services. FTS rebuilt.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
