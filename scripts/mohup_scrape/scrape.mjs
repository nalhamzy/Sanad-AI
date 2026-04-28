// Scrape MOHUP (Ministry of Housing & Urban Planning) services →
// CSV matching oman_services_directory.csv (32 columns).
//
// MOHUP runs an Angular SPA where each service is a tile on /ar/e-services
// (filtered by category) that opens its detail in a modal. There is no
// per-service URL, so we:
//   1. Read the existing static CSV as the seed list (86 services with stable
//      ServiceIDs, AR titles, and categories — built when the SPA was first
//      audited).
//   2. For each unique category, navigate to the listing page, enumerate the
//      service tiles, and click each one to open its modal.
//   3. Match the clicked tile to a seed row by AR-title text and capture the
//      modal's labelled sections (description / conditions / docs / fees /
//      duration / steps) into the matching row.
//   4. Anything that doesn't render is left blank — better empty than wrong.
//
// Run: node scripts/mohup_scrape/scrape.mjs
// Setup once:  npm install && npx playwright install chromium

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('✗ playwright-core not installed. Run:\n    npm install\n    npx playwright install chromium');
  process.exit(1);
}

const ROOT = 'scripts/mohup_scrape';
const SEED_CSV = path.join(ROOT, 'mohup_services.csv');
const OUT_CSV  = path.join(ROOT, 'mohup_services.csv');
const RAW_JSON = path.join(ROOT, 'mohup_services_raw.json');
const ENTITY_ID = 2210;
const ENTITY_AR = 'وزارة الإسكان والتخطيط العمراني';
const ENTITY_EN = 'Ministry of Housing and Urban Planning';
const CALL_PHONE = '+968 80000099';
const PAGE_TIMEOUT_MS = 30_000;
const MODAL_TIMEOUT_MS = 8_000;

// ─── Load seed (existing static CSV) ────────────────────────────
let raw;
try { raw = await fs.readFile(SEED_CSV, 'utf8'); }
catch { console.error(`✗ ${SEED_CSV} not found — seed list missing`); process.exit(1); }
const seedRows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
console.log(`▶ loaded ${seedRows.length} seed rows`);

// Group by category. Index by normalized AR title for fuzzy matching.
const normTitle = (s) => String(s || '').normalize('NFC').replace(/[‎‏]/g, '').replace(/[()-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const byCategory = new Map();
for (const r of seedRows) {
  const cat = (r.MainService || '').trim();
  if (!byCategory.has(cat)) byCategory.set(cat, new Map());
  byCategory.get(cat).set(normTitle(r.ServiceNameAr), r);
}
console.log(`  categories: ${[...byCategory.keys()].join(' | ')}`);

// ─── DOM extraction inside the modal ─────────────────────────────
function extractModal() {
  const visible = document.querySelector('mat-dialog-container, .mat-dialog-container, [role=dialog], .modal.show, .modal-dialog, .e-service-modal');
  const root = visible || document.body;
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const title = text(root.querySelector('h1, h2, h3, .modal-title, .dialog-title'));
  const all = (sel) => Array.from(root.querySelectorAll(sel));

  const SECTIONS = {
    description: ['وصف الخدمة', 'نبذة عن الخدمة', 'About', 'Description'],
    conditions:  ['الشروط', 'شروط الخدمة', 'الاشتراطات', 'Conditions'],
    documents:   ['المستندات المطلوبة', 'المتطلبات', 'الوثائق', 'Required Documents', 'Documents'],
    fees:        ['الرسوم', 'رسوم الخدمة', 'Fees'],
    duration:    ['مدة', 'Duration', 'Completion Period'],
    steps:       ['إجراءات الخدمة', 'الخطوات', 'مراحل الخدمة', 'Procedures', 'Steps']
  };

  function pickSection(labels) {
    const headings = all('h1, h2, h3, h4, h5, .section-title, .field-label, mat-label, .info-label, strong, dt');
    for (const h of headings) {
      const t = text(h);
      if (!t) continue;
      if (!labels.some(L => t.includes(L))) continue;
      // Try sibling-walk first
      const parts = [];
      let n = h.nextElementSibling;
      while (n) {
        if (/^H[1-5]$/.test(n.tagName)) break;
        const inner = text(n);
        if (inner) parts.push(inner);
        n = n.nextElementSibling;
        if (parts.join(' ').length > 4000) break;
      }
      if (parts.length) return parts.join(' \n ').trim();
      // Fallback: parent's text minus the heading
      const parent = h.parentElement;
      if (parent) {
        const ptxt = text(parent).replace(t, '').trim();
        if (ptxt) return ptxt;
      }
    }
    return '';
  }

  return {
    title,
    description: pickSection(SECTIONS.description),
    conditions:  pickSection(SECTIONS.conditions),
    documents:   pickSection(SECTIONS.documents),
    fees:        pickSection(SECTIONS.fees),
    duration:    pickSection(SECTIONS.duration),
    steps:       pickSection(SECTIONS.steps),
    rawText:     text(root).slice(0, 4000)  // for debugging when section pickup fails
  };
}

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

// ─── Per-category scrape ─────────────────────────────────────────
async function scrapeCategory(context, category, seedTitles) {
  const url = `https://mohup.gov.om/ar/e-services?category=${encodeURIComponent(category)}`;
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  const enriched = new Map(); // normTitle → { extracted modal data }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch {}
    // Give Angular a moment to render the tile list.
    await page.waitForTimeout(1500);

    // Discover service tiles. Try a variety of selectors — MOHUP's exact
    // markup may shift between deployments.
    const tileSel = [
      'a.service-card', '[data-service-id]', '.e-service-item',
      '.service-tile', '.service-list-item', '.card.service',
      '[class*="service"][class*="card"]', '[class*="service"][class*="tile"]',
      'mat-card.service', 'app-service-card', '.list-card'
    ].join(', ');

    // Sometimes the page is rendered as anchor tags or button cards. Pull the
    // visible text of each candidate and try to match against seedTitles.
    const tiles = await page.$$(tileSel);
    if (!tiles.length) {
      // Fallback — any clickable element containing one of the seed titles.
      const fallback = await page.evaluate((titles) => {
        const norm = (s) => (s || '').normalize('NFC').replace(/[‎‏]/g, '').replace(/[()-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const set = new Set(titles);
        const all = Array.from(document.querySelectorAll('a, button, [role=button], [role=link], li, div'));
        const out = [];
        for (const el of all) {
          const t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length < 3 || t.length > 200) continue;
          if (set.has(norm(t))) out.push({ key: norm(t) });
        }
        return out;
      }, [...seedTitles.keys()]);
      console.log(`    ${category}: 0 known selectors matched; fallback found ${fallback.length}`);
    } else {
      console.log(`    ${category}: ${tiles.length} tile(s) on page`);
    }

    // Click strategy: iterate tiles by AR text, click, capture modal, close.
    for (const titleKey of seedTitles.keys()) {
      // Find a clickable element whose visible text fuzzy-matches this seed title.
      const clicked = await page.evaluate((needle) => {
        const norm = (s) => (s || '').normalize('NFC').replace(/[‎‏]/g, '').replace(/[()-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const all = Array.from(document.querySelectorAll('a, button, [role=button], [role=link], .service-card, .e-service-item, .card, mat-card, li'));
        for (const el of all) {
          const t = (el.innerText || el.textContent || '').trim();
          if (!t) continue;
          const nt = norm(t);
          if (nt === needle || nt.startsWith(needle) || needle.startsWith(nt) || (nt.includes(needle) && needle.length > 8)) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
        return false;
      }, titleKey);

      if (!clicked) continue;

      // Wait for modal to appear.
      try {
        await page.waitForSelector('mat-dialog-container, .mat-dialog-container, [role=dialog], .modal.show', { timeout: MODAL_TIMEOUT_MS });
      } catch { continue; }
      await page.waitForTimeout(400); // settle text
      const data = await page.evaluate(extractModal);
      enriched.set(titleKey, data);

      // Close the modal: try Escape, fall back to clicking a close button.
      await page.keyboard.press('Escape').catch(() => {});
      const closed = await page.evaluate(() => {
        const btn = document.querySelector('mat-dialog-container .close, .modal .close, [aria-label=Close], [aria-label=إغلاق]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      // Wait for modal to disappear before next click.
      await page.waitForSelector('mat-dialog-container, [role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => {});
    }
  } catch (e) {
    console.log(`    ✗ ${category}: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }
  return enriched;
}

// ─── CSV writer ──────────────────────────────────────────────────
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

function buildRow(seed, enrich) {
  const stepsArr = parseStepsText(enrich?.steps || '');
  const stepsAr = stepsArr.map(s => `[${s.n}] ${s.step}`).join(' || ');
  return [
    seed.ServiceID,
    seed.ServiceNameAr,
    seed.ServiceNameEn || enrich?.title || '',
    ENTITY_AR, ENTITY_EN, ENTITY_ID,
    seed.EntityDepartmentAr || '', seed.EntityDepartmentEn || '',
    seed.Beneficiary || 'من الحكومة الى الأفراد(G2C)',
    seed.MainService || '',
    enrich?.description || '', '',
    enrich?.conditions || '', '',
    enrich?.documents || '', '',
    enrich?.fees || '', '',
    'الكتروني',
    enrich?.duration || '', '',
    '', '',
    'بوابة وزارة الإسكان والتخطيط العمراني (mohup.gov.om)', '',
    CALL_PHONE, 'mohup.gov.om',
    stepsAr, '',
    stepsArr.length || '',
    '',
    seed.ServiceURL || ''
  ];
}

// ─── Main ────────────────────────────────────────────────────────
console.log(`▶ launching headless Chromium`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Sanad-AI scraper)',
  locale: 'ar-OM',
  viewport: { width: 1280, height: 900 }
});

const t0 = Date.now();
const allEnriched = new Map(); // global normTitle → enrich
const rawDump = [];
for (const [category, seedTitles] of byCategory) {
  if (!category) continue;
  console.log(`  → category: ${category} (${seedTitles.size} services)`);
  const enriched = await scrapeCategory(context, category, seedTitles);
  for (const [k, v] of enriched) {
    allEnriched.set(k, v);
    rawDump.push({ category, titleKey: k, ...v });
  }
}
await context.close();
await browser.close();
console.log(`▶ done in ${Date.now() - t0}ms; enriched ${allEnriched.size}/${seedRows.length} rows`);

// ─── Write CSV ───────────────────────────────────────────────────
const lines = [HEADERS.join(',')];
let enrichedCount = 0;
for (const seed of seedRows) {
  const k = normTitle(seed.ServiceNameAr);
  const enrich = allEnriched.get(k);
  if (enrich) enrichedCount++;
  lines.push(csvRow(buildRow(seed, enrich)));
}

await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');
await fs.writeFile(RAW_JSON, JSON.stringify(rawDump, null, 2), 'utf8');

console.log(`\n=== Coverage ===`);
console.log(`  rows kept:    ${seedRows.length}`);
console.log(`  enriched:     ${enrichedCount} / ${seedRows.length}`);
console.log(`  empty (manual review needed): ${seedRows.length - enrichedCount}`);
console.log(`\n✓ ${OUT_CSV}`);
