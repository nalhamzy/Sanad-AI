// Convert the 210 sanad.om services that AREN'T in our catalogue into the
// canonical 32-column CSV (scripts/sanad_om_scrape/sanad_om_services.csv)
// so the existing enrich → normalize → rebuild pipeline can ingest them.
//
// Inputs:
//   - sanad_reconciliation.json (missing_from_us list)
//   - sanad_om_pricelist_raw.json (full grouped service data with actions/fees)
//
// Output: scripts/sanad_om_scrape/sanad_om_services.csv
//
// Each row carries:
//   - sanad_om-aware ServiceID (in a fresh per-entity 10k block)
//   - Arabic name + entity verbatim from the price list (no inference)
//   - fee_omr from the "تقديم" (submit) action — that's what the citizen pays
//     to start a request through a Sanad office
//   - Empty EN fields (Claude enrichment fills these next)
//   - Empty docs (Claude enrichment generates likely list)
//   - PaymentMethod = الكتروني (Sanad portal is electronic-only)
//   - Channels = بوابة سند للخدمات الإلكترونية / Sanad e-services portal
//   - CustomerCarePhone = +968 80077000 (Sanad national hotline)
//   - ServiceURL = sanad.om public price list link

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const RECON = './sanad_reconciliation.json';
const RAW   = './scripts/sanad_om_scrape/sanad_om_pricelist_raw.json';
const OUT   = './scripts/sanad_om_scrape/sanad_om_services.csv';

// ─── Entity_no → (entity_id, name_en, service_id_block) ────────
// Existing entities in our catalogue (don't reassign id) get the next
// available service_id slot in their existing block. New entities get a
// fresh 10k block starting at 170000.
const KNOWN_ENTITIES = {
  1:  { id: 122,  ar: 'وزارة الصحة',                                  en: 'Ministry of Health',                                                  nextId: 110100 },
  2:  { id:  91,  ar: 'شرطة عمان السلطانية',                          en: 'Royal Oman Police',                                                   nextId: 140100 },
  3:  { id: 124,  ar: 'وزارة العمل',                                  en: 'Ministry of Labour',                                                  nextId: 100400 },
  11: { id: 119,  ar: 'بلدية مسقط',                                   en: 'Muscat Municipality',                                                 nextId: 160200 },
  22: { id: 127,  ar: 'وزارة النقل والاتصالات وتقنية المعلومات',      en: 'Ministry of Transport, Communications and IT',                        nextId: 130100 },
  35: { id:2210,  ar: 'وزارة الإسكان والتخطيط العمراني',              en: 'Ministry of Housing and Urban Planning',                              nextId: 150100 }
};
// New entities — Sanad's price list distinguishes them from their parent
// ministries because Sanad offices treat them as separate dispatch targets.
const NEW_ENTITIES = {
  5:  { id: 110,  ar: 'منصة عمان للأعمال',                            en: 'Oman Business Platform',                                              nextId: 120100 }, // shares MOC entity id
  6:  { id: 230,  ar: 'جريدة عمان',                                   en: 'Oman Daily Newspaper',                                                nextId: 170000 },
  7:  { id: 231,  ar: 'جريدة الرؤية',                                 en: 'Al-Roya Newspaper',                                                   nextId: 171000 },
  8:  { id: 232,  ar: 'وزارة الأوقاف والشؤون الدينية',                en: 'Ministry of Endowments and Religious Affairs',                        nextId: 172000 },
  9:  { id: 233,  ar: 'خدمات مراكز سند',                              en: 'Sanad Centres Services',                                              nextId: 173000 },
  10: { id: 234,  ar: 'كهرباء مزون',                                  en: 'Mazoon Electricity Company',                                          nextId: 174000 },
  12: { id: 235,  ar: 'صندوق الحماية الاجتماعية',                     en: 'Social Protection Fund',                                              nextId: 175000 },
  14: { id: 236,  ar: 'وزارة الثروة الزراعية والسمكية وموارد المياه', en: 'Ministry of Agriculture, Fisheries Wealth and Water Resources',       nextId: 176000 },
  15: { id: 236,  ar: 'وزارة الثروة الزراعية والسمكية وموارد المياه', en: 'Ministry of Agriculture, Fisheries Wealth and Water Resources',       nextId: 176200 }, // typo dup in source — same entity_id, separate block
  16: { id: 237,  ar: 'الادعاء العام العماني',                        en: 'Oman Public Prosecution',                                             nextId: 177000 },
  19: { id: 238,  ar: 'غرفة عمان للتجارة والصناعة',                   en: 'Oman Chamber of Commerce and Industry',                               nextId: 178000 },
  20: { id: 239,  ar: 'شركة مسقط لتوزيع الكهرباء',                    en: 'Muscat Electricity Distribution Company',                             nextId: 179000 },
  21: { id: 240,  ar: 'مسقط للتخليص والإيداع',                        en: 'Muscat Clearing and Depository',                                      nextId: 180000 },
  24: { id: 241,  ar: 'وزارة المالية',                                en: 'Ministry of Finance',                                                 nextId: 181000 },
  25: { id: 242,  ar: 'الشركة الوطنية العمانية للهندسة والاستثمار',   en: 'Omani National Engineering and Investment Company',                   nextId: 182000 },
  28: { id: 243,  ar: 'ظفار للتأمين',                                 en: 'Dhofar Insurance',                                                    nextId: 183000 },
  29: { id: 244,  ar: 'جودوبا',                                       en: 'Jodopa',                                                              nextId: 184000 },
  30: { id: 245,  ar: 'ملاءة',                                        en: 'Mala\'a',                                                             nextId: 185000 },
  31: { id: 246,  ar: 'بنك التنمية العماني',                          en: 'Oman Development Bank',                                               nextId: 186000 },
  32: { id: 247,  ar: 'المدينة تكافل',                                en: 'Al Madina Takaful',                                                   nextId: 187000 },
  36: { id: 248,  ar: 'بنك ظفار',                                     en: 'Bank Dhofar',                                                         nextId: 188000 },
  37: { id: 249,  ar: 'الشركة المتحدة للتمويل',                       en: 'United Finance Company',                                              nextId: 189000 },
  38: { id: 250,  ar: 'صفقات',                                        en: 'Safqat (Tenders Platform)',                                           nextId: 190000 }
};
const ENTITY_MAP = { ...KNOWN_ENTITIES, ...NEW_ENTITIES };

const PAYMENT = 'الكتروني';
const CHANNELS = 'بوابة سند للخدمات الإلكترونية';
const PHONE = '+968 80077000';
const SOURCE_URL = 'https://www.sanad.om/smartformsOnline/PublicSite/Home/SanadServicePriceList';

// ─── CSV writer ───────────────────────────────────────────────
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

function inferBeneficiary(entity_no, service_ar) {
  const t = service_ar || '';
  const tags = [];
  if (/شرك?ة|تجار|مؤسس|business|company|سجل تجاري|أعمال/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  if (/فرد|مواطن|الأفراد|individual|citizen|بطاقة|عقد|وفاة|ميلاد|زواج|طلاق/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (!tags.length) tags.push('من الحكومة الى الأفراد(G2C)');
  return [...new Set(tags)].join(',');
}

// ─── Main ──────────────────────────────────────────────────────
const recon = JSON.parse(await fs.readFile(RECON, 'utf8'));
const raw = JSON.parse(await fs.readFile(RAW, 'utf8'));

// missing_from_us is the 210 services we need to ADD.
const missing = recon.details.missing_from_us;
console.log(`▶ ${missing.length} services from sanad.om to convert into CSV`);

// Precompute entity_no → counter so each new row gets a unique ServiceID.
const counters = {};
for (const k of Object.keys(ENTITY_MAP)) counters[k] = ENTITY_MAP[k].nextId;

const rows = [];
const skipped = [];
for (const m of missing) {
  const ent = ENTITY_MAP[m.entity_no];
  if (!ent) { skipped.push({ entity_no: m.entity_no, service_ar: m.service_ar, reason: 'unknown_entity' }); continue; }

  const serviceId = counters[m.entity_no]++;
  // Pick the "submit" fee — that's what the citizen pays to start a request
  // through a Sanad office. Other actions (إلغاء, دفع, إعادة ارسال) are stage
  // operations on the same request; they're noted in FeesAr but the headline
  // fee_omr at parse time uses تقديم.
  const submit = m.actions.find(a => /تقديم/.test(a.action)) || m.actions[0];
  const feeOmr = submit?.fee_omr;
  // Pack all action fees into FeesAr so the import path can render the
  // full breakdown when needed. Format: "تقديم: 3 ر.ع · إلغاء: 1 ر.ع · …"
  const feesArDetail = m.actions.map(a => `${a.action}: ${a.fee_raw}`).join(' · ');

  rows.push([
    serviceId,
    m.service_ar,                       // ServiceNameAr — verbatim from sanad.om
    '',                                 // ServiceNameEn — Claude fills
    ent.ar,
    ent.en,
    ent.id,
    '', '',                             // EntityDepartmentAr/En
    inferBeneficiary(m.entity_no, m.service_ar),
    '',                                 // MainService — Claude can suggest later
    '',                                 // DescriptionAr — Claude fills
    '',                                 // DescriptionEn — Claude fills
    '', '',                             // SpecialConditionsAr/En
    '', '',                             // RequiredDocumentsAr/En — Claude fills
    feesArDetail,                        // FeesAr — full action breakdown
    '',                                 // FeesEn — Claude fills
    PAYMENT,
    '', '',                             // AvgTimeTakenAr/En
    '', '',                             // WorkingTimeAr/En
    CHANNELS, '',
    PHONE,
    'www.sanad.om',
    '', '',                             // ProcessStepsAr/En
    '', '',
    SOURCE_URL
  ]);
}

const lines = [HEADERS.join(',')];
for (const r of rows) lines.push(csvRow(r));
await fs.writeFile(OUT, lines.join('\n') + '\n', 'utf8');

console.log(`✓ wrote ${OUT}`);
console.log(`  rows: ${rows.length}, skipped: ${skipped.length}`);
console.log('\nPer-entity breakdown:');
const counts = {};
for (const r of rows) counts[r[5]] = (counts[r[5]] || 0) + 1;
for (const [eid, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const ent = Object.values(ENTITY_MAP).find(e => e.id === Number(eid));
  console.log(`  entity_id=${eid}  ${ent?.en || '?'}  ${ent?.ar || ''}  · ${n} services`);
}
if (skipped.length) {
  console.log('\nSkipped:');
  for (const s of skipped) console.log(`  entity_no=${s.entity_no} · ${s.service_ar.slice(0,50)} · ${s.reason}`);
}
