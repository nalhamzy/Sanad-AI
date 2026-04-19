// HTTP integration tests — spins up the real Express app on a random port.
// Covers: page routes, chat POST, officer inbox, atomic claim, double-claim 409.
import { spawnServer, fetchJSON, postChat } from './helpers.js';
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

describe('HTTP · officer API', () => {
  test('GET /api/officer/inbox with x-officer-id returns me + lists', async () => {
    const res = await fetch(ctx.origin + '/api/officer/inbox', { headers: { 'x-officer-id': '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.me.full_name);
    assert.ok(Array.isArray(body.marketplace));
    assert.ok(Array.isArray(body.mine));
  });

  test('atomic claim — first wins, second officer gets 409', async () => {
    // Create a ready request by driving the agent
    const sid = 'claim-' + Math.random().toString(36).slice(2, 8);
    await postChat(ctx.origin, sid, 'renew driving licence');
    await postChat(ctx.origin, sid, 'yes');
    await postChat(ctx.origin, sid, '', { name: 'civil.jpg', mime: 'image/jpeg' });
    await postChat(ctx.origin, sid, '', { name: 'medical.pdf', mime: 'application/pdf' });
    await postChat(ctx.origin, sid, '', { name: 'photo.jpg', mime: 'image/jpeg' });
    const submit = await postChat(ctx.origin, sid, 'confirm');
    const reqId = submit.request_id;
    assert.ok(reqId, 'request must be queued');

    // Officer 1 claims
    const c1 = await fetch(`${ctx.origin}/api/officer/claim/${reqId}`, {
      method: 'POST', headers: { 'x-officer-id': '1' }
    });
    assert.equal(c1.status, 200, 'first claim should 200');

    // Officer 3 (different office) tries — must 409
    const c2 = await fetch(`${ctx.origin}/api/officer/claim/${reqId}`, {
      method: 'POST', headers: { 'x-officer-id': '3' }
    });
    assert.equal(c2.status, 409, 'double-claim must return 409');
  });

  test('officer can send a message to a claimed request', async () => {
    const sid = 'msg-' + Math.random().toString(36).slice(2, 8);
    await postChat(ctx.origin, sid, 'renew driving licence');
    await postChat(ctx.origin, sid, 'yes');
    for (let i = 0; i < 3; i++) await postChat(ctx.origin, sid, '', { name: `d${i}.jpg` });
    const submit = await postChat(ctx.origin, sid, 'confirm');
    const reqId = submit.request_id;

    await fetch(`${ctx.origin}/api/officer/claim/${reqId}`, {
      method: 'POST', headers: { 'x-officer-id': '1' }
    });

    const sendRes = await fetch(`${ctx.origin}/api/officer/request/${reqId}/message`, {
      method: 'POST',
      headers: { 'x-officer-id': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello, starting now' })
    });
    assert.equal(sendRes.status, 200);

    // Citizen polls and receives it
    const poll = await fetchJSON(ctx.origin, `/api/chat/${sid}/poll?after=0`);
    const officerMsg = poll.body.messages.find(m => m.actor_type === 'officer');
    assert.ok(officerMsg, 'officer message should be visible to citizen');
    assert.equal(officerMsg.body_text, 'Hello, starting now');
  });

  test('officer complete transitions request to completed', async () => {
    const sid = 'done-' + Math.random().toString(36).slice(2, 8);
    await postChat(ctx.origin, sid, 'renew driving licence');
    await postChat(ctx.origin, sid, 'yes');
    for (let i = 0; i < 3; i++) await postChat(ctx.origin, sid, '', { name: `d${i}.jpg` });
    const submit = await postChat(ctx.origin, sid, 'confirm');
    const reqId = submit.request_id;

    await fetch(`${ctx.origin}/api/officer/claim/${reqId}`, {
      method: 'POST', headers: { 'x-officer-id': '1' }
    });
    const done = await fetch(`${ctx.origin}/api/officer/request/${reqId}/complete`, {
      method: 'POST', headers: { 'x-officer-id': '1' }
    });
    assert.equal(done.status, 200);

    // Verify via debug state
    const { body } = await fetchJSON(ctx.origin, '/api/debug/state');
    const r = body.latestRequests.find(x => x.id === reqId);
    assert.equal(r?.status, 'completed');
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
