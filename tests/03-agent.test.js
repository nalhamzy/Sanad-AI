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

describe('runTurn() — burst messages (per-session serialization)', () => {
  test('three concurrent turns on same session do not clobber state', async () => {
    const s = sid();
    // Fire 3 turns at once. Without the per-session lock, turns 2 & 3 would
    // load the same (pre-turn-1) state, and the last writer would clobber the
    // service_code set by turn 1. With the lock, they run in order.
    const results = await Promise.all([
      runTurn({ session_id: s, user_text: 'renew driving licence' }),
      runTurn({ session_id: s, user_text: 'yes' }),
      runTurn({ session_id: s, user_text: 'cancel' })
    ]);
    // All three must have resolved.
    assert.equal(results.length, 3);
    // Each turn sees state consistent with the one before it (status only
    // moves forward in the expected order: idle → confirming → collecting → idle).
    const statuses = results.map(r => r.state.status);
    // Final turn was "cancel" so we must land on idle.
    assert.equal(statuses[2], 'idle', `final status should be idle, got ${statuses[2]}`);
    // Messages logged: 3 citizen inputs + >=3 bot replies, and never in/in/in then out/out/out.
    const { rows } = await db.execute({
      sql: `SELECT direction, actor_type FROM message WHERE session_id=? ORDER BY id ASC`,
      args: [s]
    });
    // Check the in/out pattern alternates (no block of 3 ins in a row).
    let inStreak = 0;
    for (const m of rows) {
      if (m.direction === 'in') inStreak++; else inStreak = 0;
      assert.ok(inStreak <= 1, `found ${inStreak} citizen inputs in a row — mutex broken`);
    }
  });

  test('two start_submission bursts do not create two request rows', async () => {
    const s = sid();
    // Land in confirming first.
    await runTurn({ session_id: s, user_text: 'renew driving licence' });
    await runTurn({ session_id: s, user_text: 'yes' });
    // Upload 3 docs.
    for (let i = 0; i < 3; i++) {
      await runTurn({
        session_id: s, user_text: '',
        attachment: { url: `/u/burst${i}.jpg`, mime: 'image/jpeg', size: 64 }
      });
    }
    // Now fire "confirm" 3x in parallel. Only ONE request row should exist.
    await Promise.all([
      runTurn({ session_id: s, user_text: 'confirm', citizen_phone: '+96891111111' }),
      runTurn({ session_id: s, user_text: 'confirm', citizen_phone: '+96891111111' }),
      runTurn({ session_id: s, user_text: 'confirm', citizen_phone: '+96891111111' })
    ]);
    const { rows } = await db.execute({
      sql: `SELECT id FROM request WHERE session_id=?`, args: [s]
    });
    assert.equal(rows.length, 1, `expected exactly 1 request, got ${rows.length}`);
  });
});

describe('request_document — storage_url persistence', () => {
  test('uploaded attachments write storage_url/mime/size_bytes to request_document', async () => {
    const s = sid();
    await runTurn({ session_id: s, user_text: 'renew driving licence' });
    await runTurn({ session_id: s, user_text: 'yes' });
    const files = [
      { url: `/uploads/${s}/civil.jpg`,  mime: 'image/jpeg',       size: 4096 },
      { url: `/uploads/${s}/medical.pdf`, mime: 'application/pdf', size: 8192 },
      { url: `/uploads/${s}/photo.png`,  mime: 'image/png',        size: 2048 }
    ];
    for (const att of files) {
      await runTurn({ session_id: s, user_text: '', attachment: att });
    }
    const out = await runTurn({ session_id: s, user_text: 'confirm', citizen_phone: '+96890000003' });
    const { rows: docs } = await db.execute({
      sql: `SELECT doc_code, storage_url, mime, size_bytes FROM request_document WHERE request_id=? ORDER BY id ASC`,
      args: [out.request_id]
    });
    assert.equal(docs.length, 3);
    for (const d of docs) {
      assert.ok(d.storage_url, `doc ${d.doc_code} must have storage_url, got ${d.storage_url}`);
      assert.ok(d.mime, `doc ${d.doc_code} must have mime`);
      assert.ok(d.size_bytes > 0, `doc ${d.doc_code} must have size_bytes`);
      assert.ok(d.storage_url.startsWith('/uploads/'), `URL must live under /uploads/: ${d.storage_url}`);
    }
  });
});
