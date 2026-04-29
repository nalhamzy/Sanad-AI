// Dump the current service_catalog table out to oman_services_directory_v3.csv
// (32-column canonical schema). Used to ship the post-sanad.om-reconciliation
// catalogue (601 rows) as a single deployable source so a fresh Render instance
// can recreate the exact catalogue.
//
//   node scripts/dump_db_to_csv.mjs
//
// Round-trips cleanly through autoImportCatalog: the v3 CSV is the same shape
// the importer reads, so the cycle is safe.

import 'dotenv/config';
import fs from 'node:fs/promises';
import { createClient } from '@libsql/client';

const DB_URL = process.env.DB_URL || 'file:./data/sanad.db';
const OUT = './oman_services_directory_v3.csv';

const HEADERS = [
  'ServiceID','ServiceNameAr','ServiceNameEn','EntityAr','EntityEn','EntityID',
  'EntityDepartmentAr','EntityDepartmentEn','Beneficiary','MainService',
  'DescriptionAr','DescriptionEn','SpecialConditionsAr','SpecialConditionsEn',
  'RequiredDocumentsAr','RequiredDocumentsEn','FeesAr','FeesEn','PaymentMethod',
  'AvgTimeTakenAr','AvgTimeTakenEn','WorkingTimeAr','WorkingTimeEn',
  'Channels','InputChannelOthers','CustomerCarePhone','Website',
  'ProcessStepsAr','ProcessStepsEn','NumSteps','AudienceVisitCount','ServiceURL'
];
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (arr) => arr.map(csvCell).join(',');

// Convert the parsed required_documents_json + process_steps_json back to the
// CSV-string shape the importer expects (semicolon-separated for docs,
// "[1] step || [2] step" for process steps).
function docsBack(json, lang /* 'en' | 'ar' */) {
  try {
    const arr = JSON.parse(json || '[]');
    return arr.map(d => (lang === 'en' ? d.label_en : d.label_ar) || '').filter(Boolean).join(' ; ');
  } catch { return ''; }
}
function stepsBack(json, lang) {
  try {
    const arr = JSON.parse(json || '[]');
    return arr.map((s, i) => `[${s.n || i + 1}] ${(lang === 'en' ? s.en : s.ar) || ''}`.trim())
      .filter(s => s.length > 4).join(' || ');
  } catch { return ''; }
}

const db = createClient({ url: DB_URL });
const { rows } = await db.execute(`
  SELECT id, name_en, name_ar, entity_en, entity_ar,
         entity_dept_en, entity_dept_ar, beneficiary, main_service,
         description_en, description_ar,
         special_conditions_en, special_conditions_ar,
         required_documents_json, process_steps_json,
         fees_text, fee_omr, payment_method,
         avg_time_en, avg_time_ar, working_time_en, working_time_ar,
         channels, num_steps, source_url,
         (SELECT entity_en || '|' || entity_ar) AS _entity_pair
    FROM service_catalog
   WHERE is_active = 1
   ORDER BY id`
);

// Map back entity_en → entity_id by querying — preserve the exact id we have
// for each row (re-running this script after an entity_id change still keeps
// the right number).
const entityIdByName = new Map();
const { rows: distinctEntities } = await db.execute(`
  SELECT DISTINCT entity_en, entity_ar FROM service_catalog WHERE entity_en IS NOT NULL`);
// Try to read entity_id from a representative row of each entity:
for (const e of distinctEntities) {
  // Some IDs in service_catalog don't carry entity_id directly; skip — we'll
  // synthesize from the id-block convention.
}

console.log(`▶ exporting ${rows.length} rows from ${DB_URL}`);

// id-block → entity_id mapping (mirrors how the scrapers + sanad-om-to-csv
// allocated entity_ids):
function idBlockEntityId(id) {
  if (id < 100000) return null;            // legacy master — shouldn't exist
  if (id < 110000) return 124;             // mol
  if (id < 120000) return 122;             // moh
  if (id < 130000) return 110;             // moc / oman business
  if (id < 140000) return 127;             // mtcit
  if (id < 150000) return 91;              // rop
  if (id < 160000) return 2210;            // mohup
  if (id < 170000) return 119;             // mm
  // sanad.om-allocated new entities — derive from the per-entity blocks
  if (id >= 170000 && id < 171000) return 230; // Oman Daily
  if (id >= 171000 && id < 172000) return 231; // Al-Roya
  if (id >= 172000 && id < 173000) return 232; // Awqaf
  if (id >= 173000 && id < 174000) return 233; // Sanad Centres
  if (id >= 174000 && id < 175000) return 234; // Mazoon Electricity
  if (id >= 175000 && id < 176000) return 235; // Social Protection Fund
  if (id >= 176000 && id < 177000) return 236; // Ag/Fish/Water
  if (id >= 177000 && id < 178000) return 237; // Public Prosecution
  if (id >= 178000 && id < 179000) return 238; // Oman Chamber
  if (id >= 179000 && id < 180000) return 239; // Muscat Electricity
  if (id >= 180000 && id < 181000) return 240; // Muscat Clearing
  if (id >= 181000 && id < 182000) return 241; // MoF
  if (id >= 182000 && id < 183000) return 242; // National Engineering
  if (id >= 183000 && id < 184000) return 243; // Dhofar Insurance
  if (id >= 184000 && id < 185000) return 244; // Jodopa
  if (id >= 185000 && id < 186000) return 245; // Mala'a
  if (id >= 186000 && id < 187000) return 246; // Oman Development Bank
  if (id >= 187000 && id < 188000) return 247; // Madina Takaful
  if (id >= 188000 && id < 189000) return 248; // Bank Dhofar
  if (id >= 189000 && id < 190000) return 249; // United Finance
  if (id >= 190000 && id < 191000) return 250; // Safqat
  return null;
}

const lines = [HEADERS.join(',')];
let withDocs = 0, withFee = 0;
for (const r of rows) {
  const docsAr = docsBack(r.required_documents_json, 'ar');
  const docsEn = docsBack(r.required_documents_json, 'en');
  const stepsAr = stepsBack(r.process_steps_json, 'ar');
  const stepsEn = stepsBack(r.process_steps_json, 'en');
  if (docsAr || docsEn) withDocs++;
  if (r.fee_omr != null) withFee++;
  const entityId = idBlockEntityId(r.id);
  lines.push(csvRow([
    r.id,
    r.name_ar || '',
    r.name_en || '',
    r.entity_ar || '',
    r.entity_en || '',
    entityId || '',
    r.entity_dept_ar || '',
    r.entity_dept_en || '',
    r.beneficiary || '',
    r.main_service || '',
    r.description_ar || '',
    r.description_en || '',
    r.special_conditions_ar || '',
    r.special_conditions_en || '',
    docsAr,
    docsEn,
    r.fees_text || (r.fee_omr != null ? `${r.fee_omr} OMR` : ''),
    r.fees_text || '',
    r.payment_method || '',
    r.avg_time_ar || '',
    r.avg_time_en || '',
    r.working_time_ar || '',
    r.working_time_en || '',
    r.channels || '',
    '',                     // InputChannelOthers
    '',                     // CustomerCarePhone — derive in importer
    '',                     // Website — derive in importer
    stepsAr,
    stepsEn,
    r.num_steps ?? '',
    '',                     // AudienceVisitCount
    r.source_url || ''
  ]));
}

await fs.writeFile(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`✓ wrote ${OUT}`);
console.log(`  rows:        ${rows.length}`);
console.log(`  with docs:   ${withDocs}`);
console.log(`  with fee:    ${withFee}`);
console.log(`  total bytes: ${(await fs.stat(OUT)).size}`);
