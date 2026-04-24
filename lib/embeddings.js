// ────────────────────────────────────────────────────────────
// Embedding worker + in-memory cache for the service catalogue.
//
// On boot we embed every row once using Qwen `text-embedding-v3`
// (1024-dim) and persist the vector as JSON in service_catalog.embedding_json.
// The first call to loadEmbeddingCache() packs all vectors into a single
// Float32Array for O(N) cosine scans. With ~3.4k rows × 1024 floats that's
// ≈14 MB — plenty for a Node process and a cosine sweep clocks at ~15 ms.
//
// The worker is fire-and-forget: server.js calls embedPending() in a loop
// until it returns 0, so first boot finishes warm ~90 s after start while
// the process is already accepting chat traffic (falls back to FTS-only
// until the cache is warm).
// ────────────────────────────────────────────────────────────

import { db } from './db.js';
import { embed, EMBED_DIM, LLM_ENABLED } from './llm.js';

// Compact context per service — what we stuff into the embedding model.
// Short enough to keep batch requests cheap, long enough that semantic
// matches for EN+AR queries land on the right row.
export function computeEmbeddingText(row) {
  const steps = (() => { try { return JSON.parse(row.process_steps_json || '[]'); } catch { return []; } })();
  const firstSteps = steps.slice(0, 2).map(s => `${s.en || ''} / ${s.ar || ''}`).join(' | ');
  const parts = [
    row.name_en, row.name_ar,
    row.entity_en, row.entity_ar,
    row.entity_dept_en, row.entity_dept_ar,
    row.beneficiary, row.main_service,
    row.description_en?.slice(0, 240),
    row.description_ar?.slice(0, 240),
    firstSteps
  ].filter(Boolean);
  return parts.join(' \u2022 ').slice(0, 800);
}

// Embed up to `maxRows` rows that still lack vectors. Returns the number of
// rows actually written (0 → done). The boot loop keeps calling this until 0.
export async function embedPending({ batchSize = 32, maxRows = 200 } = {}) {
  if (!LLM_ENABLED) return 0;
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, entity_dept_en, entity_dept_ar,
                 beneficiary, main_service, description_en, description_ar, process_steps_json
            FROM service_catalog
           WHERE is_active=1 AND (embedding_json IS NULL OR embedded_at IS NULL)
           LIMIT ?`,
    args: [maxRows]
  });
  if (!rows.length) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const inputs = slice.map(computeEmbeddingText);
    const vecs = await embed(inputs);
    if (!vecs) {
      console.warn('[embed] API unavailable — will retry next cycle');
      return written; // stop early; caller re-schedules
    }
    const now = Date.now();
    // libSQL supports batched writes via db.batch — one round-trip per slice.
    await db.batch(
      slice.map((r, j) => ({
        sql: `UPDATE service_catalog SET embedding_json=?, embedded_at=? WHERE id=?`,
        args: [JSON.stringify(vecs[j] || []), now, r.id]
      })),
      'write'
    );
    written += slice.length;
    _cache = null; // invalidate
  }
  return written;
}

// ─── In-memory cache (Float32Array) ────────────────────────

let _cache = null; // { ids: Int32Array, vecs: Float32Array, dim, count }

export async function loadEmbeddingCache({ force = false } = {}) {
  if (_cache && !force) return _cache;
  const { rows } = await db.execute({
    sql: `SELECT id, embedding_json FROM service_catalog
           WHERE is_active=1 AND embedding_json IS NOT NULL`
  });
  if (!rows.length) {
    _cache = { ids: new Int32Array(0), vecs: new Float32Array(0), dim: EMBED_DIM, count: 0 };
    return _cache;
  }
  const count = rows.length;
  const ids = new Int32Array(count);
  let dim = EMBED_DIM;
  // Peek first row to find actual dim.
  try {
    const first = JSON.parse(rows[0].embedding_json);
    if (Array.isArray(first) && first.length) dim = first.length;
  } catch {}
  const vecs = new Float32Array(count * dim);
  let kept = 0;
  for (let i = 0; i < rows.length; i++) {
    let arr;
    try { arr = JSON.parse(rows[i].embedding_json); } catch { arr = null; }
    if (!Array.isArray(arr) || arr.length !== dim) continue;
    ids[kept] = rows[i].id;
    for (let j = 0; j < dim; j++) vecs[kept * dim + j] = arr[j];
    kept++;
  }
  _cache = {
    ids: ids.slice(0, kept),
    vecs: vecs.slice(0, kept * dim),
    dim,
    count: kept
  };
  return _cache;
}

export function invalidateEmbeddingCache() { _cache = null; }

// Top-K cosine similarity. Returns [{id, score}] sorted descending.
// `filterIds` (Set<number> | null) restricts the scan to matching ids
// when provided — used by hybrid_search for structured pre-filtering.
export async function cosineTopK(queryVec, k = 50, filterIds = null) {
  const cache = await loadEmbeddingCache();
  if (!cache.count || !queryVec) return [];
  const { ids, vecs, dim, count } = cache;
  if (queryVec.length !== dim) return [];

  // Pre-normalize query so score = dot(q_hat, r) / |r|.
  let qNorm = 0;
  for (let j = 0; j < dim; j++) qNorm += queryVec[j] * queryVec[j];
  qNorm = Math.sqrt(qNorm) || 1;
  const q = new Float32Array(dim);
  for (let j = 0; j < dim; j++) q[j] = queryVec[j] / qNorm;

  // Min-heap via simple array; for k=50 on 3k rows this is a non-issue.
  const heap = []; // [score, id]
  const push = (score, id) => {
    if (heap.length < k) {
      heap.push([score, id]);
      if (heap.length === k) heap.sort((a, b) => a[0] - b[0]);
    } else if (score > heap[0][0]) {
      heap[0] = [score, id];
      // Re-sink: heap is kept sorted ascending so heap[0] is min.
      heap.sort((a, b) => a[0] - b[0]);
    }
  };

  for (let i = 0; i < count; i++) {
    const id = ids[i];
    if (filterIds && !filterIds.has(id)) continue;
    let dot = 0, rNorm = 0;
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      const v = vecs[base + j];
      dot += v * q[j];
      rNorm += v * v;
    }
    const score = dot / (Math.sqrt(rNorm) || 1);
    push(score, id);
  }

  return heap.sort((a, b) => b[0] - a[0]).map(([score, id]) => ({ id, score }));
}

// Embed a single user query. Returns Float32Array or null when offline.
export async function embedQuery(text) {
  if (!LLM_ENABLED) return null;
  const out = await embed([text]);
  if (!out || !out[0]) return null;
  return Float32Array.from(out[0]);
}
