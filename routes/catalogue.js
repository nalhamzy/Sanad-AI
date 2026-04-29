import { Router } from 'express';
import { db } from '../lib/db.js';
import { embedQuery, cosineTopK } from '../lib/embeddings.js';
import { LLM_ENABLED } from '../lib/llm.js';

export const catalogueRouter = Router();

// ════════════════════════════════════════════════════════════
// Hybrid search: FTS5 BM25 + substring LIKE + Qwen-embedding cosine,
// fused with Reciprocal Rank Fusion (k=60). Same lane structure as the
// annotator dashboard but with citizen-relevant fields only.
//
// Returns each row tagged with `matched_by` (subset of fts/semantic/partial)
// so the UI can show why a hit appeared.
// ════════════════════════════════════════════════════════════
const RRF_K = 60;

async function ftsLane(q, limit = 60) {
  const tokens = q.replace(/[^\p{L}\p{N}\s]/gu, ' ')
                  .split(/\s+/).filter(w => w.length >= 2).slice(0, 8);
  if (!tokens.length) return [];
  const ftsQuery = tokens.map(w => `"${w}"*`).join(' OR ');
  try {
    const { rows } = await db.execute({
      sql: `SELECT service_catalog_fts.rowid AS id, bm25(service_catalog_fts) AS rank
              FROM service_catalog_fts WHERE service_catalog_fts MATCH ?
             ORDER BY rank ASC LIMIT ?`,
      args: [ftsQuery, limit]
    });
    return rows;
  } catch { return []; }
}

async function substringLane(q, limit = 60) {
  const term = q.toLowerCase().trim();
  if (!term || term.length < 2) return [];
  const like = `%${term}%`;
  const { rows } = await db.execute({
    sql: `SELECT s.id FROM service_catalog s
           WHERE s.is_active = 1
             AND (LOWER(s.name_en) LIKE ?
                  OR s.name_ar LIKE ?
                  OR LOWER(COALESCE(s.search_blob,'')) LIKE ?)
           LIMIT ?`,
    args: [like, like, like, limit]
  });
  return rows;
}

async function semanticLane(q, limit = 60) {
  if (!LLM_ENABLED) return [];
  try {
    const vec = await embedQuery(q);
    if (!vec) return [];
    return await cosineTopK(vec, limit, null);
  } catch { return []; }
}

function rrfFuse(lanes) {
  const scores = new Map();
  for (const { name, list } of lanes) {
    list.forEach((r, i) => {
      const prev = scores.get(r.id) || { score: 0, matched_by: new Set() };
      prev.score += 1 / (RRF_K + i + 1);
      prev.matched_by.add(name);
      scores.set(r.id, prev);
    });
  }
  return [...scores.entries()]
    .map(([id, s]) => ({ id, score: s.score, matched_by: [...s.matched_by] }))
    .sort((a, b) => b.score - a.score);
}

// Build the WHERE clause + args for the citizen-side filter set. Designed
// to be ANDed with whatever id-filter the search lanes produce (or used
// alone in browse-mode).
function buildFilterClause({ entity, beneficiary, feeMin, feeMax, hasDocs }) {
  const where = ['s.is_active = 1'];
  const args = [];
  if (entity) { where.push(`s.entity_en = ?`); args.push(entity); }
  if (beneficiary) { where.push(`COALESCE(s.beneficiary,'') = ?`); args.push(beneficiary); }
  // Important: don't COALESCE NULL fees to 0 here. A NULL fee means "unknown
  // / TBD by the office" — it should NOT match the "Free" filter (fee=0).
  // Without COALESCE, NULL comparisons return UNKNOWN → filtered out, which
  // is what we want for any explicit fee bucket.
  if (feeMin != null && !Number.isNaN(feeMin)) { where.push(`s.fee_omr >= ?`); args.push(feeMin); }
  if (feeMax != null && !Number.isNaN(feeMax)) { where.push(`s.fee_omr <= ?`); args.push(feeMax); }
  if (hasDocs === 'yes') where.push(`COALESCE(s.required_documents_json,'') NOT IN ('','[]','null')`);
  if (hasDocs === 'no')  where.push(`COALESCE(s.required_documents_json,'') IN ('','[]','null')`);
  return { clause: `WHERE ${where.join(' AND ')}`, args };
}

const HYBRID_SELECT = `
  s.id, s.entity_en, s.entity_ar, s.name_en, s.name_ar,
  s.description_en, s.description_ar,
  s.fee_omr, s.fees_text, s.avg_time_en, s.avg_time_ar,
  s.beneficiary, s.required_documents_json`;

function shapeRow(r, extras = {}) {
  let docs = [];
  try { docs = JSON.parse(r.required_documents_json || '[]'); } catch {}
  return {
    ...r,
    required_documents_json: undefined,
    doc_count: Array.isArray(docs) ? docs.length : 0,
    ...extras
  };
}

// GET /api/catalogue/hybrid?q=…&entity=…&beneficiary=…&fee_min=&fee_max=&has_docs=&limit=&offset=
// Public — no auth. Used by:
//   • homepage live-search dropdown
//   • account.html dashboard search
//   • catalogue.html browse + filter
// When q is empty, returns paginated browse with the same filters applied.
catalogueRouter.get('/hybrid', async (req, res) => {
  const q          = (req.query.q || '').toString().trim();
  const entity     = (req.query.entity || '').toString().trim();
  const beneficiary= (req.query.beneficiary || '').toString().trim();
  const feeMin     = req.query.fee_min != null && req.query.fee_min !== '' ? Number(req.query.fee_min) : null;
  const feeMax     = req.query.fee_max != null && req.query.fee_max !== '' ? Number(req.query.fee_max) : null;
  const hasDocs    = (req.query.has_docs || '').toString();
  const limit      = Math.min(Number(req.query.limit || 20), 60);
  const offset     = Math.max(Number(req.query.offset || 0), 0);
  const sort       = (req.query.sort || (q ? 'relevance' : 'name')).toString();

  const filters = { entity, beneficiary, feeMin, feeMax, hasDocs };
  const { clause: filterClause, args: filterArgs } = buildFilterClause(filters);

  try {
    // ── Browse mode: no query, paginated SQL with chosen sort ──
    if (!q) {
      const orderClause = {
        name: 'COALESCE(s.name_en, s.name_ar) ASC',
        fee_asc:  'COALESCE(s.fee_omr, 999) ASC',
        fee_desc: 'COALESCE(s.fee_omr, 0) DESC',
        id: 's.id ASC'
      }[sort] || 'COALESCE(s.name_en, s.name_ar) ASC';
      const { rows } = await db.execute({
        sql: `SELECT ${HYBRID_SELECT} FROM service_catalog s
                ${filterClause}
                ORDER BY ${orderClause}
                LIMIT ? OFFSET ?`,
        args: [...filterArgs, limit, offset]
      });
      const { rows: totalRows } = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM service_catalog s ${filterClause}`,
        args: filterArgs
      });
      return res.json({
        results: rows.map(r => shapeRow(r)),
        total: totalRows[0].n, limit, offset,
        search: { mode: 'browse', semantic_available: LLM_ENABLED, filters }
      });
    }

    // ── Hybrid mode: q present ──
    const [fts, sem, sub] = await Promise.all([
      ftsLane(q, 80),
      semanticLane(q, 80),
      substringLane(q, 80)
    ]);

    const fused = rrfFuse([
      { name: 'fts',      list: fts },
      { name: 'semantic', list: sem },
      { name: 'partial',  list: sub }
    ]);

    if (!fused.length) {
      return res.json({
        results: [], total: 0, limit, offset,
        search: { mode: 'hybrid', q, semantic_available: LLM_ENABLED, lanes: { fts: 0, semantic: 0, partial: 0 }, filters }
      });
    }

    // Apply post-filter on the fused candidate set: only keep ids that pass
    // the filter clause. We do it in one IN() query so we don't N+1.
    const fusedIds = fused.map(f => f.id);
    const placeholders = fusedIds.map(() => '?').join(',');
    const { rows: kept } = await db.execute({
      sql: `SELECT ${HYBRID_SELECT} FROM service_catalog s
              ${filterClause}
              AND s.id IN (${placeholders})`,
      args: [...filterArgs, ...fusedIds]
    });
    const byId = new Map(kept.map(r => [r.id, r]));
    const filteredFused = fused.filter(f => byId.has(f.id));
    const total = filteredFused.length;
    const page = filteredFused.slice(offset, offset + limit);

    const results = page
      .map(f => byId.get(f.id) ? shapeRow(byId.get(f.id), {
        relevance: Math.round(f.score * 1000) / 1000,
        matched_by: f.matched_by
      }) : null)
      .filter(Boolean);

    res.json({
      results, total, limit, offset,
      search: {
        mode: 'hybrid', q,
        semantic_available: LLM_ENABLED,
        lanes: { fts: fts.length, semantic: sem.length, partial: sub.length },
        filters
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public search across all 3,417 services (+ launch services). Uses FTS5.
catalogueRouter.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const entity = (req.query.entity || '').toString().trim();
  const limit = Math.min(Number(req.query.limit || 40), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  try {
    let rows;
    if (q) {
      const ftsQuery = q.replace(/[^\p{L}\p{N}\s]/gu, ' ')
                        .split(/\s+/).filter(w => w.length >= 2)
                        .slice(0, 8).map(w => w + '*').join(' OR ');
      if (ftsQuery) {
        const r = await db.execute({
          sql: `SELECT s.id, s.entity_en, s.entity_ar, s.name_en, s.name_ar,
                       s.fee_omr, s.fees_text, s.is_active, s.version, s.source_url,
                       bm25(service_catalog_fts) AS rank
                  FROM service_catalog_fts f
                  JOIN service_catalog s ON s.id = f.rowid
                 WHERE service_catalog_fts MATCH ?
                   ${entity ? 'AND s.entity_en = ?' : ''}
                 ORDER BY rank
                 LIMIT ? OFFSET ?`,
          args: entity ? [ftsQuery, entity, limit, offset] : [ftsQuery, limit, offset]
        });
        rows = r.rows;
      } else {
        rows = [];
      }
    } else {
      const r = await db.execute({
        sql: `SELECT id, entity_en, entity_ar, name_en, name_ar, fee_omr, fees_text, is_active, version, source_url
                FROM service_catalog
               ${entity ? 'WHERE entity_en = ?' : ''}
               ORDER BY id ASC LIMIT ? OFFSET ?`,
        args: entity ? [entity, limit, offset] : [limit, offset]
      });
      rows = r.rows;
    }
    const { rows: total } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
    res.json({ results: rows, total: total[0].n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Entity list with counts
catalogueRouter.get('/entities', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT entity_en, entity_ar, COUNT(*) AS n
      FROM service_catalog
     WHERE entity_en != ''
     GROUP BY entity_en
     ORDER BY n DESC
  `);
  res.json({ entities: rows });
});

// Beneficiary list (Citizen / Resident / Business / Tourist / etc.)
catalogueRouter.get('/beneficiaries', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT COALESCE(beneficiary, '') AS beneficiary, COUNT(*) AS n
      FROM service_catalog
     WHERE COALESCE(beneficiary,'') != ''
     GROUP BY beneficiary
     ORDER BY n DESC
  `);
  res.json({ beneficiaries: rows });
});

// Fee buckets — for the citizen UI to show coarse "free / under 10 / 10-50 / 50+"
catalogueRouter.get('/fee-buckets', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT
      SUM(CASE WHEN fee_omr = 0 THEN 1 ELSE 0 END) AS free_count,
      SUM(CASE WHEN fee_omr > 0 AND fee_omr < 10 THEN 1 ELSE 0 END) AS lt10,
      SUM(CASE WHEN fee_omr >= 10 AND fee_omr < 50 THEN 1 ELSE 0 END) AS m10_50,
      SUM(CASE WHEN fee_omr >= 50 THEN 1 ELSE 0 END) AS gte50,
      SUM(CASE WHEN fee_omr IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM service_catalog WHERE is_active = 1
  `);
  res.json({ buckets: rows[0] });
});

// One service by id
catalogueRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT * FROM service_catalog WHERE id=?`, args: [id]
  });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const svc = rows[0];
  svc.required_documents = svc.required_documents_json ? JSON.parse(svc.required_documents_json) : [];
  delete svc.required_documents_json;
  delete svc.process_steps_json;
  res.json({ service: svc });
});
