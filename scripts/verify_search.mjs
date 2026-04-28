// Smoke-test hybrid search after the catalogue rebuild + embeddings.
// Runs a series of AR + EN queries through searchServices() (FTS5 BM25 +
// Qwen semantic + RRF) and prints the top 3 hits with the matched lane.
//
// Run: node scripts/verify_search.mjs

import 'dotenv/config';
import { db } from '../lib/db.js';
import { searchServices } from '../lib/hybrid_search.js';
import { loadEmbeddingCache } from '../lib/embeddings.js';

const QUERIES = [
  // Direct matches
  { q: 'rent contract',                expect: 'mm rent-contract services' },
  { q: 'تجديد عقد الإيجار',            expect: 'AR rent renewal' },
  { q: 'medical fitness exam',         expect: 'moh pre/post arrival medical' },
  { q: 'إصدار ترخيص بلدي',              expect: 'mm municipal license issuance' },
  { q: 'good conduct certificate',      expect: 'rop good conduct' },

  // Semantic / fuzzy
  { q: 'I want to start a business',          expect: 'commercial registration / business setup' },
  { q: 'تأشيرة عمل',                          expect: 'work-permit / labour services' },
  { q: 'driving licence',                      expect: 'rop driving licence' },
  { q: 'I lost my civil ID',                  expect: 'civil-status replacement' },
  { q: 'how do I report a labour complaint',  expect: 'mol labour complaints' },

  // Fee / filter exercises
  { q: 'free service',                                  filters: { free: true }, expect: '0 OMR rows' },
  { q: 'business permit muscat municipality',           expect: 'mm with entity match' }
];

console.log('▶ loading embedding cache…');
const cache = await loadEmbeddingCache();
console.log(`  cache: ${cache.count} vectors × ${cache.dim} dims`);

const { rows: tot } = await db.execute('SELECT COUNT(*) AS n FROM service_catalog WHERE is_active=1');
console.log(`  service_catalog active rows: ${tot[0].n}`);

console.log('\n▶ running queries\n');
let pass = 0, fail = 0;
for (const { q, filters, expect } of QUERIES) {
  const trace = [];
  const out = await searchServices(q, filters || {}, { k: 3, useLLMRerank: false, trace });
  console.log(`Q: "${q}"   (expect: ${expect})`);
  console.log(`   filters: ${JSON.stringify(filters || {})}`);
  if (!out.services.length) {
    console.log('   ✗ no hits\n');
    fail++;
    continue;
  }
  for (const s of out.services) {
    console.log(`   • [${s.id}] (${s.matched_by.join('+')}) score=${s.score}  ${s.name_en || s.name_ar}  — ${s.entity_en}`);
  }
  console.log('');
  pass++;
}
console.log(`Summary: ${pass} returned hits, ${fail} empty`);
process.exit(0);
