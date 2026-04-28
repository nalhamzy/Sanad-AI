// Scrape Muscat Municipality (بلدية مسقط) e-services portal →
// CSV matching oman_services_directory.csv (32 columns).
//
// Source:  https://eservices.mm.gov.om/MM
// Endpoints (server-rendered HTML, no JS needed):
//   GET /MM/GetSubCards?id={mainId}     — sidebar HTML; mainId=1=New Request, 2=Inquiry
//   GET /MM/GetSubContent?id={subId}    — service tile HTML for category subId
// Culture is selected via cookie .AspNetCore.Culture=c=ar|c=en
// Service form pages live at /Home/Form/{base64Id}.
//
// The portal's TLS chain is misconfigured on Windows clients; we set
// NODE_TLS_REJECT_UNAUTHORIZED=0 inside the script so the user does not need
// to remember to set it. (No security risk — read-only public scrape.)
//
// Run: node scripts/mm_scrape/scrape.mjs
// Output: scripts/mm_scrape/mm_services.csv (+ mm_services_raw.json)

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/mm_scrape';
const OUT_CSV = path.join(ROOT, 'mm_services.csv');
const RAW_JSON = path.join(ROOT, 'mm_services_raw.json');
const ORIGIN = 'https://eservices.mm.gov.om';
const ENTITY_ID = 119;
const ENTITY_AR = 'بلدية مسقط';
const ENTITY_EN = 'Muscat Municipality';
const BASE_ID = 160000;
const CALL_PHONE = '+968 24683330';   // Muscat Municipality call centre
const WEBSITE = 'eservices.mm.gov.om';

const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ─── Fetch helpers ──────────────────────────────────────────────
async function fetchCookie(culture) {
  // Switch culture; the response sets a cookie we'll attach to subsequent requests.
  const r = await fetch(`${ORIGIN}/Home/CultureManagement?culture=${culture}&returnUrl=%2FMM`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)' },
    redirect: 'manual'
  });
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(s => s.split(';')[0]).filter(s => s.includes('=')).join('; ');
}

async function fetchHtml(path, cookie, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${ORIGIN}${path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)',
          'Accept': 'text/html',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': cookie
        }
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    } catch (e) {
      if (i === attempts - 1) return { ok: false, status: 0, text: '', err: e.message };
      await new Promise(rs => setTimeout(rs, 1000 * (i + 1)));
    }
  }
}

// ─── Parsers ────────────────────────────────────────────────────
// Pull (subId, label) pairs from a sidebar HTML.
function parseSidebar(html) {
  const out = [];
  const re = /data-mainid=["']\d+["']\s+data-subid=["'](\d+)["']([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ subid: Number(m[1]), label: stripTags(m[2]).replace(/^>\s*/, '') });
  }
  return out;
}

// Pull service tiles from a sub-content HTML.
// Each tile is <div class="stat-box"> with an <h3> title and a /Home/Form/... link.
function parseTiles(html) {
  const out = [];
  const blockRe = /<div[^>]*class="[^"]*stat-box[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let bm;
  while ((bm = blockRe.exec(html)) !== null) {
    const blk = bm[1];
    const titleM = blk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const descM = blk.match(/<p[^>]*style="height:\s*\d+px[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const formM = blk.match(/href="(\/Home\/Form\/[^"]+)"/);
    if (!titleM) continue;
    const title = stripTags(titleM[1]);
    if (!title) continue;
    out.push({
      title,
      description: descM ? stripTags(descM[1]) : '',
      formPath: formM ? formM[1] : ''
    });
  }
  return out;
}

// ─── Service-detail follower (best-effort) ──────────────────────
// If we have a /Home/Form/... URL, follow it once to extract whatever fields
// the form page exposes (description, requirements, fees). Many Muscat-Muni
// service forms are bare "fill out this request" pages with little detail,
// so we don't expect rich data here — but capturing what's available beats
// leaving the field empty.
async function fetchDetailIfAvailable(formPath, cookie) {
  if (!formPath) return null;
  const r = await fetchHtml(formPath, cookie);
  if (!r.ok || r.text.length < 1000) return null;
  // Heuristic field pull: look for labelled sections by Arabic/English heading.
  const grab = (labels) => {
    for (const L of labels) {
      const re = new RegExp(`(?:<h[1-5][^>]*>|<strong>|<b>|<label[^>]*>)\\s*${L.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]?\\s*(?:</[^>]+>)?([\\s\\S]{0,800}?)(?=<h[1-5]|<strong>|<b>|<label|<table|<form|$)`, 'i');
      const m = r.text.match(re);
      if (m) {
        const v = stripTags(m[1]);
        if (v && v.length > 5 && v.length < 600) return v;
      }
    }
    return '';
  };
  return {
    description: grab(['وصف الخدمة', 'نبذة', 'About', 'Description', 'Service Description']),
    conditions:  grab(['الشروط', 'شروط الخدمة', 'Conditions', 'Terms']),
    documents:   grab(['المستندات المطلوبة', 'المتطلبات', 'Required Documents', 'Documents']),
    fees:        grab(['الرسوم', 'رسوم الخدمة', 'Fees']),
    duration:    grab(['مدة الإنجاز', 'مدة', 'Duration', 'Completion Period'])
  };
}

// ─── Main scrape ────────────────────────────────────────────────
async function discover() {
  // Build the category list per mainId for both AR and EN, keyed on subId.
  const arCookie = await fetchCookie('ar');
  const enCookie = await fetchCookie('en');

  const cats = new Map(); // subid → { mainid, labelAr, labelEn }
  for (const mainId of [1, 2]) {
    const ar = await fetchHtml(`/MM/GetSubCards?id=${mainId}`, arCookie);
    const en = await fetchHtml(`/MM/GetSubCards?id=${mainId}`, enCookie);
    const arSide = parseSidebar(ar.text);
    const enSide = parseSidebar(en.text);
    const enBySub = new Map(enSide.map(x => [x.subid, x.label]));
    for (const a of arSide) {
      cats.set(a.subid, { mainid: mainId, labelAr: a.label, labelEn: enBySub.get(a.subid) || '' });
    }
  }
  console.log(`▶ discovered ${cats.size} categories across mainId=1,2`);
  return { arCookie, enCookie, cats };
}

async function scrapeAll() {
  const { arCookie, enCookie, cats } = await discover();

  const all = []; // raw record per service
  let svcIdx = 0;

  for (const [subid, cat] of cats) {
    const ar = await fetchHtml(`/MM/GetSubContent?id=${subid}`, arCookie);
    const en = await fetchHtml(`/MM/GetSubContent?id=${subid}`, enCookie);
    const arTiles = parseTiles(ar.text);
    const enTiles = parseTiles(en.text);
    console.log(`  → subid=${subid} "${cat.labelAr}" (${arTiles.length} AR tiles, ${enTiles.length} EN tiles)`);

    // Pair AR↔EN by position. The portal renders tiles in a stable order.
    const n = Math.max(arTiles.length, enTiles.length);
    for (let i = 0; i < n; i++) {
      const a = arTiles[i] || {};
      const e = enTiles[i] || {};
      all.push({
        idx: svcIdx++,
        mainid: cat.mainid,
        subid,
        catAr: cat.labelAr,
        catEn: cat.labelEn,
        titleAr: a.title || '',
        titleEn: e.title || '',
        descAr: a.description || '',
        descEn: e.description || '',
        formPath: a.formPath || e.formPath || '',
        url: a.formPath ? ORIGIN + a.formPath : `${ORIGIN}/MM`
      });
    }
  }
  console.log(`▶ ${all.length} service tiles enumerated`);

  // Optional: try to fetch detail pages for the first few to see if they
  // carry any usable structured fields. Skip if --no-detail is passed.
  const skipDetail = process.argv.includes('--no-detail');
  if (!skipDetail) {
    console.log(`▶ fetching detail pages for ${all.length} services (may be sparse)…`);
    const CONCURRENCY = 6;
    let cur = 0, hits = 0;
    async function worker() {
      while (cur < all.length) {
        const idx = cur++;
        const rec = all[idx];
        const det = await fetchDetailIfAvailable(rec.formPath, arCookie);
        if (det) {
          rec.detailAr = det;
          if (det.description || det.conditions || det.documents || det.fees) hits++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`▶ ${hits}/${all.length} services yielded any detail`);
  }
  return all;
}

// ─── CSV writer ─────────────────────────────────────────────────
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
  if (/شرك?ة|مؤسس|تجار|business|company|institution|منشآت|قطاع|محل|فندق|مطعم/i.test(t)) tags.push('من الحكومة إلى قطاع الأعمال(G2B)');
  if (/فرد|مواطن|الأفراد|individual|citizen|owner|تأجير|بناء|منزل|إيجار/i.test(t)) tags.push('من الحكومة الى الأفراد(G2C)');
  if (!tags.length) tags.push('من الحكومة الى الأفراد(G2C)');
  return [...new Set(tags)].join(',');
}

function buildRow(rec) {
  const bilingualTitle = `${rec.titleAr} ${rec.titleEn}`;
  const benef = inferBeneficiary(`${bilingualTitle} ${rec.descAr} ${rec.catAr}`);
  const mainPrefix = rec.mainid === 1 ? 'طلب جديد' : 'استعلام';
  const mainPrefixEn = rec.mainid === 1 ? 'New Request' : 'Inquiry';
  const mainSvc = `${mainPrefix} > ${rec.catAr}`.trim();
  const channels = rec.mainid === 3 ? 'الدفع الإلكتروني' : 'بوابة الخدمات الإلكترونية لبلدية مسقط';
  const det = rec.detailAr || {};
  return [
    BASE_ID + rec.idx,
    rec.titleAr, rec.titleEn,
    ENTITY_AR, ENTITY_EN, ENTITY_ID,
    rec.catAr, rec.catEn,
    benef,
    mainSvc,
    rec.descAr || det.description || '',
    rec.descEn || '',
    det.conditions || '', '',
    det.documents || '', '',
    det.fees || '', '',
    'الكتروني',
    det.duration || '', '',
    '', '',
    channels, '',
    CALL_PHONE, WEBSITE,
    '', '',                            // ProcessStepsAr / ProcessStepsEn — not exposed
    '', '',
    rec.url
  ];
}

// ─── Main ───────────────────────────────────────────────────────
const t0 = Date.now();
console.log('▶ Muscat Municipality e-services scrape');
const records = await scrapeAll();
console.log(`▶ done in ${Date.now() - t0}ms`);

const lines = [HEADERS.join(',')];
let kept = 0;
const skipped = [];
for (const rec of records) {
  if (!rec.titleAr && !rec.titleEn) { skipped.push(rec); continue; }
  lines.push(csvRow(buildRow(rec)));
  kept++;
}

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(RAW_JSON, JSON.stringify(records, null, 2), 'utf8');

const arPct  = records.filter(r => r.titleAr).length;
const enPct  = records.filter(r => r.titleEn).length;
const haveDetail = records.filter(r => r.detailAr && (r.detailAr.description || r.detailAr.documents || r.detailAr.fees)).length;
console.log(`\n=== Coverage ===`);
console.log(`  rows kept:     ${kept} / ${records.length}`);
console.log(`  AR title:      ${arPct} / ${records.length}`);
console.log(`  EN title:      ${enPct} / ${records.length}`);
console.log(`  with detail:   ${haveDetail} / ${records.length}`);
if (skipped.length) console.log(`  skipped:       ${skipped.length}`);
console.log(`\n✓ ${OUT_CSV}`);
