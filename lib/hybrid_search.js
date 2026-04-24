// ────────────────────────────────────────────────────────────
// Hybrid search: FTS5 BM25 + Qwen embeddings + structured filters + RRF.
//
// Pipeline:
//   1. Apply structured WHERE filters → candidate id set (or null = all)
//   2. FTS5 match on tokenized query → top 50 by BM25
//   3. Semantic cosine on query embedding → top 50 within candidates
//   4. Reciprocal Rank Fusion (k=60), boost is_launch + log(popularity)
//   5. Optional LLM rerank over top 10
//
// Gracefully degrades:
//   • no LLM key  → FTS-only (semantic layer skipped)
//   • no FTS hits → semantic only
//   • neither     → empty result + suggestion
// ────────────────────────────────────────────────────────────

import { db } from './db.js';
import { embedQuery, cosineTopK } from './embeddings.js';
import { chat, LLM_ENABLED } from './llm.js';
import { normalize } from './catalogue.js';

const RRF_K = 60;
const LAUNCH_BOOST = 0.05;

// Strip FTS5 syntax characters from the user query so a stray `"` or `*`
// doesn't blow up the MATCH clause.
function sanitizeFtsQuery(q) {
  if (!q) return '';
  const tokens = normalize(q).split(/\s+/)
    .filter(t => t.length >= 2)
    .map(t => t.replace(/[^\p{L}\p{N}]/gu, ''));
  if (!tokens.length) return '';
  // "OR" connective so one misspelled token doesn't kill recall; rare
  // misses get picked up by the semantic lane.
  return tokens.map(t => `"${t}"`).join(' OR ');
}

// ─── Structured filter → candidate ID set (or null = no restriction) ──
async function buildCandidateSet(filters = {}) {
  const wh = [];
  const args = [];
  const push = (clause, ...a) => { wh.push(clause); args.push(...a); };

  if (filters.entity) {
    push(`(LOWER(entity_en) LIKE ? OR entity_ar LIKE ?)`,
         `%${filters.entity.toLowerCase()}%`, `%${filters.entity}%`);
  }
  if (filters.beneficiary) {
    push(`LOWER(COALESCE(beneficiary,'')) LIKE ?`, `%${filters.beneficiary.toLowerCase()}%`);
  }
  if (filters.payment_method) {
    push(`LOWER(COALESCE(payment_method,'')) LIKE ?`, `%${filters.payment_method.toLowerCase()}%`);
  }
  if (filters.channel) {
    push(`LOWER(COALESCE(channels,'')) LIKE ?`, `%${filters.channel.toLowerCase()}%`);
  }
  if (filters.is_launch) {
    push(`is_launch=1`);
  }
  if (filters.max_fee_omr != null) {
    push(`fee_omr IS NOT NULL AND fee_omr <= ?`, Number(filters.max_fee_omr));
  }
  if (filters.free === true) {
    push(`fee_omr = 0`);
  }
  if (!wh.length) return null;

  const { rows } = await db.execute({
    sql: `SELECT id FROM service_catalog WHERE is_active=1 AND ${wh.join(' AND ')} LIMIT 2000`,
    args
  });
  return new Set(rows.map(r => r.id));
}

// ─── FTS5 BM25 ─────────────────────────────────────────────
async function ftsSearch(query, candidateIds, limit = 50) {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  try {
    const { rows } = await db.execute({
      sql: `SELECT s.id, s.name_en, s.name_ar, s.entity_en, s.entity_ar,
                   s.fee_omr, s.is_launch, s.popularity,
                   bm25(service_catalog_fts) AS rank
              FROM service_catalog_fts
              JOIN service_catalog s ON s.id = service_catalog_fts.rowid
             WHERE service_catalog_fts MATCH ? AND s.is_active=1
             ORDER BY rank ASC LIMIT ?`,
      args: [match, limit]
    });
    if (candidateIds) return rows.filter(r => candidateIds.has(r.id));
    return rows;
  } catch (e) {
    console.warn('[hybrid] FTS failed:', e.message);
    return [];
  }
}

// ─── LIKE fallback (when FTS is empty or barfs) ───────────
async function likeSearch(query, candidateIds, limit = 50) {
  const tokens = normalize(query).split(/\s+/).filter(t => t.length >= 3).slice(0, 4);
  if (!tokens.length) return [];
  const wh = tokens.map(() => `(LOWER(name_en) LIKE ? OR name_ar LIKE ? OR LOWER(search_blob) LIKE ?)`).join(' AND ');
  const args = tokens.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, is_launch, popularity
            FROM service_catalog WHERE is_active=1 AND ${wh} LIMIT ?`,
    args: [...args, limit]
  });
  if (candidateIds) return rows.filter(r => candidateIds.has(r.id));
  return rows;
}

// ─── Reciprocal Rank Fusion ────────────────────────────────
function rrfFuse({ ftsResults, semResults, byId }) {
  const scores = new Map();
  const bump = (id, rank, source) => {
    const prev = scores.get(id) || { score: 0, matched_by: new Set() };
    prev.score += 1 / (RRF_K + rank);
    prev.matched_by.add(source);
    scores.set(id, prev);
  };
  ftsResults.forEach((r, i) => bump(r.id, i + 1, 'fts'));
  semResults.forEach((r, i) => bump(r.id, i + 1, 'semantic'));

  // Boosts — launch service priority + popularity log.
  for (const [id, s] of scores) {
    const row = byId.get(id);
    if (!row) continue;
    if (row.is_launch) s.score += LAUNCH_BOOST;
    if (row.popularity && row.popularity > 0) s.score += Math.log1p(row.popularity) / 50;
  }

  return [...scores.entries()]
    .map(([id, s]) => ({
      id,
      score: s.score,
      matched_by: [...s.matched_by],
      row: byId.get(id)
    }))
    .filter(r => r.row)
    .sort((a, b) => b.score - a.score);
}

// ─── Optional LLM rerank ───────────────────────────────────
async function llmRerank(query, fused, trace) {
  if (!LLM_ENABLED || fused.length <= 1) return fused;
  const top = fused.slice(0, 10);
  const list = top.map((c, i) =>
    `${i + 1}. [id=${c.id}] ${c.row.name_en || ''} / ${c.row.name_ar || ''} — ${c.row.entity_en || ''}`
  ).join('\n');
  const reply = await chat({
    system: 'You rank candidate Oman government services by relevance to a user query. Reply with ONLY a JSON array of ids in order, e.g. [551, 12, 330]. No prose.',
    user: `USER QUERY: "${query}"\n\nCANDIDATES:\n${list}\n\nReturn a JSON array of the ids in best-to-worst order (include only ids that are plausibly relevant).`,
    max_tokens: 120,
    trace
  });
  try {
    const ids = JSON.parse(String(reply).match(/\[[^\]]*\]/)?.[0] || '[]');
    if (Array.isArray(ids) && ids.length) {
      const order = new Map(ids.map((id, i) => [Number(id), i]));
      const ranked = [...top].sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : 99;
        const bi = order.has(b.id) ? order.get(b.id) : 99;
        return ai - bi;
      });
      return [...ranked, ...fused.slice(10)];
    }
  } catch {}
  return fused;
}

// ─── Public API ────────────────────────────────────────────
export async function searchServices(query, filters = {}, { k = 10, useLLMRerank = false, trace } = {}) {
  if (!query && !Object.keys(filters).length) return { services: [], count: 0 };

  const candidateIds = await buildCandidateSet(filters);
  trace?.push({ step: 'hybrid_filters', candidates: candidateIds?.size ?? 'unrestricted' });

  // Parallel lanes — FTS runs regardless; semantic lane fires only when the
  // LLM key is set.
  const [ftsRaw, queryVec] = await Promise.all([
    query ? ftsSearch(query, candidateIds, 50) : Promise.resolve([]),
    query ? embedQuery(query) : Promise.resolve(null)
  ]);

  let ftsResults = ftsRaw;
  if (query && ftsResults.length === 0) {
    ftsResults = await likeSearch(query, candidateIds, 50);
  }

  let semResults = [];
  if (queryVec) {
    const topSem = await cosineTopK(queryVec, 50, candidateIds);
    if (topSem.length) {
      const semIds = topSem.map(x => x.id);
      const placeholders = semIds.map(() => '?').join(',');
      const { rows } = await db.execute({
        sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, is_launch, popularity
                FROM service_catalog WHERE id IN (${placeholders})`,
        args: semIds
      });
      const byId = new Map(rows.map(r => [r.id, r]));
      semResults = topSem.map(x => byId.get(x.id)).filter(Boolean);
    }
  }

  // Build byId lookup for both lanes.
  const byId = new Map();
  for (const r of ftsResults) byId.set(r.id, r);
  for (const r of semResults) byId.set(r.id, r);

  // If neither lane returned anything but we had filters, just return the
  // filter results (candidate set) so "list all free services" works.
  if (byId.size === 0 && candidateIds && candidateIds.size) {
    const ids = [...candidateIds].slice(0, k);
    const placeholders = ids.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, is_launch, popularity
              FROM service_catalog WHERE id IN (${placeholders})
             ORDER BY is_launch DESC, popularity DESC, id ASC`,
      args: ids
    });
    return { services: rows.map(r => ({ ...r, matched_by: ['filter'] })), count: rows.length };
  }

  let fused = rrfFuse({ ftsResults, semResults, byId });
  if (!fused.length) return { services: [], count: 0 };

  if (useLLMRerank && fused.length > 1) {
    fused = await llmRerank(query, fused, trace);
  }

  const services = fused.slice(0, k).map(c => ({
    id: c.row.id,
    name_en: c.row.name_en, name_ar: c.row.name_ar,
    entity_en: c.row.entity_en, entity_ar: c.row.entity_ar,
    fee_omr: c.row.fee_omr,
    is_launch: !!c.row.is_launch,
    score: Math.round(c.score * 1000) / 1000,
    matched_by: c.matched_by
  }));

  trace?.push({ step: 'hybrid_ranked', top: services.slice(0, 3).map(s => [s.id, s.score, s.matched_by]) });
  return { services, count: services.length };
}
