// Scrape Ministry of Commerce, Industry and Investment Promotion (MoCIIP)
// service catalogue from the Oman Business Platform → CSV matching
// oman_services_directory.csv (32 columns).
//
// Source: https://www.business.gov.om/ieasy/wp/ar/services/{slug}/
// (38 unique services discovered from the home page; pages are SSR
// WordPress, fetchable via Node fetch directly, no auth required for the
// info pages themselves.)
//
// Run: node scripts/moc_scrape/scrape.mjs
// Output: scripts/moc_scrape/moc_services.csv (+ moc_services_raw.json)

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/moc_scrape';
const SERVICES_TSV = path.join(ROOT, 'services.tsv');
const OUT_CSV = path.join(ROOT, 'moc_services.csv');
const ENTITY_ID = 110;
const ENTITY_AR = 'وزارة التجارة والصناعة وترويج الإستثمار';
const ENTITY_EN = 'Ministry of Commerce, Industry and Investment Promotion';
const BASE_ID = 120000; // safely above existing max + the MOL/MOH offsets

// ─── HTML helpers ────────────────────────────────────────────
const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const slugToTitle = (slug) => decodeURIComponent(slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

// ─── Parser ──────────────────────────────────────────────────
function parseMocPage(html) {
  const out = {};
  const decoded = decodeEntities(html);

  // Title (h1)
  const h1 = decoded.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  out.title = h1 ? stripTags(h1[1]) : '';

  // Description: first <p> after the H1, before the first H2.
  // The WordPress theme renders the lead description as the first paragraph
  // in the .entry-content / .post-content area.
  const h1Idx = decoded.indexOf('<h1');
  if (h1Idx >= 0) {
    const after = decoded.slice(h1Idx);
    const firstH2 = after.indexOf('<h2');
    const window = firstH2 > 0 ? after.slice(0, firstH2) : after.slice(0, 4000);
    const pM = window.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.description = pM ? stripTags(pM[1]) : '';
  } else {
    out.description = '';
  }

  // Section blocks: <h2>{label}</h2> ... content until next <h2> / <h1> / <footer>.
  out.sections = {};
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|<h1[^>]*>|<\/article>|<\/main>|<footer)/g;
  let m;
  while ((m = h2Re.exec(decoded)) !== null) {
    const label = stripTags(m[1]);
    const body = stripTags(m[2]).slice(0, 1200);
    if (label && label.length < 100 && body.length > 5) out.sections[label] = body;
  }

  // Breadcrumb (current > parent > section) — extract as a path string for MainService.
  const bcM = decoded.match(/<(?:nav|div|ul|ol)[^>]*(?:breadcrumb|breadcrumbs)[^>]*>([\s\S]*?)<\/(?:nav|div|ul|ol)>/i);
  if (bcM) {
    const items = [...bcM[1].matchAll(/<(?:a|li|span)[^>]*>([\s\S]*?)<\/(?:a|li|span)>/gi)]
      .map(x => stripTags(x[1])).filter(Boolean)
      .filter(t => !/الرئيسية|home|الصفحة الأمامية|skip|تخطي/i.test(t));
    out.breadcrumb = items.slice(-2).join(' > ');
  } else {
    out.breadcrumb = '';
  }

  // Action button → portal endpoint (the "بدء تشغيل الخدمة" / "Start the Service")
  const startBtn = decoded.match(/<a[^>]*href="(https?:\/\/[^"]+|\/portal\/[^"]+)"[^>]*>(?:[\s\S]{0,200}?(?:بدء تشغيل الخدمة|ابدأ الخدمة|Start the Service|Start Service))/i);
  out.startUrl = startBtn ? startBtn[1] : '';

  return out;
}

// ─── Fetch helpers ───────────────────────────────────────────
async function fetchHtml(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)',
          'Accept': 'text/html',
          'Accept-Language': 'ar,en;q=0.9'
        },
        redirect: 'follow'
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, finalUrl: r.url, text };
    } catch (e) {
      if (i === attempts - 1) return { ok: false, status: 0, finalUrl: url, text: '', err: e.message };
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
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
async function scrapeService({ label, arPath }, idx) {
  const arUrl = 'https://www.business.gov.om' + encodeURI(arPath) + '/';
  const arRes = await fetchHtml(arUrl);
  if (!arRes.ok || arRes.text.length < 3000) {
    return { idx, label, arPath, arUrl, error: `ar fetch failed (status=${arRes.status})` };
  }
  const arParsed = parseMocPage(arRes.text);

  // Try the EN equivalent — the EN URL replaces /ar/ with /en/. The English
  // slug differs (English words instead of Arabic), so we discover it via
  // the AR page's language switcher if present.
  let enParsed = null, enUrl = '';
  const langSw = arRes.text.match(/href="([^"]*\/en\/services\/[^"]+?)"/);
  if (langSw) {
    enUrl = langSw[1].startsWith('http') ? langSw[1] : 'https://www.business.gov.om' + langSw[1];
    const enRes = await fetchHtml(enUrl);
    if (enRes.ok && enRes.text.length > 3000) enParsed = parseMocPage(enRes.text);
  }

  return {
    idx, label, arPath, arUrl, enUrl,
    arOk: !!arParsed.title,
    enOk: !!enParsed?.title,
    titleAr: arParsed.title || label,
    titleEn: enParsed?.title || slugToTitle(arPath.split('/').pop()),
    descAr: arParsed.description,
    descEn: enParsed?.description || '',
    sectionsAr: arParsed.sections,
    sectionsEn: enParsed?.sections || {},
    breadcrumbAr: arParsed.breadcrumb,
    breadcrumbEn: enParsed?.breadcrumb || '',
    startUrl: arParsed.startUrl
  };
}

// ─── Field mapping ───────────────────────────────────────────
// MoCIIP detail pages don't carry a uniform "required documents / fees"
// shape — most are info-only landing pages with an "Start service" button
// that hands off to the portal. We capture what's there + leave a NOTE in
// the description for missing fields.

function pickSection(sections, ...labels) {
  for (const lab of labels) {
    for (const k of Object.keys(sections || {})) {
      if (k === lab || k.includes(lab)) return sections[k];
    }
  }
  return '';
}

function buildBeneficiary(text) {
  const t = String(text || '').toLowerCase();
  const tags = [];
  // The portal is overwhelmingly business-facing.
  if (/مؤسس|شركة|تجاري|سجلي التجاري|business|company|cr|registr/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  // Some services (search registrations, business directory) are also citizen-facing.
  if (/مواطن|أفراد|individual|public|citizen|visitor/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (!tags.length) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
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
  'ServiceID', 'ServiceNameAr', 'ServiceNameEn', 'EntityAr', 'EntityEn', 'EntityID',
  'EntityDepartmentAr', 'EntityDepartmentEn', 'Beneficiary', 'MainService',
  'DescriptionAr', 'DescriptionEn', 'SpecialConditionsAr', 'SpecialConditionsEn',
  'RequiredDocumentsAr', 'RequiredDocumentsEn', 'FeesAr', 'FeesEn', 'PaymentMethod',
  'AvgTimeTakenAr', 'AvgTimeTakenEn', 'WorkingTimeAr', 'WorkingTimeEn',
  'Channels', 'InputChannelOthers', 'CustomerCarePhone', 'Website',
  'ProcessStepsAr', 'ProcessStepsEn', 'NumSteps', 'AudienceVisitCount', 'ServiceURL'
];

const NOTE_MISSING_AR = '— لم يتم استخراج هذا الحقل تلقائياً من بوابة منصة عُمان للأعمال؛ يجب التحقق يدوياً من الصفحة قبل الإدراج.';
const NOTE_MISSING_EN = '— Not auto-extracted from the Oman Business Platform; please verify manually before catalogue insertion.';

function buildRow(rec, idx) {
  const sAr = rec.sectionsAr || {};
  const sEn = rec.sectionsEn || {};
  // Map MoC sections to schema fields. The portal's WordPress detail pages
  // typically have generic h2 sections like "بيان عام", "تغطية الخدمة الإلكترونية",
  // etc. — none of which map cleanly to docs/fees/conditions. We fill what
  // we have + flag missing fields with a NOTE.
  const condAr = pickSection(sAr, 'الشروط والأحكام', 'إخلاء مسؤولية') || NOTE_MISSING_AR;
  const condEn = pickSection(sEn, 'Terms and Conditions', 'Disclaimer') || NOTE_MISSING_EN;
  const docsAr = pickSection(sAr, 'المستندات المطلوبة', 'المستندات', 'الوثائق المطلوبة') || NOTE_MISSING_AR;
  const docsEn = pickSection(sEn, 'Required Documents', 'Documents Required') || NOTE_MISSING_EN;
  const feesAr = pickSection(sAr, 'الرسوم', 'تفاصيل الرسوم', 'استرداد الرسوم') || NOTE_MISSING_AR;
  const feesEn = pickSection(sEn, 'Fees', 'Fees Details', 'Fee Details', 'Refund of Fees') || NOTE_MISSING_EN;
  const durAr = pickSection(sAr, 'مدة الخدمة', 'المتوسط الزمني') || NOTE_MISSING_AR;
  const durEn = pickSection(sEn, 'Service Duration', 'Service Completion Period', 'Average Time') || NOTE_MISSING_EN;

  const benef = buildBeneficiary(`${rec.titleAr} ${rec.descAr} ${rec.titleEn} ${rec.descEn}`);
  const mainSvc = rec.breadcrumbAr || rec.breadcrumbEn || '';

  return [
    BASE_ID + idx,
    rec.titleAr,
    rec.titleEn,
    ENTITY_AR,
    ENTITY_EN,
    ENTITY_ID,
    '', // EntityDepartmentAr — not exposed on portal info pages
    '', // EntityDepartmentEn
    benef,
    mainSvc,
    rec.descAr,
    rec.descEn,
    condAr,
    condEn,
    docsAr,
    docsEn,
    feesAr,
    feesEn,
    'الكتروني',
    durAr,
    durEn,
    '', '',
    'بوابة منصة عُمان للأعمال (business.gov.om)',
    '',
    '+968 80000070',
    'www.business.gov.om',
    '', // ProcessStepsAr — not in info pages; portal flow drives the steps
    '', // ProcessStepsEn
    '',
    '',
    rec.arUrl
  ];
}

// ─── Main ────────────────────────────────────────────────────
const tsv = await fs.readFile(SERVICES_TSV, 'utf8');
const services = tsv.trim().split(/\r?\n/).map(line => {
  const [label, arPath] = line.split(/\t/);
  return { label: label?.trim(), arPath: arPath?.trim() };
}).filter(s => s.arPath);

console.log(`▶ scraping ${services.length} MoCIIP service pages (8 concurrent) …`);
const t0 = Date.now();
const results = await pool(services, 8, async (s, idx) => {
  const r = await scrapeService(s, idx);
  if (r.error) {
    console.log(`  [${String(idx + 1).padStart(2)}/${services.length}] ✗ ${r.error}  | ${s.label}`);
  } else {
    console.log(`  [${String(idx + 1).padStart(2)}/${services.length}] ar=${r.arOk ? '✓' : '✗'} en=${r.enOk ? '✓' : '·'} "${(r.titleAr || '').slice(0, 60)}"`);
  }
  return r;
});
const dt = Date.now() - t0;
console.log(`▶ done in ${dt}ms`);

const lines = [HEADERS.join(',')];
let kept = 0;
const skipped = [];
for (let i = 0; i < results.length; i++) {
  const rec = results[i];
  if (rec.error) { skipped.push({ idx: i, error: rec.error, label: services[i].label }); continue; }
  if (!rec.titleAr && !rec.titleEn) { skipped.push({ idx: i, error: 'no title', label: services[i].label }); continue; }
  lines.push(csvRow(buildRow(rec, i)));
  kept++;
}

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(path.join(ROOT, 'moc_services_raw.json'), JSON.stringify(results, null, 2), 'utf8');

const arPct = results.filter(r => r.arOk).length;
const enPct = results.filter(r => r.enOk).length;
const haveDescAr = results.filter(r => r.descAr && r.descAr.length > 10).length;
const haveSectionsAr = results.filter(r => r.sectionsAr && Object.keys(r.sectionsAr).length).length;

console.log(`\n=== Coverage ===`);
console.log(`  rows kept:        ${kept} / ${results.length}`);
console.log(`  AR title:         ${arPct} / ${results.length}`);
console.log(`  EN title:         ${enPct} / ${results.length}`);
console.log(`  AR description:   ${haveDescAr} / ${results.length}`);
console.log(`  AR sections:      ${haveSectionsAr} / ${results.length}`);
if (skipped.length) {
  console.log(`\n=== Skipped (${skipped.length}) ===`);
  for (const s of skipped) console.log(`  [${s.idx}] ${s.error}: ${s.label}`);
}
console.log(`\n✓ ${OUT_CSV}`);
