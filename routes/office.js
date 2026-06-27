// Office self-service — profile, team, invites.
// All endpoints require a signed-in officer; most are gated to role:'owner'
// or 'manager' (owners can do everything, officers see read-only team + profile).

import { Router } from 'express';
import { db } from '../lib/db.js';
import { hashPassword, requireOfficer } from '../lib/auth.js';
import { validateIban } from '../lib/iban.js';

export const officeRouter = Router();

// ─── GET /profile ──────────────────────────────────────────
// Full profile (stats + bank details + flags). Available to any active officer
// of the office. The `has_bank_details` flag drives the dashboard banner that
// nudges owners to fill in IBAN before the next payout.
officeRouter.get('/profile', requireOfficer({ allowPending: true }), async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, governorate, wilayat, email, phone, cr_number,
                 status, plan, wallet_baisa, rating, offers_won, offers_abandoned,
                 total_completed, avg_completion_hours, reviewed_at, reject_reason,
                 credits_remaining, subscription_status, default_office_fee_omr, created_at,
                 iban, bank_name, account_holder_name, bank_swift, billing_email,
                 bank_updated_at, bank_verified_at
            FROM office WHERE id=?`,
    args: [req.office.id]
  });
  const o = rows[0] || null;
  if (o) {
    o.has_bank_details = !!(o.iban && o.bank_name && o.account_holder_name);
  }
  res.json({ office: o });
});

// ─── GET /bank ─────────────────────────────────────────────
// Returns only the bank+billing block. Lets the settings panel poll just
// this fragment without re-reading the whole profile + stats.
officeRouter.get('/bank', requireOfficer({ allowPending: true }), async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT iban, bank_name, account_holder_name, bank_swift, billing_email,
                 phone, email,
                 bank_updated_at, bank_verified_at
            FROM office WHERE id=?`,
    args: [req.office.id]
  });
  const o = rows[0] || {};
  res.json({
    bank: {
      iban:                 o.iban || '',
      bank_name:            o.bank_name || '',
      account_holder_name:  o.account_holder_name || '',
      bank_swift:           o.bank_swift || '',
      billing_email:        o.billing_email || '',
      bank_updated_at:      o.bank_updated_at || null,
      bank_verified_at:     o.bank_verified_at || null
    },
    contact: {
      phone: o.phone || '',
      email: o.email || ''
    },
    has_bank_details: !!(o.iban && o.bank_name && o.account_holder_name)
  });
});

// ─── PATCH /bank ───────────────────────────────────────────
// Owner-only edit of bank + contact info. IBAN is validated (length +
// mod-97 checksum) — we 400 with a precise error tag so the form can
// render "Please check IBAN — bad checksum" rather than a generic "save
// failed". Setting a new IBAN clears bank_verified_at so the admin
// re-verifies after the next successful transfer.
//
// Accepts any subset of fields — undefined keys are left untouched. To
// CLEAR a value pass an empty string; null is treated as "don't touch".
officeRouter.patch('/bank', requireOfficer({ roles: ['owner'], allowPending: true }), async (req, res) => {
  const b = req.body || {};
  /** @type {Record<string,string|null>} */
  const updates = {};

  // IBAN: trim → normalise → validate. Empty string clears.
  if (typeof b.iban === 'string') {
    const raw = b.iban.trim();
    if (raw === '') {
      updates.iban = null;
    } else {
      const v = validateIban(raw);
      if (!v.ok) {
        return res.status(400).json({ error: 'bad_iban', detail: v.error });
      }
      updates.iban = v.normalised;
    }
  }

  // String fields with sane length caps to keep the DB tidy.
  const setStr = (key, max) => {
    if (typeof b[key] !== 'string') return;
    const v = b[key].trim();
    updates[key] = v ? v.slice(0, max) : null;
  };
  setStr('bank_name',           120);
  setStr('account_holder_name', 200);
  setStr('bank_swift',           20);
  setStr('billing_email',       200);
  setStr('phone',                40);

  // Light validation on contact email/swift so we catch obvious typos.
  if (typeof updates.billing_email === 'string' && updates.billing_email !== null &&
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(updates.billing_email)) {
    return res.status(400).json({ error: 'bad_billing_email' });
  }
  if (typeof updates.bank_swift === 'string' && updates.bank_swift !== null &&
      !/^[A-Z0-9]{8,11}$/i.test(updates.bank_swift)) {
    return res.status(400).json({ error: 'bad_swift', detail: 'SWIFT/BIC is 8 or 11 alphanumeric chars' });
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_fields' });

  // If IBAN changed, drop any prior verification flag — admin re-verifies.
  const ibanChanged = Object.prototype.hasOwnProperty.call(updates, 'iban');

  // Build the UPDATE dynamically. We always stamp bank_updated_at so the
  // admin can see staleness; bank_verified_at clears when IBAN changes.
  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c}=?`).join(', ')
                + ', bank_updated_at=datetime(\'now\')'
                + (ibanChanged ? ', bank_verified_at=NULL' : '');
  await db.execute({
    sql: `UPDATE office SET ${setSql} WHERE id=?`,
    args: [...cols.map(c => updates[c]), req.office.id]
  });

  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'update_bank', 'office', ?, ?)`,
    args: [req.officer.officer_id, req.office.id,
           JSON.stringify({ keys: cols, iban_changed: ibanChanged })]
  });
  res.json({ ok: true, updated: cols, iban_verification_cleared: ibanChanged });
});

// ─── Per-office pricing: RETIRED ───────────────────────────
// The office commission is now GLOBAL + consistent for every office
// (service_catalog.office_fee_omr). The old per-office overrides — PATCH
// /settings (default_office_fee_omr) and GET/PATCH/DELETE /pricing
// (office_service_price) — have been removed. The office_service_price table
// and office.default_office_fee_omr column remain in the schema but are dormant
// (no longer read or written) and can be dropped in a later migration.

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

// ─── POST /catalog/service ─────────────────────────────────
// Any active office (owner/manager) can add a service to the GLOBAL catalog.
// Services are shared across all offices with a single, consistent office
// commission — so the new row is immediately live + searchable for everyone
// (verification_source 'office', status 'office_approved'). We record who added
// it (audit log + source_url) and soft-block obvious duplicate names.
officeRouter.post('/catalog/service', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const b = req.body || {};
  const name_ar   = String(b.name_ar   || '').trim().slice(0, 200);
  const name_en   = String(b.name_en   || '').trim().slice(0, 200);
  const entity_ar = String(b.entity_ar || '').trim().slice(0, 200);
  const entity_en = String(b.entity_en || '').trim().slice(0, 200);
  const office_fee_omr = Number(b.office_fee_omr);

  if (!name_ar && !name_en) return res.status(400).json({ error: 'name_required' });
  if (!(office_fee_omr > 0) || office_fee_omr > 500) return res.status(400).json({ error: 'bad_commission' });

  const { normalize } = await import('../lib/catalogue.js');
  const nAr = normalize(name_ar), nEn = normalize(name_en);
  // Soft dup-check against active services — keep the shared catalog clean.
  const { rows: existing } = await db.execute({
    sql: `SELECT id, name_ar, name_en FROM service_catalog WHERE is_active=1`
  });
  const dup = existing.find(s =>
    (nAr && normalize(s.name_ar || '') === nAr) || (nEn && normalize(s.name_en || '') === nEn));
  if (dup) return res.status(409).json({ error: 'already_exists', service: { id: dup.id, name_ar: dup.name_ar, name_en: dup.name_en } });

  // Required documents: [{label_ar, label_en, type}] — type ∈ file|text|date|number.
  const TYPES = new Set(['file', 'text', 'date', 'number']);
  const docs = (Array.isArray(b.documents) ? b.documents : []).slice(0, 30).map((d, i) => {
    const la = String(d?.label_ar || '').trim().slice(0, 160);
    const le = String(d?.label_en || '').trim().slice(0, 160);
    if (!la && !le) return null;
    return { code: `doc_${i + 1}`, label_ar: la || le, label_en: le || la, type: TYPES.has(d?.type) ? d.type : 'file' };
  }).filter(Boolean);

  const blob = [name_en, name_ar, entity_en, entity_ar].filter(Boolean).join(' ').toLowerCase();
  const ins = await db.execute({
    sql: `INSERT INTO service_catalog
            (entity_en,entity_ar,name_en,name_ar,required_documents_json,
             fee_omr,office_fee_omr,gov_fee_tbd,
             verification_status,verification_source,verified_at,
             is_active,is_launch,version,search_blob,source_url,updated_at)
          VALUES (?,?,?,?,?, NULL,?,1, 'office_approved','office',datetime('now'),
                  1,0,1,?,?,datetime('now'))`,
    args: [entity_en || null, entity_ar || null, name_en || name_ar, name_ar || name_en,
           JSON.stringify(docs), office_fee_omr, blob, `office_added:${req.office.id}`]
  });
  const serviceId = Number(ins.lastInsertRowid);
  // Stamp a unique provenance key now that we have the row id.
  await db.execute({
    sql: `UPDATE service_catalog SET source_url=? WHERE id=?`,
    args: [`office_added:${req.office.id}:${serviceId}`, serviceId]
  });
  try {
    await db.execute({
      sql: `INSERT INTO service_catalog_fts(rowid,name_en,name_ar,description_en,description_ar,entity_en,entity_ar)
            VALUES (?,?,?,?,?,?,?)`,
      args: [serviceId, name_en || name_ar, name_ar || name_en, '', '', entity_en || '', entity_ar || '']
    });
  } catch { /* contentless FTS — safe to ignore */ }
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer', ?, 'service_add', 'service', ?, ?)`,
    args: [req.officer.officer_id, serviceId, JSON.stringify({ name_ar, name_en, office_fee_omr, docs: docs.length })]
  });
  res.status(201).json({ ok: true, service_id: serviceId });
});

// ─── GET /catalog/services — FULL catalog for office maintainers ────────
// Owner/manager only. Unlike the public /api/catalogue/* (active-only, what
// CITIZENS see), this returns the FULL shared catalog (active + inactive) so an
// office can co-maintain it. Filters: ?q (name/entity substring, AR or EN),
// ?entity (exact entity_en), ?status (active|inactive|all, default all),
// ?limit (def 100, max 500), ?offset.
officeRouter.get('/catalog/services', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const entity = String(req.query.entity || '').trim();
  const status = String(req.query.status || 'all');
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [];
  const args = [];
  if (status === 'active') where.push('is_active=1');
  else if (status === 'inactive') where.push('is_active=0');
  if (q) {
    where.push('(name_en LIKE ? OR name_ar LIKE ? OR entity_en LIKE ? OR entity_ar LIKE ?)');
    const like = `%${q}%`; args.push(like, like, like, like);
  }
  if (entity) { where.push('entity_en = ?'); args.push(entity); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await db.execute({
    sql: `SELECT id, entity_en, entity_ar, name_en, name_ar, fee_omr, office_fee_omr,
                 fees_text, gov_fee_tbd, is_active, verification_status, version,
                 required_documents_json
            FROM service_catalog ${whereSql}
            ORDER BY is_active DESC, name_ar LIMIT ${limit} OFFSET ${offset}`,
    args
  });
  const { rows: tot } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM service_catalog ${whereSql}`, args });
  res.json({ services: rows, total: tot[0]?.n || 0, limit, offset });
});

// ─── PATCH /catalog/service/:id — edit / activate / deactivate ──────────
// Owner/manager only. Offices co-maintain the shared catalog. Editable subset:
// name_ar/en, entity_ar/en, fees_text, office_fee_omr, fee_omr (gov; null →
// gov_fee_tbd), is_active (activate/deactivate), documents. FTS + search_blob
// re-synced, version bumped, audit-logged as 'service_update' (actor=officer).
officeRouter.patch('/catalog/service/:id', requireOfficer({ roles: ['owner', 'manager'] }), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const b = req.body || {};
  const patch = {};
  if (typeof b.name_ar   === 'string') patch.name_ar   = b.name_ar.trim().slice(0, 200);
  if (typeof b.name_en   === 'string') patch.name_en   = b.name_en.trim().slice(0, 200);
  if (typeof b.entity_ar === 'string') patch.entity_ar = b.entity_ar.trim().slice(0, 200);
  if (typeof b.entity_en === 'string') patch.entity_en = b.entity_en.trim().slice(0, 200);
  if (typeof b.fees_text === 'string') patch.fees_text = b.fees_text.trim().slice(0, 200);
  if (b.office_fee_omr !== undefined) {
    const f = Number(b.office_fee_omr);
    if (!Number.isFinite(f) || f < 0 || f > 500) return res.status(400).json({ error: 'bad_commission' });
    patch.office_fee_omr = f;
  }
  if (b.fee_omr !== undefined) {
    if (b.fee_omr === null || b.fee_omr === '') { patch.fee_omr = null; patch.gov_fee_tbd = 1; }
    else {
      const f = Number(b.fee_omr);
      if (!Number.isFinite(f) || f < 0 || f > 5000) return res.status(400).json({ error: 'bad_fee' });
      patch.fee_omr = f; patch.gov_fee_tbd = 0;
    }
  }
  if (b.is_active !== undefined) patch.is_active = b.is_active ? 1 : 0;
  if (Array.isArray(b.documents)) {
    const TYPES = new Set(['file', 'text', 'date', 'number']);
    const docs = b.documents.slice(0, 30).map((d, i) => {
      const la = String(d?.label_ar || '').trim().slice(0, 160);
      const le = String(d?.label_en || '').trim().slice(0, 160);
      if (!la && !le) return null;
      return { code: `doc_${i + 1}`, label_ar: la || le, label_en: le || la, type: TYPES.has(d?.type) ? d.type : 'file' };
    }).filter(Boolean);
    patch.required_documents_json = JSON.stringify(docs);
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });

  const exists = await db.execute({ sql: `SELECT id FROM service_catalog WHERE id=?`, args: [id] });
  if (!exists.rows.length) return res.status(404).json({ error: 'not_found' });

  const cols = Object.keys(patch);
  await db.execute({
    sql: `UPDATE service_catalog SET ${cols.map(c => `${c}=?`).join(',')}, version=COALESCE(version,1)+1 WHERE id=?`,
    args: [...cols.map(c => patch[c]), id]
  });
  // Re-sync the search lanes if any searchable field changed.
  if (['name_en', 'name_ar', 'entity_en', 'entity_ar'].some(c => c in patch)) {
    try {
      const { rows: cur } = await db.execute({
        sql: `SELECT name_en, name_ar, description_en, description_ar, entity_en, entity_ar FROM service_catalog WHERE id=?`,
        args: [id]
      });
      const r = cur[0] || {};
      const blob = [r.name_en, r.name_ar, r.entity_en, r.entity_ar].filter(Boolean).join(' ').toLowerCase();
      await db.execute({ sql: `UPDATE service_catalog SET search_blob=? WHERE id=?`, args: [blob, id] });
      await db.execute({ sql: `DELETE FROM service_catalog_fts WHERE rowid=?`, args: [id] });
      await db.execute({
        sql: `INSERT INTO service_catalog_fts(rowid,name_en,name_ar,description_en,description_ar,entity_en,entity_ar) VALUES (?,?,?,?,?,?,?)`,
        args: [id, r.name_en || '', r.name_ar || '', r.description_en || '', r.description_ar || '', r.entity_en || '', r.entity_ar || '']
      });
    } catch { /* contentless FTS — safe to ignore */ }
  }
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer',?, 'service_update', 'service', ?, ?)`,
    args: [req.officer.officer_id, id, JSON.stringify({ ...patch, by_office: req.office.id })]
  });
  res.json({ ok: true, patched: patch });
});
