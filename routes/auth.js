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
import { rateLimit } from '../lib/rate_limit.js';
import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../lib/whatsapp_send.js';

export const authRouter = Router();

// IP-level outer ring for officer credential endpoints. Per-account guards
// (bcrypt cost, last_login_at audit) sit underneath.
const loginLimiter  = rateLimit({ key: 'auth:login',  limit: 8,  windowMs: 60_000 });
const signupLimiter = rateLimit({ key: 'auth:signup', limit: 4,  windowMs: 60_000 });

// ─── Password complexity ───────────────────────────────────
// Rejects common weak shapes. We don't try to enforce a giant blocklist —
// the bcrypt cost handles offline attacks; this just stops obviously
// guessable choices at signup.
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd',
  '12345678', '123456789', 'qwerty123', 'qwertyui',
  'admin123', 'letmein123', 'welcome1', 'sanad123', 'saned123',
  'office123', 'abc12345'
]);
function passwordIssues(p) {
  const issues = [];
  if (typeof p !== 'string' || p.length < 10) issues.push('min_10_chars');
  if (!/[A-Za-z]/.test(p))                    issues.push('needs_letter');
  if (!/\d/.test(p))                          issues.push('needs_digit');
  if (WEAK_PASSWORDS.has((p || '').toLowerCase())) issues.push('too_common');
  return issues;
}

// ─── Oman phone ────────────────────────────────────────────
// Normalize common shapes to the canonical +968XXXXXXXX, then require it.
// Accepts: +968XXXXXXXX · 00968XXXXXXXX · 968XXXXXXXX · bare 8-digit local.
function normalizeOmanPhone(raw) {
  let p = String(raw || '').trim().replace(/[\s\-()]/g, '');
  if (!p) return '';
  if (p.startsWith('+968'))  return p;
  if (p.startsWith('00968')) return '+' + p.slice(2);
  if (p.startsWith('968'))   return '+' + p;
  if (/^\d{8}$/.test(p))     return '+968' + p;
  return p; // leave as-is → phoneIssues rejects it
}
function phoneIssues(normalized) {
  if (!normalized) return ['required'];
  if (!/^\+968\d{8}$/.test(normalized)) return ['must_be_oman_+968_8_digits'];
  return [];
}

// ─── Password-reset OTP config ─────────────────────────────
const RESET_OTP_TTL_MIN      = Number(process.env.RESET_OTP_TTL_MIN || 10);
const RESET_OTP_MAX_ATTEMPTS = Number(process.env.RESET_OTP_MAX_ATTEMPTS || 5);
const RESET_OTP_COOLDOWN_S   = Number(process.env.RESET_OTP_COOLDOWN_S || 45);
const OTP_TEMPLATE      = process.env.WHATSAPP_OTP_TEMPLATE || 'sanad_otp';
const OTP_TEMPLATE_LANG = process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en';
function genOtp() { return String(randomInt(100000, 1000000)); }
function sqliteUtcToMs(s) { return new Date(String(s).replace(' ', 'T') + 'Z').getTime(); }

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
authRouter.post('/signup', signupLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const office_name_en = safeStr(b.office_name_en, 120);
    const office_name_ar = safeStr(b.office_name_ar, 120);
    const governorate    = safeStr(b.governorate, 40);
    const wilayat        = safeStr(b.wilayat, 60);
    const cr_number      = safeStr(b.cr_number, 40);
    const office_phone   = normalizeOmanPhone(b.phone);  // canonical +968XXXXXXXX
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
    const phIssues = phoneIssues(office_phone);
    if (phIssues.length) missing.push(...phIssues.map(i => `phone:${i}`));
    const pwIssues = passwordIssues(password);
    if (pwIssues.length) missing.push(...pwIssues.map(i => `password:${i}`));
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
authRouter.post('/login', loginLimiter, async (req, res) => {
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

// ─── POST /forgot-password ─────────────────────────────────
// Body: { email }. Sends a 6-digit reset code to the office's WhatsApp number.
// ALWAYS responds ok (never reveals whether the email is registered).
authRouter.post('/forgot-password', signupLimiter, async (req, res) => {
  // Generic body — identical whether or not the account exists.
  const generic = { ok: true, hint: 'إن كان البريد مسجّلاً ومرتبطاً برقم واتساب، فسيصلك رمز خلال لحظات.' };
  try {
    const email = normEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'email_required' });

    const { rows } = await db.execute({
      sql: `SELECT id, phone FROM officer WHERE lower(email)=? LIMIT 1`, args: [email]
    });
    const officer = rows[0];
    if (!officer || !officer.phone) return res.json(generic);

    // Cooldown — block rapid resends per account.
    const { rows: last } = await db.execute({
      sql: `SELECT last_sent_at FROM password_reset_otp WHERE officer_id=? ORDER BY id DESC LIMIT 1`,
      args: [officer.id]
    });
    if (last[0] && (Date.now() - sqliteUtcToMs(last[0].last_sent_at)) / 1000 < RESET_OTP_COOLDOWN_S) {
      return res.json(generic);
    }

    const code = genOtp();
    const code_hash = await bcrypt.hash(code, 8);
    await db.execute({
      sql: `INSERT INTO password_reset_otp(officer_id, code_hash, expires_at)
            VALUES (?,?, datetime('now', ?))`,
      args: [officer.id, code_hash, `+${RESET_OTP_TTL_MIN} minutes`]
    });

    // Deliver: approved template (works outside Meta's 24h window) → free-form
    // text fallback (only lands if a 24h session is already open).
    let delivered = false;
    try {
      const t = await sendWhatsAppTemplate(officer.phone, OTP_TEMPLATE, OTP_TEMPLATE_LANG, [code, String(RESET_OTP_TTL_MIN)]);
      delivered = !!t?.ok;
    } catch (e) { console.warn('[auth/forgot] template send failed:', e.message); }
    if (!delivered) {
      try {
        const r = await sendWhatsAppText(officer.phone,
          `🔐 رمز إعادة تعيين كلمة مرور ساند: ${code}\nصالح لمدة ${RESET_OTP_TTL_MIN} دقائق. لا تُشاركه مع أحد.`);
        delivered = !!r?.ok;
      } catch (e) { console.warn('[auth/forgot] text send failed:', e.message); }
    }
    res.json(generic);
  } catch (e) {
    console.error('[auth/forgot-password]', e);
    res.json(generic); // stay generic even on error
  }
});

// ─── POST /reset-password ──────────────────────────────────
// Body: { email, code, password }. Verifies the OTP, sets the new password.
authRouter.post('/reset-password', loginLimiter, async (req, res) => {
  try {
    const email    = normEmail(req.body?.email);
    const code     = String(req.body?.code || '').trim();
    const password = String(req.body?.password || '');
    if (!email || !code) return res.status(400).json({ error: 'missing_fields' });
    const pwIssues = passwordIssues(password);
    if (pwIssues.length) return res.status(400).json({ error: 'weak_password', issues: pwIssues });

    const { rows } = await db.execute({
      sql: `SELECT id FROM officer WHERE lower(email)=? LIMIT 1`, args: [email]
    });
    const officer = rows[0];
    if (!officer) return res.status(400).json({ error: 'invalid_code' });

    const { rows: otps } = await db.execute({
      sql: `SELECT id, code_hash, expires_at, attempts, consumed_at
              FROM password_reset_otp WHERE officer_id=? ORDER BY id DESC LIMIT 1`,
      args: [officer.id]
    });
    const otp = otps[0];
    if (!otp || otp.consumed_at) return res.status(400).json({ error: 'invalid_code' });
    if (sqliteUtcToMs(otp.expires_at) < Date.now()) return res.status(400).json({ error: 'code_expired' });
    if (otp.attempts >= RESET_OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'too_many_attempts' });

    const match = await bcrypt.compare(code, otp.code_hash);
    if (!match) {
      await db.execute({ sql: `UPDATE password_reset_otp SET attempts=attempts+1 WHERE id=?`, args: [otp.id] });
      return res.status(400).json({ error: 'invalid_code' });
    }

    const password_hash = await hashPassword(password);
    await db.execute({ sql: `UPDATE officer SET password_hash=? WHERE id=?`, args: [password_hash, officer.id] });
    await db.execute({ sql: `UPDATE password_reset_otp SET consumed_at=datetime('now') WHERE id=?`, args: [otp.id] });
    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id)
            VALUES ('officer', ?, 'password_reset', 'officer', ?)`,
      args: [officer.id, officer.id]
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/reset-password]', e);
    res.status(500).json({ error: 'reset_failed' });
  }
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
