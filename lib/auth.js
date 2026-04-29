// Authentication primitives for office signup / officer sign-in.
//
// Design choices:
//   • Password hashing: bcryptjs (pure-JS, no build step, 10 rounds)
//   • Session transport: signed JWT in an httpOnly cookie named `sanad_sess`
//   • Middleware shapes the request with `req.officer` + `req.office` on success
//
// Multi-tenant shape:
//   office (has status: pending_review | active | suspended | rejected)
//     └─ officer (has role: owner | manager | officer; status: active | invited | disabled)
//
// The JWT claims the officer's id; on every request we re-hydrate the officer
// + their office from the DB so revocation / suspension takes effect within one
// request, no stale token windows.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const JWT_SECRET = process.env.JWT_SECRET || 'sanad-dev-only-secret-change-me';
const COOKIE_NAME = 'sanad_sess';                  // officer / office cookie
const CITIZEN_COOKIE_NAME = 'sanad_citizen_sess';  // citizen-side cookie (separate from officer)
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Password helpers ───────────────────────────────────────
export async function hashPassword(plain) {
  if (!plain || plain.length < 8) throw new Error('password_too_short');
  return bcrypt.hash(plain, ROUNDS);
}
export async function verifyPassword(plain, hash) {
  if (!hash || !plain) return false;
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}

// ─── JWT helpers ────────────────────────────────────────────
export function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d', ...opts });
}
export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

export function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Read the session token from a request (cookie first, Bearer header fallback)
export function readToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const h = req.header('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// ─── DB helpers ─────────────────────────────────────────────
// Fetch the officer (+ their office) by id. Returns null if missing/disabled.
export async function loadOfficer(officer_id) {
  const { rows } = await db.execute({
    sql: `SELECT o.id AS officer_id, o.office_id, o.full_name, o.email, o.role, o.status AS officer_status,
                 o.phone AS officer_phone, o.last_login_at,
                 off.name_en AS office_name_en, off.name_ar AS office_name_ar,
                 off.governorate, off.wilayat, off.status AS office_status,
                 off.plan, off.rating, off.offers_won, off.offers_abandoned,
                 off.total_completed, off.avg_completion_hours, off.cr_number,
                 off.email AS office_email
            FROM officer o
            JOIN office  off ON off.id = o.office_id
           WHERE o.id = ?`,
    args: [officer_id]
  });
  return rows[0] || null;
}

// ─── Middleware ────────────────────────────────────────────
// Attach `req.session` = { officer_id, role } if a valid token is present.
// Does NOT reject unauthenticated requests — that's `requireOfficer`'s job.
export async function attachSession(req, _res, next) {
  const token = readToken(req);
  if (!token) return next();
  const claims = verifyToken(token);
  if (!claims?.officer_id) return next();
  const full = await loadOfficer(claims.officer_id);
  if (!full) return next();
  req.session = { officer_id: full.officer_id, role: full.role };
  req.officer = full;
  req.office  = {
    id: full.office_id, status: full.office_status,
    name_en: full.office_name_en, name_ar: full.office_name_ar,
    governorate: full.governorate, wilayat: full.wilayat,
    plan: full.plan, rating: full.rating
  };
  next();
}

// Require a signed-in officer. Also enforces the office is active.
// Use `opts.allowPending` for endpoints the admin should reach before approval.
export function requireOfficer(opts = {}) {
  const { allowPending = false, roles = null } = opts;
  return (req, res, next) => {
    if (!req.officer) return res.status(401).json({ error: 'not_signed_in' });
    if (req.officer.officer_status === 'disabled') return res.status(403).json({ error: 'account_disabled' });
    if (!allowPending && req.office.status !== 'active') {
      return res.status(403).json({ error: 'office_not_active', office_status: req.office.status });
    }
    if (roles && !roles.includes(req.officer.role)) {
      return res.status(403).json({ error: 'insufficient_role', need: roles, have: req.officer.role });
    }
    next();
  };
}

// Platform-admin (the Sanad-AI team reviewing office signups). For the pilot
// this is env-var driven — any officer whose email is in ADMIN_EMAILS counts.
export function requirePlatformAdmin() {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // Dev fallback: if nothing configured AND we're in debug mode, accept
  // the officer as admin so local testing works.
  return (req, res, next) => {
    if (!req.officer) return res.status(401).json({ error: 'not_signed_in' });
    const email = (req.officer.email || '').toLowerCase();
    const isAdmin = adminEmails.length
      ? adminEmails.includes(email)
      : process.env.DEBUG_MODE === 'true';
    if (!isAdmin) return res.status(403).json({ error: 'not_platform_admin' });
    next();
  };
}

// Small helper for tests / seed scripts
export async function _testIssueTokenFor(officer_id) {
  return signToken({ officer_id });
}

// ════════════════════════════════════════════════════════════
// CITIZEN AUTH — separate cookie + middleware
// ════════════════════════════════════════════════════════════
// Citizens get their own cookie (`sanad_citizen_sess`) so a phone holding
// both an office-officer login AND a personal citizen account doesn't conflict.
// The JWT payload is { citizen_id }. We re-hydrate from the DB on every
// request so a deletion / phone change takes effect immediately.

export function setCitizenSessionCookie(res, token) {
  const parts = [
    `${CITIZEN_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  // Append (don't overwrite) so an officer-cookie set in the same response
  // survives. Express will join multiple Set-Cookie headers correctly.
  const existing = res.getHeader('Set-Cookie');
  if (existing) {
    res.setHeader('Set-Cookie', [].concat(existing, parts.join('; ')));
  } else {
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

export function clearCitizenSessionCookie(res) {
  const expired = `${CITIZEN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) {
    res.setHeader('Set-Cookie', [].concat(existing, expired));
  } else {
    res.setHeader('Set-Cookie', expired);
  }
}

export function readCitizenToken(req) {
  const fromCookie = req.cookies?.[CITIZEN_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const h = req.header('x-citizen-authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Fetch a citizen by id with all auth-relevant columns. Returns null if
// missing.
export async function loadCitizen(citizen_id) {
  const { rows } = await db.execute({
    sql: `SELECT id, phone, email, google_sub, name, display_name, civil_id,
                 avatar_url, language_pref, signup_source,
                 phone_verified_at, email_verified_at, last_login_at, created_at
            FROM citizen
           WHERE id = ?`,
    args: [citizen_id]
  });
  return rows[0] || null;
}

// Attach `req.citizen` if a valid citizen-token is present. Coexists with
// `attachSession` (officer-side) — both can populate the request.
export async function attachCitizenSession(req, _res, next) {
  const token = readCitizenToken(req);
  if (!token) return next();
  const claims = verifyToken(token);
  if (!claims?.citizen_id) return next();
  const c = await loadCitizen(claims.citizen_id);
  if (!c) return next();
  req.citizen = c;
  next();
}

// Require a signed-in citizen. Use `requirePhone:true` for actions that need
// a verified phone (so a Sanad office can reach them).
export function requireCitizen(opts = {}) {
  const { requirePhone = false } = opts;
  return (req, res, next) => {
    if (!req.citizen) return res.status(401).json({ error: 'not_signed_in' });
    if (requirePhone) {
      if (!req.citizen.phone || !req.citizen.phone_verified_at) {
        return res.status(403).json({
          error: 'phone_required',
          reason: 'Sanad offices contact you via WhatsApp — please verify your number first.'
        });
      }
    }
    next();
  };
}

// Issue a citizen session token + set the cookie. Updates last_login_at.
export async function issueCitizenSession(res, citizen_id) {
  const token = signToken({ citizen_id });
  setCitizenSessionCookie(res, token);
  await db.execute({
    sql: `UPDATE citizen SET last_login_at = datetime('now') WHERE id = ?`,
    args: [citizen_id]
  });
  return token;
}
