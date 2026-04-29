// Citizen registration + sign-in.
//
// Two entry paths to a verified citizen account:
//
//   1) WhatsApp-first (the historical default)
//      The citizen messages our bot. routes/whatsapp.js opens a `wa:<phone>`
//      session and the agent serves them anonymously. We auto-promote them
//      to a citizen row on first contact (handled in lib/agent.js's
//      ensureCitizen flow). Phone is implicitly verified by Meta.
//
//   2) Web-first (this file)
//      Endpoints used by /signup.html, /login.html, /account.html:
//        POST /api/citizen-auth/start-otp   { phone }              → bot WhatsApps a 6-digit code
//        POST /api/citizen-auth/verify-otp  { phone, code }        → sets citizen-cookie
//        POST /api/citizen-auth/google      { id_token }           → Google sign-in (NO phone yet)
//        POST /api/citizen-auth/attach-phone{ phone }              → start OTP for an authed Google user
//        POST /api/citizen-auth/verify-phone{ phone, code }        → finishes phone-attach
//        GET  /api/citizen-auth/me                                  → returns the signed-in citizen
//        POST /api/citizen-auth/logout                              → clears cookie
//
// Why phone is mandatory:
//   Sanad offices reach citizens via WhatsApp. A citizen without a verified
//   phone cannot submit a request — `requireCitizen({ requirePhone:true })`
//   gates anything that needs office contact.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import {
  issueCitizenSession,
  clearCitizenSessionCookie,
  requireCitizen,
  loadCitizen
} from '../lib/auth.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../lib/whatsapp_send.js';

export const citizenAuthRouter = Router();

// ─── Config ────────────────────────────────────────────────
const OTP_TTL_MIN = Number(process.env.CITIZEN_OTP_TTL_MIN || 5);
const OTP_RESEND_COOLDOWN_S = Number(process.env.CITIZEN_OTP_COOLDOWN_S || 30);
const OTP_MAX_ATTEMPTS = Number(process.env.CITIZEN_OTP_MAX_ATTEMPTS || 5);
const OTP_TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE || 'sanad_otp';
const OTP_TEMPLATE_LANG = process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEBUG = process.env.DEBUG_MODE === 'true';

// ─── Helpers ──────────────────────────────────────────────
// Strict E.164: optional '+', 8–15 digits. Strips spaces / hyphens.
function normPhone(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[\s\-()]/g, '');
  if (!/^\+?\d{8,15}$/.test(s)) return null;
  return s.startsWith('+') ? s : `+${s}`;
}

// Sanad's primary market is Oman (+968) — accept Oman numbers without country
// code by prepending it. Anything else must be supplied as full E.164.
function omanise(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (/^\d{8}$/.test(s)) s = `+968${s}`;       // local 8-digit
  if (/^968\d{8}$/.test(s)) s = `+${s}`;       // missing '+'
  return normPhone(s);
}

function genOtp() {
  // 6-digit numeric, leading-zero safe.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

async function hashOtp(code) {
  return bcrypt.hash(code, 8); // 8 rounds is plenty — codes are short-lived
}

async function verifyOtpHash(code, hash) {
  try { return await bcrypt.compare(code, hash); } catch { return false; }
}

function publicCitizen(c) {
  if (!c) return null;
  return {
    id: c.id,
    phone: c.phone,
    email: c.email,
    name: c.display_name || c.name,
    avatar_url: c.avatar_url,
    language_pref: c.language_pref,
    phone_verified: !!c.phone_verified_at,
    email_verified: !!c.email_verified_at,
    signup_source: c.signup_source
  };
}

// Verify a Google ID token via the public tokeninfo endpoint. Avoids a new
// dep. Returns the validated claims or null.
async function verifyGoogleIdToken(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) return null;
    const claims = await r.json();
    // Audience check (skipped if no client id configured — dev mode only)
    if (GOOGLE_CLIENT_ID && claims.aud !== GOOGLE_CLIENT_ID) {
      console.warn('[google] aud mismatch:', claims.aud);
      return null;
    }
    if (!claims.sub || !claims.email) return null;
    if (claims.email_verified !== 'true' && claims.email_verified !== true) {
      // Accept anyway in dev; require verified in prod.
      if (process.env.NODE_ENV === 'production') return null;
    }
    return claims;
  } catch (e) {
    console.warn('[google] tokeninfo fetch failed:', e.message);
    return null;
  }
}

// ─── POST /start-otp ───────────────────────────────────────
// Used by:
//   • /signup.html — first-time citizen entering their phone
//   • /login.html — returning citizen
// Idempotent on repeated calls inside the cooldown window.
citizenAuthRouter.post('/start-otp', async (req, res) => {
  const phone = omanise(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });

  // Cooldown — reject rapid-fire resends.
  const { rows: recent } = await db.execute({
    sql: `SELECT last_sent_at FROM citizen_otp
            WHERE phone = ? AND purpose = 'signup' AND consumed_at IS NULL
            ORDER BY id DESC LIMIT 1`,
    args: [phone]
  });
  if (recent[0]) {
    const last = new Date(recent[0].last_sent_at + 'Z').getTime();
    const elapsed = (Date.now() - last) / 1000;
    if (elapsed < OTP_RESEND_COOLDOWN_S) {
      return res.status(429).json({
        error: 'cooldown',
        retry_in_s: Math.ceil(OTP_RESEND_COOLDOWN_S - elapsed)
      });
    }
  }

  const code = genOtp();
  const code_hash = await hashOtp(code);
  const expires_at = new Date(Date.now() + OTP_TTL_MIN * 60_000)
                       .toISOString().replace('T', ' ').replace(/\..+$/, '');

  await db.execute({
    sql: `INSERT INTO citizen_otp (phone, code_hash, expires_at, purpose, last_sent_at)
          VALUES (?,?,?, 'signup', datetime('now'))`,
    args: [phone, code_hash, expires_at]
  });

  // Send via WhatsApp template. Stub-mode (no creds) returns success and
  // logs the code so dev can see it.
  const tplResult = await sendWhatsAppTemplate(
    phone, OTP_TEMPLATE_NAME, OTP_TEMPLATE_LANG,
    [code, String(OTP_TTL_MIN)]
  );

  // Templates may not be approved yet on a fresh Meta account. As a fallback
  // (and in stub mode) we ALSO drop a freeform text — this works ONLY if the
  // citizen has previously messaged the bot in the last 24 h, otherwise it
  // silently fails. Best-effort: don't block the response.
  if (!tplResult.ok || tplResult.stub) {
    sendWhatsAppText(phone, `سند: رمز التحقق ${code}\nSanad: your code is ${code} (valid ${OTP_TTL_MIN} min).`)
      .catch(() => {});
  }

  res.json({
    ok: true,
    channel: tplResult.channel,
    cooldown_s: OTP_RESEND_COOLDOWN_S,
    expires_in_min: OTP_TTL_MIN,
    // In debug-mode we expose the code so local web testing doesn't depend on
    // a real WhatsApp delivery. Production: never expose.
    debug_code: DEBUG ? code : undefined
  });
});

// ─── POST /verify-otp ──────────────────────────────────────
// On success: creates the citizen row if missing, sets the citizen cookie,
// returns the public citizen view. The user is now signed in.
citizenAuthRouter.post('/verify-otp', async (req, res) => {
  const phone = omanise(req.body?.phone);
  const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);
  if (!phone || code.length !== 6) return res.status(400).json({ error: 'invalid_input' });

  // Pull the latest unconsumed slot for this phone.
  const { rows } = await db.execute({
    sql: `SELECT id, code_hash, expires_at, attempts, citizen_id, purpose
            FROM citizen_otp
           WHERE phone = ? AND purpose IN ('signup','attach_phone') AND consumed_at IS NULL
           ORDER BY id DESC LIMIT 1`,
    args: [phone]
  });
  const slot = rows[0];
  if (!slot) return res.status(400).json({ error: 'no_active_otp' });

  // Expiry check
  const expired = new Date(slot.expires_at + 'Z').getTime() < Date.now();
  if (expired) {
    await db.execute({ sql: `UPDATE citizen_otp SET consumed_at = datetime('now') WHERE id = ?`, args: [slot.id] });
    return res.status(400).json({ error: 'expired' });
  }
  if (slot.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const ok = await verifyOtpHash(code, slot.code_hash);
  if (!ok) {
    await db.execute({
      sql: `UPDATE citizen_otp SET attempts = attempts + 1 WHERE id = ?`,
      args: [slot.id]
    });
    return res.status(401).json({ error: 'wrong_code', attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - slot.attempts - 1) });
  }

  // Mark slot consumed (atomic with cookie issuance below).
  await db.execute({ sql: `UPDATE citizen_otp SET consumed_at = datetime('now') WHERE id = ?`, args: [slot.id] });

  // Resolve / create the citizen.
  let citizenId;
  if (slot.citizen_id) {
    // attach-phone path — the slot is bound to an existing (Google-only) citizen.
    citizenId = slot.citizen_id;
    await db.execute({
      sql: `UPDATE citizen SET phone = ?, phone_verified_at = datetime('now') WHERE id = ?`,
      args: [phone, citizenId]
    });
  } else {
    const { rows: existing } = await db.execute({
      sql: `SELECT id FROM citizen WHERE phone = ? LIMIT 1`,
      args: [phone]
    });
    if (existing[0]) {
      citizenId = existing[0].id;
      await db.execute({
        sql: `UPDATE citizen SET phone_verified_at = datetime('now') WHERE id = ?`,
        args: [citizenId]
      });
    } else {
      const ins = await db.execute({
        sql: `INSERT INTO citizen (phone, phone_verified_at, signup_source)
              VALUES (?, datetime('now'), 'web_otp')`,
        args: [phone]
      });
      citizenId = Number(ins.lastInsertRowid);
    }
  }

  await issueCitizenSession(res, citizenId);
  const fresh = await loadCitizen(citizenId);
  res.json({ ok: true, citizen: publicCitizen(fresh) });
});

// ─── POST /google ──────────────────────────────────────────
// Google sign-in. Body: { id_token } from Google Identity Services.
// Creates / merges by google_sub (preferred) or email. Phone is NOT set yet —
// the client should redirect to /account.html which renders an "add phone"
// banner that calls /attach-phone.
citizenAuthRouter.post('/google', async (req, res) => {
  const idToken = String(req.body?.id_token || '').trim();
  if (!idToken) return res.status(400).json({ error: 'no_token' });

  const claims = await verifyGoogleIdToken(idToken);
  if (!claims) return res.status(401).json({ error: 'bad_token' });

  const { sub, email, name, picture, locale } = claims;

  // Match-or-create. Prefer google_sub (stable Google id), fall back to email.
  let citizen;
  const { rows: bySub } = await db.execute({
    sql: `SELECT * FROM citizen WHERE google_sub = ? LIMIT 1`, args: [sub]
  });
  if (bySub[0]) {
    citizen = bySub[0];
  } else {
    const { rows: byEmail } = await db.execute({
      sql: `SELECT * FROM citizen WHERE lower(email) = lower(?) LIMIT 1`, args: [email]
    });
    if (byEmail[0]) {
      citizen = byEmail[0];
      // Bind google_sub to this row so future logins go straight to bySub.
      await db.execute({
        sql: `UPDATE citizen SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?),
                                 display_name = COALESCE(display_name, ?),
                                 email_verified_at = COALESCE(email_verified_at, datetime('now'))
               WHERE id = ?`,
        args: [sub, picture || null, name || null, citizen.id]
      });
    } else {
      const ins = await db.execute({
        sql: `INSERT INTO citizen (email, google_sub, display_name, avatar_url,
                                    email_verified_at, language_pref, signup_source)
              VALUES (?,?,?,?, datetime('now'), ?, 'web_google')`,
        args: [email, sub, name || null, picture || null,
               (locale || '').startsWith('ar') ? 'ar' : 'en']
      });
      const { rows } = await db.execute({
        sql: `SELECT * FROM citizen WHERE id = ?`, args: [Number(ins.lastInsertRowid)]
      });
      citizen = rows[0];
    }
  }

  await issueCitizenSession(res, citizen.id);
  res.json({
    ok: true,
    citizen: publicCitizen(citizen),
    needs_phone: !citizen.phone || !citizen.phone_verified_at
  });
});

// ─── POST /attach-phone ────────────────────────────────────
// Authenticated. Starts an OTP for an existing citizen who needs to add a
// phone (typical: signed in with Google but doesn't have a verified phone).
citizenAuthRouter.post('/attach-phone', requireCitizen(), async (req, res) => {
  const phone = omanise(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });

  // If another citizen already owns this phone we'd merge accounts — for now
  // we reject the conflict explicitly so the user can recover via OTP login.
  const { rows: clash } = await db.execute({
    sql: `SELECT id FROM citizen WHERE phone = ? AND id != ? LIMIT 1`,
    args: [phone, req.citizen.id]
  });
  if (clash[0]) {
    return res.status(409).json({ error: 'phone_taken', hint: 'Sign in with phone OTP and merge later.' });
  }

  const code = genOtp();
  const code_hash = await hashOtp(code);
  const expires_at = new Date(Date.now() + OTP_TTL_MIN * 60_000)
                       .toISOString().replace('T', ' ').replace(/\..+$/, '');

  await db.execute({
    sql: `INSERT INTO citizen_otp (phone, code_hash, expires_at, purpose, citizen_id, last_sent_at)
          VALUES (?,?,?, 'attach_phone', ?, datetime('now'))`,
    args: [phone, code_hash, expires_at, req.citizen.id]
  });

  const tpl = await sendWhatsAppTemplate(
    phone, OTP_TEMPLATE_NAME, OTP_TEMPLATE_LANG,
    [code, String(OTP_TTL_MIN)]
  );
  if (!tpl.ok || tpl.stub) {
    sendWhatsAppText(phone, `سند: رمز ربط الرقم ${code}\nSanad attach-phone code: ${code}`).catch(() => {});
  }

  res.json({
    ok: true,
    expires_in_min: OTP_TTL_MIN,
    debug_code: DEBUG ? code : undefined
  });
});

// /verify-phone is just /verify-otp (the slot's purpose='attach_phone' is
// already filtered there). Alias for clarity from the client side.
citizenAuthRouter.post('/verify-phone', async (req, res, next) => {
  // Forward to /verify-otp logic by calling the same handler stack.
  // (Express 4 doesn't have a clean way to dispatch internally without a
  // refactor — easiest is to reuse the body and reroute via the router.)
  req.url = '/verify-otp';
  return citizenAuthRouter.handle(req, res, next);
});

// ─── GET /me ───────────────────────────────────────────────
citizenAuthRouter.get('/me', requireCitizen(), (req, res) => {
  res.json({
    citizen: publicCitizen(req.citizen),
    needs_phone: !req.citizen.phone || !req.citizen.phone_verified_at
  });
});

// ─── POST /logout ──────────────────────────────────────────
citizenAuthRouter.post('/logout', (_req, res) => {
  clearCitizenSessionCookie(res);
  res.json({ ok: true });
});
