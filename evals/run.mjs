#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Retrieval eval — how often does the search pipeline rank the RIGHT
// government service in the top-1 / top-3 for a labelled set of citizen
// queries? This is the apparatus for the model bake-off: run the SAME set
// under different configs and compare hit@1, hit@3, MRR, and latency.
//
//   node evals/run.mjs                                   # FTS-only (no keys)
//   QWEN_API_KEY=…   node evals/run.mjs                  # + semantic (Qwen embeddings)
//   ANTHROPIC_API_KEY=… QWEN_API_KEY=… node evals/run.mjs --rerank   # + LLM rerank
//   ANTHROPIC_MODEL=claude-opus-4-8 … node evals/run.mjs --rerank    # pin rerank model
//   LLM_PROVIDER=qwen QWEN_API_KEY=… node evals/run.mjs --rerank     # bake off Qwen
//
// Reads evals/retrieval_set.json; writes evals/report_retrieval.json.
// Matches the expected service by id OR a distinctive name substring, so the
// set survives an id re-import (and works against prod or a local DB).
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { searchServices } from '../lib/hybrid_search.js';
import { normalize } from '../lib/catalogue.js';
import { LLM_ENABLED, LLM_PROVIDER, LLM_MODEL } from '../lib/llm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SET = JSON.parse(readFileSync(join(HERE, 'retrieval_set.json'), 'utf8'));
const useRerank = process.argv.includes('--rerank');
const K = 5; // top-K window we inspect for hit@1 / hit@3

const scored = SET.filter(c => typeof c.id === 'number');
const triage = SET.filter(c => c.id === null);

function matches(s, c) {
  if (Number(s.id) === Number(c.id)) return true;
  if (c.name && s.name_ar && normalize(String(s.name_ar)).includes(normalize(c.name))) return true;
  return false;
}
function rankOf(services, c) {
  const i = services.findIndex(s => matches(s, c));
  return i === -1 ? 0 : i + 1; // 1-indexed; 0 = not in top-K
}

async function search(query, filters) {
  try {
    const { services } = await searchServices(query, filters || {}, { k: K, useLLMRerank: useRerank });
    return Array.isArray(services) ? services : [];
  } catch (e) {
    console.error('  ! search failed:', query, '—', e.message);
    return [];
  }
}

// Warm up: the first query in a fresh process pays one-time DB/index setup
// (~tens of seconds). Absorb it here so per-query latency reflects steady state.
process.stdout.write('warming up (one-time DB/index setup)…');
const warmT0 = Date.now();
await search('تجديد رخصة', {});
console.log(` ${((Date.now() - warmT0) / 1000).toFixed(1)}s\n`);

const rows = [];
let hit1 = 0, hit3 = 0, mrr = 0, totalMs = 0;
for (const c of scored) {
  const t0 = Date.now();
  const services = await search(c.query, c.filters);
  const ms = Date.now() - t0; totalMs += ms;
  const rank = rankOf(services, c);
  if (rank === 1) hit1++;
  if (rank >= 1 && rank <= 3) hit3++;
  mrr += rank ? 1 / rank : 0;
  rows.push({ query: c.query, lang: c.lang, want: c.id, got: services[0]?.id ?? null,
              gotName: services[0]?.name_ar ?? '—', rank, ms });
}

const n = scored.length;
const pct = x => (100 * x / n).toFixed(1) + '%';
console.log('\n══════════ RETRIEVAL EVAL ══════════');
console.log(`config : provider=${LLM_PROVIDER}  model=${LLM_MODEL}  llm=${LLM_ENABLED}  rerank=${useRerank}`);
console.log(`cases  : ${n}   avg latency: ${(totalMs / n).toFixed(0)}ms\n`);
for (const r of rows) {
  const mark = r.rank === 1 ? '✅' : (r.rank >= 1 && r.rank <= 3 ? '🟡' : '❌');
  console.log(`  ${mark} rank=${String(r.rank || '-').padStart(2)} ${String(r.ms).padStart(5)}ms  want ${String(r.want).padEnd(7)} got ${String(r.got ?? '-').padEnd(7)} ${r.query}`);
}
console.log('\n  ────────────────────────────');
console.log(`  HIT@1 : ${hit1}/${n}  (${pct(hit1)})`);
console.log(`  HIT@3 : ${hit3}/${n}  (${pct(hit3)})`);
console.log(`  MRR   : ${(mrr / n).toFixed(3)}`);

if (triage.length) {
  console.log('\n  --- triage / not-in-catalogue (informational) ---');
  for (const c of triage) {
    const services = await search(c.query, c.filters);
    console.log(`  "${c.query}" → top: ${services[0]?.name_ar ?? '(empty)'}   « ${c.note || ''} »`);
  }
}

const report = {
  provider: LLM_PROVIDER, model: LLM_MODEL, llm_enabled: LLM_ENABLED, rerank: useRerank,
  n, hit1, hit3, hit1_pct: +pct(hit1).replace('%', ''), hit3_pct: +pct(hit3).replace('%', ''),
  mrr: +(mrr / n).toFixed(3), avg_ms: +(totalMs / n).toFixed(0), rows,
};
writeFileSync(join(HERE, 'report_retrieval.json'), JSON.stringify(report, null, 2));
console.log('\n  wrote evals/report_retrieval.json\n');
process.exit(0);
