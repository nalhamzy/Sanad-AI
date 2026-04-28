// Scrape MTCIT (Ministry of Transport, Communications & IT) services →
// CSV matching oman_services_directory.csv (32 columns).
//
// MTCIT pages (mtcit.gov.om/ar/5/13/92/{id}) load the body via JavaScript
// after page-load, so plain fetch() only sees the SSR shell. We use
// playwright-core + headless Chromium to render the page, then extract
// description / conditions / docs / fees / steps from the rendered DOM.
//
// Naql.om services are added from a hand-curated list (their actual flows
// are login-gated; we capture the public-facing service names + descriptions).
//
// Run: node scripts/mtcit_scrape/scrape.mjs
// Setup once:
//   npm install
//   npx playwright install chromium

import fs from 'node:fs/promises';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('✗ playwright-core not installed. Run:\n    npm install\n    npx playwright install chromium');
  process.exit(1);
}

const ROOT = 'scripts/mtcit_scrape';
const IDS_TSV = path.join(ROOT, 'ids.tsv');
const OUT_CSV = path.join(ROOT, 'mtcit_services.csv');
const RAW_JSON = path.join(ROOT, 'mtcit_services_raw.json');
const ENTITY_ID = 127;
const ENTITY_AR = 'وزارة النقل والاتصالات وتقنية المعلومات';
const ENTITY_EN = 'Ministry of Transport, Communications and IT';
const BASE_ID = 130000;
const PAGE_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 60_000;

const slugToTitle = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

// ─── DOM extraction (runs inside the page) ──────────────────────
// Pulls the labelled service-content sections by Arabic/English heading
// match. Returns plain strings; the caller tags AR vs EN by which page is
// being scraped.
function extractInPage() {
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  const title = text(document.querySelector('h1, .service-title, .page-title, .o_blog_post_title')) || (document.title || '').replace(/\|\s*MTCIT\s*$/i, '').trim();
  const lead = text(document.querySelector('main p, article p, .o_blog_post_content p, .service-description'));

  // Section labels we care about (AR + EN twins)
  const SECTIONS = {
    description: ['وصف الخدمة', 'نبذة عن الخدمة', 'Service Description', 'About the Service', 'Description'],
    conditions:  ['الشروط', 'شروط الخدمة', 'الاشتراطات', 'Conditions', 'Service Conditions', 'Terms'],
    documents:   ['المستندات المطلوبة', 'المتطلبات', 'Required Documents', 'Documents'],
    fees:        ['الرسوم', 'رسوم الخدمة', 'Fees', 'Service Fees'],
    duration:    ['مدة الإنجاز', 'مدة إنجاز الخدمة', 'Service Duration', 'Duration', 'Completion Period'],
    steps:       ['إجراءات الخدمة', 'الخطوات', 'مراحل الخدمة', 'Procedures', 'Service Steps', 'Steps']
  };

  // Find the heading element whose text contains any of the labels, then
  // collect the text nodes that follow until the next heading.
  function pickSection(labels) {
    const headings = all('h1, h2, h3, h4, .section-title, .o_blog_post_content h2, .o_blog_post_content h3');
    for (const h of headings) {
      const t = text(h);
      if (!t) continue;
      if (!labels.some(L => t.includes(L))) continue;
      // Walk siblings until next heading
      const parts = [];
      let n = h.nextElementSibling;
      while (n) {
        if (/^H[1-4]$/.test(n.tagName)) break;
        const inner = text(n);
        if (inner) parts.push(inner);
        n = n.nextElementSibling;
        if (parts.join(' ').length > 4000) break;
      }
      if (parts.length) return parts.join(' \n ').trim();
    }
    return '';
  }

  return {
    title,
    description: pickSection(SECTIONS.description) || lead,
    conditions:  pickSection(SECTIONS.conditions),
    documents:   pickSection(SECTIONS.documents),
    fees:        pickSection(SECTIONS.fees),
    duration:    pickSection(SECTIONS.duration),
    steps:       pickSection(SECTIONS.steps),
    // EN URL via <link hreflang=en>
    enUrl: (document.querySelector('link[rel="alternate"][hreflang="en"]') || {}).href || ''
  };
}

// Steps prose like "1. step 2. step" → array of {n, step}.
function parseStepsText(text) {
  if (!text) return [];
  const splits = text.split(/(?:^|\s)(\d+)\s*[.\-)–]\s*/u).slice(1);
  const out = [];
  for (let i = 0; i < splits.length; i += 2) {
    const n = splits[i];
    const step = (splits[i + 1] || '').trim().replace(/\s+/g, ' ');
    if (step && step.length > 3) out.push({ n, step: step.slice(0, 500) });
  }
  if (out.length === 0 && text.length > 10) out.push({ n: '1', step: text.slice(0, 500) });
  return out;
}

// ─── Per-service scrape ─────────────────────────────────────────
async function scrapeOne(context, { id, googleTitle }, idx, total) {
  const arUrl = `https://mtcit.gov.om/ar/5/13/92/${id}`;
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  const rec = { idx, id, googleTitle, arUrl, enUrl: '', titleAr: '', titleEn: '', descAr: '', descEn: '', condAr: '', condEn: '', docsAr: '', docsEn: '', feesAr: '', feesEn: '', durAr: '', durEn: '', stepsAr: [], stepsEn: [] };

  try {
    await page.goto(arUrl, { waitUntil: 'domcontentloaded' });
    // Settle: try networkidle but don't fail if the page keeps polling.
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
    const ar = await page.evaluate(extractInPage);
    rec.titleAr = ar.title || googleTitle;
    rec.descAr  = ar.description;
    rec.condAr  = ar.conditions;
    rec.docsAr  = ar.documents;
    rec.feesAr  = ar.fees;
    rec.durAr   = ar.duration;
    rec.stepsAr = parseStepsText(ar.steps);
    rec.enUrl   = ar.enUrl;

    if (rec.enUrl) {
      try {
        await page.goto(rec.enUrl, { waitUntil: 'domcontentloaded' });
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
        const en = await page.evaluate(extractInPage);
        rec.titleEn = en.title;
        rec.descEn  = en.description;
        rec.condEn  = en.conditions;
        rec.docsEn  = en.documents;
        rec.feesEn  = en.fees;
        rec.durEn   = en.duration;
        rec.stepsEn = parseStepsText(en.steps);
      } catch (e) { rec.enError = e.message; }
    }
    if (!rec.titleEn) {
      // Last-ditch EN title from the URL slug
      const m = rec.enUrl.match(/\/([^/]+)-\d+\/?$/);
      if (m) rec.titleEn = slugToTitle(m[1]);
    }
  } catch (e) {
    rec.error = e.message;
  } finally {
    await page.close().catch(() => {});
  }

  const ok = rec.titleAr ? '✓' : '✗';
  const enOk = rec.titleEn ? '✓' : '·';
  console.log(`  [${String(idx + 1).padStart(2)}/${total}] ar=${ok} en=${enOk} "${(rec.titleAr || '').slice(0, 60)}"${rec.error ? '  ERR ' + rec.error : ''}`);
  return rec;
}

// ─── Naql.om hand-curated transport services ─────────────────────
// Public-facing land-transport licensing services hinted on naql.om's landing
// page. Actual flows are login-gated; this captures the public service names
// and high-level descriptions so the catalogue knows they exist.
const NAQL_SERVICES = [
  { titleAr: 'إصدار بطاقة تشغيل مركبة', titleEn: 'Issue Vehicle Operation Card',
    desc: 'إصدار بطاقة تشغيل مركبة للأفراد والمنشآت العاملة في قطاع النقل البري وفقاً للائحة التنفيذية لقانون النقل البري (القرار الوزاري رقم 2/2018).' },
  { titleAr: 'تجديد بطاقة تشغيل مركبة', titleEn: 'Renew Vehicle Operation Card',
    desc: 'تجديد بطاقة تشغيل مركبة بعد انتهاء صلاحيتها.' },
  { titleAr: 'نقل بطاقة تشغيل مركبة', titleEn: 'Transfer Vehicle Operation Card',
    desc: 'نقل بطاقة تشغيل مركبة من مالك إلى آخر عبر البوابة الموحدة.' },
  { titleAr: 'إلغاء بطاقة تشغيل مركبة', titleEn: 'Cancel Vehicle Operation Card',
    desc: 'إلغاء بطاقة تشغيل مركبة سارية المفعول.' },
  { titleAr: 'تسجيل لوحة أجرة', titleEn: 'Register Taxi Plate',
    desc: 'تسجيل لوحة سيارة أجرة عبر البوابة الموحدة لمنصة نقل.' },
  { titleAr: 'إصدار تصريح حمولة استثنائية', titleEn: 'Issue Exceptional Load Permit',
    desc: 'إصدار تصريح للحمولات الاستثنائية على الطرق وفق اشتراطات النقل البري.' },
  { titleAr: 'إصدار ترخيص تأجير وسائل النقل البري للركاب بدون سائق', titleEn: 'Issue Land Passenger Transport Rental Licence (Without Driver)',
    desc: 'ترخيص تأجير المركبات لنقل الركاب بدون سائق (صالون / دفع رباعي / حافلات).' },
  { titleAr: 'إصدار ترخيص تأجير وسائل النقل البري للركاب مع سائق', titleEn: 'Issue Land Passenger Transport Rental Licence (With Driver)',
    desc: 'ترخيص تأجير المركبات لنقل الركاب مع سائق.' },
  { titleAr: 'إصدار ترخيص تشغيل سيارات الأجرة', titleEn: 'Issue Taxi Operation Licence',
    desc: 'ترخيص تشغيل المركبات كسيارات أجرة.' },
  { titleAr: 'إصدار ترخيص نقل البضائع البري', titleEn: 'Issue Land Goods Transport Licence',
    desc: 'ترخيص نقل البضائع برّاً (شاحنات / صهاريج).' }
];

// ─── CSV helpers ─────────────────────────────────────────────────
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

function inferBeneficiary(text) {
  const t = String(text || '');
  const tags = [];
  if (/مرك?ب|ترخ?يص|تشغيل|نقل|بري|بحري|سفينة|business|company|institution|منشآت|قطاع|تأجير/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  if (/فرد|مواطن|سائق|individual|citizen/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (!tags.length) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  return [...new Set(tags)].join(',');
}

function buildMtcitRow(rec, idx) {
  const benef = inferBeneficiary(`${rec.titleAr} ${rec.titleEn} ${rec.descAr}`);
  const stepsAr = rec.stepsAr.map(s => `[${s.n}] ${s.step}`).join(' || ');
  const stepsEn = rec.stepsEn.map(s => `[${s.n}] ${s.step}`).join(' || ');
  return [
    BASE_ID + idx,
    rec.titleAr, rec.titleEn,
    ENTITY_AR, ENTITY_EN, ENTITY_ID,
    '', '', benef, '',
    rec.descAr, rec.descEn,
    rec.condAr, rec.condEn,
    rec.docsAr, rec.docsEn,
    rec.feesAr, rec.feesEn,
    'الكتروني',
    rec.durAr, rec.durEn,
    '', '',
    'الموقع الإلكتروني', '',
    '+968 24410000', 'mtcit.gov.om',
    stepsAr, stepsEn,
    rec.stepsAr.length || rec.stepsEn.length || '',
    '',
    rec.arUrl
  ];
}

function buildNaqlRow(svc, idx, baseOffset) {
  const benef = inferBeneficiary(`${svc.titleAr} ${svc.titleEn}`);
  return [
    BASE_ID + baseOffset + idx,
    svc.titleAr, svc.titleEn,
    ENTITY_AR, ENTITY_EN, ENTITY_ID,
    'منصة نقل (الإدارة العامة للنقل البري)', 'Naql Platform (Land Transport General Directorate)',
    benef, 'النقل البري > منصة نقل',
    svc.desc, '',
    '', '',
    '', '',
    '', '',
    'الكتروني',
    '', '',
    '', '',
    'بوابة منصة نقل (naql.om)', '',
    '+968 22650650', 'www.naql.om',
    '', '',
    '', '',
    'https://www.naql.om/ar/Home/UnifiedLogin'
  ];
}

// ─── Main ────────────────────────────────────────────────────────
const idsRaw = await fs.readFile(IDS_TSV, 'utf8');
const ids = idsRaw.trim().split(/\r?\n/).slice(1)
  .map(line => { const [id, googleTitle] = line.split(/\t/); return { id: id?.trim(), googleTitle: googleTitle?.trim() }; })
  .filter(x => x.id && /^\d+$/.test(x.id));

console.log(`▶ launching headless Chromium for ${ids.length} MTCIT pages + ${NAQL_SERVICES.length} naql.om services`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Sanad-AI scraper)',
  locale: 'ar-OM',
  viewport: { width: 1280, height: 900 }
});

const t0 = Date.now();
const results = [];
const CONCURRENCY = 2;
let cursor = 0;
async function worker() {
  while (cursor < ids.length) {
    const idx = cursor++;
    const r = await scrapeOne(context, ids[idx], idx, ids.length);
    results[idx] = r;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await context.close();
await browser.close();
console.log(`▶ done in ${Date.now() - t0}ms`);

const lines = [HEADERS.join(',')];
let kept = 0;
const skipped = [];
results.forEach((rec, i) => {
  if (!rec || rec.error || !rec.titleAr) { skipped.push({ idx: i, error: rec?.error || 'no title', id: ids[i].id }); return; }
  lines.push(csvRow(buildMtcitRow(rec, i)));
  kept++;
});
NAQL_SERVICES.forEach((svc, i) => {
  lines.push(csvRow(buildNaqlRow(svc, i, ids.length)));
  kept++;
});

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(RAW_JSON, JSON.stringify(results, null, 2), 'utf8');

const arOk      = results.filter(r => r?.titleAr).length;
const enOk      = results.filter(r => r?.titleEn).length;
const haveDesc  = results.filter(r => r?.descAr && r.descAr.length > 10).length;
const haveSteps = results.filter(r => r?.stepsAr && r.stepsAr.length > 0).length;
console.log(`\n=== Coverage ===`);
console.log(`  total kept:       ${kept} (${arOk} from MTCIT site + ${NAQL_SERVICES.length} from naql.om)`);
console.log(`  AR title (MTCIT): ${arOk} / ${ids.length}`);
console.log(`  EN title (MTCIT): ${enOk} / ${ids.length}`);
console.log(`  AR description:   ${haveDesc} / ${ids.length}`);
console.log(`  AR steps:         ${haveSteps} / ${ids.length}`);
if (skipped.length) {
  console.log(`\n=== Skipped (${skipped.length}) ===`);
  for (const s of skipped) console.log(`  [${s.idx}] ${s.error}: ${s.id}`);
}
console.log(`\n✓ ${OUT_CSV}`);
