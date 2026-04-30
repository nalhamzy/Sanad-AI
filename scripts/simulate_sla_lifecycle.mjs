// End-to-end SLA-window verification with short windows.
//
// Drives both timers in real time:
//   • REVIEW window  =  3 seconds (OFFICE_REVIEW_SLA_MINUTES = 0.05)
//   • WORK window    =  6 seconds (OFFICE_SLA_MINUTES = 0.1)
//
// Three flows are exercised end-to-end:
//
//   A. Pre-payment release path
//      Office A claims → no payment link → review window expires →
//      sweep flips back to status='ready' with a clean wipe of office_id +
//      payment fields → Office B can claim cleanly.
//
//   B. Post-payment transfer path
//      Office B claims → sends payment link → citizen pays (paid_at set) →
//      work window expires without completion → sweep flips status='ready',
//      clears office_id, but PRESERVES paid_at + payment_amount + payment_ref.
//      Office C claims → status goes directly to 'in_progress' (transfer
//      claim, no second payment from citizen) → audit shows
//      'request_claim_transfer' → citizen receives the transfer notification.
//
//   C. Awaiting-payment immunity
//      A request stuck at status='awaiting_payment' for longer than the work
//      window MUST NOT be released — the citizen is the bottleneck here.
//
// Implementation notes:
//   • Env knobs MUST be set before lib/sla.js is imported (the constants are
//     evaluated at module-load).
//   • We disable the auto watcher (SANAD_SKIP_SLA=true) and drive
//     sweepExpiredSLA() manually so timing is deterministic.

import 'dotenv/config';
import bcrypt from 'bcryptjs';

// Short SLA windows + skip the auto-watcher (we'll drive sweeps manually).
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';
process.env.SANAD_SKIP_SLA = 'true';
process.env.OFFICE_REVIEW_SLA_MINUTES = '0.05';   // 3 seconds
process.env.OFFICE_SLA_MINUTES        = '0.1';    // 6 seconds

const { start } = await import('../server.js');
const { db } = await import('../lib/db.js');
const { sweepExpiredSLA, REVIEW_SLA_MINUTES, SLA_MINUTES } = await import('../lib/sla.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[lifecycle] server on ${port}`);
console.log(`[lifecycle] REVIEW_SLA_MINUTES=${REVIEW_SLA_MINUTES} (${REVIEW_SLA_MINUTES * 60}s) · SLA_MINUTES=${SLA_MINUTES} (${SLA_MINUTES * 60}s)`);

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
}
function getCookie(res, exactName) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(new RegExp(`(${exactName}=[^;]+)`));
  return m ? m[1] : '';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  const tag = `lifecycle-${Date.now()}`;
  const pwHash = bcrypt.hashSync('demo123', 10);

  // ── 1) Seed 3 offices (A, B, C) with logins ─────────────
  const offices = [];
  const cookies = [];
  for (const letter of ['A','B','C']) {
    const r = await db.execute({
      sql: `INSERT INTO office(name_en, name_ar, governorate, wilayat, email, phone, cr_number,
              status, credits_remaining, subscription_status, subscription_since, rating, total_completed,
              default_office_fee_omr)
            VALUES (?,?,?,?,?,?,?, 'active', 999, 'active', datetime('now'), 4.5, 0, 5.0)`,
      args: [
        `Office ${tag}-${letter}`, `مكتب ${tag}-${letter}`, 'Muscat', 'Bawshar',
        `office-${tag}-${letter}@example.om`, `+9689000${letter.charCodeAt(0)}${String(Date.now()).slice(-4)}`, `CR-${tag}-${letter}`
      ]
    });
    const officeId = Number(r.lastInsertRowid);
    const email = `officer-${tag}-${letter}@example.om`;
    await db.execute({
      sql: `INSERT INTO officer(office_id, full_name, email, role, status, password_hash)
            VALUES (?,?,?,'owner','active',?)`,
      args: [officeId, `Officer ${letter}`, email, pwHash]
    });
    offices.push({ letter, officeId, email });
    const lr = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'demo123' })
    });
    if (lr.status !== 200) throw new Error(`login failed for ${email}: ${lr.status}`);
    cookies.push(getCookie(lr, 'sanad_sess'));
  }
  ok('seeded 3 offices A/B/C with cookies', offices.length === 3 && cookies.every(Boolean));

  // ── 2) Sign in citizen + seed a ready request with one doc ──
  const phone = `+9689${String(Date.now()).slice(-9)}`;
  const cr = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000' })
  });
  const cd = await cr.json();
  ok('citizen seeded', cr.status === 200 && cd.ok);
  const citizenId = cd.citizen.id;
  const citizenCookie = getCookie(cr, 'sanad_citizen_sess');

  const { rows: svc } = await db.execute({ sql: `SELECT id FROM service_catalog WHERE is_active=1 LIMIT 1` });
  const serviceId = svc[0]?.id || 1;

  async function seedReady(label = 'lifecycle') {
    const ins = await db.execute({
      sql: `INSERT INTO request(session_id, citizen_id, service_id, status, governorate, created_at, last_event_at)
            VALUES (?,?,?, 'ready', 'Muscat', datetime('now'), datetime('now'))`,
      args: [`${tag}-${label}-${Date.now()}`, citizenId, serviceId]
    });
    const id = Number(ins.lastInsertRowid);
    await db.execute({
      sql: `INSERT INTO request_document(request_id, doc_code, label, mime, size_bytes, status)
            VALUES (?, 'civil_id', 'Civil ID', 'image/jpeg', 100000, 'pending')`,
      args: [id]
    });
    return id;
  }

  // ──────────────────────────────────────────────────────────
  // FLOW A — Pre-payment release path
  // ──────────────────────────────────────────────────────────
  console.log('\n── FLOW A: pre-pay release ──');
  const reqA = await seedReady('A');

  // Office A claims it.
  const claimA = await fetch(`${base}/api/officer/request/${reqA}/claim`, {
    method: 'POST', headers: { cookie: cookies[0] }
  });
  ok('Office A claims reqA → 200', claimA.status === 200);

  let { rows: chk } = await db.execute({
    sql: `SELECT status, office_id, claim_review_started_at, payment_status FROM request WHERE id=?`,
    args: [reqA]
  });
  ok('reqA status=claimed + office_id=A', chk[0].status === 'claimed' && chk[0].office_id === offices[0].officeId);
  ok('reqA claim_review_started_at set', !!chk[0].claim_review_started_at);

  // Wait past the review window (3s), then sweep.
  console.log('   ... sleeping 4s (review window = 3s) ...');
  await sleep(4000);
  let sweepRes = await sweepExpiredSLA();
  ok('sweep released the unpaid claim (pre_released ≥ 1)', sweepRes.pre_released >= 1, JSON.stringify(sweepRes));

  ({ rows: chk } = await db.execute({
    sql: `SELECT status, office_id, payment_status, paid_at FROM request WHERE id=?`,
    args: [reqA]
  }));
  ok('reqA status=ready after sweep', chk[0].status === 'ready');
  ok('reqA office_id cleared', chk[0].office_id === null);
  ok('reqA payment_status reset to none', chk[0].payment_status === 'none');
  ok('reqA paid_at still null (never paid)', chk[0].paid_at === null);

  // Office B can claim cleanly now.
  const claimB = await fetch(`${base}/api/officer/request/${reqA}/claim`, {
    method: 'POST', headers: { cookie: cookies[1] }
  });
  ok('Office B claims reqA after release → 200', claimB.status === 200);
  ({ rows: chk } = await db.execute({
    sql: `SELECT status, office_id FROM request WHERE id=?`, args: [reqA]
  }));
  ok('reqA now held by office B', chk[0].office_id === offices[1].officeId);

  // Audit log entry for the pre-pay release.
  const { rows: auditA } = await db.execute({
    sql: `SELECT action FROM audit_log
           WHERE target_type='request' AND target_id=? AND action='sla_pre_pay_release'
           ORDER BY id DESC LIMIT 1`,
    args: [reqA]
  });
  ok('audit_log records sla_pre_pay_release for reqA', auditA.length === 1);

  // ──────────────────────────────────────────────────────────
  // FLOW B — Post-payment transfer path
  // ──────────────────────────────────────────────────────────
  console.log('\n── FLOW B: post-pay transfer ──');
  // Same reqA (now held by B). B sends payment link.
  const payStart = await fetch(`${base}/api/officer/request/${reqA}/payment/start`, {
    method: 'POST', headers: { cookie: cookies[1] }
  });
  const payBody = await payStart.json();
  ok('Office B sends payment link → 200', payStart.status === 200 && !!payBody.payment_link);
  const merchantRef = payBody.merchant_ref;

  ({ rows: chk } = await db.execute({
    sql: `SELECT status, payment_status, payment_link, payment_ref FROM request WHERE id=?`,
    args: [reqA]
  }));
  ok('reqA status=awaiting_payment + payment_link set',
     chk[0].status === 'awaiting_payment' && !!chk[0].payment_link);

  // Citizen pays via the dev stub link (same path the smoke takes — fires
  // markRequestPaid() server-side and flips status to in_progress).
  const stubPay = await fetch(`${base}/api/payments/_stub/request_pay?ref=${encodeURIComponent(merchantRef)}`, {
    redirect: 'manual', headers: { cookie: citizenCookie }
  });
  ok('stub_pay redirected (citizen paid)', stubPay.status >= 300 && stubPay.status < 400, `status=${stubPay.status}`);

  ({ rows: chk } = await db.execute({
    sql: `SELECT status, payment_status, paid_at, payment_amount_omr, payment_ref FROM request WHERE id=?`,
    args: [reqA]
  }));
  ok('reqA status=in_progress + paid_at set',
     chk[0].status === 'in_progress' && !!chk[0].paid_at);
  const paidAtBefore = chk[0].paid_at;
  const paymentAmountBefore = chk[0].payment_amount_omr;
  const paymentRefBefore = chk[0].payment_ref;

  // Wait past the work window (6s), then sweep.
  console.log('   ... sleeping 7s (work window = 6s) ...');
  await sleep(7000);
  sweepRes = await sweepExpiredSLA();
  ok('sweep transferred the paid claim (post_transferred ≥ 1)',
     sweepRes.post_transferred >= 1, JSON.stringify(sweepRes));

  ({ rows: chk } = await db.execute({
    sql: `SELECT status, office_id, paid_at, payment_amount_omr, payment_ref FROM request WHERE id=?`,
    args: [reqA]
  }));
  ok('reqA status back to ready', chk[0].status === 'ready');
  ok('reqA office_id cleared', chk[0].office_id === null);
  ok('reqA paid_at PRESERVED across transfer',
     chk[0].paid_at === paidAtBefore,
     `before=${paidAtBefore} after=${chk[0].paid_at}`);
  ok('reqA payment_amount_omr preserved', chk[0].payment_amount_omr === paymentAmountBefore);
  ok('reqA payment_ref preserved', chk[0].payment_ref === paymentRefBefore);

  // Office C claims → should land directly in 'in_progress' (transfer claim).
  const claimC = await fetch(`${base}/api/officer/request/${reqA}/claim`, {
    method: 'POST', headers: { cookie: cookies[2] }
  });
  const claimCBody = await claimC.json();
  ok('Office C transfer-claims reqA → 200', claimC.status === 200, JSON.stringify(claimCBody));
  ok('Office C claim flagged as transfer (transfer:true)',
     claimCBody.transfer === true, JSON.stringify(claimCBody));

  ({ rows: chk } = await db.execute({
    sql: `SELECT status, office_id, paid_at FROM request WHERE id=?`, args: [reqA]
  }));
  ok('reqA jumps to in_progress (skips claimed/awaiting_payment)',
     chk[0].status === 'in_progress' && chk[0].office_id === offices[2].officeId);
  ok('reqA paid_at still preserved post-transfer-claim',
     chk[0].paid_at === paidAtBefore);

  // Audit log entry for the transfer.
  const { rows: auditB } = await db.execute({
    sql: `SELECT action FROM audit_log
           WHERE target_type='request' AND target_id=?
             AND action IN ('sla_post_pay_transfer','request_claim_transfer')
           ORDER BY id DESC`,
    args: [reqA]
  });
  ok('audit_log records both sla_post_pay_transfer and request_claim_transfer',
     auditB.some(r => r.action === 'sla_post_pay_transfer') &&
     auditB.some(r => r.action === 'request_claim_transfer'),
     JSON.stringify(auditB));

  // Citizen received the transfer notification (the AR system message).
  const { rows: msgs } = await db.execute({
    sql: `SELECT body_text FROM message
           WHERE request_id=? AND actor_type='system'
           ORDER BY id DESC LIMIT 5`,
    args: [reqA]
  });
  const transferNote = msgs.find(m => /لن تدفع|لن تدفع مرّة|تحوَّل/.test(m.body_text || ''));
  ok('citizen received the transfer notification', !!transferNote,
     JSON.stringify(msgs.map(m => m.body_text?.slice(0, 60))));

  // Office C completes.
  const completeC = await fetch(`${base}/api/officer/request/${reqA}/complete`, {
    method: 'POST', headers: { cookie: cookies[2] }
  });
  ok('Office C completes reqA → 200', completeC.status === 200);
  ({ rows: chk } = await db.execute({
    sql: `SELECT status FROM request WHERE id=?`, args: [reqA]
  }));
  ok('reqA status=completed', chk[0].status === 'completed');

  // ──────────────────────────────────────────────────────────
  // FLOW C — Awaiting-payment immunity
  // ──────────────────────────────────────────────────────────
  console.log('\n── FLOW C: awaiting-payment immunity ──');
  const reqC = await seedReady('C');
  // Office A claims and sends payment link.
  await fetch(`${base}/api/officer/request/${reqC}/claim`, {
    method: 'POST', headers: { cookie: cookies[0] }
  });
  await fetch(`${base}/api/officer/request/${reqC}/payment/start`, {
    method: 'POST', headers: { cookie: cookies[0] }
  });
  ({ rows: chk } = await db.execute({
    sql: `SELECT status, payment_status FROM request WHERE id=?`, args: [reqC]
  }));
  ok('reqC at awaiting_payment', chk[0].status === 'awaiting_payment' && chk[0].payment_status === 'awaiting');

  // Wait LONGER than work-window. Should NOT be released.
  console.log('   ... sleeping 7s (longer than work window) ...');
  await sleep(7000);
  const sweepResC = await sweepExpiredSLA();
  // The sweep may release OTHER stale claims, but reqC must NOT be in either bucket.
  ({ rows: chk } = await db.execute({
    sql: `SELECT status, office_id FROM request WHERE id=?`, args: [reqC]
  }));
  ok('reqC stays at awaiting_payment (citizen bottleneck — never auto-released)',
     chk[0].status === 'awaiting_payment' && chk[0].office_id === offices[0].officeId,
     `status=${chk[0].status} office_id=${chk[0].office_id}`);
  console.log(`   (sweep returned pre_released=${sweepResC.pre_released} post_transferred=${sweepResC.post_transferred})`);

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n────────── SLA LIFECYCLE SIM ──────────`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
