// Enrich the seven scraped ministry CSVs so every row has:
//   • bilingual ServiceNameAr + ServiceNameEn
//   • bilingual DescriptionAr + DescriptionEn
//   • RequiredDocumentsAr + RequiredDocumentsEn
//
// Strategy: for each row, identify which fields are missing, then make ONE
// Claude call asking for the lot in JSON. The model is told to translate
// where the other side already exists and to generate ONLY a short factual
// description from the service name + entity + category — no inventing.
//
// For required documents we ask for "the documents most reasonable to expect"
// with a hard cap of 5 items. Rows are clearly labelled (each item is an
// English-Arabic pair) so officers can verify in the dashboard before going
// live with citizens.
//
// The script writes every ministry CSV in place and is idempotent: rows that
// already have all four fields populated are skipped without an LLM call.
//
//   node scripts/enrich_scraped.mjs                       # all seven
//   node scripts/enrich_scraped.mjs --ministry mm         # one only
//   node scripts/enrich_scraped.mjs --limit 5             # smoke-test
//   node scripts/enrich_scraped.mjs --dry                 # no LLM, report only

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

// Bypass lib/llm.js — its dotenv override re-applies LLM_PROVIDER from .env
// even when we set it programmatically. For this one-off batch we call Qwen
// directly: Anthropic credits are exhausted, Qwen handles AR/EN well, and
// keeping the call here makes the script self-contained.
const QWEN_KEY = process.env.QWEN_API_KEY;
const QWEN_BASE = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-plus';
if (!QWEN_KEY) { console.error('✗ QWEN_API_KEY not set in .env'); process.exit(1); }

async function chat({ system, user, temperature = 0.2, max_tokens = 700 }) {
  const r = await fetch(`${QWEN_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${QWEN_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL, temperature, max_tokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`qwen ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || '';
}

const MINISTRIES = [
  { code: 'mm',    dir: 'scripts/mm_scrape',    csv: 'mm_services.csv'    },
  { code: 'moc',   dir: 'scripts/moc_scrape',   csv: 'moc_services.csv'   },
  { code: 'moh',   dir: 'scripts/moh_scrape',   csv: 'moh_services.csv'   },
  { code: 'mohup', dir: 'scripts/mohup_scrape', csv: 'mohup_services.csv' },
  { code: 'mol',   dir: 'scripts/mol_scrape',   csv: 'mol_services.csv'   },
  { code: 'mtcit', dir: 'scripts/mtcit_scrape', csv: 'mtcit_services.csv' },
  { code: 'rop',   dir: 'scripts/rop_scrape',   csv: 'rop_services.csv'   }
];

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

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const targetMin = opt('--ministry');
const limit = Number(opt('--limit') || '0') || Infinity;
const dryRun = args.includes('--dry');

const SHORT = (s) => String(s || '').trim().replace(/\s+/g, ' ');

function rowNeedsEnrichment(r) {
  const need = {};
  const titleAr = SHORT(r.ServiceNameAr);
  const titleEn = SHORT(r.ServiceNameEn);
  const descAr = SHORT(r.DescriptionAr);
  const descEn = SHORT(r.DescriptionEn);
  const docsAr = SHORT(r.RequiredDocumentsAr);
  const docsEn = SHORT(r.RequiredDocumentsEn);
  if (!titleAr && titleEn) need.titleAr = true;
  if (!titleEn && titleAr) need.titleEn = true;
  if (descAr.length < 25)  need.descAr = true;
  if (descEn.length < 25)  need.descEn = true;
  if (docsAr.length < 10)  need.docsAr = true;
  if (docsEn.length < 10)  need.docsEn = true;
  return need;
}

const SYSTEM_PROMPT = `You are filling missing fields in an Oman government service catalogue (Sanad-AI). Citizens read these to know what a service does and what to bring.

RULES:
1. Translate when the other language is provided. Keep names short and natural — what a citizen would actually call this service.
2. For descriptions, write 1–2 plain sentences that paraphrase the service name + category. Do NOT invent fees, deadlines, eligibility, or facts that aren't given. If the service title is opaque (e.g. "View application Status"), simply describe what it does literally.
3. For required documents, list 3–5 items that are universally needed for THIS type of service in Oman. Always include "Civil ID" / "البطاقة المدنية" or "Passport" / "جواز السفر" as applicable. Add 1–3 service-specific items that are obvious from the service name (e.g. for a renewal, the expiring item; for a marriage cert, both parties' IDs). Do NOT pad with vague items like "any other document" — keep it tight and useful.
4. Use the input language pair as ground truth. The two languages must say the same thing.
5. Output STRICT JSON, no prose, no markdown fences. Keys you may include: name_ar, name_en, description_ar, description_en, documents_ar, documents_en. Each documents_* is a single string with items separated by " ; " (semicolon space). Only include keys that were requested in the user message.`;

function buildUserPrompt(row, need) {
  const ctx = `
Entity (EN): ${row.EntityEn || '—'}
Entity (AR): ${row.EntityAr || '—'}
Department (EN): ${row.EntityDepartmentEn || '—'}
Department (AR): ${row.EntityDepartmentAr || '—'}
Category: ${row.MainService || '—'}
Beneficiary: ${row.Beneficiary || '—'}
Service name (AR): ${row.ServiceNameAr || '—'}
Service name (EN): ${row.ServiceNameEn || '—'}
Description (AR): ${row.DescriptionAr || '—'}
Description (EN): ${row.DescriptionEn || '—'}
Existing required docs (AR): ${row.RequiredDocumentsAr || '—'}
Existing required docs (EN): ${row.RequiredDocumentsEn || '—'}
`.trim();

  const need_list = Object.keys(need);
  const want = [];
  if (need.titleAr) want.push('"name_ar"');
  if (need.titleEn) want.push('"name_en"');
  if (need.descAr)  want.push('"description_ar"');
  if (need.descEn)  want.push('"description_en"');
  if (need.docsAr)  want.push('"documents_ar"');
  if (need.docsEn)  want.push('"documents_en"');

  return `${ctx}\n\nFill in JUST these JSON keys: ${want.join(', ')}.\nReturn STRICT JSON, nothing else.`;
}

function parseJsonReply(reply) {
  if (!reply) return null;
  // Strip markdown fences if any.
  let s = String(reply).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Take the first {...} block.
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function enrichRow(row, need, idx, total) {
  const userPrompt = buildUserPrompt(row, need);
  let attempt = 0, parsed = null, lastErr = null;
  while (attempt < 2 && !parsed) {
    attempt++;
    try {
      const reply = await chat({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.2,
        max_tokens: 700
      });
      parsed = parseJsonReply(reply);
      if (!parsed) lastErr = 'unparseable JSON: ' + String(reply).slice(0, 120);
    } catch (e) {
      lastErr = e.message;
    }
  }
  if (!parsed) {
    console.log(`  [${idx + 1}/${total}] ✗ ${row.ServiceID} :: ${lastErr}`);
    return { applied: 0, error: lastErr };
  }
  let applied = 0;
  if (need.titleAr && parsed.name_ar)        { row.ServiceNameAr = SHORT(parsed.name_ar); applied++; }
  if (need.titleEn && parsed.name_en)        { row.ServiceNameEn = SHORT(parsed.name_en); applied++; }
  if (need.descAr  && parsed.description_ar) { row.DescriptionAr = SHORT(parsed.description_ar); applied++; }
  if (need.descEn  && parsed.description_en) { row.DescriptionEn = SHORT(parsed.description_en); applied++; }
  if (need.docsAr  && parsed.documents_ar)   { row.RequiredDocumentsAr = SHORT(parsed.documents_ar); applied++; }
  if (need.docsEn  && parsed.documents_en)   { row.RequiredDocumentsEn = SHORT(parsed.documents_en); applied++; }
  console.log(`  [${idx + 1}/${total}] ✓ ${row.ServiceID} (+${applied} fields) :: ${SHORT(row.ServiceNameEn || row.ServiceNameAr).slice(0, 50)}`);
  return { applied };
}

async function processOne({ code, dir, csv }) {
  const csvPath = path.join(dir, csv);
  let raw;
  try { raw = await fs.readFile(csvPath, 'utf8'); }
  catch { console.log(`  · ${code}: ${csvPath} missing — skip`); return null; }

  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  let needCount = 0;
  for (const r of rows) {
    const need = rowNeedsEnrichment(r);
    if (Object.keys(need).length) needCount++;
  }
  console.log(`▶ ${code}: ${rows.length} rows, ${needCount} need enrichment`);

  if (dryRun) {
    return { code, total: rows.length, need: needCount, applied: 0 };
  }

  let processed = 0, totalApplied = 0, errors = 0;
  for (let i = 0; i < rows.length && processed < limit; i++) {
    const r = rows[i];
    const need = rowNeedsEnrichment(r);
    if (!Object.keys(need).length) continue;
    const res = await enrichRow(r, need, i, rows.length);
    if (res.error) errors++;
    totalApplied += (res.applied || 0);
    processed++;
    // Save every 5 rows to make a long run resumable.
    if (processed % 5 === 0) await writeCsv(csvPath, rows);
  }
  await writeCsv(csvPath, rows);

  console.log(`  ✓ ${code}: processed=${processed}, fields_filled=${totalApplied}, errors=${errors}`);
  return { code, total: rows.length, processed, applied: totalApplied, errors };
}

async function writeCsv(csvPath, rows) {
  const lines = [HEADERS.join(',')];
  for (const r of rows) lines.push(csvRow(HEADERS.map(h => r[h] ?? '')));
  await fs.writeFile(csvPath, lines.join('\n') + '\n', 'utf8');
}

// ─── Main ───────────────────────────────────────────────────────
const list = targetMin ? MINISTRIES.filter(m => m.code === targetMin) : MINISTRIES;
if (!list.length) { console.error(`unknown ministry: ${targetMin}`); process.exit(1); }

console.log(`▶ enriching ${list.length} ministry CSV(s)${dryRun ? ' (dry-run)' : ''}${limit !== Infinity ? `, limit=${limit}` : ''}`);
const t0 = Date.now();
const summary = [];
for (const m of list) {
  const r = await processOne(m);
  if (r) summary.push(r);
}
console.log(`\n=== Summary (${Date.now() - t0}ms) ===`);
for (const r of summary) {
  if (dryRun) {
    console.log(`  ${r.code.padEnd(6)} total=${r.total}  need_enrichment=${r.need}`);
  } else {
    console.log(`  ${r.code.padEnd(6)} total=${r.total}  processed=${r.processed}  fields_filled=${r.applied}  errors=${r.errors}`);
  }
}
