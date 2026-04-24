// Platform-admin endpoints — for the Sanad-AI core team (not the offices).
// Approves / rejects / suspends offices. Gated by `requirePlatformAdmin`
// which checks email against ADMIN_EMAILS env (or falls back to DEBUG_MODE).

import { Router } from 'express';
import { db } from '../lib/db.js';
import { requireOfficer, requirePlatformAdmin } from '../lib/auth.js';

export const platformAdminRouter = Router();

// All routes: must be a signed-in officer AND their email must match the
// platform-admin allowlist.
platformAdminRouter.use(requireOfficer({ allowPending: true }));
platformAdminRouter.use(requirePlatformAdmin());

// ─── GET /offices ──────────────────────────────────────────
// Supports ?status=pending_review | active | suspended | rejected | all
platformAdminRouter.get('/offices', async (req, res) => {
  const wanted = String(req.query.status || 'pending_review');
  let sql = `SELECT id, name_en, name_ar, governorate, wilayat, email, phone, cr_number,
                    status, plan, rating, total_completed, offers_won, reviewed_at,
                    reject_reason, created_at
               FROM office`;
  const args = [];
  if (wanted !== 'all') { sql += ` WHERE status=?`; args.push(wanted); }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  const { rows } = await db.execute({ sql, args });
  res.json({ offices: rows });
});

// ─── GET /office/:id ───────────────────────────────────────
platformAdminRouter.get('/office/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT * FROM office WHERE id=?`, args: [id]
  });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const { rows: team } = await db.execute({
    sql: `SELECT id, full_name, email, role, status, last_login_at, created_at
            FROM officer WHERE office_id=? ORDER BY role, id`,
    args: [id]
  });
  res.json({ office: rows[0], team });
});

// ─── POST /office/:id/approve ──────────────────────────────
platformAdminRouter.post('/office/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.execute({
    sql: `UPDATE office
             SET status='active', reviewed_at=datetime('now'), reviewed_by=?, reject_reason=NULL
           WHERE id=? AND status IN ('pending_review','suspended','rejected')`,
    args: [req.officer.officer_id, id]
  });
  if (!r.rowsAffected) return res.status(409).json({ error: 'bad_state' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id)
          VALUES ('officer', ?, 'office_approve', 'office', ?)`,
    args: [req.officer.officer_id, id]
  });
  res.json({ ok: true });
});

// ─── POST /office/:id/reject ──────────────────────────────
platformAdminRouter.post('/office/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 400) || 'No reason given';
  const r = await db.execute({
    sql: `UPDATE office
             SET status='rejected', reviewed_at=datetime('now'), reviewed_by=?, reject_reason=?
           WHERE id=? AND status IN ('pending_review','active','suspended')`,
    args: [req.officer.officer_id, reason, id]
  });
  if (!r.rowsAffected) return res.status(409).json({ error: 'bad_state' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer', ?, 'office_reject', 'office', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ reason })]
  });
  res.json({ ok: true });
});

// ─── POST /office/:id/suspend ──────────────────────────────
platformAdminRouter.post('/office/:id/suspend', async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 400) || null;
  const r = await db.execute({
    sql: `UPDATE office
             SET status='suspended', reviewed_at=datetime('now'), reviewed_by=?, reject_reason=?
           WHERE id=? AND status='active'`,
    args: [req.officer.officer_id, reason, id]
  });
  if (!r.rowsAffected) return res.status(409).json({ error: 'bad_state' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer', ?, 'office_suspend', 'office', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ reason })]
  });
  res.json({ ok: true });
});

// ─── GET /services ─────────────────────────────────────────
// Admin-owned catalog CRUD. Offices see this list + their own fee overrides
// but they CANNOT mutate the catalog itself — only platform admins can
// add, rename, reprice, or disable a service.
//   ?q=search   substring match on name/entity (EN or AR)
//   ?entity=…   filter by the parent ministry/entity
//   ?limit      default 200, max 1000
platformAdminRouter.get('/services', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const entity = String(req.query.entity || '').trim();
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [];
  const args = [];
  if (q) {
    where.push(`(name_en LIKE ? OR name_ar LIKE ? OR entity_en LIKE ? OR entity_ar LIKE ?)`);
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  if (entity) { where.push(`entity_en = ?`); args.push(entity); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await db.execute({
    sql: `SELECT id, entity_en, entity_ar, name_en, name_ar,
                 fee_omr, fees_text, is_active, version
            FROM service_catalog
            ${whereSql}
            ORDER BY name_ar
            LIMIT ${limit} OFFSET ${offset}`,
    args
  });
  const { rows: totalRows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM service_catalog ${whereSql}`,
    args
  });
  res.json({ services: rows, total: totalRows[0]?.n || 0 });
});

// ─── POST /services ────────────────────────────────────────
// Create a new service. Minimum fields: name_ar (Arabic is primary), fee_omr.
platformAdminRouter.post('/services', async (req, res) => {
  const b = req.body || {};
  const name_ar   = String(b.name_ar   || '').trim().slice(0, 200);
  const name_en   = String(b.name_en   || '').trim().slice(0, 200) || null;
  const entity_ar = String(b.entity_ar || '').trim().slice(0, 200) || null;
  const entity_en = String(b.entity_en || '').trim().slice(0, 200) || null;
  const fees_text = String(b.fees_text || '').trim().slice(0, 200) || null;
  const source_url = String(b.source_url || '').trim().slice(0, 500) || null;
  const fee = b.fee_omr === '' || b.fee_omr == null ? null : Number(b.fee_omr);
  const is_active = b.is_active === false ? 0 : 1;

  if (!name_ar) return res.status(400).json({ error: 'missing_name_ar' });
  if (fee != null && (!Number.isFinite(fee) || fee < 0 || fee > 5000))
    return res.status(400).json({ error: 'bad_fee' });

  const ins = await db.execute({
    sql: `INSERT INTO service_catalog
            (entity_en, entity_ar, name_en, name_ar, fee_omr, fees_text, source_url, is_active, version)
          VALUES (?,?,?,?,?,?,?,?, 1)`,
    args: [entity_en, entity_ar, name_en, name_ar, fee, fees_text, source_url, is_active]
  });
  const id = Number(ins.lastInsertRowid);
  // Keep the FTS shadow table in sync so search still works.
  try {
    await db.execute({
      sql: `INSERT INTO service_catalog_fts (rowid, name_en, name_ar, description_en, description_ar, entity_en, entity_ar)
            VALUES (?,?,?,?,?,?,?)`,
      args: [id, name_en || '', name_ar || '', '', '', entity_en || '', entity_ar || '']
    });
  } catch {}
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'service_create', 'service', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ name_ar, fee_omr: fee })]
  });
  res.status(201).json({ ok: true, id });
});

// ─── PATCH /services/:id ───────────────────────────────────
// Edit any subset of catalog fields. Bumps version so clients can detect.
platformAdminRouter.patch('/services/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const b = req.body || {};
  const patch = {};
  if (typeof b.name_ar   === 'string') patch.name_ar   = b.name_ar.trim().slice(0, 200);
  if (typeof b.name_en   === 'string') patch.name_en   = b.name_en.trim().slice(0, 200);
  if (typeof b.entity_ar === 'string') patch.entity_ar = b.entity_ar.trim().slice(0, 200);
  if (typeof b.entity_en === 'string') patch.entity_en = b.entity_en.trim().slice(0, 200);
  if (typeof b.fees_text === 'string') patch.fees_text = b.fees_text.trim().slice(0, 200);
  if (typeof b.source_url === 'string') patch.source_url = b.source_url.trim().slice(0, 500);
  if (b.fee_omr !== undefined) {
    if (b.fee_omr === null || b.fee_omr === '') patch.fee_omr = null;
    else {
      const f = Number(b.fee_omr);
      if (!Number.isFinite(f) || f < 0 || f > 5000) return res.status(400).json({ error: 'bad_fee' });
      patch.fee_omr = f;
    }
  }
  if (b.is_active !== undefined) patch.is_active = b.is_active ? 1 : 0;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });

  const cols = Object.keys(patch);
  await db.execute({
    sql: `UPDATE service_catalog
             SET ${cols.map(c => `${c}=?`).join(',')}, version=COALESCE(version,1)+1
           WHERE id=?`,
    args: [...cols.map(c => patch[c]), id]
  });
  // Refresh FTS row if any searchable field changed.
  if (patch.name_en !== undefined || patch.name_ar !== undefined ||
      patch.entity_en !== undefined || patch.entity_ar !== undefined) {
    try {
      const { rows: cur } = await db.execute({
        sql: `SELECT name_en, name_ar, description_en, description_ar, entity_en, entity_ar
                FROM service_catalog WHERE id=?`, args: [id]
      });
      const r = cur[0] || {};
      await db.execute({ sql: `DELETE FROM service_catalog_fts WHERE rowid=?`, args: [id] });
      await db.execute({
        sql: `INSERT INTO service_catalog_fts (rowid, name_en, name_ar, description_en, description_ar, entity_en, entity_ar)
              VALUES (?,?,?,?,?,?,?)`,
        args: [id, r.name_en || '', r.name_ar || '', r.description_en || '', r.description_ar || '',
               r.entity_en || '', r.entity_ar || '']
      });
    } catch {}
  }
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'service_update', 'service', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify(patch)]
  });
  res.json({ ok: true, patched: patch });
});

// ─── DELETE /services/:id ──────────────────────────────────
// Soft-delete (is_active=0). Keeping rows around preserves referential
// integrity with historical requests / offers that point at this service_id.
platformAdminRouter.delete('/services/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const r = await db.execute({
    sql: `UPDATE service_catalog SET is_active=0, version=COALESCE(version,1)+1 WHERE id=?`,
    args: [id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id)
          VALUES ('officer',?, 'service_disable', 'service', ?)`,
    args: [req.officer.officer_id, id]
  });
  res.json({ ok: true });
});

// ─── GET /stats ────────────────────────────────────────────
platformAdminRouter.get('/stats', async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT status, COUNT(*) AS n FROM office GROUP BY status`);
  const byStatus = Object.fromEntries(rows.map(r => [r.status, r.n]));
  res.json({ offices_by_status: byStatus });
});
