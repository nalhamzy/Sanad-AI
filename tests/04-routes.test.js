// HTTP integration tests — spins up the real Express app on a random port.
// Covers: page routes, chat POST, officer inbox, atomic claim, double-claim 409.
import { spawnServer, fetchJSON, postChat, registerAndApproveOffice, createReadyRequest } from './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

let ctx;
before(async () => { ctx = await spawnServer(); });
after(async () => { await ctx?.stop(); });

describe('HTTP · page routes', () => {
  test('all pages return 200', async () => {
    for (const p of ['/', '/chat.html', '/officer.html', '/admin.html', '/catalogue.html', '/theme.css', '/i18n.js', '/ui.js']) {
      const res = await fetch(ctx.origin + p);
      assert.equal(res.status, 200, `${p} returned ${res.status}`);
    }
  });

  test('/api/health reports LLM + debug flags', async () => {
    const { status, body } = await fetchJSON(ctx.origin, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.llm, 'boolean');
    assert.equal(typeof body.debug, 'boolean');
  });

  test('/api/debug/state returns counts and latest lists', async () => {
    const { body } = await fetchJSON(ctx.origin, '/api/debug/state');
    assert.ok(body.counts);
    assert.ok(body.counts.office >= 3, 'demo offices should be seeded');
    assert.ok(Array.isArray(body.latestRequests));
    assert.ok(Array.isArray(body.latestMessages));
  });
});

describe('HTTP · chat API', () => {
  test('POST /api/chat/:sid returns reply + state', async () => {
    const sid = 'http-' + Math.random().toString(36).slice(2, 8);
    const data = await postChat(ctx.origin, sid, 'hello');
    assert.ok(data.reply);
    assert.ok(data.state);
    assert.equal(data.state.status, 'idle');
  });

  test('GET /api/chat/:sid/history returns stored messages', async () => {
    const sid = 'hist-' + Math.random().toString(36).slice(2, 8);
    await postChat(ctx.origin, sid, 'renew driving licence');
    await postChat(ctx.origin, sid, 'yes');
    const { body } = await fetchJSON(ctx.origin, `/api/chat/${sid}/history`);
    assert.ok(Array.isArray(body.messages));
    assert.ok(body.messages.length >= 4, 'should have user+bot turns, got ' + body.messages.length);
  });
});

describe('HTTP · officer API (cookie auth + offer flow)', () => {
  test('/api/officer/inbox requires sign-in', async () => {
    const res = await fetch(ctx.origin + '/api/officer/inbox');
    assert.equal(res.status, 401);
  });

  test('signed-in officer sees anonymized marketplace', async () => {
    const { cookie } = await registerAndApproveOffice(ctx.origin);
    await createReadyRequest(ctx.origin);
    const res = await fetch(ctx.origin + '/api/officer/inbox', { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.me && body.me.full_name, 'me should be hydrated');
    assert.ok(Array.isArray(body.marketplace));
    // Marketplace entries must NOT leak citizen PII or fee.
    for (const m of body.marketplace) {
      assert.equal(m.fee_omr, undefined, 'fee must not be in marketplace');
      assert.equal(m.citizen_phone, undefined, 'phone must never leak');
      assert.equal(m.citizen_name, undefined, 'name must never leak');
      assert.equal(typeof m.doc_count, 'number', 'doc_count surfaced');
    }
  });

  test('first-accepted offer wins; losing office gets rejected', async () => {
    const a = await registerAndApproveOffice(ctx.origin);
    const b = await registerAndApproveOffice(ctx.origin);
    const { sid, request_id } = await createReadyRequest(ctx.origin);

    const quoteA = await fetch(`${ctx.origin}/api/officer/request/${request_id}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ quoted_fee_omr: 4.5 })
    });
    assert.equal(quoteA.status, 201, 'A quotes');
    const quoteB = await fetch(`${ctx.origin}/api/officer/request/${request_id}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.cookie },
      body: JSON.stringify({ quoted_fee_omr: 5.0 })
    });
    assert.equal(quoteB.status, 201, 'B quotes');

    // Citizen lists and accepts the cheaper (A).
    // Under anonymity, the /offers endpoint no longer returns office identity
    // (no office_id, name, or rating). We verify "A wins" by price + ordering:
    // A quoted 4.5, B quoted 5.0; the cheaper offer must be on top.
    const list = await fetchJSON(ctx.origin, `/api/chat/${sid}/request/${request_id}/offers`);
    assert.equal(list.status, 200);
    assert.equal(list.body.offers.length, 2);
    const cheapest = list.body.offers[0]; // sorted asc in endpoint
    assert.equal(cheapest.quoted_fee_omr, 4.5, 'cheapest offer at top should be A (4.5 OMR)');

    const accept = await fetch(
      `${ctx.origin}/api/chat/${sid}/request/${request_id}/offers/${cheapest.id}/accept`,
      { method: 'POST' }
    );
    assert.equal(accept.status, 200);

    // Second accept on same offer → 409 not_pending
    const dup = await fetch(
      `${ctx.origin}/api/chat/${sid}/request/${request_id}/offers/${cheapest.id}/accept`,
      { method: 'POST' }
    );
    assert.equal(dup.status, 409, 'double-accept must fail');

    // A now sees full detail; B gets 403.
    const asA = await fetch(`${ctx.origin}/api/officer/request/${request_id}`, { headers: { cookie: a.cookie } });
    assert.equal(asA.status, 200);
    const asAJ = await asA.json();
    assert.ok(asAJ.messages, 'winner sees messages');
    // Product rule: even after winning, the office never sees the citizen's
    // phone or the session_id used by the citizen.
    assert.ok(!('citizen_phone' in asAJ.request), 'winner must NOT see citizen_phone');
    assert.ok(!('session_id'    in asAJ.request), 'winner must NOT see session_id');

    const asB = await fetch(`${ctx.origin}/api/officer/request/${request_id}`, { headers: { cookie: b.cookie } });
    assert.equal(asB.status, 403, 'loser is locked out after award');
  });

  test('winning officer can message citizen and then mark complete', async () => {
    const a = await registerAndApproveOffice(ctx.origin);
    const { sid, request_id } = await createReadyRequest(ctx.origin);

    // Submit + self-accept (single-office acceptance path).
    await fetch(`${ctx.origin}/api/officer/request/${request_id}/offer`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ quoted_fee_omr: 3.0 })
    });
    const list = await fetchJSON(ctx.origin, `/api/chat/${sid}/request/${request_id}/offers`);
    const offerId = list.body.offers[0].id;
    await fetch(`${ctx.origin}/api/chat/${sid}/request/${request_id}/offers/${offerId}/accept`,
      { method: 'POST' });

    // Chat is gated behind payment under the v3 flow. Office sends the
    // payment link first; we then mark the request paid via the stub endpoint.
    await fetch(`${ctx.origin}/api/officer/request/${request_id}/payment/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({})
    });
    await fetch(`${ctx.origin}/api/payments/request/${request_id}/confirm-stub`, {
      method: 'POST', headers: { cookie: a.cookie }
    });

    // Send a chat message — citizen should see it via the session poll.
    const send = await fetch(`${ctx.origin}/api/officer/request/${request_id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: a.cookie },
      body: JSON.stringify({ text: 'Hello, starting now' })
    });
    assert.equal(send.status, 200);
    const poll = await fetchJSON(ctx.origin, `/api/chat/${sid}/poll?after=0`);
    assert.ok(poll.body.messages.some(m => m.actor_type === 'officer' && m.body_text === 'Hello, starting now'));

    // Complete.
    const done = await fetch(`${ctx.origin}/api/officer/request/${request_id}/complete`, {
      method: 'POST', headers: { cookie: a.cookie }
    });
    assert.equal(done.status, 200);
    const { body } = await fetchJSON(ctx.origin, '/api/debug/state');
    const row = body.latestRequests.find(x => x.id === request_id);
    assert.equal(row?.status, 'completed');
  });
});

describe('HTTP · catalogue API', () => {
  test('GET /api/catalogue/search?q=passport returns results', async () => {
    const { body } = await fetchJSON(ctx.origin, '/api/catalogue/search?q=passport&limit=3');
    assert.ok(Array.isArray(body.results));
  });
  test('GET /api/catalogue/entities returns list', async () => {
    const { body } = await fetchJSON(ctx.origin, '/api/catalogue/entities');
    assert.ok(Array.isArray(body.entities));
  });
});
