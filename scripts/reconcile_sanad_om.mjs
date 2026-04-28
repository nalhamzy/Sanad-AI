// Reconcile our scraped catalogue against the canonical Sanad price list.
//
// Inputs:
//   - scripts/sanad_om_scrape/sanad_om_pricelist_raw.json (253 services, 29 entities)
//   - service_catalog table from data/sanad.db (453 scraped services)
//
// Outputs (./sanad_reconciliation.json) and a printed summary:
//   - matches:     services in BOTH (our id + sanad price list rows)
//   - missing_from_us:  services in sanad.om but NOT in our catalogue
//   - junk_in_us:  services in our catalogue that look like non-requests
//                  (FAQs, info pages, employee tools, scraper artifacts)
//   - entities_missing:  entities present in sanad.om but absent from ours
//
// Match strategy: normalize Arabic service name (strip diacritics, unify
// alef/yaa, lower whitespace), then 3-pass:
//   1. exact normalized match
//   2. one contains the other (substring)
//   3. token-overlap score ≥ 0.6 (fuzzy)

import 'dotenv/config';
import fs from 'node:fs/promises';
import { createClient } from '@libsql/client';

const DB_URL = process.env.DB_URL || 'file:./data/sanad.db';
const SANAD_OM = './scripts/sanad_om_scrape/sanad_om_pricelist_raw.json';
const OUT = './sanad_reconciliation.json';

const db = createClient({ url: DB_URL });

// ─── Arabic normalisation (mirrors lib/catalogue.js) ───────────
function normalizeAr(s) {
  if (!s) return '';
  let x = s.toLowerCase().trim();
  x = x.replace(/[ً-ْٰ]/g, '');     // strip tashkeel
  x = x.replace(/[إأآٱ]/g, 'ا');                    // unify alef
  x = x.replace(/ى/g, 'ي');                          // unify yaa
  x = x.replace(/ة/g, 'ه');                          // taa marbuta → haa
  x = x.replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  x = x.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return x;
}

function tokens(s) {
  const STOP = new Set(['من','الى','إلى','في','على','و','ال','او','أو','عن','مع','هل','ما','هذا','هذه','الـ','بـ','لـ']);
  return normalizeAr(s).split(/\s+/).filter(t => t && t.length >= 2 && !STOP.has(t));
}

function tokenOverlap(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

// ─── Junk classifier — heuristic ───────────────────────────────
const JUNK_PATTERNS = [
  /faq|frequently/i, /^أسئلة|^سؤال/i,
  /^contact|تواصل|للاستفسار|مركز الاتصال/i,
  /headquarter|مقر/i,
  /^find\b.*\bphone|أرقام\s+الهواتف/i,
  /^view application status|^my\s+(applications|tasks|notifications|cr|certificates|public)/i,
  /^search\s+(for|commercial|public|obligations|business activities)/i,
  /^404\s|404\s+صفحة/i,
  /sms\s+services|short\s+message|تطبيق\s+الجوال|mobile\s+apps?/i,
  /^email$|البريد\s+الإلكتروني/i,
  /^ROP\s|royal\s+oman\s+police\s*(headquarters|sms)/i,
  /system$|نظام\s+(داخلي|راصد|أجيال|البروة|إنجاز|راصد)/i,
  /(ajyal|albarwa|ejada|rassed|mawrd)\s*(system)?$/i,
  /workforce\s+platform|portal\s+access/i,
  /^to know\b.*\bvisas?/i,                // "To know the types of visas, please choose…"
  /periodic\s+audit|تدقيق\s+دوري/i,
  /general\s+department\s+for|الإدارة\s+العامة\s+لـ/i,
];
function looksJunk(name_en, name_ar, beneficiary) {
  const text = `${name_en || ''}  ${name_ar || ''}`;
  // G2E (government-to-employee) services are internal tools, not citizen requests
  if (/g2e|الموظف\s+الحكوم|الموظفين\s+الحكومي/i.test(beneficiary || '')) return 'g2e_internal';
  for (const re of JUNK_PATTERNS) if (re.test(text)) return 'pattern_match';
  return null;
}

// ─── Main ──────────────────────────────────────────────────────
const sanadOm = JSON.parse(await fs.readFile(SANAD_OM, 'utf8'));
const sanadServices = sanadOm.services; // [{entity_no, entity_ar, service_ar, actions[]}, …]

const { rows: catalogueRows } = await db.execute(`
  SELECT id, entity_en, entity_ar, name_en, name_ar, fee_omr, beneficiary, is_active
    FROM service_catalog WHERE is_active = 1`);
console.log(`▶ catalogue rows: ${catalogueRows.length}`);
console.log(`▶ sanad.om services: ${sanadServices.length}`);

// Index our catalogue by normalized name for fast lookup.
const ourByName = new Map();
for (const r of catalogueRows) {
  const k1 = normalizeAr(r.name_ar);
  const k2 = normalizeAr(r.name_en);
  if (k1) ourByName.set(k1, r);
  if (k2) ourByName.set(k2, r);
}

// 3-pass match
const matches = [];
const missingFromUs = [];
for (const s of sanadServices) {
  const sk = normalizeAr(s.service_ar);
  // pass 1: exact normalized
  let hit = ourByName.get(sk);
  let how = 'exact';
  // pass 2: substring (one contains the other)
  if (!hit) {
    for (const r of catalogueRows) {
      const a = normalizeAr(r.name_ar), b = normalizeAr(r.name_en);
      if ((a && (a.includes(sk) || sk.includes(a))) ||
          (b && (b.includes(sk) || sk.includes(b)))) {
        hit = r; how = 'substring'; break;
      }
    }
  }
  // pass 3: token overlap ≥ 0.7 (we want HIGH confidence here)
  if (!hit) {
    let bestScore = 0, bestRow = null;
    for (const r of catalogueRows) {
      const sc = Math.max(tokenOverlap(s.service_ar, r.name_ar), tokenOverlap(s.service_ar, r.name_en));
      if (sc > bestScore) { bestScore = sc; bestRow = r; }
    }
    if (bestScore >= 0.7) { hit = bestRow; how = `fuzzy(${bestScore.toFixed(2)})`; }
  }
  if (hit) {
    matches.push({
      our_id: hit.id, our_name_ar: hit.name_ar, our_name_en: hit.name_en, our_fee_omr: hit.fee_omr,
      our_entity_ar: hit.entity_ar,
      sanad_entity_ar: s.entity_ar, sanad_service_ar: s.service_ar,
      sanad_actions: s.actions, match_method: how
    });
  } else {
    missingFromUs.push({ entity_no: s.entity_no, entity_ar: s.entity_ar, service_ar: s.service_ar, actions: s.actions });
  }
}

// Junk in our catalogue
const junkInUs = [];
for (const r of catalogueRows) {
  const reason = looksJunk(r.name_en, r.name_ar, r.beneficiary);
  if (reason) junkInUs.push({ id: r.id, name_en: r.name_en, name_ar: r.name_ar, beneficiary: r.beneficiary, reason });
}

// Entities missing from us
const ourEntitiesAr = new Set(catalogueRows.map(r => r.entity_ar?.trim()).filter(Boolean));
const sanadEntities = sanadOm.entities;
const entitiesMissing = sanadEntities.filter(e => {
  const norm = normalizeAr(e.entity_ar);
  for (const our of ourEntitiesAr) if (normalizeAr(our).includes(norm) || norm.includes(normalizeAr(our))) return false;
  return true;
});

// Fee-discrepancy detection on matches
const feeDiscrepancies = matches.filter(m => {
  const ourFee = m.our_fee_omr;
  const submitAction = m.sanad_actions.find(a => /تقديم/.test(a.action)) || m.sanad_actions[0];
  const sanadFee = submitAction?.fee_omr;
  if (sanadFee == null || ourFee == null) return false;
  return Math.abs(ourFee - sanadFee) > 0.01;
});

const report = {
  generated_at: new Date().toISOString(),
  source: SANAD_OM,
  catalogue_rows: catalogueRows.length,
  sanad_om_services: sanadServices.length,
  sanad_om_entities: sanadEntities.length,
  matches: matches.length,
  match_methods: matches.reduce((acc, m) => { acc[m.match_method.split('(')[0]] = (acc[m.match_method.split('(')[0]] || 0) + 1; return acc; }, {}),
  missing_from_us: missingFromUs.length,
  junk_in_us: junkInUs.length,
  entities_missing: entitiesMissing.length,
  fee_discrepancies: feeDiscrepancies.length,
  details: {
    matches,
    missing_from_us: missingFromUs,
    junk_in_us: junkInUs,
    entities_missing: entitiesMissing,
    fee_discrepancies: feeDiscrepancies
  }
};

await fs.writeFile(OUT, JSON.stringify(report, null, 2), 'utf8');

console.log(`\n=== Reconciliation summary ===`);
console.log(`  catalogue rows:        ${report.catalogue_rows}`);
console.log(`  sanad.om services:     ${report.sanad_om_services}`);
console.log(`  sanad.om entities:     ${report.sanad_om_entities}`);
console.log(`  matched (overlap):     ${report.matches}  (methods: ${JSON.stringify(report.match_methods)})`);
console.log(`  missing from us:       ${report.missing_from_us}  ← need to ADD`);
console.log(`  junk in our cat:       ${report.junk_in_us}  ← candidates to REMOVE`);
console.log(`  entities missing:      ${report.entities_missing}  ← entire entities not in ours`);
console.log(`  fee discrepancies:     ${report.fee_discrepancies}  ← sanad.om says different fee than ours`);

console.log(`\n✓ wrote ${OUT}`);
process.exit(0);
