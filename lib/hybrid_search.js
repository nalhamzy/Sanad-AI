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
// Launch services are now a GENTLE tiebreaker only — every catalogue service is
// fulfillable (TOOL_IMPL_V2.start_submission accepts any id), so relevance must
// dominate. The old 0.05 swamped RRF (a rank-1 lane contribution is only ~0.016),
// which floated the 5 launch services to the top of every query (prod bug: a
// "renew domestic-worker residency" query returned commercial-reg + driving-licence).
const LAUNCH_BOOST = 0.004;
// Cross-lane agreement (matched by BOTH lexical FTS and semantic embeddings) is the
// strongest relevance signal — reward it so semantically-correct matches outrank
// single-lane keyword hits on a common word like "تجديد" (renew).
const MULTILANE_BONUS = 0.012;

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

  // Verified-only gate (SANAD_VERIFIED_ONLY=true): restrict EVERY search lane to
  // office-approved / annotator-validated services (+ the curated launch flows),
  // so unverified scraped rows are never offered to citizens. When nothing
  // verified matches, the search returns empty and the agent routes to triage.
  // Read at call time so it can be flipped per-deploy without a code change.
  if (process.env.SANAD_VERIFIED_ONLY === 'true') {
    push(`(verification_status IN ('office_approved','annotator_validated') OR is_launch=1)`);
  }

  if (filters.entity) {
    push(`(LOWER(entity_en) LIKE ? OR entity_ar LIKE ?)`,
         `%${filters.entity.toLowerCase()}%`, `%${filters.entity}%`);
  }
  if (filters.beneficiary) {
    // Map common LLM-side names ("Citizen", "Business", "Resident") to the
    // tags actually stored in the catalogue ("G2C" + الأفراد, "G2B" + الأعمال,
    // "G2E" + موظف). Match if ANY synonym hits, so the LLM doesn't have to
    // know the exact catalogue vocabulary.
    const b = String(filters.beneficiary).toLowerCase().trim();
    const groups = [];
    if (/citizen|individual|person|fardd|fard|resident|مواطن|أفراد|الأفراد|فرد/i.test(b)) {
      groups.push('g2c', 'الأفراد', 'أفراد', 'مواطن');
    }
    if (/business|company|firm|institution|قطاع|الأعمال|شرك/i.test(b)) {
      groups.push('g2b', 'الأعمال', 'قطاع');
    }
    if (/employee|staff|gov|government|موظف|الموظفين/i.test(b)) {
      groups.push('g2e', 'موظف');
    }
    if (!groups.length) groups.push(b);  // fall back to the raw input
    const ors = groups.map(() => `LOWER(COALESCE(beneficiary,'')) LIKE ?`).join(' OR ');
    push(`(${ors})`, ...groups.map(g => `%${g.toLowerCase()}%`));
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
  // Two token forms — the search_blob is only LOWERCASED, not ta-marbuta /
  // alef normalized. NORMALIZED tokens (alef/ya unified) catch alef-variant
  // mismatches; RAW tokens (ة / أ preserved) catch the huge class of service
  // words ending in ة (رخصة / قيادة / تأشيرة / إقامة …) that a normalized token
  // like "رخصه" would NEVER LIKE-match against a raw blob "رخصة". Without the
  // raw form the lexical lane silently died for most ة-ending names, leaving an
  // undifferentiated semantic-only list (every row ~0.016 → noisy, unrankable).
  const _norm = normalize(query).split(/\s+/).filter(t => t.length >= 3);
  const _raw  = String(query || '').toLowerCase().split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(t => t.length >= 3);
  const tokens = [...new Set([..._norm, ..._raw])].slice(0, 10);
  if (!tokens.length) return [];
  // Per-token substring test across name + the normalized search_blob.
  const tokExpr = `(LOWER(COALESCE(name_en,'')) LIKE ? OR COALESCE(name_ar,'') LIKE ? OR LOWER(COALESCE(search_blob,'')) LIKE ?)`;
  const tokArgs = (t) => [`%${t}%`, `%${t}%`, `%${t}%`];
  // OR across tokens for RECALL — a natural query carries filler words
  // ("أبغى", "أجدد", "بغيت اسوي") that appear in NO service name. The old
  // ' AND ' join required every token as a substring, so one filler word
  // zeroed the whole match: the lexical lane returned nothing and only the
  // semantic lane survived → "أبغى أجدد رخصة القيادة" ranked visas, not the
  // driving-licence service. OR fixes recall; ORDER BY match-count (mc)
  // restores PRECISION so a row hitting both "رخصة" and "قيادة" outranks a
  // single-token hit. (FTS5's own MATCH returns nothing for these Arabic
  // phrases, so likeSearch is the de-facto lexical lane — it must be robust.)
  const orWh   = tokens.map(() => tokExpr).join(' OR ');
  const mcExpr = tokens.map(() => `(CASE WHEN ${tokExpr} THEN 1 ELSE 0 END)`).join(' + ');
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, is_launch, popularity,
                 (${mcExpr}) AS mc
            FROM service_catalog
           WHERE is_active=1 AND (${orWh})
           ORDER BY mc DESC, is_launch DESC, popularity DESC LIMIT ?`,
    args: [...tokens.flatMap(tokArgs), ...tokens.flatMap(tokArgs), limit]
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
    // Cross-lane agreement first — it's the dominant relevance signal.
    if (s.matched_by.has('fts') && s.matched_by.has('semantic')) s.score += MULTILANE_BONUS;
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
  // filter results (candidate set) so "list all free services" works. EXCEPTION:
  // under the verified-only gate, a TEXT query that matched nothing must stay
  // empty (→ triage) instead of falling back to the entire verified set.
  const _verifiedGate = process.env.SANAD_VERIFIED_ONLY === 'true';
  if (byId.size === 0 && candidateIds && candidateIds.size && !(_verifiedGate && query)) {
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

  // Collapse same-named services so the citizen never sees a service twice.
  // Two cases: (a) Arabic character variants — Farsi yeh ی U+06CC vs Arabic yeh
  // ي U+064A ("تجدید السجل التجاري" vs "تجديد السجل التجاري"); (b) the same
  // service offered through multiple channels/entities (e.g. Ministry of Commerce
  // vs Oman Business Platform; Oman vs Al-Roya newspaper). We dedup on the
  // normalized NAME only and keep the highest-ranked row — the receiving office
  // handles the channel. (Only ~9 such name-collision groups in the catalogue.)
  const _dedupKey = (c) => String(c.row.name_ar || '')
    .replace(/[ً-ْ]/g, '')               // strip tashkeel
    .replace(/[ىيی]/g, 'ي')    // alef-maksura / farsi yeh → yeh
    .replace(/[كک]/g, 'ك')          // farsi kaf → arabic kaf
    .replace(/[أإآا]/g, 'ا')// alef variants → bare alef
    .replace(/ة/g, 'ه')                  // ta-marbuta → ha
    .replace(/\s+/g, ' ').trim();
  const _seenDup = new Set();
  fused = fused.filter((c) => {
    const key = _dedupKey(c);
    if (_seenDup.has(key)) return false;
    _seenDup.add(key);
    return true;
  });

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
