// Scrape Ministry of Labour (MOL) Oman service catalogue → CSV matching the
// existing oman_services_directory.csv schema (32 columns).
//
// Source list: https://www.mol.gov.om/ManpowerAllEServices  (76 unique services)
// Each service's /Details/{slug}-{id} URL either stays on mol.gov.om OR
// 30x-redirects to https://gov.om/ar/w/{slug}. We detect which and use the
// matching parser. EN data is only available where the page lives on gov.om.
//
// Run: node scripts/mol_scrape/scrape.mjs
// Output: scripts/mol_scrape/mol_services.csv (+ mol_services_raw.json)

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/mol_scrape';
const SERVICES_TSV = path.join(ROOT, 'services.tsv');
const OUT_CSV = path.join(ROOT, 'mol_services.csv');
const ENTITY_ID = 124;
const ENTITY_AR = 'وزارة العمل';
const ENTITY_EN = 'Ministry of Labour';

// ─── HTML helpers ────────────────────────────────────────────
const decodeEntities = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&#?[a-z0-9]+;/gi, '');
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const slugToTitle = (slug) => String(slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

// ─── gov.om parser ───────────────────────────────────────────
function parseGovOm(html) {
  const out = {};
  // Title
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  out.title = h1 ? stripTags(h1[1]) : '';
  // Description: lead paragraph or first <p> after h1
  const desc = html.match(/<p[^>]*class="[^"]*lead[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    || html.match(/<h1[^>]*>[\s\S]*?<\/h1>[\s\S]{0,400}<p[^>]*>([\s\S]*?)<\/p>/i);
  out.description = desc ? stripTags(desc[1]) : '';
  // Documents (under "المستندات المطلوبة" / "Required Documents")
  const docsRe = /<h[1-6][^>]*>[^<]*?(?:المستندات\s*المطلوبة|Required\s*Documents)[^<]*?<\/h[1-6]>[\s\S]{0,400}?<ul[^>]*>([\s\S]*?)<\/ul>/i;
  const docsM = html.match(docsRe);
  out.docs = docsM
    ? [...docsM[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => stripTags(x[1])).filter(Boolean)
    : [];
  // Conditions
  const condM = html.match(/<h[1-6][^>]*>[^<]*?(?:شروط\s*الخدمة|Service\s*Conditions|Conditions)[^<]*?<\/h[1-6]>[\s\S]{0,400}?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  out.conditions = condM
    ? [...condM[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => stripTags(x[1])).filter(Boolean)
    : [];
  // Steps: <ol class="timeline"> ... <li class="timeline-item"> ... timeline-count + <p>
  const olM = html.match(/<ol[^>]*class="[^"]*timeline[^"]*"[^>]*>([\s\S]*?)<\/ol>/i);
  out.steps = olM
    ? [...olM[1].matchAll(/<li[^>]*timeline-item[^>]*>[\s\S]*?<span[^>]*timeline-count[^>]*>([\s\S]*?)<\/span>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map(x => ({ n: stripTags(x[1]), step: stripTags(x[2]) }))
    : [];
  // Fees — pull only the actual fee from inside the collapsible body, not
  // the toggle button text (اظهر/اخف / Show/Hide).
  const feeM = html.match(/<div[^>]*timeline-item-collapse[\s\S]*?<div[^>]*d-flex flex-column[\s\S]*?>([\s\S]*?)<\/div>\s*<\/div>/i);
  out.fees = feeM ? stripTags(feeM[1]).slice(0, 500) : '';
  // Duration — service info aside
  const durM = html.match(/ri-time-line[\s\S]{0,80}<\/i>([\s\S]{0,80}?)<\/li>/i);
  out.duration = durM ? stripTags(durM[1]) : '';
  // Breadcrumb — the SiteNavigationBreadcrumb portlet renders a real <nav>
  // with categories. Skip the "skip-to-main" anchor and any nav inside the
  // header / footer.
  const bcMatches = [...html.matchAll(/<nav[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/nav>/gi)];
  let mainService = '';
  for (const bc of bcMatches) {
    const items = [...bc[1].matchAll(/<(?:a|li|span)[^>]*>([\s\S]*?)<\/(?:a|li|span)>/gi)]
      .map(x => stripTags(x[1]))
      .filter(t => t && !/تخطي|skip|main content/i.test(t));
    if (items.length >= 2) { mainService = items.slice(-2).join(' > '); break; }
  }
  out.mainService = mainService;
  return out;
}

// ─── MOL parser ──────────────────────────────────────────────
function parseMolPage(html) {
  const out = {};
  // Title
  const titleM = html.match(/<h2[^>]*class="title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  out.title = titleM ? stripTags(titleM[1]) : '';
  // Breadcrumb (last 2 items)
  const bcM = html.match(/<ol[^>]*class="breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/ol>/i);
  if (bcM) {
    const items = [...bcM[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => stripTags(x[1])).filter(Boolean);
    out.mainService = items.slice(-2).join(' > ');
  } else {
    out.mainService = '';
  }
  // Description: first <p> inside <div class="single-service"> after the action buttons
  const ssIdx = html.indexOf('single-service');
  if (ssIdx > 0) {
    const slice = html.slice(ssIdx, ssIdx + 8000);
    // Skip past the <h3> (title repeat) + the <div class="mb-40"> action buttons
    const afterButtons = slice.replace(/[\s\S]*?<\/div>\s*<p[^>]*>/, '<p>');
    const pM = afterButtons.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.description = pM ? stripTags(pM[1]) : '';
  } else {
    out.description = '';
  }
  // Panels — collapse headers → bodies
  const panelRe = /<h5[^>]*panel-title[^>]*>[\s\S]*?<a[^>]*data-toggle="collapse"[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h5>[\s\S]*?<div[^>]*id="\1"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  const panels = {};
  let m;
  while ((m = panelRe.exec(html)) !== null) {
    const header = stripTags(m[2]);
    const body = stripTags(m[3]);
    panels[header] = body;
  }
  // Map known headers
  out.docs = panels['المستندات والوثائق'] || panels['المستندات المطلوبة'] || '';
  out.stepsText = panels['مخطط سير العمل'] || panels['الخطوات'] || panels['الإجراءات'] || '';
  out.fees = panels['رسوم الخدمة'] || panels['الرسوم'] || '';
  out.channels = panels['قنوات تقديم الخدمة'] || '';
  out.duration = panels['المتوسط الزمني لإنجاز الخدمة'] || panels['مدة تقديم الخدمة'] || '';
  out.workingTime = panels['أوقات العمل'] || panels['ساعات العمل'] || '';
  out.conditions = panels['شروط الخدمة'] || panels['الشروط'] || '';
  // Conditions might be empty on MOL — fine
  // Steps: split numbered items "1- ..." or "1. ..." into list
  out.steps = [];
  if (out.stepsText) {
    const splits = out.stepsText.split(/(?:^|\s)(\d+)\s*[-.–]\s+/).slice(1);
    for (let i = 0; i < splits.length; i += 2) {
      const n = splits[i];
      const step = (splits[i + 1] || '').trim().replace(/^\s*[-:.]\s*/, '');
      if (step) out.steps.push({ n, step });
    }
  }
  // Service start URL (the dark "ابدأ الخدمة" button)
  const startUrlM = html.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*btn-theme-colored2[^"]*"[^>]*>[\s\S]{0,200}ابدأ الخدمة/i);
  out.startUrl = startUrlM ? startUrlM[1] : '';
  return out;
}

// ─── Beneficiary inference ───────────────────────────────────
function inferBeneficiary(text) {
  const t = String(text || '');
  const tags = [];
  if (/أصحاب\s*العمل|للمنشآت|للأفراد|للأفراد|الأفراد|individual|citizen/i.test(t)) {
    if (/أصحاب\s*العمل|للمنشآت|establishment|employer|business/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
    if (/الأفراد|للأفراد|individual|citizen|مواطن/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  }
  return tags.length ? [...new Set(tags)].join(',') : 'من الحكومة الى الأفراد(G2C)';
}

// ─── Fetch helpers ───────────────────────────────────────────
async function fetchHtml(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)',
          'Accept': 'text/html,application/xhtml+xml',
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
async function scrapeService({ id, slug }) {
  const molUrl = `https://www.mol.gov.om/ManpowerAllEServices/Details/${slug}-${id}`;
  const arRes = await fetchHtml(molUrl);
  const finalUrl = arRes.finalUrl || molUrl;
  const isGovOm = /gov\.om\/(?:ar\/)?w\//.test(finalUrl);

  let arParsed, enParsed = null, arUrl = finalUrl, enUrl = '';

  if (isGovOm) {
    arParsed = parseGovOm(arRes.text);
    // EN equivalent
    const slugMatch = finalUrl.match(/gov\.om\/(?:ar\/)?w\/([^?#/]+)/);
    if (slugMatch) {
      enUrl = `https://gov.om/en/w/${slugMatch[1]}`;
      const enRes = await fetchHtml(enUrl);
      if (enRes.ok && enRes.text.length > 5000) enParsed = parseGovOm(enRes.text);
    }
  } else {
    arParsed = parseMolPage(arRes.text);
    // No reliable EN page on MOL — leave EN as derived-from-slug only.
  }

  return {
    id, slug,
    arUrl, enUrl,
    arOk: arRes.ok && (arParsed.title?.length > 2),
    enOk: !!enParsed,
    parser: isGovOm ? 'gov.om' : 'mol',
    titleAr: arParsed.title || '',
    titleEn: enParsed?.title || slugToTitle(slug),
    descAr: arParsed.description || '',
    descEn: enParsed?.description || '',
    docsAr: Array.isArray(arParsed.docs) ? arParsed.docs.join(' ; ') : (arParsed.docs || ''),
    docsEn: enParsed ? (Array.isArray(enParsed.docs) ? enParsed.docs.join(' ; ') : (enParsed.docs || '')) : '',
    condAr: Array.isArray(arParsed.conditions) ? arParsed.conditions.join(' ; ') : (arParsed.conditions || ''),
    condEn: enParsed ? (Array.isArray(enParsed.conditions) ? enParsed.conditions.join(' ; ') : (enParsed.conditions || '')) : '',
    stepsAr: arParsed.steps || [],
    stepsEn: enParsed?.steps || [],
    feesAr: arParsed.fees || '',
    feesEn: enParsed?.fees || '',
    durAr: arParsed.duration || '',
    durEn: enParsed?.duration || '',
    channelsAr: arParsed.channels || '',
    workingTimeAr: arParsed.workingTime || '',
    mainService: arParsed.mainService || enParsed?.mainService || '',
    startUrl: arParsed.startUrl || ''
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

function buildRow(rec, baseId) {
  const serviceId = baseId + Number(rec.id);
  const stepsAr = rec.stepsAr.map(s => `[${s.n}] ${s.step}`).join(' || ');
  const stepsEn = rec.stepsEn.map(s => `[${s.n}] ${s.step}`).join(' || ');
  const benef = inferBeneficiary([rec.titleAr, rec.descAr, rec.titleEn, rec.descEn].join(' '));
  return [
    serviceId,
    rec.titleAr,
    rec.titleEn,
    ENTITY_AR,
    ENTITY_EN,
    ENTITY_ID,
    '', // EntityDepartmentAr — not exposed
    '', // EntityDepartmentEn
    benef,
    rec.mainService,
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
    rec.workingTimeAr,
    '',
    rec.channelsAr || 'الموقع الإلكتروني',
    '',
    '80077000',
    'www.mol.gov.om',
    stepsAr,
    stepsEn,
    rec.stepsAr.length || rec.stepsEn.length,
    '',
    rec.arUrl
  ];
}

// ─── Main ────────────────────────────────────────────────────
const tsv = await fs.readFile(SERVICES_TSV, 'utf8');
const services = tsv.trim().split(/\n/).map(line => {
  const [id, slug] = line.split(/\t/);
  return { id, slug };
}).filter(s => s.id && s.slug);

console.log(`▶ scraping ${services.length} services (8 concurrent) …`);
const t0 = Date.now();
const results = await pool(services, 8, async (s, idx) => {
  const r = await scrapeService(s);
  console.log(`  [${String(idx + 1).padStart(2)}/${services.length}] ${s.id} ${r.parser.padEnd(7)} ar=${r.arOk ? '✓' : '✗'} en=${r.enOk ? '✓' : '·'} "${(r.titleAr || r.titleEn || '').slice(0, 60)}"`);
  return r;
});
const dt = Date.now() - t0;
console.log(`▶ done in ${dt}ms`);

const baseId = 100000;
const lines = [HEADERS.join(',')];
let kept = 0;
for (const rec of results) {
  if (rec.error) { console.warn(`[skip] error: ${rec.error}`); continue; }
  if (!rec.titleAr && !rec.titleEn) { console.warn(`[skip] ${rec.id} no title`); continue; }
  lines.push(csvRow(buildRow(rec, baseId)));
  kept++;
}

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(path.join(ROOT, 'mol_services_raw.json'), JSON.stringify(results, null, 2), 'utf8');

// Summary stats
const arPct = results.filter(r => r.arOk).length;
const enPct = results.filter(r => r.enOk).length;
const haveDescAr = results.filter(r => r.descAr && r.descAr.length > 10).length;
const haveDocsAr = results.filter(r => r.docsAr && r.docsAr.length > 5).length;
const haveStepsAr = results.filter(r => r.stepsAr && r.stepsAr.length > 0).length;
console.log(`\n=== Coverage ===`);
console.log(`  rows kept:        ${kept} / ${results.length}`);
console.log(`  AR title:         ${arPct} / ${results.length}`);
console.log(`  EN data (gov.om): ${enPct} / ${results.length}`);
console.log(`  AR description:   ${haveDescAr} / ${results.length}`);
console.log(`  AR docs:          ${haveDocsAr} / ${results.length}`);
console.log(`  AR steps:         ${haveStepsAr} / ${results.length}`);
console.log(`\n✓ ${OUT_CSV}`);
