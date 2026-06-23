// Platform-admin endpoints — for the Sanad-AI core team (not the offices).
// Approves / rejects / suspends offices. Gated by `requirePlatformAdmin`
// which checks email against ADMIN_EMAILS env (or falls back to DEBUG_MODE).

import { Router } from 'express';
import { db } from '../lib/db.js';
import { requireOfficer, requirePlatformAdmin, hashPassword } from '../lib/auth.js';
import { randomBytes, randomInt } from 'crypto';
import {
  previewPayout, generatePayout, markPayoutPaid, cancelPayout,
  exportPayoutsCsv, platformFeeOmr, recomputeTotals, reconcile
} from '../lib/payouts.js';

// Temp password for admin-initiated resets: 10 chars, always has a letter + a digit.
function genTempPassword() {
  const raw = randomBytes(12).toString('base64url').replace(/[-_]/g, '');
  return 'S' + raw.slice(0, 8) + randomInt(0, 10);
}

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
  const office = rows[0];
  office.has_bank_details = !!(office.iban && office.bank_name && office.account_holder_name);
  res.json({ office, team });
});

// ─── POST /office/:id/verify-bank ─────────────────────────
// Admin marks an office's bank details as "verified" after the first
// successful transfer to that IBAN clears. Stamps bank_verified_at — a
// purely informational signal surfaced in the payouts table. Setting
// `{ verified: false }` clears the flag (e.g. an IBAN issue surfaced).
platformAdminRouter.post('/office/:id/verify-bank', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  const verified = req.body?.verified !== false;
  await db.execute({
    sql: `UPDATE office
             SET bank_verified_at = ${verified ? "datetime('now')" : 'NULL'}
           WHERE id=?`,
    args: [id]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'verify_bank', 'office', ?, ?)`,
    args: [req.officer?.officer_id || null, id, JSON.stringify({ verified })]
  });
  res.json({ ok: true, verified });
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

// ─── POST /office/:id/reset-password ──────────────────────
// Admin-initiated reset: sets a NEW temporary password on the office's owner
// account and returns it ONCE. The admin relays it to the office, who signs in
// and changes it via /api/office/change-password. No WhatsApp dependency — the
// reliable path when an office is locked out and can't receive an OTP.
platformAdminRouter.post('/office/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  // Target the owner; fall back to the earliest officer of the office.
  const { rows } = await db.execute({
    sql: `SELECT id, email, full_name FROM officer
           WHERE office_id=? ORDER BY (role='owner') DESC, id ASC LIMIT 1`,
    args: [id]
  });
  const officer = rows[0];
  if (!officer) return res.status(404).json({ error: 'no_officer' });

  const temp = genTempPassword();
  const password_hash = await hashPassword(temp);
  await db.execute({ sql: `UPDATE officer SET password_hash=? WHERE id=?`, args: [password_hash, officer.id] });
  // Invalidate any pending self-service reset codes for that officer.
  await db.execute({
    sql: `UPDATE password_reset_otp SET consumed_at=datetime('now')
           WHERE officer_id=? AND consumed_at IS NULL`,
    args: [officer.id]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id)
          VALUES ('officer', ?, 'admin_password_reset', 'officer', ?)`,
    args: [req.officer.officer_id, officer.id]
  });
  res.json({ ok: true, email: officer.email, full_name: officer.full_name, temp_password: temp });
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

// ════════════════════════════════════════════════════════════
// PAYMENTS ADMIN — subscriptions, citizen payments, KPIs, events
// ════════════════════════════════════════════════════════════
// Surface the v2 subscription state + Thawani payment activity to the
// platform-admin dashboard. All routes are read-only EXCEPT extend/cancel
// which let an operator manually intervene (e.g. comp a free month after
// a billing dispute).
//
// Listing endpoints return capped result sets (LIMIT 200 default, max
// 500) so the admin UI stays snappy even as data grows. For deep dives,
// the operator filters by office / date / status — every list supports
// `?office_id=`, `?status=`, `?from=YYYY-MM-DD`, `?to=YYYY-MM-DD`.

// Tiny helper — bounded LIMIT from `?limit=` query param.
function cappedLimit(q, fallback = 200, max = 500) {
  const n = Number(q.limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

// ─── GET /subscriptions ────────────────────────────────────
// List v2 subscriptions with filters. Returns the most-recently-touched
// row per (office, plan) combo for the operator's at-a-glance view.
platformAdminRouter.get('/subscriptions', async (req, res) => {
  const filters = [];
  const args = [];
  if (req.query.status && req.query.status !== 'all') {
    filters.push(`s.payment_status = ?`);
    args.push(String(req.query.status));
  }
  if (req.query.plan && req.query.plan !== 'all') {
    filters.push(`s.plan_code = ?`);
    args.push(String(req.query.plan));
  }
  if (req.query.office_id) {
    filters.push(`s.office_id = ?`);
    args.push(Number(req.query.office_id));
  }
  // Only show v2 plans (filter out the legacy starter-70 pack).
  filters.push(`s.plan_code IN ('monthly','quarterly','semi-annual','annual')`);
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const limit = cappedLimit(req.query);
  const { rows } = await db.execute({
    sql: `SELECT s.id, s.office_id, s.plan_code, s.amount_omr, s.months,
                 s.payment_status, s.starts_at, s.expires_at, s.paid_at,
                 s.cancelled_at, s.auto_renew, s.created_at,
                 s.thawani_session_id, s.amwal_merchant_ref AS merchant_ref,
                 o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 o.governorate, o.email AS office_email
            FROM office_subscription s
            JOIN office o ON o.id = s.office_id
            ${where}
           ORDER BY s.id DESC
           LIMIT ${limit}`,
    args
  });
  res.json({ subscriptions: rows, count: rows.length });
});

// ─── GET /subscriptions/:id ────────────────────────────────
// Detail view with the full payment_event timeline. Used by the
// "where did this go?" debug pane.
platformAdminRouter.get('/subscriptions/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT s.*, o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 o.email AS office_email, o.phone AS office_phone
            FROM office_subscription s
            JOIN office o ON o.id = s.office_id
           WHERE s.id=? LIMIT 1`,
    args: [id]
  });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const { rows: events } = await db.execute({
    sql: `SELECT id, event_type, amount_omr, thawani_session_id, raw_json, created_at
            FROM payment_event
           WHERE subject_type='office_subscription' AND subject_id=?
           ORDER BY id DESC LIMIT 50`,
    args: [id]
  });
  res.json({ subscription: rows[0], events });
});

// ─── POST /subscriptions/:id/extend ────────────────────────
// Manual extension — add N days (or set a specific expires_at) without
// going through the gateway. Use for compensating billing disputes,
// promo grants, etc. Writes a payment_event 'manual_extend' for audit.
platformAdminRouter.post('/subscriptions/:id/extend', async (req, res) => {
  const id = Number(req.params.id);
  const days = Number(req.body?.days);
  const explicit = req.body?.expires_at ? String(req.body.expires_at) : null;
  if (!explicit && (!Number.isFinite(days) || days <= 0)) {
    return res.status(400).json({ error: 'missing_days_or_expires_at' });
  }

  const { rows } = await db.execute({
    sql: `SELECT id, office_id, plan_code, expires_at, payment_status
            FROM office_subscription WHERE id=?`,
    args: [id]
  });
  const sub = rows[0];
  if (!sub) return res.status(404).json({ error: 'not_found' });

  // Compute new expiry — either an absolute date or current + N days.
  let newExpiry;
  if (explicit) {
    newExpiry = explicit;
  } else {
    const baseMs = sub.expires_at
      ? new Date(sub.expires_at.replace(' ', 'T') + 'Z').getTime()
      : Date.now();
    const target = new Date(Math.max(baseMs, Date.now()) + days * 86_400_000);
    newExpiry = target.toISOString().replace('T', ' ').replace(/\..+$/, '');
  }

  await db.execute({
    sql: `UPDATE office_subscription
             SET expires_at=?, payment_status='active', cancelled_at=NULL
           WHERE id=?`,
    args: [newExpiry, id]
  });
  // Snapshot office row IF this is the latest sub for it.
  await db.execute({
    sql: `UPDATE office
             SET subscription_expires_at=?, subscription_status='active', current_plan=?
           WHERE id=?
             AND (current_plan IS NULL OR current_plan=?)`,
    args: [newExpiry, sub.plan_code, sub.office_id, sub.plan_code]
  });
  await db.execute({
    sql: `INSERT INTO payment_event
            (subject_type, subject_id, provider, event_type, raw_json)
          VALUES ('office_subscription', ?, 'thawani', 'manual_extend', ?)`,
    args: [id, JSON.stringify({
      by_officer_id: req.officer.officer_id, days, explicit, new_expiry: newExpiry
    })]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'sub_extend', 'office_subscription', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ days, explicit, new_expiry: newExpiry })]
  });
  res.json({ ok: true, expires_at: newExpiry });
});

// ─── POST /subscriptions/:id/cancel ────────────────────────
// Manually cancel an active sub. The office's subscription_status flips
// to 'expired' immediately. No refund logic here — use the dedicated
// refund endpoint (POST /payments/:id/refund) for that side.
platformAdminRouter.post('/subscriptions/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '');

  const { rows } = await db.execute({
    sql: `SELECT id, office_id, plan_code, payment_status, expires_at
            FROM office_subscription WHERE id=?`,
    args: [id]
  });
  const sub = rows[0];
  if (!sub) return res.status(404).json({ error: 'not_found' });
  if (sub.payment_status !== 'active') {
    return res.status(409).json({ error: 'not_active', current: sub.payment_status });
  }

  await db.execute({
    sql: `UPDATE office_subscription
             SET payment_status='expired', cancelled_at=datetime('now')
           WHERE id=? AND payment_status='active'`,
    args: [id]
  });
  await db.execute({
    sql: `UPDATE office
             SET subscription_status='expired'
           WHERE id=? AND current_plan=? AND subscription_expires_at=?`,
    args: [sub.office_id, sub.plan_code, sub.expires_at]
  });
  await db.execute({
    sql: `INSERT INTO payment_event
            (subject_type, subject_id, provider, event_type, raw_json)
          VALUES ('office_subscription', ?, 'thawani', 'cancelled', ?)`,
    args: [id, JSON.stringify({ by_officer_id: req.officer.officer_id, reason })]
  });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'sub_cancel', 'office_subscription', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ reason })]
  });
  res.json({ ok: true });
});

// ─── GET /payments ─────────────────────────────────────────
// Citizen payments (one row per `request.payment_*`). Returns the row
// joined with the citizen + service + office for the dashboard's
// per-row narrative ("Civil ID renewal for Citizen X paid Y OMR to Office Z").
platformAdminRouter.get('/payments', async (req, res) => {
  const filters = [];
  const args = [];
  if (req.query.status && req.query.status !== 'all') {
    filters.push(`r.payment_status = ?`);
    args.push(String(req.query.status));
  }
  if (req.query.office_id) {
    filters.push(`r.office_id = ?`);
    args.push(Number(req.query.office_id));
  }
  if (req.query.from) {
    filters.push(`COALESCE(r.paid_at, r.last_event_at) >= ?`);
    args.push(String(req.query.from) + ' 00:00:00');
  }
  if (req.query.to) {
    filters.push(`COALESCE(r.paid_at, r.last_event_at) <= ?`);
    args.push(String(req.query.to) + ' 23:59:59');
  }
  // Only return rows where a payment_ref exists (filters out 'collecting' etc.)
  filters.push(`r.payment_ref IS NOT NULL`);
  const where = 'WHERE ' + filters.join(' AND ');
  const limit = cappedLimit(req.query);

  const { rows } = await db.execute({
    sql: `SELECT r.id AS request_id, r.payment_status, r.payment_amount_omr,
                 r.payment_ref, r.payment_session_id, r.payment_provider,
                 r.paid_at, r.last_event_at, r.created_at,
                 r.office_id, r.status,
                 o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 c.phone AS citizen_phone, c.name AS citizen_name,
                 s.name_en AS service_name_en, s.name_ar AS service_name_ar
            FROM request r
            LEFT JOIN office o ON o.id = r.office_id
            LEFT JOIN citizen c ON c.id = r.citizen_id
            LEFT JOIN service_catalog s ON s.id = r.service_id
            ${where}
           ORDER BY COALESCE(r.paid_at, r.last_event_at) DESC
           LIMIT ${limit}`,
    args
  });
  res.json({ payments: rows, count: rows.length });
});

// ─── GET /payments/events ──────────────────────────────────
// Raw payment_event feed — last N rows, newest first. The "what happened
// at the gateway" view; useful for diagnosing a stuck payment.
platformAdminRouter.get('/payments/events', async (req, res) => {
  const limit = cappedLimit(req.query, 100, 500);
  const filters = [];
  const args = [];
  if (req.query.event_type) {
    filters.push(`event_type = ?`);
    args.push(String(req.query.event_type));
  }
  if (req.query.subject_type) {
    filters.push(`subject_type = ?`);
    args.push(String(req.query.subject_type));
  }
  if (req.query.subject_id) {
    filters.push(`subject_id = ?`);
    args.push(Number(req.query.subject_id));
  }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const { rows } = await db.execute({
    sql: `SELECT id, subject_type, subject_id, provider, thawani_session_id,
                 event_type, amount_omr, raw_json, created_at
            FROM payment_event
            ${where}
           ORDER BY id DESC LIMIT ${limit}`,
    args
  });
  res.json({ events: rows, count: rows.length });
});

// ─── GET /payments/kpis ────────────────────────────────────
// Top-strip aggregates for the dashboard. Single read, cheap enough to
// poll every minute.
//
//   • active_subscriptions  — count of (office_subscription where active)
//   • mrr_omr               — sum(amount_omr / months) over active subs
//   • expiring_7d           — subs whose expires_at is in the next 7 days
//   • citizen_payments_today — paid requests with paid_at in today (UTC)
//   • omr_collected_today    — sum(payment_amount_omr) over those rows
//   • by_plan               — count per plan_code (for a pie/bar chart)
platformAdminRouter.get('/payments/kpis', async (_req, res) => {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartStr = todayStart.toISOString().replace('T', ' ').replace(/\..+$/, '');
  const sevenDaysStr = new Date(Date.now() + 7 * 86_400_000)
    .toISOString().replace('T', ' ').replace(/\..+$/, '');

  // Run all aggregate reads in parallel — they're independent.
  const [active, mrr, expiring, today, byPlan] = await Promise.all([
    db.execute(`
      SELECT COUNT(*) AS n FROM office_subscription
       WHERE payment_status='active'
         AND plan_code IN ('monthly','quarterly','semi-annual','annual')`),
    db.execute(`
      SELECT COALESCE(SUM(amount_omr * 1.0 / NULLIF(months,0)), 0) AS mrr_omr
        FROM office_subscription
       WHERE payment_status='active'
         AND months > 0
         AND plan_code IN ('monthly','quarterly','semi-annual','annual')`),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM office_subscription
             WHERE payment_status='active'
               AND expires_at IS NOT NULL
               AND expires_at <= ?`,
      args: [sevenDaysStr]
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n, COALESCE(SUM(payment_amount_omr), 0) AS omr
              FROM request
             WHERE payment_status='paid' AND paid_at >= ?`,
      args: [todayStartStr]
    }),
    db.execute(`
      SELECT plan_code, COUNT(*) AS n
        FROM office_subscription
       WHERE payment_status='active'
         AND plan_code IN ('monthly','quarterly','semi-annual','annual')
       GROUP BY plan_code`),
  ]);

  res.json({
    active_subscriptions: Number(active.rows[0]?.n || 0),
    mrr_omr: Number(mrr.rows[0]?.mrr_omr || 0),
    expiring_7d: Number(expiring.rows[0]?.n || 0),
    citizen_payments_today: Number(today.rows[0]?.n || 0),
    omr_collected_today: Number(today.rows[0]?.omr || 0),
    by_plan: Object.fromEntries(byPlan.rows.map(r => [r.plan_code, Number(r.n)])),
    generated_at: new Date().toISOString()
  });
});

// ════════════════════════════════════════════════════════════
// OFFICE PAYOUTS — weekly settlement of citizen payments
// ════════════════════════════════════════════════════════════
// Flow used by ops on Fridays:
//   1. GET  /payouts/eligible-by-office  — overview: per-office unsettled
//      totals for the chosen period. The "who do we owe what" table.
//   2. GET  /payouts/preview?office_id&from&to  — drill into one office's
//      requests + totals. Read-only.
//   3. POST /payouts/generate  — materialise as office_payout (status=pending)
//      and stamp request.payout_id so we never double-pay.
//   4. (External bank transfer happens here.)
//   5. POST /payouts/:id/mark-paid  { reference, notes }  — close the loop.
//   6. GET  /payouts/export?from&to  — CSV download for archival / accounting.
// All gated by requirePlatformAdmin (set above this section).

// Helper: "this week", "last week" presets the UI sends as period_preset.
function expandPreset(preset, from, to) {
  if (from && to) return { from, to };
  const now = new Date();
  const weekDayUtc = now.getUTCDay(); // 0=Sun
  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - ((weekDayUtc + 6) % 7));   // last Mon
  thisMonday.setUTCHours(0, 0, 0, 0);
  if (preset === 'this_week') {
    const sun = new Date(thisMonday); sun.setUTCDate(thisMonday.getUTCDate() + 6);
    return { from: ymd(thisMonday), to: ymd(sun) };
  }
  if (preset === 'last_week') {
    const lastMon = new Date(thisMonday); lastMon.setUTCDate(thisMonday.getUTCDate() - 7);
    const lastSun = new Date(lastMon);    lastSun.setUTCDate(lastMon.getUTCDate() + 6);
    return { from: ymd(lastMon), to: ymd(lastSun) };
  }
  if (preset === 'this_month') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const last  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { from: ymd(first), to: ymd(last) };
  }
  // Default: last 30 days
  const back = new Date(now); back.setUTCDate(now.getUTCDate() - 30);
  return { from: ymd(back), to: ymd(now) };
}
function ymd(d) { return d.toISOString().slice(0, 10); }

// ─── GET /payouts/reconciliation ───────────────────────────
// Top-line cash position for the period: collected from citizens, platform
// fee retained, and net owed to offices split into transferred / pending /
// unsettled. The "where is the money + what's left to transfer" view.
platformAdminRouter.get('/payouts/reconciliation', async (req, res) => {
  const { from, to } = expandPreset(req.query.preset || 'last_week', req.query.from, req.query.to);
  try {
    res.json(await reconcile({ from, to }));
  } catch (e) {
    console.error('[payouts/reconciliation]', e);
    res.status(500).json({ error: 'reconciliation_failed', detail: e.message });
  }
});

// ─── GET /payouts/eligible-by-office ───────────────────────
// One-row-per-office summary of UNSETTLED paid requests for the period.
// Drives the main "who do we owe" table on the admin UI. Bank fields are
// included so the operator can see at a glance which offices are
// transfer-ready vs. still need to fill in their IBAN.
platformAdminRouter.get('/payouts/eligible-by-office', async (req, res) => {
  const { from, to } = expandPreset(req.query.preset || 'last_week', req.query.from, req.query.to);
  const feePerReq = platformFeeOmr();
  const { rows } = await db.execute({
    sql: `SELECT r.office_id,
                 o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 o.email AS office_email, o.phone AS office_phone,
                 o.iban, o.bank_name, o.account_holder_name, o.bank_swift,
                 o.bank_verified_at, o.billing_email,
                 COUNT(*) AS request_count,
                 COALESCE(SUM(r.payment_amount_omr), 0) AS gross_omr
            FROM request r
            JOIN office o ON o.id = r.office_id
           WHERE r.payment_status = 'paid'
             AND r.paid_at >= ? AND r.paid_at <= ?
             AND r.payout_id IS NULL
           GROUP BY r.office_id
           ORDER BY gross_omr DESC`,
    args: [from + ' 00:00:00', to + ' 23:59:59']
  });
  const eligible = rows.map(r => {
    const platform_fee_omr = Number(r.request_count) * feePerReq;
    const net_omr = Math.max(0, Number(r.gross_omr) - platform_fee_omr);
    const has_bank = !!(r.iban && r.bank_name && r.account_holder_name);
    return {
      office_id: r.office_id,
      office_name_ar: r.office_name_ar, office_name_en: r.office_name_en,
      office_email: r.office_email, office_phone: r.office_phone,
      billing_email: r.billing_email || null,
      iban: r.iban || null, bank_name: r.bank_name || null,
      account_holder_name: r.account_holder_name || null,
      bank_swift: r.bank_swift || null,
      bank_verified_at: r.bank_verified_at || null,
      has_bank_details: has_bank,
      request_count: Number(r.request_count),
      gross_omr:        round3(r.gross_omr),
      platform_fee_omr: round3(platform_fee_omr),
      net_omr:          round3(net_omr)
    };
  });
  res.json({
    period: { from, to },
    fee_per_request_omr: feePerReq,
    offices: eligible,
    totals: {
      offices_count:    eligible.length,
      request_count:    eligible.reduce((a, e) => a + e.request_count, 0),
      gross_omr:        round3(eligible.reduce((a, e) => a + e.gross_omr, 0)),
      platform_fee_omr: round3(eligible.reduce((a, e) => a + e.platform_fee_omr, 0)),
      net_omr:          round3(eligible.reduce((a, e) => a + e.net_omr, 0))
    }
  });
});

// ─── GET /payouts/preview ──────────────────────────────────
// Drill-down: every eligible request for ONE office in the period, with
// totals. Read-only — no DB writes.
platformAdminRouter.get('/payouts/preview', async (req, res) => {
  const officeId = Number(req.query.office_id);
  if (!officeId) return res.status(400).json({ error: 'missing_office_id' });
  const { from, to } = expandPreset(req.query.preset || 'last_week', req.query.from, req.query.to);
  const preview = await previewPayout({ officeId, from, to });
  res.json(preview);
});

// ─── POST /payouts/generate ────────────────────────────────
// Materialise a payout for one office + period. Stamps request.payout_id
// atomically so the same request can't end up in two payouts.
platformAdminRouter.post('/payouts/generate', async (req, res) => {
  const officeId = Number(req.body?.office_id);
  if (!officeId) return res.status(400).json({ error: 'missing_office_id' });
  const { from, to } = expandPreset(req.body?.preset || 'last_week', req.body?.from, req.body?.to);
  const result = await generatePayout({
    officeId, from, to,
    createdByOfficerId: req.officer?.officer_id || null
  });
  if (!result) return res.status(409).json({ error: 'nothing_eligible', from, to, office_id: officeId });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'payout_generate', 'office_payout', ?, ?)`,
    args: [req.officer?.officer_id || null, result.payout.id,
           JSON.stringify({ office_id: officeId, from, to, request_count: result.request_ids.length })]
  });
  res.json(result);
});

// ─── POST /payouts/generate-all ────────────────────────────
// Convenience: run generatePayout for EVERY office with eligible
// requests in the period, in one call. Returns the list of new payout ids.
platformAdminRouter.post('/payouts/generate-all', async (req, res) => {
  const { from, to } = expandPreset(req.body?.preset || 'last_week', req.body?.from, req.body?.to);
  const { rows } = await db.execute({
    sql: `SELECT DISTINCT office_id FROM request
           WHERE payment_status='paid'
             AND paid_at >= ? AND paid_at <= ?
             AND payout_id IS NULL`,
    args: [from + ' 00:00:00', to + ' 23:59:59']
  });
  const created = [];
  for (const r of rows) {
    const result = await generatePayout({
      officeId: r.office_id, from, to,
      createdByOfficerId: req.officer?.officer_id || null
    });
    if (result) created.push(result.payout);
  }
  res.json({ period: { from, to }, created_count: created.length, payouts: created });
});

// ─── GET /payouts ──────────────────────────────────────────
// List generated payouts, newest first. Filters: status, office_id, date.
platformAdminRouter.get('/payouts', async (req, res) => {
  const filters = [];
  const args = [];
  if (req.query.status && req.query.status !== 'all') {
    filters.push(`p.status = ?`); args.push(String(req.query.status));
  }
  if (req.query.office_id) {
    filters.push(`p.office_id = ?`); args.push(Number(req.query.office_id));
  }
  if (req.query.from) { filters.push(`p.period_end >= ?`); args.push(String(req.query.from)); }
  if (req.query.to)   { filters.push(`p.period_start <= ?`); args.push(String(req.query.to)); }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const { rows } = await db.execute({
    sql: `SELECT p.*, o.name_en AS office_name_en, o.name_ar AS office_name_ar
            FROM office_payout p
            LEFT JOIN office o ON o.id = p.office_id
            ${where}
           ORDER BY p.created_at DESC LIMIT 500`,
    args
  });
  res.json({ payouts: rows, count: rows.length });
});

// ─── GET /payouts/export ───────────────────────────────────
// CSV download. UTF-8 BOM so Excel renders Arabic columns correctly.
// MUST stay above `/payouts/:id` — Express matches routes in declaration
// order and /payouts/:id would otherwise swallow /payouts/export with
// id='export'. (Number('export')=NaN then crashed downstream.)
platformAdminRouter.get('/payouts/export', async (req, res) => {
  let csv;
  try {
    csv = await exportPayoutsCsv({
      from:     req.query.from || undefined,
      to:       req.query.to   || undefined,
      status:   req.query.status || undefined,
      officeId: req.query.office_id ? Number(req.query.office_id) : undefined
    });
  } catch (e) {
    console.error('[payouts/export] failed:', e);
    return res.status(500).json({ error: 'export_failed', detail: e.message });
  }
  const tag = (req.query.from || 'all') + '_' + (req.query.to || 'all');
  // Send as a Buffer so the leading UTF-8 BOM survives Express's string-mode
  // Content-Length calc (BOM is 1 char but 3 bytes — would stall the stream).
  const body = Buffer.from(csv, 'utf8');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sanad-payouts-${tag}.csv"`);
  res.setHeader('Content-Length', body.length);
  res.end(body);
});

// ─── GET /payouts/:id ──────────────────────────────────────
// Detail + the list of requests included in this settlement.
platformAdminRouter.get('/payouts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'bad_id' });
  const { rows } = await db.execute({
    sql: `SELECT p.*, o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 o.email AS office_email, o.phone AS office_phone
            FROM office_payout p
            LEFT JOIN office o ON o.id = p.office_id
           WHERE p.id=? LIMIT 1`,
    args: [id]
  });
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const { rows: reqs } = await db.execute({
    sql: `SELECT r.id, r.payment_amount_omr, r.paid_at, r.payment_ref,
                 s.name_en AS service_name_en, s.name_ar AS service_name_ar,
                 c.name AS citizen_name, c.phone AS citizen_phone
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
            LEFT JOIN citizen c         ON c.id = r.citizen_id
           WHERE r.payout_id=? ORDER BY r.paid_at ASC`,
    args: [id]
  });
  res.json({ payout: rows[0], requests: reqs });
});

// ─── POST /payouts/:id/mark-paid ───────────────────────────
// Refuses if the office doesn't have IBAN + bank_name + holder set —
// otherwise the bank reference the operator pastes in is unverifiable.
// Operator can override with { force: true } in the body (logged in
// audit_log so it's traceable).
platformAdminRouter.post('/payouts/:id/mark-paid', async (req, res) => {
  const id = Number(req.params.id);
  const force = req.body?.force === true || req.body?.force === 'true';
  // Look up the office's bank state for this payout.
  const { rows } = await db.execute({
    sql: `SELECT o.iban, o.bank_name, o.account_holder_name
            FROM office_payout p
            JOIN office o ON o.id = p.office_id
           WHERE p.id=? LIMIT 1`,
    args: [id]
  });
  const o = rows[0];
  if (!o) return res.status(404).json({ error: 'not_found' });
  const has_bank = !!(o.iban && o.bank_name && o.account_holder_name);
  if (!has_bank && !force) {
    return res.status(409).json({
      error: 'office_missing_bank_details',
      detail: 'Office must set IBAN + bank name + account holder before payout can be marked paid. Pass { force: true } to override.'
    });
  }
  const result = await markPayoutPaid({
    payoutId: id,
    reference: String(req.body?.reference || ''),
    notes:     String(req.body?.notes || ''),
    paidByOfficerId: req.officer?.officer_id || null
  });
  if (!result.ok) return res.status(409).json(result);
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'payout_paid', 'office_payout', ?, ?)`,
    args: [req.officer?.officer_id || null, id,
           JSON.stringify({ reference: req.body?.reference, notes: req.body?.notes })]
  });
  res.json(result);
});

// ─── POST /payouts/:id/cancel ──────────────────────────────
// Releases the included requests back to the eligible pool.
platformAdminRouter.post('/payouts/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  const result = await cancelPayout({ payoutId: id, notes: String(req.body?.notes || '') });
  if (!result.ok) return res.status(409).json(result);
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'payout_cancel', 'office_payout', ?, ?)`,
    args: [req.officer?.officer_id || null, id, JSON.stringify({ notes: req.body?.notes })]
  });
  res.json(result);
});

// ─── GET /payouts/export ───────────────────────────────────
// CSV download. UTF-8 BOM so Excel renders Arabic columns correctly.

// Tiny — same rounding helper as the lib; declared local so this file
// doesn't need to import a single private util.
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
