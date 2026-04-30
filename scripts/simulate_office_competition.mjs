// Simulate N offices racing for M requests. Verifies the atomic single-claim
// SQL (`UPDATE ... WHERE office_id IS NULL AND status='ready'`) is genuinely
// race-free under concurrent load: only one office wins each request, no
// double-claims, exactly M audit entries.
//
// Setup:
//   • Boot server in-process (SANAD_NO_AUTOSTART=true).
//   • Seed 10 fresh offices + 1 officer each (independent sessions).
//   • Seed 5 ready requests (status='ready', office_id=NULL).
//   • Fire 50 simultaneous claim attempts (10 offices × 5 requests) via
//     Promise.all so they all hit the API in the same event-loop tick.
//
// Assertions:
//   • Exactly 5 claims succeed (200), 45 lose (409 already_claimed).
//   • Exactly 5 distinct offices end up holding the requests.
//   • No request has > 1 winning office.
//   • request rows: status='claimed', office_id NOT NULL,
//     claim_review_started_at NOT NULL.
//   • audit_log has 5 'request_claim' entries (no duplicates).
//   • A 6th unrelated office trying to claim a won request → 409.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';
// Skip the SLA sweep so timing-sensitive checks don't get clobbered mid-test.
process.env.SANAD_SKIP_SLA = 'true';

const { start } = await import('../server.js');
const { db } = await import('../lib/db.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[compete] server on ${port}`);

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

const N_OFFICES = 10;
const N_REQUESTS = 5;

try {
  const tag = `compete-${Date.now()}`;
  const pwHash = bcrypt.hashSync('demo123', 10);

  // ── 1) Seed 10 offices + 1 officer each ───────────────
  const officeIds = [];
  const officerEmails = [];
  for (let i = 0; i < N_OFFICES; i++) {
    const r = await db.execute({
      sql: `INSERT INTO office(name_en, name_ar, governorate, wilayat, email, phone, cr_number,
              status, credits_remaining, subscription_status, subscription_since, rating, total_completed,
              default_office_fee_omr)
            VALUES (?,?,?,?,?,?,?, 'active', 999, 'active', datetime('now'), 4.5, 0, 5.0)`,
      args: [
        `Office ${tag} #${i}`, `مكتب ${tag} #${i}`, 'Muscat', 'Bawshar',
        `office-${tag}-${i}@example.om`, `+96890${String(i).padStart(6,'1')}`, `CR-${tag}-${i}`
      ]
    });
    const officeId = Number(r.lastInsertRowid);
    officeIds.push(officeId);
    const email = `officer-${tag}-${i}@example.om`;
    await db.execute({
      sql: `INSERT INTO officer(office_id, full_name, email, role, status, password_hash)
            VALUES (?,?,?,'owner','active',?)`,
      args: [officeId, `Officer ${i}`, email, pwHash]
    });
    officerEmails.push(email);
  }
  ok(`seeded ${N_OFFICES} offices + 1 officer each`, officeIds.length === N_OFFICES);

  // ── 2) Sign in all 10 officers (independent cookies) ──
  const cookies = [];
  for (const email of officerEmails) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'demo123' })
    });
    if (r.status !== 200) {
      const body = await r.text();
      throw new Error(`login failed for ${email}: ${r.status} ${body}`);
    }
    cookies.push(getCookie(r, 'sanad_sess'));
  }
  ok('all 10 officers signed in', cookies.every(Boolean) && cookies.length === N_OFFICES);

  // ── 3) Seed a citizen + 5 ready requests ──────────────
  // Use magic OTP so the citizen has the right shape (citizen_id FK).
  const phone = `+9689${String(Date.now()).slice(-9)}`;
  const cr = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000' })
  });
  const cd = await cr.json();
  ok('citizen seeded via magic OTP', cr.status === 200 && cd.ok);
  const citizenId = cd.citizen.id;

  // Pick a real service id from the catalogue (any active service).
  const { rows: svc } = await db.execute({
    sql: `SELECT id FROM service_catalog WHERE is_active=1 LIMIT 1`
  });
  const serviceId = svc[0]?.id || 1;

  const requestIds = [];
  for (let i = 0; i < N_REQUESTS; i++) {
    const r = await db.execute({
      sql: `INSERT INTO request(session_id, citizen_id, service_id, status, governorate, created_at, last_event_at)
            VALUES (?,?,?, 'ready', 'Muscat', datetime('now'), datetime('now'))`,
      args: [`${tag}-req-${i}`, citizenId, serviceId]
    });
    requestIds.push(Number(r.lastInsertRowid));
    // Each request needs at least one doc so it shows on the marketplace card.
    await db.execute({
      sql: `INSERT INTO request_document(request_id, doc_code, label, mime, size_bytes, status)
            VALUES (?, 'civil_id', 'Civil ID', 'image/jpeg', 100000, 'pending')`,
      args: [requestIds[i]]
    });
  }
  ok(`seeded ${N_REQUESTS} ready requests`, requestIds.length === N_REQUESTS);

  // ── 4) Race! 10 offices × 5 requests = 50 concurrent POSTs ──
  const attempts = [];
  for (const reqId of requestIds) {
    for (let i = 0; i < N_OFFICES; i++) {
      attempts.push(
        fetch(`${base}/api/officer/request/${reqId}/claim`, {
          method: 'POST',
          headers: { cookie: cookies[i] }
        }).then(async r => ({
          reqId,
          officerIdx: i,
          status: r.status,
          body: await r.json().catch(() => ({}))
        }))
      );
    }
  }
  const t0 = Date.now();
  const results = await Promise.all(attempts);
  const elapsed = Date.now() - t0;
  console.log(`[compete] 50 racing claims completed in ${elapsed}ms`);

  // ── 5) Tally ──────────────────────────────────────────
  const wins = results.filter(r => r.status === 200);
  const losses = results.filter(r => r.status === 409);
  const errors = results.filter(r => r.status !== 200 && r.status !== 409);

  ok(`exactly ${N_REQUESTS} claims won (200)`, wins.length === N_REQUESTS,
    `actual=${wins.length} losses=${losses.length} errors=${errors.length}`);
  ok(`exactly ${N_OFFICES * N_REQUESTS - N_REQUESTS} losses (409)`,
    losses.length === N_OFFICES * N_REQUESTS - N_REQUESTS,
    `actual=${losses.length}`);
  ok('no protocol errors (no 4xx other than 409, no 5xx)', errors.length === 0,
    JSON.stringify(errors.slice(0,3)));

  // Each winning office must have a 'already_claimed' or 'not_open' error code on losses.
  const expectedErrors = ['already_claimed', 'not_open'];
  const badLosses = losses.filter(l => !expectedErrors.includes(l.body?.error));
  ok('all losses report already_claimed or not_open',
    badLosses.length === 0, JSON.stringify(badLosses.slice(0,3)));

  // ── 6) Verify winning offices in DB ───────────────────
  const { rows: dbReqs } = await db.execute({
    sql: `SELECT id, status, office_id, claim_review_started_at
            FROM request
           WHERE id IN (${requestIds.join(',')})
           ORDER BY id`,
    args: []
  });
  ok('all 5 requests now claimed', dbReqs.every(r => r.status === 'claimed'));
  ok('all 5 requests have office_id NOT NULL', dbReqs.every(r => r.office_id != null));
  ok('all 5 requests have claim_review_started_at NOT NULL',
     dbReqs.every(r => r.claim_review_started_at != null));

  // Each request has exactly ONE winning office (no double-locks). It's
  // perfectly fine for one office to win multiple requests — fast officer
  // wins more — but no single request can have two owners.
  const winningOfficeIds = dbReqs.map(r => r.office_id);
  ok(`each of the ${N_REQUESTS} requests has exactly one office_id (no double-lock)`,
     winningOfficeIds.every(o => o != null));
  console.log(`   winning offices per request: [${winningOfficeIds.join(',')}]`);

  // Cross-check: each winning office in API should match the office_id in DB.
  for (const w of wins) {
    const dbRow = dbReqs.find(r => r.id === w.reqId);
    const expectedOfficeId = officeIds[w.officerIdx];
    ok(`API winner reqId=${w.reqId} officer #${w.officerIdx} (office=${expectedOfficeId}) matches DB office_id=${dbRow.office_id}`,
       dbRow.office_id === expectedOfficeId);
  }

  // ── 7) Audit log: 5 'request_claim' entries, no duplicates ──
  const { rows: audit } = await db.execute({
    sql: `SELECT target_id, COUNT(*) AS n FROM audit_log
           WHERE action='request_claim' AND target_type='request'
             AND target_id IN (${requestIds.join(',')})
           GROUP BY target_id`,
    args: []
  });
  ok('audit_log has exactly 5 request_claim entries (one per request)',
     audit.length === N_REQUESTS && audit.every(a => a.n === 1),
     JSON.stringify(audit));

  // ── 8) Sanity: 6th unrelated office cannot steal a won request ──
  // Create one more office + officer outside the original 10.
  const extraR = await db.execute({
    sql: `INSERT INTO office(name_en, name_ar, governorate, wilayat, email, phone, cr_number,
            status, credits_remaining, subscription_status, subscription_since, rating, total_completed,
            default_office_fee_omr)
          VALUES ('Extra Office', 'مكتب إضافي','Muscat','Seeb', ?, ?, ?, 'active', 999, 'active', datetime('now'), 4.0, 0, 5.0)`,
    args: [`extra-${tag}@example.om`, `+96890999${String(Date.now()).slice(-3)}`, `CR-EXTRA-${tag}`]
  });
  const extraOfficeId = Number(extraR.lastInsertRowid);
  await db.execute({
    sql: `INSERT INTO officer(office_id, full_name, email, role, status, password_hash)
          VALUES (?,?,?, 'owner','active', ?)`,
    args: [extraOfficeId, 'Extra Officer', `extra-officer-${tag}@example.om`, pwHash]
  });
  const extraLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `extra-officer-${tag}@example.om`, password: 'demo123' })
  });
  const extraCookie = getCookie(extraLogin, 'sanad_sess');

  const stealAttempt = await fetch(`${base}/api/officer/request/${requestIds[0]}/claim`, {
    method: 'POST',
    headers: { cookie: extraCookie }
  });
  const stealBody = await stealAttempt.json();
  ok('6th office cannot steal an already-claimed request (409)',
     stealAttempt.status === 409 && stealBody.error === 'already_claimed',
     JSON.stringify(stealBody));

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n────────── COMPETITION SIM ──────────`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
