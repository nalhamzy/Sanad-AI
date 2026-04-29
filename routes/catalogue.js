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

// GET /api/catalogue/hybrid?q=…&limit=10
// Public — no auth, used by the citizen homepage live-search box +
// account.html dashboard.
catalogueRouter.get('/hybrid', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const entity = (req.query.entity || '').toString().trim();
  const limit = Math.min(Number(req.query.limit || 10), 30);

  try {
    if (!q) {
      // No query — return empty so the UI shows the empty state.
      return res.json({
        results: [], total: 0, limit,
        search: { mode: 'browse', semantic_available: LLM_ENABLED }
      });
    }

    const [fts, sem, sub] = await Promise.all([
      ftsLane(q, 60),
      semanticLane(q, 60),
      substringLane(q, 60)
    ]);

    const fused = rrfFuse([
      { name: 'fts',      list: fts },
      { name: 'semantic', list: sem },
      { name: 'partial',  list: sub }
    ]);

    if (!fused.length) {
      return res.json({
        results: [], total: 0, limit,
        search: { mode: 'hybrid', q, semantic_available: LLM_ENABLED, lanes: { fts: 0, semantic: 0, partial: 0 } }
      });
    }

    const pageIds = fused.slice(0, limit).map(x => x.id);
    const placeholders = pageIds.map(() => '?').join(',');
    const args = entity ? [...pageIds, entity] : pageIds;
    const where = entity ? `WHERE s.id IN (${placeholders}) AND s.entity_en = ?`
                         : `WHERE s.id IN (${placeholders})`;
    const { rows } = await db.execute({
      sql: `SELECT s.id, s.entity_en, s.entity_ar, s.name_en, s.name_ar,
                   s.fee_omr, s.fees_text, s.avg_time_en, s.avg_time_ar,
                   s.required_documents_json
              FROM service_catalog s
              ${where}`,
      args
    });
    const byId = new Map(rows.map(r => [r.id, r]));

    const results = fused.slice(0, limit)
      .map(f => {
        const r = byId.get(f.id);
        if (!r) return null;
        let docs = [];
        try { docs = JSON.parse(r.required_documents_json || '[]'); } catch {}
        return {
          ...r,
          required_documents_json: undefined,
          doc_count: Array.isArray(docs) ? docs.length : 0,
          relevance: Math.round(f.score * 1000) / 1000,
          matched_by: f.matched_by
        };
      })
      .filter(Boolean);

    res.json({
      results,
      total: fused.length,
      limit,
      search: {
        mode: 'hybrid', q,
        semantic_available: LLM_ENABLED,
        lanes: { fts: fts.length, semantic: sem.length, partial: sub.length }
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
