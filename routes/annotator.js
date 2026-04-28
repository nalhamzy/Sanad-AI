// ─────────────────────────────────────────────────────────────
// Annotator API — review / edit / validate services in the catalogue.
//
// Auth is intentionally stubbed (the client passes an annotator_id in
// the `X-Annotator-Id` header or query/body). Swap for real auth later.
//
// Endpoints:
//   GET  /annotators                    list annotators (for picker)
//   POST /annotators                    create annotator {name,email}
//   GET  /services                      search + filter + paginate
//   GET  /services/:id                  full detail + validation history
//   POST /services                      create new service (annotator-only)
//   PATCH /services/:id                 edit fields — bumps version, audits
//   POST /services/:id/validate         record validation
//   POST /services/:id/unvalidate       remove the latest validation
//   GET  /stats                         global + per-annotator counts
// ─────────────────────────────────────────────────────────────

import { Router } from 'express';
import { db } from '../lib/db.js';
import { embedQuery, cosineTopK } from '../lib/embeddings.js';
import { LLM_ENABLED } from '../lib/llm.js';

export const annotatorRouter = Router();

// ─── Helpers ────────────────────────────────────────────────
function actingAnnotator(req) {
  const id = Number(
    req.header('x-annotator-id') || req.query.annotator_id || req.body?.annotator_id || 0
  );
  return id > 0 ? id : null;
}

const EDITABLE_FIELDS = [
  'entity_en', 'entity_ar',
  'name_en', 'name_ar',
  'description_en', 'description_ar',
  'fees_text', 'fee_omr',
  'required_documents_json',
  'process_steps_json',
  'source_url',
  'is_active'
];

function toSearchBlob(svc) {
  return [
    svc.name_en, svc.name_ar, svc.entity_en, svc.entity_ar,
    svc.description_en, svc.description_ar, svc.fees_text
  ].filter(Boolean).join(' ').toLowerCase();
}

// ─── Annotators ─────────────────────────────────────────────

annotatorRouter.get('/annotators', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT a.id, a.name, a.email, a.created_at,
           (SELECT COUNT(*) FROM service_validation v WHERE v.annotator_id = a.id) AS validations
      FROM annotator a
     ORDER BY a.id ASC
  `);
  res.json({ annotators: rows });
});

annotatorRouter.post('/annotators', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  try {
    const r = await db.execute({
      sql: `INSERT INTO annotator(name,email) VALUES (?,?)`,
      args: [name.trim(), (email || '').trim() || null]
    });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Services search ────────────────────────────────────────
//
// Hybrid search pipeline (used when ?q= is present):
//   1. Apply structured filters (entity, fee, has_docs, active, validation
//      status) → candidate id Set or null=all.
//   2. Three parallel scoring lanes within the candidate set:
//        a) FTS5 BM25 — keyword match with prefix wildcards on tokens
//        b) Substring LIKE — true infix match on name_en/name_ar/search_blob
//           (catches what FTS prefix-only misses, e.g. "ence" in "licence")
//        c) Semantic cosine — Qwen embedding of the query against the
//           pre-computed catalogue embeddings (concept matching, AR↔EN
//           cross-language)
//   3. Reciprocal Rank Fusion across the 3 lanes (k=60), with a "matched_by"
//      tag per row so the UI can show why a row was found.
//   4. Pagination on the fused result list.
//
// When q is empty, fall back to plain SQL with the chosen sort (id / name /
// fee / updated). Returns the same shape either way.
const RRF_K = 60;

function buildFiltersClause({ entity, status, feeMin, feeMax, hasDocs, active }) {
  const where = [];
  const args = [];
  if (entity) { where.push(`s.entity_en = ?`); args.push(entity); }
  if (feeMin != null && !Number.isNaN(feeMin)) { where.push(`COALESCE(s.fee_omr, 0) >= ?`); args.push(feeMin); }
  if (feeMax != null && !Number.isNaN(feeMax)) { where.push(`COALESCE(s.fee_omr, 0) <= ?`); args.push(feeMax); }
  if (hasDocs === 'yes') where.push(`COALESCE(s.required_documents_json,'') NOT IN ('', '[]', 'null')`);
  if (hasDocs === 'no')  where.push(`COALESCE(s.required_documents_json,'') IN ('', '[]', 'null')`);
  if (active === 'yes')  where.push(`s.is_active = 1`);
  if (active === 'no')   where.push(`s.is_active = 0`);
  if (status === 'validated')    where.push(`EXISTS (SELECT 1 FROM service_validation v WHERE v.service_id = s.id AND v.status = 'validated')`);
  if (status === 'pending')      where.push(`NOT EXISTS (SELECT 1 FROM service_validation v WHERE v.service_id = s.id AND v.status = 'validated')`);
  if (status === 'needs_review') where.push(`EXISTS (SELECT 1 FROM service_validation v WHERE v.service_id = s.id AND v.status = 'needs_review')`);
  return { where, args, clause: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

const SELECT_COLUMNS = `
  s.id, s.entity_en, s.entity_ar, s.name_en, s.name_ar,
  s.fee_omr, s.fees_text, s.is_active, s.version, s.source_url,
  s.required_documents_json, s.updated_at, s.last_edited_by,
  (SELECT v.status FROM service_validation v WHERE v.service_id = s.id
    ORDER BY v.created_at DESC LIMIT 1) AS validation_status,
  (SELECT v.annotator_id FROM service_validation v WHERE v.service_id = s.id
    ORDER BY v.created_at DESC LIMIT 1) AS validated_by,
  (SELECT a.name FROM service_validation v JOIN annotator a ON a.id = v.annotator_id
    WHERE v.service_id = s.id ORDER BY v.created_at DESC LIMIT 1) AS validated_by_name,
  (SELECT v.created_at FROM service_validation v WHERE v.service_id = s.id
    ORDER BY v.created_at DESC LIMIT 1) AS validated_at`;

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

// Pre-filter candidate id set; null = no restriction (faster path).
async function loadCandidateIds(filterClause, filterArgs) {
  if (!filterClause) return null;
  const { rows } = await db.execute({
    sql: `SELECT s.id FROM service_catalog s ${filterClause}`,
    args: filterArgs
  });
  return new Set(rows.map(r => r.id));
}

// FTS lane: tokenize, OR-join with prefix wildcards. Returns [{id, rank}].
async function ftsLane(q, candidateIds, limit = 80) {
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
    return candidateIds ? rows.filter(r => candidateIds.has(r.id)) : rows;
  } catch { return []; }
}

// Substring lane: true infix LIKE. SQLite indexes don't help here so we cap
// to 80 hits and only fire when q is short enough to be cheap.
async function substringLane(q, candidateIds, limit = 80) {
  const term = q.toLowerCase().trim();
  if (!term || term.length < 2) return [];
  const like = `%${term}%`;
  const { rows } = await db.execute({
    sql: `SELECT s.id FROM service_catalog s
           WHERE s.is_active = 1
             AND (LOWER(s.name_en) LIKE ?
                  OR s.name_ar LIKE ?
                  OR LOWER(s.search_blob) LIKE ?)
           LIMIT ?`,
    args: [like, like, like, limit]
  });
  return candidateIds ? rows.filter(r => candidateIds.has(r.id)) : rows;
}

// Semantic lane: query embedding × catalogue embeddings via cosine top-K.
async function semanticLane(q, candidateIds, limit = 80) {
  if (!LLM_ENABLED) return [];
  const vec = await embedQuery(q);
  if (!vec) return [];
  return await cosineTopK(vec, limit, candidateIds);
}

// RRF fusion of N ranked lists; preserves matched_by tags.
function rrfFuse(lanes) {
  const scores = new Map(); // id → { score, matched_by }
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

annotatorRouter.get('/services', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const entity = (req.query.entity || '').toString().trim();
  const status = (req.query.status || '').toString().trim();
  const feeMin = req.query.fee_min != null ? Number(req.query.fee_min) : null;
  const feeMax = req.query.fee_max != null ? Number(req.query.fee_max) : null;
  const hasDocs = req.query.has_docs;
  const active = req.query.active;
  const limit = Math.min(Number(req.query.limit || 40), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const sort = (req.query.sort || (q ? 'relevance' : 'id')).toString();

  const filters = { entity, status, feeMin, feeMax, hasDocs, active };
  const { args: filterArgs, clause: filterClause } = buildFiltersClause(filters);

  try {
    // ─── No query → plain SQL with chosen sort ─────────────────
    if (!q) {
      const orderClause = {
        id: 's.id ASC',
        name: 'COALESCE(s.name_en, s.name_ar) ASC',
        fee: 'COALESCE(s.fee_omr, 0) DESC',
        updated: `COALESCE(s.updated_at, '') DESC, s.id DESC`
      }[sort] || 's.id ASC';
      const { rows } = await db.execute({
        sql: `SELECT ${SELECT_COLUMNS} FROM service_catalog s
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
        search: { mode: 'browse', semantic_available: LLM_ENABLED }
      });
    }

    // ─── Hybrid search (q present) ──────────────────────────────
    const candidateIds = await loadCandidateIds(filterClause, filterArgs);
    const [fts, sem, sub] = await Promise.all([
      ftsLane(q, candidateIds, 80),
      semanticLane(q, candidateIds, 80),
      substringLane(q, candidateIds, 80)
    ]);

    const fused = rrfFuse([
      { name: 'fts', list: fts },
      { name: 'semantic', list: sem },
      { name: 'partial', list: sub }
    ]);

    if (!fused.length) {
      return res.json({
        results: [], total: 0, limit, offset,
        search: { mode: 'hybrid', q, semantic_available: LLM_ENABLED, lanes: { fts: 0, semantic: 0, partial: 0 } }
      });
    }

    const total = fused.length;
    const pageIds = fused.slice(offset, offset + limit).map(x => x.id);
    if (!pageIds.length) {
      return res.json({
        results: [], total, limit, offset,
        search: { mode: 'hybrid', q, semantic_available: LLM_ENABLED, lanes: { fts: fts.length, semantic: sem.length, partial: sub.length } }
      });
    }

    // Hydrate the page slice in one round-trip preserving the fused order.
    const placeholders = pageIds.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT ${SELECT_COLUMNS} FROM service_catalog s WHERE s.id IN (${placeholders})`,
      args: pageIds
    });
    const byId = new Map(rows.map(r => [r.id, r]));
    const results = fused.slice(offset, offset + limit)
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
        lanes: { fts: fts.length, semantic: sem.length, partial: sub.length }
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Single service detail + history ────────────────────────

annotatorRouter.get('/services/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({ sql: `SELECT * FROM service_catalog WHERE id=?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });

  const svc = rows[0];
  try { svc.required_documents = JSON.parse(svc.required_documents_json || '[]'); } catch { svc.required_documents = []; }
  try { svc.process_steps = JSON.parse(svc.process_steps_json || '[]'); } catch { svc.process_steps = []; }

  const { rows: validations } = await db.execute({
    sql: `SELECT v.id, v.status, v.notes, v.created_at, a.id AS annotator_id, a.name AS annotator_name
            FROM service_validation v
            LEFT JOIN annotator a ON a.id = v.annotator_id
           WHERE v.service_id = ?
           ORDER BY v.created_at DESC
           LIMIT 20`,
    args: [id]
  });

  const { rows: edits } = await db.execute({
    sql: `SELECT l.id, l.action, l.diff_json, l.created_at, a.name AS annotator_name
            FROM audit_log l
            LEFT JOIN annotator a ON a.id = l.actor_id AND l.actor_type = 'annotator'
           WHERE l.target_type = 'service' AND l.target_id = ?
           ORDER BY l.created_at DESC
           LIMIT 20`,
    args: [id]
  });

  res.json({ service: svc, validations, edits });
});

// ─── Create service ─────────────────────────────────────────

annotatorRouter.post('/services', async (req, res) => {
  const actor = actingAnnotator(req);
  if (!actor) return res.status(401).json({ error: 'no_annotator' });

  const body = req.body || {};
  const docs = Array.isArray(body.required_documents) ? body.required_documents : [];
  const steps = Array.isArray(body.process_steps) ? body.process_steps : [];

  const payload = {
    entity_en: body.entity_en || '',
    entity_ar: body.entity_ar || '',
    name_en: (body.name_en || '').trim(),
    name_ar: (body.name_ar || '').trim(),
    description_en: body.description_en || '',
    description_ar: body.description_ar || '',
    fees_text: body.fees_text || '',
    fee_omr: body.fee_omr != null ? Number(body.fee_omr) : null,
    required_documents_json: JSON.stringify(docs),
    process_steps_json: JSON.stringify(steps),
    source_url: body.source_url || '',
    is_active: body.is_active === false ? 0 : 1
  };
  if (!payload.name_en && !payload.name_ar) return res.status(400).json({ error: 'name_required' });
  payload.search_blob = toSearchBlob(payload);

  try {
    const r = await db.execute({
      sql: `INSERT INTO service_catalog
            (entity_en,entity_ar,name_en,name_ar,description_en,description_ar,
             fees_text,fee_omr,required_documents_json,process_steps_json,
             source_url,is_active,version,search_blob,updated_at,last_edited_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,datetime('now'),?)`,
      args: [
        payload.entity_en, payload.entity_ar, payload.name_en, payload.name_ar,
        payload.description_en, payload.description_ar, payload.fees_text, payload.fee_omr,
        payload.required_documents_json, payload.process_steps_json,
        payload.source_url, payload.is_active, payload.search_blob, actor
      ]
    });
    const id = Number(r.lastInsertRowid);

    // Keep FTS in sync
    try {
      await db.execute({
        sql: `INSERT INTO service_catalog_fts(rowid,name_en,name_ar,description_en,description_ar,entity_en,entity_ar)
              VALUES (?,?,?,?,?,?,?)`,
        args: [id, payload.name_en, payload.name_ar, payload.description_en, payload.description_ar, payload.entity_en, payload.entity_ar]
      });
    } catch (e) { /* FTS may fail if contentless; safe to ignore */ }

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('annotator',?, 'service_create','service',?,?)`,
      args: [actor, id, JSON.stringify(payload)]
    });

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Edit service ───────────────────────────────────────────

annotatorRouter.patch('/services/:id', async (req, res) => {
  const id = Number(req.params.id);
  const actor = actingAnnotator(req);
  if (!actor) return res.status(401).json({ error: 'no_annotator' });

  const { rows } = await db.execute({ sql: `SELECT * FROM service_catalog WHERE id=?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const current = rows[0];

  // Normalize incoming JSON fields
  const incoming = { ...req.body };
  if (Array.isArray(incoming.required_documents)) {
    incoming.required_documents_json = JSON.stringify(incoming.required_documents);
    delete incoming.required_documents;
  }
  if (Array.isArray(incoming.process_steps)) {
    incoming.process_steps_json = JSON.stringify(incoming.process_steps);
    delete incoming.process_steps;
  }
  if (incoming.fee_omr != null && incoming.fee_omr !== '') incoming.fee_omr = Number(incoming.fee_omr);
  if (incoming.is_active != null) incoming.is_active = incoming.is_active ? 1 : 0;

  const updates = [];
  const args = [];
  const diff = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in incoming && incoming[field] !== undefined && incoming[field] !== current[field]) {
      updates.push(`${field} = ?`);
      args.push(incoming[field]);
      diff[field] = { before: current[field], after: incoming[field] };
    }
  }

  if (!updates.length) return res.json({ ok: true, id, changed: 0 });

  // Recompute search_blob after merging edits
  const merged = { ...current };
  for (const f of Object.keys(diff)) merged[f] = diff[f].after;
  updates.push(`search_blob = ?`);
  args.push(toSearchBlob(merged));

  updates.push(`version = version + 1`);
  updates.push(`updated_at = datetime('now')`);
  updates.push(`last_edited_by = ?`);
  args.push(actor);

  await db.execute({
    sql: `UPDATE service_catalog SET ${updates.join(', ')} WHERE id = ?`,
    args: [...args, id]
  });

  // Keep FTS in sync
  try {
    await db.execute({
      sql: `UPDATE service_catalog_fts SET name_en=?,name_ar=?,description_en=?,description_ar=?,entity_en=?,entity_ar=?
              WHERE rowid=?`,
      args: [
        merged.name_en, merged.name_ar, merged.description_en, merged.description_ar,
        merged.entity_en, merged.entity_ar, id
      ]
    });
  } catch (e) { /* ignore */ }

  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('annotator',?, 'service_edit','service',?,?)`,
    args: [actor, id, JSON.stringify(diff)]
  });

  res.json({ ok: true, id, changed: Object.keys(diff).length, diff });
});

// ─── Validation actions ─────────────────────────────────────

annotatorRouter.post('/services/:id/validate', async (req, res) => {
  const id = Number(req.params.id);
  const actor = actingAnnotator(req);
  if (!actor) return res.status(401).json({ error: 'no_annotator' });

  const status = (req.body?.status || 'validated').toString();
  if (!['validated', 'needs_review', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'bad_status' });
  }
  const notes = (req.body?.notes || '').toString().slice(0, 2000);

  const { rows } = await db.execute({ sql: `SELECT id FROM service_catalog WHERE id=?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });

  const r = await db.execute({
    sql: `INSERT INTO service_validation(service_id,annotator_id,status,notes) VALUES (?,?,?,?)`,
    args: [id, actor, status, notes || null]
  });

  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('annotator',?, ?, 'service', ?, ?)`,
    args: [actor, `service_${status}`, id, JSON.stringify({ notes })]
  });

  res.json({ ok: true, id, validation_id: Number(r.lastInsertRowid), status });
});

annotatorRouter.post('/services/:id/unvalidate', async (req, res) => {
  const id = Number(req.params.id);
  const actor = actingAnnotator(req);
  if (!actor) return res.status(401).json({ error: 'no_annotator' });

  await db.execute({
    sql: `DELETE FROM service_validation
           WHERE id = (SELECT id FROM service_validation WHERE service_id=? ORDER BY created_at DESC LIMIT 1)`,
    args: [id]
  });

  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('annotator',?, 'service_unvalidate','service',?, '{}')`,
    args: [actor, id]
  });

  res.json({ ok: true, id });
});

// ─── Stats ──────────────────────────────────────────────────

annotatorRouter.get('/stats', async (_req, res) => {
  const { rows: total } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
  const { rows: validated } = await db.execute(`
    SELECT COUNT(DISTINCT service_id) AS n FROM service_validation WHERE status = 'validated'
  `);
  const { rows: needsReview } = await db.execute(`
    SELECT COUNT(DISTINCT service_id) AS n FROM service_validation WHERE status = 'needs_review'
  `);
  const { rows: perAnnotator } = await db.execute(`
    SELECT a.id, a.name,
           SUM(CASE WHEN v.status='validated' THEN 1 ELSE 0 END) AS validated,
           SUM(CASE WHEN v.status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
           SUM(CASE WHEN v.status='rejected' THEN 1 ELSE 0 END) AS rejected,
           COUNT(v.id) AS total_actions
      FROM annotator a
      LEFT JOIN service_validation v ON v.annotator_id = a.id
     GROUP BY a.id
     ORDER BY validated DESC, total_actions DESC
  `);

  res.json({
    total_services: total[0].n,
    validated: validated[0].n,
    needs_review: needsReview[0].n,
    pending: Math.max(0, total[0].n - validated[0].n),
    per_annotator: perAnnotator
  });
});

// ─── Entities (reuse from catalogue) ────────────────────────

annotatorRouter.get('/entities', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT entity_en, entity_ar, COUNT(*) AS n
      FROM service_catalog
     WHERE entity_en != ''
     GROUP BY entity_en
     ORDER BY n DESC
  `);
  res.json({ entities: rows });
});
