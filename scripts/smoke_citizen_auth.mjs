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

  // 2) verify-otp with a definitely-wrong code (not the magic 000000, not the
  //    real debug_code). Bias to a code that cannot collide.
  const bogus = (debugCode === '999999') ? '888888' : '999999';
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: bogus })
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

  // 4b) Magic OTP — DEBUG_MODE bypass with 000000 + a fresh phone (no slot)
  const magicPhone = '+96890999777';
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: magicPhone, code: '000000' })
  });
  d = await r.json();
  ok('magic OTP 000000 works in DEBUG_MODE', r.status === 200 && d.ok, JSON.stringify(d));
  ok('magic OTP creates citizen + verifies phone', d.citizen?.phone === magicPhone && d.citizen?.phone_verified === true);

  // 4c) Auto-fill flow simulation — what the "🔑 Generate OTP & auto-fill"
  // button does when clicked: start-otp → read debug_code → verify-otp.
  // Validates that the round-trip works end-to-end with a fresh phone.
  const autofillPhone = '+96890999555';
  r = await fetch(`${base}/api/citizen-auth/start-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: autofillPhone })
  });
  d = await r.json();
  ok('auto-fill: start-otp returns debug_code', r.status === 200 && /^\d{6}$/.test(d.debug_code || ''), JSON.stringify(d));
  const fetchedCode = d.debug_code;
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: autofillPhone, code: fetchedCode })
  });
  d = await r.json();
  ok('auto-fill: verify-otp accepts the fetched debug_code', r.status === 200 && d.ok === true, JSON.stringify(d));

  // 4d) /api/health exposes the debug flag the client uses to gate the UI
  r = await fetch(`${base}/api/health`);
  d = await r.json();
  ok('/api/health exposes debug:true in DEBUG_MODE', d.debug === true, JSON.stringify(d));

  // 4e) Hardening — origin check is bypassed in DEBUG_MODE, but the source
  // wiring should still be present (smoke is a static assertion here).
  const fs = await import('node:fs');
  const serverSrc = fs.readFileSync('./server.js', 'utf8');
  ok('server.js wires originGuard on /api/auth', serverSrc.includes("originGuard, authRouter"));
  ok('server.js wires originGuard on /api/citizen-auth', serverSrc.includes("originGuard, citizenAuthRouter"));
  ok('server.js wires originGuard on /api/officer', serverSrc.includes("originGuard, officerRouter"));
  ok('server.js excludes whatsapp + payments/webhook from origin check',
     serverSrc.includes("'/api/whatsapp/'") && serverSrc.includes("'/api/payments/webhook'"));
  ok('server.js excludes /api/chat (no cookie + dev tester)', serverSrc.includes("'/api/chat/'"));

  // 4f) Rate-limit module is wired into the auth routes
  const authSrc = fs.readFileSync('./routes/auth.js', 'utf8');
  ok('routes/auth.js mounts loginLimiter on /login', /authRouter\.post\('\/login',\s*loginLimiter/.test(authSrc));
  ok('routes/auth.js mounts signupLimiter on /signup', /authRouter\.post\('\/signup',\s*signupLimiter/.test(authSrc));
  ok('routes/auth.js enforces password complexity (passwordIssues helper)',
     authSrc.includes('passwordIssues') && authSrc.includes('min_10_chars'));

  const citAuthSrc = fs.readFileSync('./routes/citizen_auth.js', 'utf8');
  ok('routes/citizen_auth.js mounts startLim on /start-otp',
     /\/start-otp',\s*startLim/.test(citAuthSrc));
  ok('routes/citizen_auth.js mounts verifyLim on /verify-otp',
     /\/verify-otp',\s*verifyLim/.test(citAuthSrc));
  ok('routes/citizen_auth.js mounts googleLim on /google',
     /\/google',\s*googleLim/.test(citAuthSrc));

  // 5) Static pages exist
  for (const p of ['/signup.html', '/login.html', '/account.html', '/request.html', '/auth-client.js', '/config.js', '/i18n.js']) {
    const sr = await fetch(`${base}${p}`);
    ok(`${p} serves 200`, sr.status === 200, `status=${sr.status}`);
  }

  // 5b) auth-client.js carries the debug shortcut wiring
  const ac = await fetch(`${base}/auth-client.js`).then(r => r.text());
  ok('auth-client.js gates debug UI on /api/health', ac.includes('/api/health') && ac.includes('debug'));
  ok('auth-client.js wires Generate-OTP button', ac.includes('dbgAutoFillBtn'));
  ok('auth-client.js wires Magic-000000 button', ac.includes('dbgMagicBtn'));

  // 6) Brand & landing structure
  const idx = await fetch(`${base}/`).then(r => r.text());
  ok('index.html does not advertise office signup in footer',
     !idx.includes('home.footer.office_register'));
  ok('index.html has the Sign-up CTA',
     idx.includes('navSignUp'));
  ok('index.html no longer says Sanad-AI in titles', !idx.includes('Sanad-AI</title>'));
  ok('index.html says Saned somewhere', idx.includes('Saned'));
  ok('index.html has live hybrid search UI', idx.includes('heroSearch') && idx.includes('/api/catalogue/hybrid'));
  ok('index.html has why-Saned section', idx.includes('home.why.h2'));
  ok('index.html has voices section', idx.includes('home.voices.h2'));

  // 7) Hybrid search
  r = await fetch(`${base}/api/catalogue/hybrid?q=passport&limit=5`);
  d = await r.json();
  ok('/hybrid returns 200', r.status === 200);
  ok('/hybrid returns matched_by tags', Array.isArray(d.results) && (d.results[0]?.matched_by !== undefined || d.results.length === 0));
  ok('/hybrid returns lane counts in search.lanes', d.search?.mode === 'hybrid' && !!d.search.lanes);

  // 7b) Hybrid arabic query also works
  r = await fetch(`${base}/api/catalogue/hybrid?q=${encodeURIComponent('جواز')}&limit=3`);
  d = await r.json();
  ok('/hybrid handles Arabic query', r.status === 200);

  // 7c) Browse mode (no q) — returns paginated results sorted by name
  r = await fetch(`${base}/api/catalogue/hybrid?limit=5&sort=name`);
  d = await r.json();
  ok('/hybrid browse mode returns 200', r.status === 200);
  ok('/hybrid browse mode = "browse"', d.search?.mode === 'browse', JSON.stringify(d.search));
  ok('/hybrid browse mode returns total count', typeof d.total === 'number' && d.total > 0);

  // 7d) Filter combos work
  r = await fetch(`${base}/api/catalogue/hybrid?fee_min=0&fee_max=0&limit=3`);
  d = await r.json();
  ok('/hybrid fee filter (free only) returns 200', r.status === 200);
  if (d.results?.length) {
    ok('all returned services have fee_omr=0 when filtered free', d.results.every(r => r.fee_omr === 0));
  } else {
    ok('free-fee filter empty result is OK', true);
  }

  r = await fetch(`${base}/api/catalogue/hybrid?has_docs=yes&limit=3`);
  d = await r.json();
  ok('/hybrid has_docs=yes returns 200', r.status === 200);

  // 7e) Faceting endpoints
  r = await fetch(`${base}/api/catalogue/beneficiaries`);
  d = await r.json();
  ok('/beneficiaries returns 200 + array', r.status === 200 && Array.isArray(d.beneficiaries));

  r = await fetch(`${base}/api/catalogue/fee-buckets`);
  d = await r.json();
  ok('/fee-buckets returns 200', r.status === 200);
  ok('fee-buckets has free_count + lt10 + m10_50 + gte50', d.buckets && 'free_count' in d.buckets && 'lt10' in d.buckets);

  // 7f) Catalogue page brand + RTL + hybrid wiring
  const catHtml = await fetch(`${base}/catalogue.html`).then(r => r.text());
  ok('catalogue.html is Arabic-first (lang="ar" dir="rtl")',
     catHtml.includes('lang="ar"') && catHtml.includes('dir="rtl"'));
  ok('catalogue.html uses /api/catalogue/hybrid (not legacy search)',
     catHtml.includes('/api/catalogue/hybrid') && !/\/api\/catalogue\/search\?/.test(catHtml));
  ok('catalogue.html has fee-bucket filter pills', catHtml.includes('data-fee="lt10"'));
  ok('catalogue.html has beneficiary filter rail', catHtml.includes('beneficiaries'));
  ok('catalogue.html has sort dropdown', catHtml.includes('sortSel'));
  // matched-fts/semantic/partial color classes live in /theme.css now;
  // pages render them via inline JS template `matched-${t}`.
  ok('catalogue.html renders match-chips (matched-chip + matched-${t} template)',
     catHtml.includes('matched-chip') && /matched-\$\{[^}]+\}/.test(catHtml));

  // 8) my-request/:id 404 for non-existent id
  r = await fetch(`${base}/api/chat/my-request/999999`, { headers: { cookie } });
  ok('/my-request/999999 returns 404', r.status === 404);

  // 8b) my-request without cookie → 401
  r = await fetch(`${base}/api/chat/my-request/1`);
  ok('/my-request without cookie is 401', r.status === 401);

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
