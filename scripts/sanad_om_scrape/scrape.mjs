// Scrape the official Sanad price list — the canonical source of truth for
// services that Sanad offices process plus their fees.
//
// Source: https://www.sanad.om/smartformsOnline/PublicSite/Home/SanadServicePriceList
//   Last updated: 01/01/2026 (per the OpenData page meta — semi-annual refresh).
//
// Each row in the price list has columns:
//   1. entity_no     (number assigned to the issuing entity in this list)
//   2. entity_ar     (Arabic entity name, e.g. وزارة العمل, منصة عمان للأعمال)
//   3. service_ar    (Arabic service name)
//   4. action_ar     (تقديم / إلغاء / دفع / إعادة ارسال — the request stage)
//   5. fee_raw       (e.g. "3 ر.ع", "200 بيسة لكل صفحة ر.ع")
//
// Multiple rows can share the same (entity, service) when fees differ by
// action stage. The scraper preserves every row and emits a flat CSV; the
// merge step downstream groups by (entity, service) for the catalogue.
//
// Run: node scripts/sanad_om_scrape/scrape.mjs

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'scripts/sanad_om_scrape';
const URL  = 'https://www.sanad.om/smartformsOnline/PublicSite/Home/SanadServicePriceList';
const OUT_CSV = path.join(ROOT, 'sanad_om_pricelist.csv');
const OUT_JSON = path.join(ROOT, 'sanad_om_pricelist_raw.json');

// ─── HTML helpers ──────────────────────────────────────────────
const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ─── Parse one fee string → numeric OMR (or null) ──────────────
// "3 ر.ع"                → 3
// "200 بيسة لكل صفحة ر.ع" → 0.2 (200 baisa = 0.2 OMR; per-page note kept in raw)
// "10 ر.ع"               → 10
// "1.5 ر.ع"              → 1.5
function parseFeeOmr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // baisa amount → divide by 1000
  const baisa = s.match(/(\d+(?:\.\d+)?)\s*بيسة/);
  if (baisa) return Number(baisa[1]) / 1000;
  // direct OMR (ر.ع or OMR)
  const omr = s.match(/(\d+(?:\.\d+)?)\s*(?:ر\.?ع|OMR|ريال)/i);
  if (omr) return Number(omr[1]);
  // bare number
  const num = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (num) return Number(num[1]);
  return null;
}

// ─── Fetch + parse table ──────────────────────────────────────
async function fetchPage() {
  const r = await fetch(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Sanad-AI scraper)',
      'Accept': 'text/html',
      'Accept-Language': 'ar,en;q=0.9'
    },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  return await r.text();
}

function parseRows(html) {
  // The table rows alternate: <tr><td>n</td><td>entity</td><td>service</td><td>action</td><td>fee</td></tr>
  // Use a non-greedy match to capture each <tr> block, then split on <td> boundaries.
  const rowRe = /<tr>\s*([\s\S]*?)\s*<\/tr>/g;
  const out = [];
  for (const m of html.matchAll(rowRe)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripTags(c[1]));
    if (cells.length !== 5) continue;
    const [no, entity, service, action, fee_raw] = cells;
    // Header rows have empty cells or non-numeric "no"
    if (!service || !entity || !fee_raw) continue;
    if (!/^\d+$/.test(no)) continue;
    const fee_omr = parseFeeOmr(fee_raw);
    out.push({
      entity_no: Number(no),
      entity_ar: entity,
      service_ar: service,
      action_ar: action || '',
      fee_raw,
      fee_omr
    });
  }
  return out;
}

// ─── CSV writer ───────────────────────────────────────────────
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (arr) => arr.map(csvCell).join(',');
const HEADERS = ['entity_no', 'entity_ar', 'service_ar', 'action_ar', 'fee_raw', 'fee_omr'];

// ─── Main ─────────────────────────────────────────────────────
console.log(`▶ fetching ${URL}`);
const html = await fetchPage();
console.log(`  body length: ${html.length}`);

const rows = parseRows(html);
console.log(`▶ parsed ${rows.length} price-list rows`);

// Distinct service-level summary (group by entity + service name)
const services = new Map();
for (const r of rows) {
  const key = `${r.entity_no}|${r.service_ar}`;
  if (!services.has(key)) {
    services.set(key, {
      entity_no: r.entity_no,
      entity_ar: r.entity_ar,
      service_ar: r.service_ar,
      actions: []
    });
  }
  services.get(key).actions.push({ action: r.action_ar, fee_raw: r.fee_raw, fee_omr: r.fee_omr });
}

// Distinct entities
const entities = new Map();
for (const r of rows) {
  if (!entities.has(r.entity_no)) entities.set(r.entity_no, { entity_no: r.entity_no, entity_ar: r.entity_ar, count: 0 });
  entities.get(r.entity_no).count++;
}

// CSV output (one row per price-list line)
await fs.mkdir(ROOT, { recursive: true });
const lines = [HEADERS.join(',')];
for (const r of rows) lines.push(csvRow(HEADERS.map(h => r[h] ?? '')));
await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf8');

// JSON output (grouped by service for downstream reconciliation)
await fs.writeFile(OUT_JSON, JSON.stringify({
  fetched_at: new Date().toISOString(),
  source_url: URL,
  total_rows: rows.length,
  total_services: services.size,
  total_entities: entities.size,
  entities: [...entities.values()].sort((a, b) => a.entity_no - b.entity_no),
  services: [...services.values()]
}, null, 2), 'utf8');

console.log(`\n=== Summary ===`);
console.log(`  raw rows:        ${rows.length}`);
console.log(`  unique services: ${services.size}`);
console.log(`  unique entities: ${entities.size}`);
console.log(`\nEntities:`);
for (const e of [...entities.values()].sort((a, b) => a.entity_no - b.entity_no)) {
  console.log(`  ${String(e.entity_no).padStart(3)} · ${e.entity_ar.padEnd(45)} · ${e.count} rows`);
}
console.log(`\n✓ wrote ${OUT_CSV} (${lines.length} lines)`);
console.log(`✓ wrote ${OUT_JSON}`);
