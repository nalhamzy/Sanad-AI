// Office self-service — profile, team, invites.
// All endpoints require a signed-in officer; most are gated to role:'owner'
// or 'manager' (owners can do everything, officers see read-only team + profile).

import { Router } from 'express';
import { db } from '../lib/db.js';
import { hashPassword, requireOfficer } from '../lib/auth.js';

export const officeRouter = Router();

// ─── GET /profile ──────────────────────────────────────────
// Full profile (stats included). Available to any active officer of the office.
officeRouter.get('/profile', requireOfficer({ allowPending: true }), async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, governorate, wilayat, email, phone, cr_number,
                 status, plan, wallet_baisa, rating, offers_won, offers_abandoned,
                 total_completed, avg_completion_hours, reviewed_at, reject_reason,
                 credits_remaining, subscription_status, default_office_fee_omr, created_at
            FROM office WHERE id=?`,
    args: [req.office.id]
  });
  res.json({ office: rows[0] || null });
});

// ─── PATCH /settings ───────────────────────────────────────
// Owner-only: adjust the office's pricing defaults. Currently just
// default_office_fee_omr — the fee applied when an officer clicks the
// one-click "Send quote" button. Per-request overrides still work via the
// /request/:id/offer endpoint.
officeRouter.patch('/settings', requireOfficer({ roles: ['owner'] }), async (req, res) => {
  const b = req.body || {};
  const fee = Number(b.default_office_fee_omr);
  if (!(fee >= 0) || !(fee <= 500) || !Number.isFinite(fee)) {
    return res.status(400).json({ error: 'bad_fee', detail: 'default_office_fee_omr must be 0..500' });
  }
  await db.execute({
    sql: `UPDATE office SET default_office_fee_omr=? WHERE id=?`,
    args: [fee, req.office.id]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'update_default_fee', 'office', ?, ?)`,
    args: [req.officer.officer_id, req.office.id,
           JSON.stringify({ default_office_fee_omr: fee })]
  });
  res.json({ ok: true, default_office_fee_omr: fee });
});

// ─── GET /pricing ──────────────────────────────────────────
// Return the full service catalog joined with this office's per-service
// overrides (if any). The UI uses this to render a searchable pricing table
// where the owner can fix both "my fee" (office_fee_omr) and "government fee"
// (معاملة, government_fee_omr) per service. `effective_*` already resolves
// NULLs so the client only has to render one number per column.
officeRouter.get('/pricing', requireOfficer({ allowPending: true }), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const { rows: officeRows } = await db.execute({
    sql: `SELECT default_office_fee_omr FROM office WHERE id=?`,
    args: [req.office.id]
  });
  const defaultFee = Number(officeRows[0]?.default_office_fee_omr ?? 5);

  const where = [`sc.is_active = 1`];
  const args = [req.office.id];
  if (q) {
    where.push(`(sc.name_en LIKE ? OR sc.name_ar LIKE ? OR sc.entity_en LIKE ? OR sc.entity_ar LIKE ?)`);
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await db.execute({
    sql: `
      SELECT sc.id              AS service_id,
             sc.name_en,
             sc.name_ar,
             sc.entity_en,
             sc.entity_ar,
             sc.fee_omr         AS catalog_fee_omr,
             osp.office_fee_omr     AS office_fee_override,
             osp.government_fee_omr AS government_fee_override,
             osp.updated_at         AS override_updated_at
        FROM service_catalog sc
        LEFT JOIN office_service_price osp
               ON osp.service_id = sc.id AND osp.office_id = ?
        ${whereSql}
        ORDER BY sc.name_ar
        LIMIT ${limit}
    `,
    args
  });

  const items = rows.map(r => ({
    ...r,
    effective_office_fee_omr:     r.office_fee_override     ?? defaultFee,
    effective_government_fee_omr: r.government_fee_override ?? r.catalog_fee_omr ?? 0,
    has_override: r.office_fee_override != null || r.government_fee_override != null
  }));

  res.json({ default_office_fee_omr: defaultFee, items });
});

// ─── PATCH /pricing/:service_id ────────────────────────────
// UPSERT a per-service price override. Pass `null` for either field to fall
// back to the default (office default fee / catalog fee). Owner/manager only.
officeRouter.patch('/pricing/:service_id', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const service_id = Number(req.params.service_id);
  if (!Number.isInteger(service_id) || service_id <= 0) {
    return res.status(400).json({ error: 'bad_service_id' });
  }
  // Confirm the service exists so we don't dangle a row that fails the FK in
  // production libSQL (local SQLite is lenient about FK unless enabled).
  const { rows: svcRows } = await db.execute({
    sql: `SELECT id FROM service_catalog WHERE id=? LIMIT 1`,
    args: [service_id]
  });
  if (!svcRows.length) return res.status(404).json({ error: 'service_not_found' });

  const parseFee = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 500) return NaN;
    return Math.round(n * 1000) / 1000;
  };
  const office_fee = parseFee(req.body?.office_fee_omr);
  const gov_fee    = parseFee(req.body?.government_fee_omr);
  if (Number.isNaN(office_fee) || Number.isNaN(gov_fee)) {
    return res.status(400).json({ error: 'bad_fee', detail: 'fees must be 0..500 or null' });
  }

  await db.execute({
    sql: `
      INSERT INTO office_service_price (office_id, service_id, office_fee_omr, government_fee_omr, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(office_id, service_id) DO UPDATE SET
        office_fee_omr     = excluded.office_fee_omr,
        government_fee_omr = excluded.government_fee_omr,
        updated_at         = datetime('now')
    `,
    args: [req.office.id, service_id, office_fee, gov_fee]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'set_service_price', 'service', ?, ?)`,
    args: [req.officer.officer_id, service_id,
           JSON.stringify({ office_fee_omr: office_fee, government_fee_omr: gov_fee })]
  });
  res.json({ ok: true, service_id, office_fee_omr: office_fee, government_fee_omr: gov_fee });
});

// ─── DELETE /pricing/:service_id ───────────────────────────
// Revert a per-service override back to office default + catalog value.
officeRouter.delete('/pricing/:service_id', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const service_id = Number(req.params.service_id);
  if (!Number.isInteger(service_id) || service_id <= 0) {
    return res.status(400).json({ error: 'bad_service_id' });
  }
  const r = await db.execute({
    sql: `DELETE FROM office_service_price WHERE office_id=? AND service_id=?`,
    args: [req.office.id, service_id]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'clear_service_price', 'service', ?, '{}')`,
    args: [req.officer.officer_id, service_id]
  });
  res.json({ ok: true, cleared: Boolean(r.rowsAffected) });
});

// ─── PATCH /profile ────────────────────────────────────────
// Owner/manager can update display fields. Governorate/CR-number require
// platform-admin re-review so we don't let them drift silently.
officeRouter.patch('/profile', requireOfficer({ roles: ['owner', 'manager'], allowPending: true }), async (req, res) => {
  const b = req.body || {};
  const allowed = {};
  if (typeof b.name_en === 'string') allowed.name_en = b.name_en.trim().slice(0, 120);
  if (typeof b.name_ar === 'string') allowed.name_ar = b.name_ar.trim().slice(0, 120);
  if (typeof b.wilayat === 'string') allowed.wilayat = b.wilayat.trim().slice(0, 60);
  if (typeof b.phone === 'string')   allowed.phone   = b.phone.trim().slice(0, 40);
  if (!Object.keys(allowed).length) return res.status(400).json({ error: 'no_fields' });
  const cols = Object.keys(allowed);
  await db.execute({
    sql: `UPDATE office SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`,
    args: [...cols.map(c => allowed[c]), req.office.id]
  });
  res.json({ ok: true, updated: allowed });
});

// ─── GET /team ─────────────────────────────────────────────
officeRouter.get('/team', requireOfficer({ allowPending: true }), async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT id, full_name, email, role, status, phone, last_login_at, created_at
            FROM officer WHERE office_id=? ORDER BY
              CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id`,
    args: [req.office.id]
  });
  res.json({ officers: rows });
});

// ─── POST /team/invite ─────────────────────────────────────
// Owner/manager invites another officer. We create the row with a temporary
// password the admin hands off — or a magic "invited" status where the first
// login via /set-password endpoint locks it in. For simplicity we let the
// inviter provide the initial password (they can share it and ask the teammate
// to change it). Returns the new officer id.
officeRouter.post('/team/invite', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const full_name = String(req.body?.full_name || '').trim().slice(0, 120);
  const role = ['owner', 'manager', 'officer'].includes(req.body?.role) ? req.body.role : 'officer';
  const phone = (req.body?.phone || '').toString().trim().slice(0, 40);
  const initial_password = String(req.body?.initial_password || '');

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  if (!full_name) return res.status(400).json({ error: 'missing_name' });
  if (initial_password.length < 8) return res.status(400).json({ error: 'password>=8' });
  // Only owners may appoint another owner
  if (role === 'owner' && req.officer.role !== 'owner') return res.status(403).json({ error: 'only_owner_can_create_owner' });

  const { rows: dupe } = await db.execute({
    sql: `SELECT 1 FROM officer WHERE lower(email)=? LIMIT 1`, args: [email]
  });
  if (dupe.length) return res.status(409).json({ error: 'email_taken' });

  const password_hash = await hashPassword(initial_password);
  const ins = await db.execute({
    sql: `INSERT INTO officer (office_id, full_name, email, role, password_hash, phone, status, invited_by)
          VALUES (?,?,?,?,?,?, 'active', ?)`,
    args: [req.office.id, full_name, email, role, password_hash, phone || null, req.officer.officer_id]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?,'invite_officer','officer',?,?)`,
    args: [req.officer.officer_id, Number(ins.lastInsertRowid), JSON.stringify({ role, email })]
  });
  res.status(201).json({ ok: true, officer_id: Number(ins.lastInsertRowid) });
});

// ─── POST /team/:id/disable ────────────────────────────────
officeRouter.post('/team/:id/disable', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.officer.officer_id) return res.status(400).json({ error: 'cannot_disable_self' });
  const r = await db.execute({
    sql: `UPDATE officer SET status='disabled' WHERE id=? AND office_id=?`,
    args: [id, req.office.id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// ─── POST /team/:id/enable ─────────────────────────────────
officeRouter.post('/team/:id/enable', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.execute({
    sql: `UPDATE officer SET status='active' WHERE id=? AND office_id=?`,
    args: [id, req.office.id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// ─── POST /change-password ─────────────────────────────────
officeRouter.post('/change-password', requireOfficer({ allowPending: true }), async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'password>=8' });
  const { rows } = await db.execute({
    sql: `SELECT password_hash FROM officer WHERE id=?`, args: [req.officer.officer_id]
  });
  const { verifyPassword } = await import('../lib/auth.js');
  if (!await verifyPassword(old_password, rows[0]?.password_hash || '')) {
    return res.status(401).json({ error: 'wrong_old_password' });
  }
  const hash = await hashPassword(new_password);
  await db.execute({
    sql: `UPDATE officer SET password_hash=? WHERE id=?`,
    args: [hash, req.officer.officer_id]
  });
  res.json({ ok: true });
});
