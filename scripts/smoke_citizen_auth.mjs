// Smoke test for the new citizen-auth flow.
//
// Boots the server in-process, exercises:
//   1) start-otp → debug code returned
//   2) verify-otp → cookie set, /me returns the citizen
//   3) my-requests → 200 with empty list
//   4) logout → cookie cleared, /me 401
//
// Runs in DEBUG_MODE so the debug_code field is populated and we don't need
// real WhatsApp creds. Exits 0 on success, 1 on any failure with details.

import 'dotenv/config';
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';

const { start } = await import('../server.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[smoke] server listening on ${port}`);

let cookie = '';
function setCookie(res) {
  const sc = res.headers.get('set-cookie');
  if (sc) {
    // Extract sanad_citizen_sess=… (parsing only the citizen cookie we care about)
    const m = sc.match(/sanad_citizen_sess=([^;]+)/);
    if (m) cookie = `sanad_citizen_sess=${m[1]}`;
  }
}

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

const phone = '+96890999001';
let debugCode = '';

try {
  // 1) start-otp
  let r = await fetch(`${base}/api/citizen-auth/start-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  let d = await r.json();
  ok('start-otp returns 200', r.status === 200, `status=${r.status} body=${JSON.stringify(d)}`);
  ok('start-otp returns debug_code in DEBUG_MODE', !!d.debug_code, JSON.stringify(d));
  ok('start-otp returns expires_in_min', typeof d.expires_in_min === 'number');
  debugCode = d.debug_code;

  // 1b) cooldown
  r = await fetch(`${base}/api/citizen-auth/start-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  d = await r.json();
  ok('rapid resend hits cooldown', r.status === 429 && d.error === 'cooldown', JSON.stringify(d));

  // 2) verify-otp with WRONG code first
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000' })
  });
  d = await r.json();
  ok('wrong code returns 401', r.status === 401 && d.error === 'wrong_code', JSON.stringify(d));

  // 2b) verify-otp with the right one
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: debugCode })
  });
  d = await r.json();
  ok('correct code returns 200', r.status === 200 && d.ok, JSON.stringify(d));
  ok('citizen.phone matches', d.citizen?.phone === phone);
  ok('citizen.phone_verified is true', d.citizen?.phone_verified === true);
  setCookie(r);
  ok('cookie was set', !!cookie, 'no sanad_citizen_sess in set-cookie');

  // 3) /me with cookie
  r = await fetch(`${base}/api/citizen-auth/me`, { headers: { cookie } });
  d = await r.json();
  ok('/me returns the signed-in citizen', r.status === 200 && d.citizen?.phone === phone, JSON.stringify(d));

  // 3b) /api/chat/my-requests
  r = await fetch(`${base}/api/chat/my-requests`, { headers: { cookie } });
  d = await r.json();
  ok('/my-requests returns 200', r.status === 200, `status=${r.status}`);
  ok('/my-requests has requests array', Array.isArray(d.requests));

  // 3c) /me without cookie → 401
  r = await fetch(`${base}/api/citizen-auth/me`);
  ok('/me without cookie is 401', r.status === 401);

  // 4) logout
  r = await fetch(`${base}/api/citizen-auth/logout`, { method: 'POST', headers: { cookie } });
  ok('logout returns 200', r.status === 200);

  // 5) Static pages exist
  for (const p of ['/signup.html', '/login.html', '/account.html', '/auth-client.js', '/config.js', '/i18n.js']) {
    const sr = await fetch(`${base}${p}`);
    ok(`${p} serves 200`, sr.status === 200, `status=${sr.status}`);
  }

  // 6) Index no longer carries the office partner block
  const idx = await fetch(`${base}/`).then(r => r.text());
  ok('index.html no longer mentions Register your office in footer',
     !idx.includes('home.footer.office_register'));
  ok('index.html still has the Sign-up CTA',
     idx.includes('navSignUp'));

  // 7) Schema spot-check: citizen has the new columns
  const { db } = await import('../lib/db.js');
  const { rows: cols } = await db.execute(`SELECT name FROM pragma_table_info('citizen')`);
  const cn = new Set(cols.map(c => c.name));
  ok('citizen.email column exists', cn.has('email'));
  ok('citizen.google_sub column exists', cn.has('google_sub'));
  ok('citizen.phone_verified_at column exists', cn.has('phone_verified_at'));
  ok('citizen.signup_source column exists', cn.has('signup_source'));

  const { rows: rcols } = await db.execute(`SELECT name FROM pragma_table_info('request')`);
  const rn = new Set(rcols.map(c => c.name));
  ok('request.payment_status column exists', rn.has('payment_status'));
  ok('request.paid_at column exists', rn.has('paid_at'));

  const { rows: ot } = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='citizen_otp'`);
  ok('citizen_otp table exists', ot.length === 1);

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
