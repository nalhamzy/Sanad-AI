// Hardening smoke — runs the server with DEBUG_MODE='' so the rate-limiter
// and origin/CSRF guards actually fire. Verifies:
//   • /api/auth/login burst → 429 after the configured threshold
//   • /api/auth/login without Origin/Referer → 403 origin_missing
//   • /api/auth/login with foreign Origin → 403 origin_mismatch
//   • /api/auth/login with same-origin Referer → passes guard, returns
//     401 invalid_credentials (so we know the rest of the route still runs)
//   • /api/auth/signup with weak password → 400 password:* missing field
//
// We pass NODE_ENV=test (not 'production') so cookies don't get Secure
// (otherwise the citizen-cookie path can't set without TLS in dev).

import 'dotenv/config';
process.env.DEBUG_MODE = 'false';
process.env.NODE_ENV = 'test';
process.env.SANAD_NO_AUTOSTART = 'true';

const { start } = await import('../server.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
const ownHost = `localhost:${port}`;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

try {
  // ── A) Origin guard ────────────────────────────────────
  // No Origin or Referer at all
  let r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z', password: 'whatever' })
  });
  let d = await r.json();
  ok('login without Origin/Referer is blocked', r.status === 403 && d.error === 'origin_missing', JSON.stringify(d));

  // Cross-origin Referer
  r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'https://attacker.example'
    },
    body: JSON.stringify({ email: 'x@y.z', password: 'whatever' })
  });
  d = await r.json();
  ok('login with foreign Origin is blocked', r.status === 403 && d.error === 'origin_mismatch', JSON.stringify(d));

  // Same-origin Referer → passes the guard, hits the auth check
  r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': `http://${ownHost}`,
      'referer': `http://${ownHost}/office-login.html`
    },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever1' })
  });
  d = await r.json();
  ok('same-origin login passes guard, returns 401', r.status === 401 && d.error === 'invalid_credentials', `${r.status} ${JSON.stringify(d)}`);

  // ── B) Password complexity at signup ────────────────────
  const baseSignupBody = {
    office_name_en: 'Test Office', governorate: 'Muscat', cr_number: 'CR-test-1',
    full_name: 'Test Owner', email: `audit-${Date.now()}@example.com`
  };
  const headers = {
    'content-type': 'application/json',
    'origin': `http://${ownHost}`,
    'referer': `http://${ownHost}/office-signup.html`
  };

  // Too short
  r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...baseSignupBody, password: 'short' })
  });
  d = await r.json();
  ok('signup rejects <10 chars', r.status === 400 && (d.missing||[]).includes('password:min_10_chars'), JSON.stringify(d));

  // Letters only, no digit
  r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...baseSignupBody, password: 'onlyletters' })
  });
  d = await r.json();
  ok('signup rejects no-digit', r.status === 400 && (d.missing||[]).includes('password:needs_digit'), JSON.stringify(d));

  // Common password
  r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...baseSignupBody, password: 'password123' })
  });
  d = await r.json();
  ok('signup rejects common password', r.status === 400 && (d.missing||[]).includes('password:too_common'), JSON.stringify(d));

  // Strong password — should pass complexity, fail later if email taken etc.
  r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...baseSignupBody, password: 'Saned-Strong-9' })
  });
  ok('signup accepts strong password (status not 400)', r.status !== 400, `status=${r.status}`);

  // ── C) Rate limiter ─────────────────────────────────────
  // 8 / minute on /api/auth/login → 9th in burst should return 429.
  let lastStatus = null;
  for (let i = 0; i < 9; i++) {
    const rr = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'origin': `http://${ownHost}`
      },
      body: JSON.stringify({ email: `attacker-${i}@example.com`, password: 'irrelevant' })
    });
    lastStatus = rr.status;
  }
  ok('9th rapid /login from same IP returns 429',
     lastStatus === 429, `last=${lastStatus}`);

  // Citizen start-otp limit is 12; burst 13.
  let lastOtp = null;
  for (let i = 0; i < 13; i++) {
    const rr = await fetch(`${base}/api/citizen-auth/start-otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'origin': `http://${ownHost}`
      },
      body: JSON.stringify({ phone: `+9689050000${(i % 10)}${i % 10}` })
    });
    lastOtp = rr.status;
  }
  ok('13th rapid /start-otp from same IP returns 429',
     lastOtp === 429, `last=${lastOtp}`);

  // ── D) Webhook bypass — /api/payments/webhook + /api/whatsapp/webhook
  //     should NOT be rejected by THE ORIGIN GUARD (those are
  //     server-to-server, signed by Meta/Amwal). They may still reject for
  //     OTHER reasons (e.g. missing HMAC signature) — we just need to
  //     verify the rejection isn't origin_missing.
  r = await fetch(`${base}/api/payments/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  // Read body — if it has {error:"origin_missing"} the guard fired (bug).
  const payBody = await r.text();
  ok('payments webhook bypasses ORIGIN guard (no origin_missing)',
     !payBody.includes('origin_missing'),
     `status=${r.status} body=${payBody.slice(0, 80)}`);

  r = await fetch(`${base}/api/whatsapp/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const waBody = await r.text();
  ok('whatsapp webhook bypasses ORIGIN guard (no origin_missing)',
     !waBody.includes('origin_missing'),
     `status=${r.status} body=${waBody.slice(0, 80)}`);

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
