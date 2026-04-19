// State-machine tests for runTurn. Exercises the real agent (heuristic mode
// because QWEN_API_KEY='' in test env) and asserts DB side-effects.
import { bootTestEnv } from './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

await bootTestEnv();
const { runTurn, loadSession } = await import('../lib/agent.js');
const { db } = await import('../lib/db.js');

function sid() { return 'test-' + Math.random().toString(36).slice(2, 8); }

describe('runTurn() — greetings', () => {
  test('"hello" in a fresh session stays idle with a welcome', async () => {
    const s = sid();
    const out = await runTurn({ session_id: s, user_text: 'hello' });
    assert.equal(out.state.status, 'idle');
    assert.ok(/welcome|مرحب|السلام|أهلاً/i.test(out.reply), 'expected a welcome reply');
  });

  test('"مرحبا" same as English', async () => {
    const s = sid();
    const out = await runTurn({ session_id: s, user_text: 'مرحبا' });
    assert.equal(out.state.status, 'idle');
  });

  test('"help" returns capability menu', async () => {
    const s = sid();
    const out = await runTurn({ session_id: s, user_text: 'help' });
    assert.equal(out.state.status, 'idle');
    assert.ok(/search|ask|browse|submit|بحث|سؤال/i.test(out.reply || ''));
  });
});

describe('runTurn() — launch service happy path', () => {
  test('full flow: renew driving licence → 3 docs → submit → queued', async () => {
    const s = sid();

    // 1. Request a launch service
    let out = await runTurn({ session_id: s, user_text: 'renew driving licence' });
    assert.equal(out.state.status, 'confirming', 'should go to confirming state');
    assert.equal(out.state.service_code, 'drivers_licence_renewal');

    // 2. Confirm "yes"
    out = await runTurn({ session_id: s, user_text: 'yes' });
    assert.equal(out.state.status, 'collecting');
    assert.equal(out.state.pending_doc_index, 0);

    // 3. Upload 3 fake documents
    for (let i = 0; i < 3; i++) {
      out = await runTurn({
        session_id: s, user_text: '',
        attachment: { url: `/uploads/${s}/fake${i}.jpg`, mime: 'image/jpeg', size: 1024 }
      });
    }
    assert.equal(out.state.status, 'reviewing',
      `after 3 uploads should be reviewing, was ${out.state.status}`);

    // 4. Confirm submission
    out = await runTurn({ session_id: s, user_text: 'تأكيد', citizen_phone: '+96890000001' });
    assert.equal(out.state.status, 'queued');
    assert.ok(out.request_id, 'should have a request_id');
  });

  test('submitted request lands in DB with all FKs + 3 documents', async () => {
    const s = sid();
    await runTurn({ session_id: s, user_text: 'renew driving licence' });
    await runTurn({ session_id: s, user_text: 'yes' });
    for (let i = 0; i < 3; i++) {
      await runTurn({ session_id: s, user_text: '', attachment: { url: `/u/${i}.jpg`, mime: 'image/jpeg', size: 256 } });
    }
    const out = await runTurn({ session_id: s, user_text: 'confirm', citizen_phone: '+96890000002' });
    const reqId = out.request_id;
    assert.ok(reqId, 'expected request_id');

    const { rows: [r] } = await db.execute({ sql: 'SELECT * FROM request WHERE id=?', args: [reqId] });
    assert.equal(r.status, 'ready');
    assert.ok(r.fee_omr > 0, 'fee should be populated');
    assert.ok(r.service_id, 'service_id should link to catalogue');
    assert.ok(r.citizen_id, 'citizen_id should be set (phone was provided)');

    const { rows: docs } = await db.execute({ sql: 'SELECT * FROM request_document WHERE request_id=?', args: [reqId] });
    assert.equal(docs.length, 3, 'expected exactly 3 docs');
    const codes = docs.map(d => d.doc_code).sort();
    assert.deepEqual(codes, ['civil_id', 'medical', 'photo']);
  });
});

describe('runTurn() — regression guards (stuck state + dialect)', () => {
  test('greeting pops out of a stuck confirming state', async () => {
    const s = sid();
    await runTurn({ session_id: s, user_text: 'commercial registration' });
    // Confirming state now
    let st = await loadSession(s);
    assert.equal(st.status, 'confirming');
    // Say hi — should go back to idle
    const out = await runTurn({ session_id: s, user_text: 'مرحبا' });
    assert.equal(out.state.status, 'idle');
  });

  test('uploading a file in idle state does not dump a service card', async () => {
    const s = sid();
    const out = await runTurn({
      session_id: s, user_text: '',
      attachment: { url: '/u/random.jpg', mime: 'image/jpeg', size: 128 }
    });
    // Should be a helpful "tell me the service first" or collecting (if context matched)
    assert.ok(out.reply.length > 10);
    assert.ok(
      /(استلمت|received|خدمة|service)/i.test(out.reply),
      'reply should handle the upload gracefully: ' + out.reply.slice(0, 80)
    );
  });
});

describe('runTurn() — cancellation', () => {
  test('"cancel" during collecting resets to idle', async () => {
    const s = sid();
    await runTurn({ session_id: s, user_text: 'renew driving licence' });
    await runTurn({ session_id: s, user_text: 'yes' });
    const out = await runTurn({ session_id: s, user_text: 'cancel' });
    assert.equal(out.state.status, 'idle');
    assert.deepEqual(out.state.collected, {});
  });
});
