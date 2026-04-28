// After phase C+D inserts, re-warm Qwen embeddings for the new rows
// (lib/embeddings.js#embedPending() naturally only hits rows where
// embedding_json IS NULL — perfect for incremental warmup) and run a
// few smoke queries that target the new entities.
//
// Usage: node scripts/post_sanad_om_verify.mjs

import 'dotenv/config';
import { db } from '../lib/db.js';
import { embedPending, loadEmbeddingCache, invalidateEmbeddingCache } from '../lib/embeddings.js';
import { searchServices } from '../lib/hybrid_search.js';

console.log('▶ DB state');
const { rows: total } = await db.execute('SELECT COUNT(*) AS n FROM service_catalog WHERE is_active=1');
console.log(`  active services: ${total[0].n}`);
const { rows: pending } = await db.execute(
  'SELECT COUNT(*) AS n FROM service_catalog WHERE is_active=1 AND (embedding_json IS NULL OR embedded_at IS NULL)'
);
console.log(`  embeddings pending: ${pending[0].n}`);

console.log('\n▶ warming embeddings (Qwen text-embedding-v3, 1024-dim)…');
let warmed = 0, cycles = 0;
while (true) {
  const n = await embedPending({ batchSize: 32, maxRows: 200 });
  if (n === 0) break;
  warmed += n;
  cycles++;
  console.log(`  cycle ${cycles}: +${n}  (running total: ${warmed})`);
}
console.log(`✓ embeddings warm: ${warmed} new rows across ${cycles} cycles`);

invalidateEmbeddingCache();
const cache = await loadEmbeddingCache();
console.log(`  cache: ${cache.count} vectors × ${cache.dim} dims`);

// ─── Smoke queries — target the new entities ───────────────────
const QUERIES = [
  ['sanad center services',                'Sanad-Centres-Services hits'],
  ['شهادة وفاة',                            'death certificate (PubProsec / Civil status)'],
  ['عقد عمل',                               'work-contract services (MOL via sanad)'],
  ['مزون كهرباء',                           'Mazoon Electricity'],
  ['register a new business',               'Oman Business Platform / commercial reg'],
  ['I want to publish in the newspaper',    'Oman Daily / Al-Roya semantic match'],
  ['social protection',                     'Social Protection Fund'],
  ['fishery licence',                       'Min. of Agriculture / Fisheries']
];
console.log('\n▶ smoke queries against the new catalogue:');
let pass = 0;
for (const [q, expect] of QUERIES) {
  const out = await searchServices(q, {}, { k: 3 });
  const top = out.services.slice(0, 2);
  console.log(`\n  Q: "${q}"   (expect: ${expect})`);
  if (!top.length) { console.log('     ✗ no hits'); continue; }
  for (const s of top) {
    console.log(`    [${s.id}] ${(s.name_en || s.name_ar || '?').slice(0, 60)}  · ${s.entity_en}  · ${s.matched_by.join('+')}`);
  }
  pass++;
}
console.log(`\nSummary: ${pass}/${QUERIES.length} queries returned hits`);
process.exit(0);
