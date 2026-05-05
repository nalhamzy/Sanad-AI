// Regression test for the burst-aggregator + in-flight gate.
//
// Bug: when a citizen sent N files in quick succession on WhatsApp, the bot
// replied N times instead of once ("is that the doc for passport?" repeating
// per image). The burst-quiet timer fires after BURST_QUIET_MS of silence
// from the LAST file's handler completion — but under WhatsApp-typical
// per-file processing latency (LLM + vision = 3-5s) the gap between
// successive file COMPLETIONS exceeds the quiet window even while MORE
// files are still queued behind the session lock. drainBurst then flushes
// mid-batch, the next file rearms a fresh window, and the cycle repeats.
//
// Fix: track a per-session in-flight file count. drainBurst checks it before
// flushing — if any files are still being processed, the timer reschedules
// itself a short interval later instead of speaking. Only when the count
// reaches zero does the consolidated reply go out.
//
// This file exercises the burst internals directly via the __testBurst
// export so the test runs in <1s and doesn't need a real LLM.
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Force the burst windows tiny so the test runs in real time without sleeps
// of seconds. Must be set BEFORE importing agent.js so the module-level
// constants pick them up.
process.env.SANAD_BURST_QUIET_MS  = '50';
process.env.SANAD_BURST_RECHECK_MS = '20';

// Boot the test DB before importing agent.js so drainBurst's storeMessage
// call lands on a real `message` table instead of triggering "no such table"
// warnings. The bug under test is purely about timer scheduling — the DB
// just needs to exist.
const { bootTestEnv } = await import('./helpers.js');
await bootTestEnv();

const { __testBurst } = await import('../lib/agent.js');
const { armBurst, drainBurst, bumpInflightFiles, inflightFilesFor,
        pendingBurst, SESSION_BURST, SESSION_INFLIGHT_FILES } = __testBurst;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(() => {
  // Clean state so a previous test file doesn't leak burst entries here.
  SESSION_BURST.clear();
  SESSION_INFLIGHT_FILES.clear();
});
after(() => {
  SESSION_BURST.clear();
  SESSION_INFLIGHT_FILES.clear();
});

describe('lib/agent.js · burst aggregator + in-flight gate', () => {

  test('inflightFilesFor reports zero for an unknown session', () => {
    assert.equal(inflightFilesFor('wa:+nobody-' + Date.now()), 0);
  });

  test('bumpInflightFiles increments + decrements, clamps at zero', () => {
    const sid = 'wa:+test-bump-' + Date.now();
    assert.equal(bumpInflightFiles(sid, +1), 1);
    assert.equal(bumpInflightFiles(sid, +1), 2);
    assert.equal(inflightFilesFor(sid), 2);
    assert.equal(bumpInflightFiles(sid, -1), 1);
    assert.equal(bumpInflightFiles(sid, -1), 0);
    assert.equal(inflightFilesFor(sid), 0,
      'reaching zero should remove the entry');
    // Decrementing past zero is a no-op (defensive — should never happen
    // in practice but mustn't go negative).
    assert.equal(bumpInflightFiles(sid, -1), 0);
  });

  test('drainBurst with no in-flight files flushes immediately', async () => {
    const sid = 'wa:+drain-clean-' + Date.now();
    armBurst(sid, { reply: 'one file ack' });
    assert.ok(pendingBurst(sid), 'burst should be armed');
    // Wait past the quiet window — drain timer fires on its own.
    await sleep(120);
    assert.equal(pendingBurst(sid), null,
      'burst entry should be cleared after the timer drained it');
  });

  test('drainBurst defers while in-flight files are still processing', async () => {
    const sid = 'wa:+drain-defer-' + Date.now();
    // Simulate: 5 files arrive in quick succession; only the first has
    // completed processing so far (armed the burst). The other 4 are still
    // in flight (waiting on the session lock or running their handlers).
    bumpInflightFiles(sid, +5);
    bumpInflightFiles(sid, -1); // file 1 just finished (decrements before armBurst)
    armBurst(sid, { reply: 'file 1 ack' });
    assert.equal(inflightFilesFor(sid), 4, '4 files still pending');

    // Wait past the quiet window. With the FIX in place the timer fires,
    // sees inflight > 0, and reschedules without flushing.
    await sleep(120);
    assert.ok(pendingBurst(sid),
      'burst entry MUST still be present — drain must not have flushed yet');

    // Files 2-4 finish, but file 5 is still running. Flush still deferred.
    bumpInflightFiles(sid, -3);
    await sleep(60);
    assert.ok(pendingBurst(sid),
      'one file still in flight → drain must keep waiting');

    // Last file completes → next recheck tick should drain.
    bumpInflightFiles(sid, -1);
    assert.equal(inflightFilesFor(sid), 0);
    await sleep(80); // > BURST_RECHECK_MS so the next reschedule fires
    assert.equal(pendingBurst(sid), null,
      'with no files in flight the recheck tick should now flush');
  });

  test('armBurst stores quick-reply buttons and surfaces them on drain', async () => {
    // Verifies that handlers can attach `_buttons` to their reply and the
    // burst aggregator carries them through to the drain step (where the
    // drain layer would send them as an interactive WhatsApp message).
    const sid = 'wa:+buttons-' + Date.now();
    const buttons = [
      { id: 'doc:yes',   title: '✓ نعم' },
      { id: 'doc:wrong', title: '🔄 ملف آخر' },
      { id: 'doc:extra', title: '📎 إضافي' }
    ];
    armBurst(sid, { reply: 'is this for civil id?', buttons });
    const cur = pendingBurst(sid);
    assert.ok(cur, 'burst should be armed');
    assert.deepEqual(cur.buttons, buttons,
      'buttons attached at arm time must persist on the burst entry');
    // Drain so we don't leak state into other tests.
    await sleep(120);
    assert.equal(pendingBurst(sid), null, 'drain should clear the entry');
  });

  test('armBurst ignores empty/non-array buttons', () => {
    const sid = 'wa:+buttons-empty-' + Date.now();
    armBurst(sid, { reply: 'plain', buttons: null });
    armBurst(sid, { reply: 'plain', buttons: [] });
    armBurst(sid, { reply: 'plain', buttons: 'not-an-array' });
    const cur = pendingBurst(sid);
    assert.equal(cur.buttons, null, 'no buttons should be set');
  });

  test('drainBurst does NOT re-store the solo handler reply (de-dup)', async () => {
    // Regression: trace from production showed two identical bot rows ~1.8s
    // apart for every solo file (#985 + #986, #992 + #993, #997 stored once
    // by runAgentV2 then again by drainBurst). For n === 1 the handler has
    // already written the reply; drainBurst must only SEND, not re-STORE.
    const sid = 'wa:+dedup-' + Date.now();
    // Pre-store the handler's reply (mimics runAgentV2 behaviour).
    const { db: liveDb } = await import('../lib/db.js');
    await liveDb.execute({
      sql: `INSERT INTO message(session_id, direction, actor_type, body_text)
            VALUES (?, 'out', 'bot', ?)`,
      args: [sid, 'is this for civil id?']
    });
    armBurst(sid, { reply: 'is this for civil id?' });
    await sleep(120); // > BURST_QUIET_MS so drain fires

    const { rows } = await liveDb.execute({
      sql: `SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND actor_type = 'bot'`,
      args: [sid]
    });
    assert.equal(rows[0].n, 1,
      'after a solo-file drain there must be exactly ONE bot row for this session — the handler-stored one');
  });

  test('drainBurst DOES store the synthetic summary for multi-file bursts', async () => {
    // Counterpart to the de-dup test: when n >= 2 the drain text is a NEW
    // synthetic summary that no handler emitted, so it MUST land in the DB.
    const sid = 'wa:+multi-store-' + Date.now();
    armBurst(sid, { reply: 'per-file 1' });
    armBurst(sid, { reply: 'per-file 2' });
    await sleep(120);

    const { db: liveDb } = await import('../lib/db.js');
    const { rows } = await liveDb.execute({
      sql: `SELECT body_text FROM message WHERE session_id = ? AND actor_type = 'bot' ORDER BY id`,
      args: [sid]
    });
    assert.equal(rows.length, 1,
      'multi-file drain stores exactly one summary row (handler replies are suppressed)');
    assert.match(rows[0].body_text, /استلمت 2/,
      'the row body should be the templated multi-file summary, not a per-file reply');
  });

  test('rapid arms within the quiet window collapse to a single drain', async () => {
    // No in-flight pretence — just verify that armBurst's own rearm logic
    // collapses N rapid arms into ONE drain (the original burst behaviour
    // we must NOT regress).
    const sid = 'wa:+rapid-' + Date.now();
    let drainCount = 0;
    // Wrap drainBurst by polling for the entry-cleared transition. We can't
    // directly count internal timer firings without monkey-patching, so we
    // measure the observable effect: ONE clear of the SESSION_BURST entry.
    armBurst(sid, { reply: 'r1' });
    armBurst(sid, { reply: 'r2' });
    armBurst(sid, { reply: 'r3' });
    armBurst(sid, { reply: 'r4' });
    armBurst(sid, { reply: 'r5' });
    const cur = pendingBurst(sid);
    assert.equal(cur.count, 5, 'all 5 arms should accumulate');

    await sleep(120);
    assert.equal(pendingBurst(sid), null, 'single drain after the quiet window');
  });
});
