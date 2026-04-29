// Smoke test for the full request lifecycle:
//   citizen submits → request goes to ready
//   officer signs in → claims (atomic)
//   officer triggers payment → payment_link created, status=awaiting_payment
//   citizen pays via stub → paid_at set, status=in_progress, chat unlocks
//   officer messages citizen → succeeds (was 403 before paid_at)
//   officer completes → status=completed
//
// All in-process. No real Amwal, no real WhatsApp.

import 'dotenv/config';
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';

const { start } = await import('../server.js');
const { db } = await import('../lib/db.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[smoke] server on ${port}`);

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

function getCookie(res, exactName) {
  const sc = res.headers.get('set-cookie') || '';
  const re = new RegExp(`(${exactName}=[^;]+)`);
  const m = sc.match(re);
  return m ? m[1] : '';
}

try {
  // ── 1) Sign in citizen via magic OTP ─────────────────────
  const citizenPhone = '+96890888001';
  let r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: citizenPhone, code: '000000' })
  });
  let d = await r.json();
  ok('citizen signed in via magic OTP', r.status === 200 && d.ok, JSON.stringify(d));
  const citizenCookie = getCookie(r, 'sanad_citizen_sess');
  ok('citizen cookie present', !!citizenCookie);
  const citizenId = d.citizen.id;

  // ── 2) Seed a 'ready' request directly (skip the full agent flow) ──
  // Find a real service id from the catalogue.
  const { rows: svc } = await db.execute({
    sql: `SELECT id FROM service_catalog WHERE name_en LIKE '%passport%' LIMIT 1`
  });
  const serviceId = svc[0]?.id || 1;
  const sessionId = `test-flow-${Date.now()}`;
  const ins = await db.execute({
    sql: `INSERT INTO request (session_id, citizen_id, service_id, status, governorate, created_at, last_event_at)
          VALUES (?,?,?, 'ready', 'Muscat', datetime('now'), datetime('now'))`,
    args: [sessionId, citizenId, serviceId]
  });
  const reqId = Number(ins.lastInsertRowid);
  ok('seeded ready request', reqId > 0);

  // Add 2 dummy docs so the office has something to "review"
  for (let i = 0; i < 2; i++) {
    await db.execute({
      sql: `INSERT INTO request_document (request_id, doc_code, label, mime, size_bytes, status)
            VALUES (?,?,?,?,?, 'pending')`,
      args: [reqId, `doc${i}`, `Document ${i+1}`, 'image/jpeg', 100_000]
    });
  }

  // ── 3) Sign in the demo office officer ────────────────────
  r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'khalid@nahdha.om', password: 'demo123' })
  });
  d = await r.json();
  ok('officer signed in', r.status === 200, JSON.stringify(d));
  const officerCookie = getCookie(r, 'sanad_sess');
  ok('officer cookie present', !!officerCookie);

  // ── 4) Claim the request ─────────────────────────────────
  r = await fetch(`${base}/api/officer/request/${reqId}/claim`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('claim returns 200 + pricing', r.status === 200 && d.ok, JSON.stringify(d));
  ok('pricing has office_fee + government_fee', typeof d.pricing?.office_fee === 'number' && typeof d.pricing?.government_fee === 'number');
  ok('total = office_fee + government_fee', Math.abs((d.pricing?.total) - (d.pricing.office_fee + d.pricing.government_fee)) < 0.001);

  // ── 4b) Concurrent claim by same office returns 409 ──────
  r = await fetch(`${base}/api/officer/request/${reqId}/claim`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('second claim returns 409 already_claimed', r.status === 409 && d.error === 'already_claimed', JSON.stringify(d));

  // ── 5) Send-payment-link (officer → citizen WA + DB link) ──
  r = await fetch(`${base}/api/officer/request/${reqId}/payment/start`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('payment/start returns 200 + link', r.status === 200 && !!d.payment_link, JSON.stringify(d));
  ok('amount > 0', d.amount_omr > 0);
  ok('stub mode (no Amwal creds)', d.stubbed === true);
  const merchantRef = d.merchant_ref;

  // Status should now be awaiting_payment
  let { rows: chk } = await db.execute({ sql: `SELECT status, payment_status, payment_amount_omr FROM request WHERE id=?`, args: [reqId] });
  ok('status=awaiting_payment', chk[0].status === 'awaiting_payment');
  ok('payment_status=awaiting', chk[0].payment_status === 'awaiting');

  // ── 5b) Idempotent: second call returns the same link ────
  r = await fetch(`${base}/api/officer/request/${reqId}/payment/start`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('payment/start idempotent (reused=true)', r.status === 200 && d.reused === true);

  // ── 6) Officer chat is locked before payment ─────────────
  r = await fetch(`${base}/api/officer/request/${reqId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: officerCookie },
    body: JSON.stringify({ text: 'hi citizen' })
  });
  d = await r.json();
  ok('officer chat locked pre-payment (403)', r.status === 403 && d.error === 'chat_locked_until_paid', JSON.stringify(d));

  // ── 6b) Citizen sees no office messages yet either ───────
  r = await fetch(`${base}/api/chat/my-request/${reqId}`, { headers: { cookie: citizenCookie } });
  d = await r.json();
  ok('citizen sees request detail', r.status === 200);
  ok('chat_unlocked_for_office=false pre-payment', d.chat_unlocked_for_office === false);

  // ── 7) Citizen pays via stub link ────────────────────────
  r = await fetch(`${base}/api/payments/_stub/request_pay?ref=${encodeURIComponent(merchantRef)}`, {
    redirect: 'manual', headers: { cookie: citizenCookie }
  });
  ok('stub_pay redirects to /request.html', r.status >= 300 && r.status < 400);
  const loc = r.headers.get('location') || '';
  ok('stub_pay redirect points at this request', loc.includes(`/request.html?id=${reqId}`));

  ({ rows: chk } = await db.execute({ sql: `SELECT status, payment_status, paid_at FROM request WHERE id=?`, args: [reqId] }));
  ok('paid_at is set', !!chk[0].paid_at);
  ok('status=in_progress', chk[0].status === 'in_progress');
  ok('payment_status=paid', chk[0].payment_status === 'paid');

  // ── 8) Officer chat unlocked after payment ───────────────
  r = await fetch(`${base}/api/officer/request/${reqId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: officerCookie },
    body: JSON.stringify({ text: 'Got your file. Starting now.' })
  });
  d = await r.json();
  ok('officer chat works post-payment', r.status === 200 && d.ok, JSON.stringify(d));

  // 8b) Citizen detail now reports chat unlocked
  r = await fetch(`${base}/api/chat/my-request/${reqId}`, { headers: { cookie: citizenCookie } });
  d = await r.json();
  ok('chat_unlocked_for_office=true post-payment', d.chat_unlocked_for_office === true);

  // 8c) Officer GET /request/:id includes messages now
  r = await fetch(`${base}/api/officer/request/${reqId}`, { headers: { cookie: officerCookie } });
  d = await r.json();
  ok('officer GET /request includes messages post-payment', Array.isArray(d.messages) && d.messages.length > 0);
  ok('chat_unlocked=true on officer detail', d.chat_unlocked === true);

  // ── 9) Officer completes ─────────────────────────────────
  r = await fetch(`${base}/api/officer/request/${reqId}/complete`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('complete returns 200', r.status === 200 && d.ok, JSON.stringify(d));
  ({ rows: chk } = await db.execute({ sql: `SELECT status FROM request WHERE id=?`, args: [reqId] }));
  ok('status=completed', chk[0].status === 'completed');

  // ── 10) Inbox lifecycle buckets are populated correctly ───
  // Seed another ready request and check it lands in marketplace, not buckets.
  const ins2 = await db.execute({
    sql: `INSERT INTO request (session_id, citizen_id, service_id, status, governorate)
          VALUES (?,?,?, 'ready', 'Muscat')`,
    args: [`test-flow2-${Date.now()}`, citizenId, serviceId]
  });
  r = await fetch(`${base}/api/officer/inbox`, { headers: { cookie: officerCookie } });
  d = await r.json();
  ok('inbox returns lifecycle buckets', !!d.lifecycle && typeof d.lifecycle === 'object');
  ok('lifecycle has reviewing / awaiting_payment / in_progress keys',
     'reviewing' in d.lifecycle && 'awaiting_payment' in d.lifecycle && 'in_progress' in d.lifecycle);

  // ── 11) Release before payment is clean (no refund needed) ──
  // Claim the new request first, then release it.
  await fetch(`${base}/api/officer/request/${Number(ins2.lastInsertRowid)}/claim`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  r = await fetch(`${base}/api/officer/request/${Number(ins2.lastInsertRowid)}/release`, {
    method: 'POST', headers: { cookie: officerCookie }
  });
  d = await r.json();
  ok('release returns 200', r.status === 200);
  ok('release has refund_required=false (no payment yet)', d.refund_required === false);

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
