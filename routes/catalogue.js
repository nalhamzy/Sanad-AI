import { Router } from 'express';
import { db } from '../lib/db.js';

export const catalogueRouter = Router();

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
