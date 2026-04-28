// Scrape Royal Oman Police (ROP) services → CSV matching the existing
// oman_services_directory.csv schema (32 columns).
//
// Source: https://www.rop.gov.om/arabic/{ServicePage}.aspx
// (31 unique service pages discovered via Google site:rop.gov.om/arabic).
// Each AR page has an EN twin at /english/{ServicePage}.aspx with parallel
// h2 section structure.
//
// Run: node scripts/rop_scrape/scrape.mjs
// Output: scripts/rop_scrape/rop_services.csv (+ rop_services_raw.json)

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/rop_scrape';
const TSV = path.join(ROOT, 'services.tsv');
const OUT_CSV = path.join(ROOT, 'rop_services.csv');
const ENTITY_ID = 91;
const ENTITY_AR = 'شرطة عمان السلطانية';
const ENTITY_EN = 'Royal Oman Police';
const BASE_ID = 140000;

// ─── HTML helpers ────────────────────────────────────────────
const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ─── Parser ──────────────────────────────────────────────────
function parseRopPage(html) {
  const out = {};
  // Title is the FIRST h2 inside the main service block (h1 is generic ROP brand).
  // Strategy: collect all h2's + the content between each pair (until next h2).
  const sections = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|<\/main>|<footer|<\/body)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = stripTags(m[1]);
    const body = stripTags(m[2]).slice(0, 1500);
    if (!label || label.length > 200) continue;
    sections.push({ label, body });
  }
  out.sections = sections;

  // Service title — first h2 (skip menu/utility entries)
  const skipFirst = /^(الصفحة|اختر|menu|home|navigation|search)/i;
  const titleSec = sections.find(s => !skipFirst.test(s.label) && s.label.length < 120);
  out.title = titleSec ? titleSec.label : '';

  return out;
}

function pickSection(sections, ...labels) {
  for (const l of labels) {
    for (const s of sections) {
      if (s.label === l || s.label.includes(l) || l.includes(s.label)) return s.body;
    }
  }
  return '';
}

// ─── Fetch ────────────────────────────────────────────────────
async function fetchHtml(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)', 'Accept': 'text/html', 'Accept-Language': 'ar,en;q=0.9' },
        redirect: 'follow'
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, finalUrl: r.url, text };
    } catch (e) {
      if (i === attempts - 1) return { ok: false, status: 0, finalUrl: url, text: '', err: e.message };
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function pool(items, workerN, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: workerN }, worker));
  return out;
}

// ─── Per-service scrape ──────────────────────────────────────
async function scrapeOne({ arPath, googleTitle }, idx) {
  const arUrl = 'https://www.rop.gov.om' + arPath;
  const enUrl = arUrl.replace('/arabic/', '/english/');

  const [arRes, enRes] = await Promise.all([fetchHtml(arUrl), fetchHtml(enUrl)]);
  if (!arRes.ok || arRes.text.length < 3000) {
    return { idx, arPath, arUrl, error: `ar fetch failed (status=${arRes.status})` };
  }
  const arP = parseRopPage(arRes.text);
  const enP = enRes.ok && enRes.text.length > 3000 ? parseRopPage(enRes.text) : null;

  // Map AR sections to schema fields
  const sA = arP.sections;
  const sE = enP?.sections || [];
  return {
    idx, arPath, arUrl, enUrl,
    arOk: !!arP.title,
    enOk: !!enP?.title,
    titleAr: arP.title || googleTitle,
    titleEn: enP?.title || '',
    descAr: pickSection(sA, 'وصف الخدمة', 'الوصف', 'نبذة عن الخدمة'),
    descEn: pickSection(sE, 'Description', 'Service Description', 'About the Service'),
    condAr: pickSection(sA, 'الشروط الواجبة للحصول على الخدمة', 'الشروط', 'شروط الخدمة'),
    condEn: pickSection(sE, 'Conditions', 'Service Conditions', 'Eligibility'),
    docsAr: pickSection(sA, 'المستندات المطلوبة', 'الوثائق المطلوبة', 'المستندات'),
    docsEn: pickSection(sE, 'Required Documents', 'Documents'),
    feesAr: pickSection(sA, 'رسوم الخدمة', 'الرسوم'),
    feesEn: pickSection(sE, 'Fees', 'Service Fees'),
    stepsAr: pickSection(sA, 'إجراءات الخدمــــة', 'إجراءات الخدمة', 'الإجراءات', 'خطوات الخدمة'),
    stepsEn: pickSection(sE, 'Procedures', 'Service Procedures', 'Steps'),
    timeAr: pickSection(sA, 'مدة الخدمة', 'مدة تقديم الخدمة', 'المدة'),
    timeEn: pickSection(sE, 'Service Duration', 'Duration', 'Time'),
    rawSectionsAr: sA.map(s => s.label),
    rawSectionsEn: sE.map(s => s.label)
  };
}

const NOTE_AR = 'لم يُستخرج هذا الحقل تلقائياً من موقع شرطة عمان السلطانية؛ يرجى التحقق يدوياً من رابط الخدمة قبل الإدراج.';
const NOTE_EN = 'Not auto-extracted from rop.gov.om; please verify manually via the service URL before catalogue insertion.';

function nz(v, n) { return (v && String(v).trim().length > 5) ? v : n; }

function inferBeneficiary(text) {
  const t = String(text || '');
  const tags = [];
  if (/مؤسس|شركة|business|company|institution|منشآت|معرض|سفينة|تجاري|نفط|غاز/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  if (/مواطن|أفراد|سائق|individual|public|citizen|driver|passport|visit/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (!tags.length) tags.push('من الحكومة الى الأفراد(G2C)');
  return [...new Set(tags)].join(',');
}

// ─── CSV helpers ─────────────────────────────────────────────
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (arr) => arr.map(csvCell).join(',');
const HEADERS = [
  'ServiceID','ServiceNameAr','ServiceNameEn','EntityAr','EntityEn','EntityID',
  'EntityDepartmentAr','EntityDepartmentEn','Beneficiary','MainService',
  'DescriptionAr','DescriptionEn','SpecialConditionsAr','SpecialConditionsEn',
  'RequiredDocumentsAr','RequiredDocumentsEn','FeesAr','FeesEn','PaymentMethod',
  'AvgTimeTakenAr','AvgTimeTakenEn','WorkingTimeAr','WorkingTimeEn',
  'Channels','InputChannelOthers','CustomerCarePhone','Website',
  'ProcessStepsAr','ProcessStepsEn','NumSteps','AudienceVisitCount','ServiceURL'
];

function buildRow(r, idx) {
  const benef = inferBeneficiary(r.titleAr + ' ' + r.titleEn + ' ' + r.descAr);
  return [
    BASE_ID + idx,
    r.titleAr, r.titleEn,
    ENTITY_AR, ENTITY_EN, ENTITY_ID,
    '', '', benef, '',
    nz(r.descAr, NOTE_AR), nz(r.descEn, NOTE_EN),
    nz(r.condAr, NOTE_AR), nz(r.condEn, NOTE_EN),
    nz(r.docsAr, NOTE_AR), nz(r.docsEn, NOTE_EN),
    nz(r.feesAr, NOTE_AR), nz(r.feesEn, NOTE_EN),
    'الكتروني',
    nz(r.timeAr, NOTE_AR), nz(r.timeEn, NOTE_EN),
    '', '',
    'الموقع الإلكتروني', '',
    '+968 24569999', 'www.rop.gov.om',
    nz(r.stepsAr, NOTE_AR), nz(r.stepsEn, NOTE_EN),
    '', '',
    r.arUrl
  ];
}

// ─── Main ────────────────────────────────────────────────────
const tsv = await fs.readFile(TSV, 'utf8');
const services = tsv.trim().split(/\r?\n/).slice(1)
  .map(line => {
    const [arPath, googleTitle] = line.split(/\t/);
    return { arPath: arPath?.trim(), googleTitle: googleTitle?.trim() };
  })
  .filter(s => s.arPath);

console.log(`▶ scraping ${services.length} ROP service pages (8 concurrent, AR + EN twins)`);
const t0 = Date.now();
const results = await pool(services, 8, async (s, idx) => {
  const r = await scrapeOne(s, idx);
  if (r.error) {
    console.log(`  [${String(idx + 1).padStart(2)}/${services.length}] ✗ ${r.error}  | ${s.arPath}`);
  } else {
    console.log(`  [${String(idx + 1).padStart(2)}/${services.length}] ar=${r.arOk ? '✓' : '✗'} en=${r.enOk ? '✓' : '·'} "${(r.titleAr || '').slice(0, 60)}"`);
  }
  return r;
});
console.log(`▶ done in ${Date.now() - t0}ms`);

const lines = [HEADERS.join(',')];
let kept = 0;
const skipped = [];
results.forEach((rec, i) => {
  if (rec.error) { skipped.push({ i, err: rec.error, p: services[i].arPath }); return; }
  if (!rec.titleAr) { skipped.push({ i, err: 'no title', p: services[i].arPath }); return; }
  lines.push(csvRow(buildRow(rec, i)));
  kept++;
});

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(path.join(ROOT, 'rop_services_raw.json'), JSON.stringify(results, null, 2), 'utf8');

const cov = (k, mk = 5) => results.filter(r => r[k] && String(r[k]).length > mk).length;
console.log(`\n=== Coverage ===`);
console.log(`  rows kept:        ${kept} / ${results.length}`);
console.log(`  AR title:         ${cov('titleAr', 2)} / ${results.length}`);
console.log(`  EN title:         ${cov('titleEn', 2)} / ${results.length}`);
console.log(`  AR description:   ${cov('descAr')} / ${results.length}`);
console.log(`  EN description:   ${cov('descEn')} / ${results.length}`);
console.log(`  AR conditions:    ${cov('condAr')} / ${results.length}`);
console.log(`  AR documents:     ${cov('docsAr')} / ${results.length}`);
console.log(`  AR fees:          ${cov('feesAr')} / ${results.length}`);
console.log(`  AR steps:         ${cov('stepsAr')} / ${results.length}`);
if (skipped.length) {
  console.log(`\n=== Skipped (${skipped.length}) ===`);
  for (const s of skipped) console.log(`  [${s.i}] ${s.err}: ${s.p}`);
}
console.log(`\n✓ ${OUT_CSV}`);
