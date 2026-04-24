// Authentication + office signup routes.
//
// Public endpoints:
//   POST /api/auth/signup        — register a new Sanad office + its first admin officer
//   POST /api/auth/login         — sign in (email + password) → sets httpOnly cookie
//   POST /api/auth/logout        — clears the cookie
//   GET  /api/auth/me            — who am I (office + officer)
//
// Signup creates the office in status='pending_review' — they cannot browse the
// marketplace until a platform admin approves them. Their admin officer can
// still log in to see the "awaiting approval" screen.

import { Router } from 'express';
import { db } from '../lib/db.js';
import {
  hashPassword, verifyPassword,
  signToken, setSessionCookie, clearSessionCookie,
  loadOfficer, requireOfficer
} from '../lib/auth.js';

export const authRouter = Router();

// Oman governorates — used for signup validation
const GOVERNORATES = new Set([
  'Muscat','Dhofar','Musandam','Al Buraimi','Ad Dakhiliyah','Al Batinah North',
  'Al Batinah South','Ash Sharqiyah North','Ash Sharqiyah South','Adh Dhahirah','Al Wusta'
]);

function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function safeStr(s, max = 200) { return String(s || '').trim().slice(0, max); }

// ─── POST /signup ──────────────────────────────────────────
// Body: {
//   office_name_en, office_name_ar, governorate, wilayat, cr_number, phone,
//   email, full_name, password
// }
// Creates office (status='pending_review') + admin officer (role='owner').
// Auto-signs them in so they see "pending approval" page immediately.
authRouter.post('/signup', async (req, res) => {
  try {
    const b = req.body || {};
    const office_name_en = safeStr(b.office_name_en, 120);
    const office_name_ar = safeStr(b.office_name_ar, 120);
    const governorate    = safeStr(b.governorate, 40);
    const wilayat        = safeStr(b.wilayat, 60);
    const cr_number      = safeStr(b.cr_number, 40);
    const office_phone   = safeStr(b.phone, 40);
    const email          = normEmail(b.email);
    const full_name      = safeStr(b.full_name, 120);
    const password       = String(b.password || '');

    // Basic validation
    const missing = [];
    if (!office_name_en && !office_name_ar) missing.push('office_name');
    if (!governorate) missing.push('governorate');
    if (!cr_number) missing.push('cr_number');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push('email');
    if (!full_name) missing.push('full_name');
    if (password.length < 8) missing.push('password>=8');
    if (missing.length) return res.status(400).json({ error: 'validation', missing });
    if (governorate && !GOVERNORATES.has(governorate)) {
      return res.status(400).json({ error: 'bad_governorate', allowed: [...GOVERNORATES] });
    }

    // Uniqueness — officer email (admin) AND office email
    const { rows: dupe } = await db.execute({
      sql: `SELECT 1 FROM officer WHERE lower(email)=? LIMIT 1`, args: [email]
    });
    if (dupe.length) return res.status(409).json({ error: 'email_taken' });

    // Create the office first
    const password_hash = await hashPassword(password);
    const ins = await db.execute({
      sql: `INSERT INTO office
              (name_en, name_ar, governorate, wilayat, email, phone, cr_number, status, plan)
            VALUES (?,?,?,?,?,?,?, 'pending_review', 'pro')`,
      args: [office_name_en || office_name_ar, office_name_ar || office_name_en,
             governorate, wilayat || null, email, office_phone || null, cr_number]
    });
    const office_id = Number(ins.lastInsertRowid);

    // Create the owner officer
    const ofIns = await db.execute({
      sql: `INSERT INTO officer (office_id, full_name, email, role, password_hash, phone, status)
            VALUES (?,?,?, 'owner', ?, ?, 'active')`,
      args: [office_id, full_name, email, password_hash, office_phone || null]
    });
    const officer_id = Number(ofIns.lastInsertRowid);

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'office_signup', 'office', ?, ?)`,
      args: [officer_id, office_id, JSON.stringify({ governorate, cr_number })]
    });

    const token = signToken({ officer_id });
    setSessionCookie(res, token);

    const fresh = await loadOfficer(officer_id);
    res.status(201).json({ ok: true, officer: publicOfficer(fresh) });
  } catch (e) {
    console.error('[auth/signup] error', e);
    res.status(500).json({ error: 'signup_failed', detail: e.message });
  }
});

// ─── POST /login ───────────────────────────────────────────
authRouter.post('/login', async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });

  const { rows } = await db.execute({
    sql: `SELECT id, password_hash, status FROM officer WHERE lower(email)=? LIMIT 1`,
    args: [email]
  });
  const officer = rows[0];
  if (!officer || !officer.password_hash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (officer.status === 'disabled') return res.status(403).json({ error: 'account_disabled' });
  const ok = await verifyPassword(password, officer.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  await db.execute({
    sql: `UPDATE officer SET last_login_at=datetime('now') WHERE id=?`, args: [officer.id]
  });
  setSessionCookie(res, signToken({ officer_id: officer.id }));

  const fresh = await loadOfficer(officer.id);
  res.json({ ok: true, officer: publicOfficer(fresh) });
});

// ─── POST /logout ──────────────────────────────────────────
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─── GET /me ───────────────────────────────────────────────
// Returns the full officer+office view if signed in.
// Explicitly tolerates a not-yet-approved office (allowPending:true)
// so the signup success page can render while status='pending_review'.
authRouter.get('/me', requireOfficer({ allowPending: true }), (req, res) => {
  res.json({ officer: publicOfficer(req.officer) });
});

// Small wrapper — never leak password_hash to the client
function publicOfficer(o) {
  if (!o) return null;
  return {
    id: o.officer_id,
    full_name: o.full_name,
    email: o.email,
    role: o.role,
    status: o.officer_status,
    phone: o.officer_phone,
    office: {
      id: o.office_id,
      name_en: o.office_name_en,
      name_ar: o.office_name_ar,
      governorate: o.governorate,
      wilayat: o.wilayat,
      status: o.office_status,
      plan: o.plan,
      rating: o.rating,
      cr_number: o.cr_number,
      offers_won: o.offers_won,
      offers_abandoned: o.offers_abandoned,
      total_completed: o.total_completed
    }
  };
}
