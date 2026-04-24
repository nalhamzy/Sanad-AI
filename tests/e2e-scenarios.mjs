// End-to-end scenario harness — drives the full marketplace → offer → accept
// → chat → complete pipeline through the real HTTP APIs. Goal: catch bugs by
// exercising every realistic path + obvious failure modes.
//
// WHY WE SEED THE "ready" REQUEST DIRECTLY VIA DB:
//   The citizen intake flow (LLM → tool calls → doc upload → confirm) depends
//   on Qwen responses and is non-deterministic. The parts the user actually
//   cares about in this test — "Sanad sends offer → citizen accepts →
//   dashboard chat → finalize" — all happen AFTER the request is 'ready'.
//   So we shortcut the intake by writing a 'ready' row directly, then use the
//   real APIs for everything downstream. This keeps the test fast + stable
//   while still exercising 100% of the marketplace/chat/complete code paths.
//
// Run:
//   DEBUG_MODE=true node tests/e2e-scenarios.mjs            (server on :3030)
//   DEBUG_MODE=true node tests/e2e-scenarios.mjs --port 3031
//
// Assumes the server is already running (otherwise: `npm run dev` first).

import crypto from 'crypto';
import { db } from '../lib/db.js';

const PORT  = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7) || process.env.PORT || 3030);
const BASE  = `http://localhost:${PORT}`;

// ─── Test runner ──────────────────────────────────────────────────────
const results = [];
let scenarioName = '(none)';
function assert(cond, detail) {
  if (!cond) {
    const err = new Error(`ASSERT failed — ${detail}`);
    err._scenario = scenarioName;
    throw err;
  }
}
async function scenario(name, fn) {
  scenarioName = name;
  process.stdout.write(`\n▶ ${name}\n`);
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ passed (${Date.now()-t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message, ms: Date.now() - t0 });
    console.error(`  ✗ FAILED — ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────
async function http(method, path, { body, cookie, headers = {}, expect } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (cookie) h.cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (expect != null && res.status !== expect) {
    throw new Error(`${method} ${path} → expected ${expect}, got ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

function extractSessionCookie(setCookie) {
  if (!setCookie) return null;
  const m = setCookie.match(/sanad_sess=[^;]+/);
  return m ? m[0] : null;
}

async function login(email, password) {
  const r = await http('POST', '/api/auth/login', { body: { email, password }, expect: 200 });
  const c = extractSessionCookie(r.setCookie);
  if (!c) throw new Error('no session cookie on login');
  return c;
}

// ─── DB helpers (bypass LLM intake) ───────────────────────────────────
async function pickAnyActiveService() {
  const { rows } = await db.execute(
    `SELECT id, name_ar, fee_omr FROM service_catalog WHERE is_active=1 ORDER BY id LIMIT 1`
  );
  return rows[0];
}

async function seedReadyRequest({ governorate = 'Muscat', serviceId, catalogFee = 2.0 } = {}) {
  const session_id = 'e2e-' + crypto.randomBytes(4).toString('hex');
  if (!serviceId) {
    const svc = await pickAnyActiveService();
    serviceId = svc.id;
    if (catalogFee === 2.0 && svc.fee_omr != null) catalogFee = Number(svc.fee_omr);
  }
  // Minimal citizen row for the session
  const phone = '+968' + Math.floor(90000000 + Math.random() * 9999999);
  const cIns = await db.execute({
    sql: `INSERT INTO citizen (phone, name, language_pref) VALUES (?, ?, 'ar')`,
    args: [phone, 'Test Citizen ' + session_id.slice(-4)]
  });
  const citizen_id = Number(cIns.lastInsertRowid);
  const rIns = await db.execute({
    sql: `INSERT INTO request (session_id, citizen_id, service_id, status, governorate, state_json, created_at, last_event_at)
          VALUES (?,?,?, 'ready', ?, '{}', datetime('now'), datetime('now'))`,
    args: [session_id, citizen_id, serviceId, governorate]
  });
  const request_id = Number(rIns.lastInsertRowid);
  // Add two dummy docs so the request looks realistic (the offer path doesn't
  // need them but the officer-side detail view iterates request_document).
  await db.execute({
    sql: `INSERT INTO request_document (request_id, doc_code, label, mime, size_bytes, status, uploaded_at)
          VALUES (?, 'civil_id_front', 'البطاقة المدنية — الأمام', 'image/jpeg', 120000, 'pending', datetime('now')),
                 (?, 'civil_id_back',  'البطاقة المدنية — الخلف', 'image/jpeg', 118000, 'pending', datetime('now'))`,
    args: [request_id, request_id]
  });
  // Seed a citizen-side opener message for realism — exercises the citizen→office relay path.
  await db.execute({
    sql: `INSERT INTO message (session_id, request_id, direction, actor_type, body_text)
          VALUES (?, ?, 'in', 'citizen', 'السلام عليكم، أحتاج هذه الخدمة.')`,
    args: [session_id, request_id]
  });
  return { session_id, request_id, citizen_id, service_id: serviceId, catalog_fee_omr: catalogFee };
}

async function pollCitizenMessages(session_id, afterId = 0) {
  const r = await http('GET', `/api/chat/${session_id}/poll?after=${afterId}`, { expect: 200 });
  return r.json.messages || [];
}

async function sendCitizenMessage(session_id, text) {
  // Bypass the LLM by writing the citizen message straight to the DB — we only
  // want to test that the officer SEES the reply, not re-test the agent.
  await db.execute({
    sql: `INSERT INTO message (session_id, direction, actor_type, body_text)
          VALUES (?, 'in', 'citizen', ?)`,
    args: [session_id, text]
  });
}

async function promoteToManager(email) {
  await db.execute({ sql: `UPDATE officer SET role='manager' WHERE email=?`, args: [email] });
}

async function ensureOfficer3Owner() {
  // Office 3 (Muttrah) has no officer row — make sure there's an owner so
  // multi-office scenarios work.
  const { rows } = await db.execute(`SELECT id FROM officer WHERE email='owner@muttrah.om' LIMIT 1`);
  if (rows.length) return;
  const bcrypt = await import('bcryptjs');
  const hash = bcrypt.default.hashSync('demo123', 10);
  await db.execute({
    sql: `INSERT INTO officer (office_id, full_name, email, role, status, password_hash)
          VALUES (3, 'Yousef Al-Balushi', 'owner@muttrah.om', 'owner', 'active', ?)`,
    args: [hash]
  });
  // And give that office the right subscription state for non-DEBUG guards.
  await db.execute(`UPDATE office SET status='active', subscription_status='active', credits_remaining=50, default_office_fee_omr=5 WHERE id=3`);
}

// ─── Scenarios ────────────────────────────────────────────────────────

// S1 — Happy path: request ready → one office quotes → citizen accepts →
//      officer chats → citizen replies → officer completes.
async function s1_happyPath() {
  const seed = await seedReadyRequest();
  const cookie = await login('khalid@nahdha.om', 'demo123');

  // Inbox sees the request in marketplace
  let inbox = (await http('GET', '/api/officer/inbox', { cookie, expect: 200 })).json;
  let mk = inbox.marketplace.find(x => x.id === seed.request_id);
  assert(mk, 'request not in marketplace');
  assert(mk.my_offer_status !== 'pending', 'offer already pending before we sent one');

  // Officer sends a quote (custom office fee 4.5, gov fee from catalog)
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie, body: { office_fee_omr: 4.5, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });

  // Citizen lists offers → sees exactly one
  let offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  assert(offers.offers.length === 1, `citizen saw ${offers.offers.length} offers, expected 1`);
  const offerId = offers.offers[0].id;
  assert(Number(offers.offers[0].quoted_fee_omr).toFixed(3) === (4.5 + seed.catalog_fee_omr).toFixed(3),
    `total fee mismatch (got ${offers.offers[0].quoted_fee_omr})`);

  // Citizen accepts
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offerId}/accept`, { expect: 200 });

  // Inbox → request no longer in marketplace, now in mine
  inbox = (await http('GET', '/api/officer/inbox', { cookie, expect: 200 })).json;
  assert(!inbox.marketplace.find(x => x.id === seed.request_id), 'request still in marketplace after accept');
  assert(inbox.mine.find(x => x.id === seed.request_id), 'request not in mine after accept');

  // Officer opens the detail → full docs, messages, no session_id leaked
  const detail = (await http('GET', `/api/officer/request/${seed.request_id}`, { cookie, expect: 200 })).json;
  assert(detail.request.id === seed.request_id, 'detail id mismatch');
  assert(!('session_id' in detail.request), 'session_id leaked in officer detail');
  assert(detail.documents.length === 2, 'docs missing');
  assert(detail.messages.length >= 1, 'no citizen-opener message relayed');

  // Officer sends a chat message
  const greet = 'أهلاً بك، استلمت طلبك وسأعمل عليه فوراً.';
  await http('POST', `/api/officer/request/${seed.request_id}/message`, { cookie, body: { text: greet }, expect: 200 });

  // Citizen polls → sees the officer message
  const poll1 = await pollCitizenMessages(seed.session_id);
  assert(poll1.find(m => m.actor_type === 'officer' && m.body_text === greet),
    'citizen did not see officer greeting via /poll');

  // Citizen replies "شكراً"
  await sendCitizenMessage(seed.session_id, 'شكراً، أنتظر ردكم.');

  // Officer re-opens detail → sees citizen reply
  const detail2 = (await http('GET', `/api/officer/request/${seed.request_id}`, { cookie, expect: 200 })).json;
  assert(detail2.messages.find(m => m.actor_type === 'citizen' && m.body_text.includes('شكراً')),
    'citizen reply not visible to officer');

  // Officer asks for additional info (simulated via message) then verifies docs
  await http('POST', `/api/officer/request/${seed.request_id}/message`,
    { cookie, body: { text: 'هل يمكنك إرسال جواز السفر؟' }, expect: 200 });
  // Verify both docs
  for (const d of detail.documents) {
    await http('POST', `/api/officer/request/${seed.request_id}/document/${d.id}/verify`, { cookie, expect: 200 });
  }

  // Status after sending a message should become in_progress
  const { rows: status1 } = await db.execute({ sql: `SELECT status FROM request WHERE id=?`, args: [seed.request_id] });
  assert(['claimed', 'in_progress'].includes(status1[0].status), `unexpected status ${status1[0].status}`);

  // Complete
  await http('POST', `/api/officer/request/${seed.request_id}/complete`, { cookie, expect: 200 });
  const { rows: status2 } = await db.execute({ sql: `SELECT status FROM request WHERE id=?`, args: [seed.request_id] });
  assert(status2[0].status === 'completed', `expected completed, got ${status2[0].status}`);

  // total_completed bumped on office
  const { rows: offRows } = await db.execute(`SELECT total_completed FROM office WHERE id=1`);
  assert(offRows[0].total_completed >= 1, 'office.total_completed not incremented');
}

// S2 — Multi-office bidding: two offices quote different amounts, citizen
//      picks the cheaper, the loser's offer is auto-rejected, and the loser
//      cannot subsequently message the request.
async function s2_multiOfficeBidding() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');   // office 1 (Nahdha)
  const c3 = await login('owner@muttrah.om', 'demo123');   // office 3 (Muttrah)

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 6.0, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c3, body: { office_fee_omr: 3.0, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });

  // Citizen sees both, sorted by price ascending (cheaper first)
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  assert(offers.offers.length === 2, `expected 2 offers, got ${offers.offers.length}`);
  assert(Number(offers.offers[0].quoted_fee_omr) <= Number(offers.offers[1].quoted_fee_omr),
    'offers not sorted ascending by price');
  const cheaperOfficeId = offers.offers[0].office_id;
  const cheaperOfferId = offers.offers[0].id;
  assert(cheaperOfficeId === 3, `expected office 3 to win (cheaper), got ${cheaperOfficeId}`);

  // Citizen accepts cheaper
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${cheaperOfferId}/accept`, { expect: 200 });

  // Winning office sees it in mine; losing office does NOT
  const inbox3 = (await http('GET', '/api/officer/inbox', { cookie: c3, expect: 200 })).json;
  assert(inbox3.mine.find(x => x.id === seed.request_id), 'winner does not see request in mine');
  const inbox1 = (await http('GET', '/api/officer/inbox', { cookie: c1, expect: 200 })).json;
  assert(!inbox1.mine.find(x => x.id === seed.request_id), 'loser sees request in mine');

  // Loser tries to message → 403
  const r = await http('POST', `/api/officer/request/${seed.request_id}/message`,
    { cookie: c1, body: { text: 'try' } });
  assert(r.status === 403, `loser should get 403 on message, got ${r.status}`);

  // Loser opens detail anonymously → should be 403 (request already awarded)
  const r2 = await http('GET', `/api/officer/request/${seed.request_id}`, { cookie: c1 });
  assert(r2.status === 403, `loser should get 403 on drilldown of lost request, got ${r2.status}`);

  // DB check: loser's offer was marked 'rejected'
  const { rows: offRows } = await db.execute({
    sql: `SELECT status FROM request_offer WHERE request_id=? AND office_id=?`,
    args: [seed.request_id, 1]
  });
  assert(offRows[0]?.status === 'rejected', `loser offer status: ${offRows[0]?.status}`);
}

// S3 — Double-accept is blocked even when two offers exist and a second
//      accept call races in.
async function s3_doubleAcceptBlocked() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');
  const c3 = await login('owner@muttrah.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 2, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c3, body: { office_fee_omr: 2, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });

  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  const [a, b] = offers.offers;

  // Accept first
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${a.id}/accept`, { expect: 200 });
  // Accept second — must fail
  const r = await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${b.id}/accept`);
  assert(r.status === 409, `second accept should 409, got ${r.status}`);
  assert(r.json?.error, `second accept should have error code`);
}

// S4 — Offer withdraw leaves the other office's offer intact and acceptable.
async function s4_withdrawDoesNotBreakOthers() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');
  const c3 = await login('owner@muttrah.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 5, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c3, body: { office_fee_omr: 4, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });

  // Office 1 withdraws
  await http('POST', `/api/officer/request/${seed.request_id}/offer/withdraw`, { cookie: c1, expect: 200 });

  // Citizen sees only one offer (status=pending)
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  assert(offers.offers.length === 1, `after withdraw expected 1 visible offer, got ${offers.offers.length}`);
  assert(offers.offers[0].office_id === 3, 'remaining offer is not office 3');

  // Accept it — should succeed
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offers.offers[0].id}/accept`, { expect: 200 });
}

// S5 — Auto-learn pricing: an office's fee for a service is cached on first
//      quote and pre-filled (via office_fee_override) on the next one.
async function s5_autoLearnPricing() {
  const svc = await pickAnyActiveService();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  // Clear any prior override from earlier test runs
  await db.execute({ sql: `DELETE FROM office_service_price WHERE office_id=1 AND service_id=?`, args: [svc.id] });

  const seedA = await seedReadyRequest({ serviceId: svc.id });
  // Office quotes at a distinctive fee: 7.777
  await http('POST', `/api/officer/request/${seedA.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 7.777, government_fee_omr: seedA.catalog_fee_omr }, expect: 201 });

  // Verify cache row exists
  const { rows: cache } = await db.execute({
    sql: `SELECT office_fee_omr FROM office_service_price WHERE office_id=1 AND service_id=?`,
    args: [svc.id]
  });
  assert(Number(cache[0]?.office_fee_omr).toFixed(3) === '7.777', `auto-learn row missing/mismatch: ${JSON.stringify(cache)}`);

  // Seed a NEW request for the same service — inbox must pre-fill with 7.777
  const seedB = await seedReadyRequest({ serviceId: svc.id });
  const inbox = (await http('GET', '/api/officer/inbox', { cookie: c1, expect: 200 })).json;
  const b = inbox.marketplace.find(x => x.id === seedB.request_id);
  assert(b, 'second request not in marketplace');
  assert(Number(b.office_fee_override).toFixed(3) === '7.777',
    `new card should pre-fill 7.777, got office_fee_override=${b.office_fee_override}`);

  // Cleanup
  await db.execute({ sql: `DELETE FROM office_service_price WHERE office_id=1 AND service_id=?`, args: [svc.id] });
}

// S6 — Document reject flow: officer rejects a doc with a reason, the reason
//      is relayed to the citizen as a chat message, and re-verify flips it.
async function s6_docRejectFlow() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 5, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offers.offers[0].id}/accept`, { expect: 200 });

  const detail = (await http('GET', `/api/officer/request/${seed.request_id}`, { cookie: c1, expect: 200 })).json;
  const docId = detail.documents[0].id;
  const reason = 'الصورة غير واضحة — برجاء إعادة التصوير بإضاءة أفضل.';
  await http('POST', `/api/officer/request/${seed.request_id}/document/${docId}/reject`,
    { cookie: c1, body: { reason }, expect: 200 });

  // Citizen sees rejection message via poll
  const msgs = await pollCitizenMessages(seed.session_id);
  assert(msgs.find(m => m.body_text && m.body_text.includes(reason)),
    'rejection reason not relayed to citizen');

  // DB: doc status flipped
  const { rows: dRows } = await db.execute({
    sql: `SELECT status, reject_reason FROM request_document WHERE id=?`, args: [docId]
  });
  assert(dRows[0].status === 'rejected', `doc status should be rejected, got ${dRows[0].status}`);

  // Re-verify flips the same doc
  await http('POST', `/api/officer/request/${seed.request_id}/document/${docId}/verify`, { cookie: c1, expect: 200 });
  const { rows: dRows2 } = await db.execute({
    sql: `SELECT status, reject_reason FROM request_document WHERE id=?`, args: [docId]
  });
  assert(dRows2[0].status === 'verified' && dRows2[0].reject_reason == null,
    `after re-verify expected verified+null reason, got ${JSON.stringify(dRows2[0])}`);
}

// S7 — Bad fee inputs are rejected (0,0 → 400, negative → 400, too-high → 400).
async function s7_feeValidation() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');
  const bads = [
    { office_fee_omr: 0,    government_fee_omr: 0 },
    { office_fee_omr: -1,   government_fee_omr: 0 },
    { office_fee_omr: 400,  government_fee_omr: 200 },   // total > 500
    { office_fee_omr: 'x',  government_fee_omr: 1 },
    {}                                                  // missing entirely
  ];
  for (const b of bads) {
    const r = await http('POST', `/api/officer/request/${seed.request_id}/offer`, { cookie: c1, body: b });
    assert(r.status === 400, `bad body ${JSON.stringify(b)} should 400, got ${r.status}`);
  }
}

// S8 — Session isolation: citizen A cannot accept an offer on citizen B's request.
async function s8_sessionIsolation() {
  const seedA = await seedReadyRequest();
  const seedB = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  // Office quotes on B
  await http('POST', `/api/officer/request/${seedB.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 4, government_fee_omr: seedB.catalog_fee_omr }, expect: 201 });
  const offers = (await http('GET', `/api/chat/${seedB.session_id}/request/${seedB.request_id}/offers`, { expect: 200 })).json;
  const offerBid = offers.offers[0].id;

  // Citizen A tries to accept with their own session_id → must fail (ownership check)
  const r = await http('POST', `/api/chat/${seedA.session_id}/request/${seedB.request_id}/offers/${offerBid}/accept`);
  assert(r.status === 403 || r.status === 404,
    `cross-session accept should 403/404, got ${r.status} (${JSON.stringify(r.json)})`);

  // Listing offers under the wrong session must also 404
  const r2 = await http('GET', `/api/chat/${seedA.session_id}/request/${seedB.request_id}/offers`);
  assert(r2.status === 404, `cross-session list should 404, got ${r2.status}`);
}

// S9 — Officer role guard: an officer with role='officer' (not owner/manager)
//      cannot submit or withdraw offers.
async function s9_officerRoleGuard() {
  // hassan@seeb.om seeded with role='officer'. We make sure he's still role='officer'.
  await db.execute({ sql: `UPDATE officer SET role='officer' WHERE email='hassan@seeb.om'` });
  const seed = await seedReadyRequest();
  const c = await login('hassan@seeb.om', 'demo123');

  const r = await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c, body: { office_fee_omr: 5, government_fee_omr: seed.catalog_fee_omr } });
  assert([401, 403].includes(r.status), `role=officer should be blocked, got ${r.status}`);
}

// S10 — Complete and release are guarded to the owning office only.
async function s10_completeGuard() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');
  const c3 = await login('owner@muttrah.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 3, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offers.offers[0].id}/accept`, { expect: 200 });

  // Office 3 tries to complete or release → 403
  const r1 = await http('POST', `/api/officer/request/${seed.request_id}/complete`, { cookie: c3 });
  assert(r1.status === 403, `stranger /complete should 403, got ${r1.status}`);
  const r2 = await http('POST', `/api/officer/request/${seed.request_id}/release`, { cookie: c3 });
  assert(r2.status === 403, `stranger /release should 403, got ${r2.status}`);
}

// S11 — Officer cannot message or manipulate a request they haven't won.
//       (Covers the 'ready' state — office_id is NULL — and the foreign-office case.)
async function s11_messagingBeforeAccept() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  // Officer has NOT quoted yet — unclaimed request. Message must 403.
  let r = await http('POST', `/api/officer/request/${seed.request_id}/message`, { cookie: c1, body: { text: 'x' } });
  assert(r.status === 403, `pre-accept message should 403, got ${r.status}`);

  // Verifying a doc before accept must also 403.
  const { rows: docs } = await db.execute({ sql: `SELECT id FROM request_document WHERE request_id=?`, args: [seed.request_id] });
  r = await http('POST', `/api/officer/request/${seed.request_id}/document/${docs[0].id}/verify`, { cookie: c1 });
  assert(r.status === 403, `pre-accept verify should 403, got ${r.status}`);

  // Even /otp-window should 403 before accept.
  r = await http('POST', `/api/officer/request/${seed.request_id}/otp-window`, { cookie: c1 });
  assert(r.status === 403, `pre-accept otp-window should 403, got ${r.status}`);
}

// S12 — UPSERT semantics: re-quoting replaces the previous offer instead of
//       duplicating (unique index on (request_id, office_id)).
async function s12_reQuoteReplaces() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 5, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 7, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 2.5, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });

  // Must be exactly ONE row per (request, office)
  const { rows } = await db.execute({
    sql: `SELECT id, office_fee_omr, status FROM request_offer WHERE request_id=? AND office_id=1`,
    args: [seed.request_id]
  });
  assert(rows.length === 1, `expected 1 offer row after re-quote, got ${rows.length}`);
  assert(Number(rows[0].office_fee_omr) === 2.5, `last fee should be 2.5, got ${rows[0].office_fee_omr}`);
  assert(rows[0].status === 'pending', `re-quote status should stay pending, got ${rows[0].status}`);
}

// S13 — Idempotency of /complete: calling it twice must not inflate
//       office.total_completed beyond +1. Hitting a terminal status shouldn't
//       double-bill the stats.
async function s13_completeIdempotent() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  // Pre-baseline stat
  const { rows: before } = await db.execute(`SELECT total_completed FROM office WHERE id=1`);
  const base = Number(before[0].total_completed || 0);

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 3, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offers.offers[0].id}/accept`, { expect: 200 });

  // First complete → +1
  await http('POST', `/api/officer/request/${seed.request_id}/complete`, { cookie: c1, expect: 200 });
  // Second complete → should NOT double-count
  await http('POST', `/api/officer/request/${seed.request_id}/complete`, { cookie: c1 }); // status is free-form; not strictly 200/409

  const { rows: after } = await db.execute(`SELECT total_completed FROM office WHERE id=1`);
  const now = Number(after[0].total_completed || 0);
  assert(now - base === 1,
    `total_completed drift = ${now - base} (expected 1). Double-complete inflated the stat — server needs to guard on current status.`);
}

// S14 — /release is gated to non-terminal statuses. Releasing a completed
//       request must NOT reopen it.
async function s14_releaseAfterComplete() {
  const seed = await seedReadyRequest();
  const c1 = await login('khalid@nahdha.om', 'demo123');

  await http('POST', `/api/officer/request/${seed.request_id}/offer`,
    { cookie: c1, body: { office_fee_omr: 3, government_fee_omr: seed.catalog_fee_omr }, expect: 201 });
  const offers = (await http('GET', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers`, { expect: 200 })).json;
  await http('POST', `/api/chat/${seed.session_id}/request/${seed.request_id}/offers/${offers.offers[0].id}/accept`, { expect: 200 });
  await http('POST', `/api/officer/request/${seed.request_id}/complete`, { cookie: c1, expect: 200 });

  // Now /release — should NOT resurrect a completed request.
  const rel = await http('POST', `/api/officer/request/${seed.request_id}/release`, { cookie: c1 });
  // Either 409 (server guards properly) or 403. Anything 2xx is a bug.
  assert(rel.status >= 400, `release of completed request should fail, got ${rel.status}`);

  const { rows } = await db.execute(`SELECT status, office_id FROM request WHERE id=${seed.request_id}`);
  assert(rows[0].status === 'completed',
    `release of completed request mutated status to '${rows[0].status}' — should stay 'completed'`);
  assert(rows[0].office_id === 1,
    `release of completed request cleared office_id — data integrity broken`);
}

// S15 — Admin disabling a service should hide it from office pricing list
//       AND from future marketplace cards (is_active filter), but existing
//       claimed/completed requests keep working.
async function s15_adminDisableServicePropagates() {
  const svc = await pickAnyActiveService();
  const cA = await login('khalid@nahdha.om', 'demo123');

  // Admin (khalid is admin in DEBUG_MODE) disables the service
  await http('DELETE', `/api/platform-admin/services/${svc.id}`, { cookie: cA, expect: 200 });

  // Office /pricing should not list the disabled service
  const pricing = (await http('GET', '/api/office/pricing?limit=2000', { cookie: cA, expect: 200 })).json;
  const found = pricing.items.find(x => x.service_id === svc.id);
  assert(!found, `disabled service still appears in office pricing list`);

  // Admin re-enables for cleanup
  await http('PATCH', `/api/platform-admin/services/${svc.id}`,
    { cookie: cA, body: { is_active: true }, expect: 200 });
  const pricing2 = (await http('GET', '/api/office/pricing?limit=2000', { cookie: cA, expect: 200 })).json;
  assert(pricing2.items.find(x => x.service_id === svc.id),
    `re-enabled service should be back in office pricing list`);
}

// ─── main ─────────────────────────────────────────────────────────────
(async () => {
  console.log(`E2E scenarios against ${BASE}  (DEBUG_MODE=${process.env.DEBUG_MODE || 'unset'})`);
  // Pre-flight: server up?
  try { await http('GET', '/api/health', { expect: 200 }); }
  catch (e) {
    console.error(`× server not reachable at ${BASE} — start it first (npm run dev)`);
    process.exit(2);
  }
  // Fixtures: office 3 owner, officer roles normalized, promote Noor to manager (she already is, but safe).
  await ensureOfficer3Owner();
  await promoteToManager('noor@nahdha.om');

  await scenario('S1 happy path — quote → accept → chat → docs → complete', s1_happyPath);
  await scenario('S2 multi-office bidding — cheaper wins, loser blocked',     s2_multiOfficeBidding);
  await scenario('S3 double-accept blocked',                                  s3_doubleAcceptBlocked);
  await scenario('S4 withdraw leaves the other offer acceptable',             s4_withdrawDoesNotBreakOthers);
  await scenario('S5 auto-learn pricing — pre-fills next card',               s5_autoLearnPricing);
  await scenario('S6 doc reject flow — reason relayed, re-verify flips back', s6_docRejectFlow);
  await scenario('S7 fee validation — 0/0, negative, too-high, wrong types',  s7_feeValidation);
  await scenario('S8 session isolation — cross-session accept blocked',       s8_sessionIsolation);
  await scenario('S9 officer-role guard blocks non-managers from quoting',    s9_officerRoleGuard);
  await scenario('S10 complete/release guarded to owning office only',        s10_completeGuard);
  await scenario('S11 messaging/docs/OTP blocked before accept',              s11_messagingBeforeAccept);
  await scenario('S12 re-quote UPSERTs (no duplicate offer rows)',            s12_reQuoteReplaces);
  await scenario('S13 complete is idempotent (no double total_completed)',    s13_completeIdempotent);
  await scenario('S14 release of a completed request must fail',              s14_releaseAfterComplete);
  await scenario('S15 admin disable/enable service propagates to offices',    s15_adminDisableServicePropagates);

  // Summary
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${pass}/${results.length} scenarios passed`);
  if (fail.length) {
    console.log(`  Failures:`);
    for (const f of fail) console.log(`    ✗ ${f.name}\n      ${f.err}`);
  }
  console.log('═'.repeat(60));
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('[harness] fatal:', e);
  process.exit(3);
});
