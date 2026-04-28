// Scrape Ministry of Health (MOH) Oman service catalogue → CSV matching the
// existing oman_services_directory.csv schema (32 columns).
//
// Source list: https://moh.gov.om/ar/الخدمات/  (69 unique services, all rendered
// in the DOM regardless of classification filter — verified).
// Each detail page is at /ar/الخدمات/{classification}/{category}/{service}/ and
// has an EN counterpart that's discoverable via the page's language switcher.
//
// Run: node scripts/moh_scrape/scrape.mjs
// Output: scripts/moh_scrape/moh_services.csv (+ moh_services_raw.json)

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/moh_scrape';
const PATHS_FILE = path.join(ROOT, 'paths.txt');
const OUT_CSV = path.join(ROOT, 'moh_services.csv');
const ENTITY_ID = 122;
const ENTITY_AR = 'وزارة الصحة';
const ENTITY_EN = 'Ministry of Health';
const BASE_ID = 110000; // safely above existing max (35678) AND the MOL offset (100000)

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

// ─── Parser ──────────────────────────────────────────────────
function parseMohPage(html) {
  const out = {};
  const decoded = decodeEntities(html);

  // Title (h1)
  const h1 = decoded.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  out.title = h1 ? stripTags(h1[1]) : '';

  // Breadcrumb — last item is the page itself, second-to-last is the category,
  // and the third-to-last is the classification (الأفراد / الأعمال / الموظفين).
  const bc = decoded.match(/<ol[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/ol>/);
  out.breadcrumb = [];
  if (bc) {
    out.breadcrumb = [...bc[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
      .map(x => stripTags(x[1])).filter(Boolean);
  }
  out.classification = out.breadcrumb[2] || '';
  out.category = out.breadcrumb[3] || '';

  // sectionHeading sections — pull each label's adjacent content.
  // Pattern: <div class="sectionHeading">LABEL</div> ... content ... until next
  // sectionHeading / </main> / </section> / next heading-like marker.
  out.sections = {};
  const shRe = /<div[^>]*class="[^"]*sectionHeading[^"]*"[^>]*>([\s\S]*?)<\/div>([\s\S]*?)(?=<div[^>]*sectionHeading|<\/main>|<section[^>]|<h2[^>]*>)/g;
  let m;
  while ((m = shRe.exec(decoded)) !== null) {
    const label = stripTags(m[1]);
    const body = stripTags(m[2]);
    if (label) out.sections[label] = body;
  }

  // <h2> sidebar sections (provider, audience, channels, duration).
  // The page has many h2 elements (header nav, sidebar, etc.); we only want
  // the service-info ones. Keep labels that look like service-info headings:
  // short, non-empty, and the body that follows them is non-trivial.
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|<div[^>]*sectionHeading|<\/section>|<\/main>)/g;
  out.h2 = {};
  let m2;
  while ((m2 = h2Re.exec(decoded)) !== null) {
    const label = stripTags(m2[1]);
    const body = stripTags(m2[2]);
    if (!label || label.length > 60 || label.length < 3) continue;
    // Keep if label has Arabic OR is one of the known EN service-info heads
    const isAr = /[؀-ۿ]/.test(label);
    const knownEn = /^(Service\s+(Provider|Delivery\s+Channels|Channels|Completion\s+Period|Duration|Steps)|Target\s+Audience|Duration|Fees|Channels)$/i.test(label);
    if (isAr || knownEn) out.h2[label] = body.slice(0, 600);
  }

  // Language switcher: discover the EN URL.
  const langSw = html.match(/href="([^"]*\/en\/[^"]+?)"/);
  out.enUrlPath = langSw ? decodeEntities(langSw[1]) : '';

  // "ابدأ الخدمة" / "بدء الخدمة" / "Start service" outbound link
  const startBtn = html.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>(?:[\s\S]{0,200}?(?:بدء الخدمة|ابدأ الخدمة|Start the Service|Start Service))/i);
  out.startUrl = startBtn ? startBtn[1] : '';

  return out;
}

// ─── Field extraction (map MOH labels → CSV columns) ─────────
function extractFields(parsed) {
  const sec = parsed.sections || {};
  const h2 = parsed.h2 || {};
  return {
    title: parsed.title,
    // AR uses "وصف الخدمة" / "نبذة عن الخدمة"; EN uses "Details" or "Service Description".
    description: sec['وصف الخدمة'] || sec['نبذة عن الخدمة'] || sec['Details'] || sec['Service Description'] || '',
    // AR "مراحل الخدمة" / "الخطوات"; EN "Service Steps" / "Service Stages".
    steps: sec['مراحل الخدمة'] || sec['الخطوات'] || sec['Service Steps'] || sec['Service Stages'] || '',
    // AR "الشروط والأحكام"; EN "Terms and Conditions".
    conditions: sec['الشروط والأحكام'] || sec['شروط الخدمة'] || sec['Terms and Conditions'] || sec['Terms & Conditions'] || '',
    // AR "تفاصيل الرسوم"; EN "Fees Details" (note: plural Fees, not Fee).
    fees: sec['تفاصيل الرسوم'] || sec['الرسوم'] || sec['Fees Details'] || sec['Fee Details'] || sec['Fees'] || '',
    // AR "موفر الخدمة"; EN "Service Provider".
    department: h2['موفر الخدمة'] || h2['Service Provider'] || '',
    // AR "الجمهور المستهدف"; EN "Target Audience".
    audience: h2['الجمهور المستهدف'] || h2['Target Audience'] || '',
    // AR "قنوات تقديم الخدمة"; EN "Service Delivery Channels".
    channels: h2['قنوات تقديم الخدمة'] || h2['Service Delivery Channels'] || h2['Service Channels'] || '',
    // AR "مُدّة اتمام الخدمة"; EN "Service Completion Period".
    duration: h2['مُدّة اتمام الخدمة'] || h2['مدة اتمام الخدمة'] || h2['Service Completion Period'] || h2['Service Duration'] || h2['Duration'] || '',
    classification: parsed.classification,
    category: parsed.category
  };
}

function inferBeneficiary(audience, classification) {
  const t = `${audience || ''} ${classification || ''}`.toLowerCase();
  const tags = [];
  if (/أصحاب|business|employer|company|companies|الأعمال|تجاري|industrial|institutions|منشآ?ت/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  if (/أفراد|individual|citizen|مواطن|الأفراد|patient|public/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (/موظف|employee|staff|الموظفين|government/i.test(t)) tags.push('من الحكومة الى موظف الحكومة(G2E)');
  if (!tags.length) tags.push('من الحكومة الى الأفراد(G2C)');
  return [...new Set(tags)].join(',');
}

// Steps text usually has "1. ... 2. ..." inline. Split into numbered list.
function parseStepsText(text) {
  if (!text) return [];
  // Match patterns like "1. step", "1.step", "1- step", "1)step"
  const splits = text.split(/(?:^|\s)(\d+)\s*[.\-)–]\s*/u).slice(1);
  const steps = [];
  for (let i = 0; i < splits.length; i += 2) {
    const n = splits[i];
    const step = (splits[i + 1] || '').trim().replace(/\s+/g, ' ');
    if (step && step.length > 3) steps.push({ n, step: step.slice(0, 500) });
  }
  // Fallback: if regex matched nothing but text is non-trivial, treat whole text as step 1.
  if (steps.length === 0 && text.length > 10) steps.push({ n: '1', step: text.slice(0, 500) });
  return steps;
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
async function scrapeService(arPath, idx) {
  const arUrl = 'https://moh.gov.om/ar/' + encodeURI('الخدمات/' + arPath + '/');
  const arRes = await fetchHtml(arUrl);
  if (!arRes.ok || arRes.text.length < 5000) {
    return { idx, arPath, arUrl, error: `ar fetch failed (status=${arRes.status})` };
  }
  const arParsed = parseMohPage(arRes.text);
  const ar = extractFields(arParsed);

  // EN — discovered via language-switcher href in the AR page.
  let enParsed = null, enUrl = '';
  if (arParsed.enUrlPath) {
    enUrl = arParsed.enUrlPath.startsWith('http')
      ? arParsed.enUrlPath
      : 'https://moh.gov.om' + arParsed.enUrlPath;
    const enRes = await fetchHtml(enUrl);
    if (enRes.ok && enRes.text.length > 3000) {
      enParsed = parseMohPage(enRes.text);
    }
  }
  const en = enParsed ? extractFields(enParsed) : null;

  const arSteps = parseStepsText(ar.steps);
  const enSteps = en ? parseStepsText(en.steps) : [];

  return {
    idx, arPath, arUrl, enUrl,
    arOk: !!ar.title,
    enOk: !!en?.title,
    titleAr: ar.title,
    titleEn: en?.title || arPath.split('/').pop().replace(/-+/g, ' '),
    descAr: ar.description, descEn: en?.description || '',
    condAr: ar.conditions, condEn: en?.conditions || '',
    docsAr: '', docsEn: '', // MOH detail pages do not carry an explicit docs section
    feesAr: ar.fees, feesEn: en?.fees || '',
    durAr: ar.duration, durEn: en?.duration || '',
    channelsAr: ar.channels,
    deptAr: ar.department, deptEn: en?.department || '',
    audienceAr: ar.audience, audienceEn: en?.audience || '',
    classification: ar.classification,
    category: ar.category,
    stepsAr: arSteps, stepsEn: enSteps,
    startUrl: arParsed.startUrl
  };
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

function buildRow(rec, idx) {
  const stepsAr = rec.stepsAr.map(s => `[${s.n}] ${s.step}`).join(' || ');
  const stepsEn = rec.stepsEn.map(s => `[${s.n}] ${s.step}`).join(' || ');
  const benef = inferBeneficiary(rec.audienceAr || rec.audienceEn || '', rec.classification);
  const mainSvc = rec.category && rec.classification ? `${rec.classification} > ${rec.category}` : (rec.category || rec.classification || '');
  return [
    BASE_ID + idx,
    rec.titleAr,
    rec.titleEn,
    ENTITY_AR,
    ENTITY_EN,
    ENTITY_ID,
    rec.deptAr,
    rec.deptEn,
    benef,
    mainSvc,
    rec.descAr,
    rec.descEn,
    rec.condAr,
    rec.condEn,
    rec.docsAr,
    rec.docsEn,
    rec.feesAr,
    rec.feesEn,
    'الكتروني',
    rec.durAr,
    rec.durEn,
    '', // WorkingTimeAr — not exposed
    '',
    rec.channelsAr || 'الموقع الإلكتروني',
    '',
    '24441999', // MOH call centre
    'www.moh.gov.om',
    stepsAr,
    stepsEn,
    rec.stepsAr.length || rec.stepsEn.length,
    '',
    rec.arUrl
  ];
}

// ─── Main ────────────────────────────────────────────────────
const pathsFile = await fs.readFile(PATHS_FILE, 'utf8');
const paths = pathsFile.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
console.log(`▶ scraping ${paths.length} MOH services (8 concurrent) …`);
const t0 = Date.now();
const results = await pool(paths, 8, async (p, idx) => {
  const r = await scrapeService(p, idx);
  if (r.error) {
    console.log(`  [${String(idx + 1).padStart(2)}/${paths.length}] ${p.split('/').pop().slice(0, 50)} … ✗ ${r.error}`);
  } else {
    console.log(`  [${String(idx + 1).padStart(2)}/${paths.length}] ar=${r.arOk ? '✓' : '✗'} en=${r.enOk ? '✓' : '·'} "${(r.titleAr || '').slice(0, 60)}"`);
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
  if (rec.error) { skipped.push({ idx: i, error: rec.error, path: paths[i] }); continue; }
  if (!rec.titleAr && !rec.titleEn) { skipped.push({ idx: i, error: 'no title', path: paths[i] }); continue; }
  lines.push(csvRow(buildRow(rec, i)));
  kept++;
}

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(path.join(ROOT, 'moh_services_raw.json'), JSON.stringify(results, null, 2), 'utf8');

const arPct = results.filter(r => r.arOk).length;
const enPct = results.filter(r => r.enOk).length;
const haveDescAr = results.filter(r => r.descAr && r.descAr.length > 10).length;
const haveStepsAr = results.filter(r => r.stepsAr && r.stepsAr.length > 0).length;
const haveFeesAr = results.filter(r => r.feesAr && r.feesAr.length > 5).length;
const haveDurAr = results.filter(r => r.durAr && r.durAr.length > 2).length;

console.log(`\n=== Coverage ===`);
console.log(`  rows kept:        ${kept} / ${results.length}`);
console.log(`  AR title:         ${arPct} / ${results.length}`);
console.log(`  EN title:         ${enPct} / ${results.length}`);
console.log(`  AR description:   ${haveDescAr} / ${results.length}`);
console.log(`  AR steps:         ${haveStepsAr} / ${results.length}`);
console.log(`  AR fees:          ${haveFeesAr} / ${results.length}`);
console.log(`  AR duration:      ${haveDurAr} / ${results.length}`);
if (skipped.length) {
  console.log(`\n=== Skipped (${skipped.length}) ===`);
  for (const s of skipped) console.log(`  [${s.idx}] ${s.error}: ${s.path}`);
}
console.log(`\n✓ ${OUT_CSV}`);
