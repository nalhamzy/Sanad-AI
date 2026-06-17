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
// Cooldown > quiet so the cooldown test has a clear deferred-drain window
// to assert against. (Production uses 4s cooldown vs 1.2s quiet.)
process.env.SANAD_BURST_COOLDOWN_MS = '300';

// Boot the test DB before importing agent.js so drainBurst's storeMessage
// call lands on a real `message` table instead of triggering "no such table"
// warnings. The bug under test is purely about timer scheduling — the DB
// just needs to exist.
const { bootTestEnv } = await import('./helpers.js');
await bootTestEnv();

const { __testBurst } = await import('../lib/agent.js');
const { armBurst, drainBurst, bumpInflightFiles, inflightFilesFor,
        pendingBurst, SESSION_BURST, SESSION_INFLIGHT_FILES,
        SESSION_LAST_DRAIN_AT,
        parseUploadDescriptions, looksLikeYesNoAsk } = __testBurst;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(() => {
  // Clean state so a previous test file doesn't leak burst entries here.
  SESSION_BURST.clear();
  SESSION_INFLIGHT_FILES.clear();
  SESSION_LAST_DRAIN_AT.clear();
});
after(() => {
  SESSION_BURST.clear();
  SESSION_INFLIGHT_FILES.clear();
  SESSION_LAST_DRAIN_AT.clear();
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

  test('uploading files against a PROPOSED service auto-starts it (no "اختر الخدمة" loop)', async () => {
    // Regression — real prod report (+96892888715, 2026-06-17): the citizen
    // picked a service (confirm card shown → pending_service_id set), then
    // UPLOADED their files instead of tapping «نعم، ابدأ». The buffered files
    // used to re-prompt "اختر الخدمة" with dead-end confirm buttons → loop.
    // Now the upload IS the "yes": drainBurst starts the proposed service and
    // flushes the buffered files into its checklist.
    const { loadSession, saveSession } = await import('../lib/agent.js');
    const { db } = await import('../lib/db.js');
    // Self-sufficient: the test DB isn't seeded with the full catalogue, so
    // insert a service with a 2-doc checklist (getServiceById reads the DB).
    const svcId = 990012; // service_catalog.id is not AUTOINCREMENT — fix it
    await db.execute({
      sql: `INSERT OR REPLACE INTO service_catalog
              (id, name_en, name_ar, entity_en, entity_ar, fee_omr, required_documents_json, is_active)
            VALUES (?, 'Replacement Title Deed', 'إصدار سند ملكية بدل فاقد',
                    'MOHUP', 'وزارة الإسكان', 5, ?, 1)`,
      args: [svcId, JSON.stringify([
        { code: 'civil_id',      label_en: 'Civil ID',      label_ar: 'البطاقة المدنية' },
        { code: 'police_report', label_en: 'Police report', label_ar: 'محضر الشرطة' }
      ])]
    });

    const sid = 'wa:+proposed-' + Date.now();
    await loadSession(sid);            // create the session row (saveSession UPDATEs)
    await saveSession(sid, {
      status: 'confirming',            // card shown, awaiting «نعم»
      pending_service_id: svcId,       // ← the proposed service
      pending_service_name_ar: 'خدمة مقترحة',
      docs: [],                        // not started yet → no checklist
      collected: {},
      pending_uploads: [               // citizen uploaded instead of tapping نعم
        { idx: 0, url: '/uploads/x/a.jpg', name: 'a.jpg', mime: 'image/jpeg' },
        { idx: 1, url: '/uploads/x/b.jpg', name: 'b.jpg', mime: 'image/jpeg' }
      ]
    });

    armBurst(sid, { reply: '' });
    armBurst(sid, { reply: '' });      // 2-file burst
    await sleep(160);                  // > BURST_QUIET_MS → drain fires

    const st = await loadSession(sid);
    assert.ok(['collecting', 'reviewing'].includes(st.status),
      `the proposed service must auto-start when the citizen uploads instead of tapping نعم (got status='${st.status}')`);
    assert.ok((st.docs || []).filter(d => d && d.code).length > 0,
      'the service checklist should now be loaded');
    assert.ok(!st.pending_service_id, 'pending_service_id consumed by the implicit start');
    assert.equal((st.pending_uploads || []).length, 0,
      'buffered uploads flushed into the submission (none left orphaned)');
    const placed = Object.keys(st.collected || {}).length + (st.extras || []).length;
    assert.equal(placed, 2, 'both uploaded files attached to the started service');
  });

  test('drainBurst stores the solo reply itself (centralised storage)', async () => {
    // Updated 2026-05-07: contract changed — handler (runAgentV2) now
    // SKIPS storeMessage for attachment turns; drainBurst is the single
    // store point. Net: ONE bubble per burst on web AND WhatsApp.
    // Trace +96892888715 #1364-#1370 showed 4 bubbles for a 4-file
    // burst on web channel; this contract change fixes that.
    const sid = 'wa:+dedup-' + Date.now();
    const { db: liveDb } = await import('../lib/db.js');
    armBurst(sid, { reply: 'is this for civil id?' });
    await sleep(120); // > BURST_QUIET_MS so drain fires

    const { rows } = await liveDb.execute({
      sql: `SELECT body_text, COUNT(*) AS n FROM message WHERE session_id = ? AND actor_type = 'bot' GROUP BY body_text`,
      args: [sid]
    });
    assert.equal(rows.length, 1,
      'after a solo-file drain there must be exactly ONE bot row — drainBurst is the single store point');
    assert.equal(rows[0].n, 1);
    assert.equal(rows[0].body_text, 'is this for civil id?');
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

  describe('parseUploadDescriptions yes-fallback', () => {
    // Regression: a citizen uploaded a file with no caption then replied
    // "نعم". The old code mapped "yes" to vision_best on every pending file;
    // if vision didn't run (or wasn't confident) the entire branch was
    // skipped and the function fell through to the comma-parse path, which
    // recorded the file as an EXTRA with caption "نعم". Trace bug observed
    // 2026-05-05 on +96892888715 — bot then hallucinated "✅ حفظت Civil ID"
    // even though state.collected was empty. Fix: positional fallback to
    // the next still-empty required slot when vision_best is absent.

    const docs = [
      { code: 'civil_id', label_en: 'Civil ID' },
      { code: 'passport', label_en: 'Passport' },
      { code: 'photo', label_en: 'Personal Photo' }
    ];
    const upload = (idx, vision_best = null) => ({
      idx, url: 'wa://' + idx, name: 'doc' + idx + '.jpg',
      mime: 'image/jpeg', caption: '', vision_best
    });

    test('"نعم" with one file + no vision → records into next pending slot', () => {
      const r = parseUploadDescriptions('نعم', [upload(1)], docs, {});
      assert.equal(r.ok, true);
      assert.equal(r.method, 'yes_positional');
      assert.deepEqual(r.mappings, [{ idx: 1, doc_code: 'civil_id' }]);
      assert.ok(!r.extras || r.extras.length === 0,
        'must NOT route to extras (the original bug)');
    });

    test('"yes" with three files + no vision → fills 3 slots positionally', () => {
      const r = parseUploadDescriptions('yes', [upload(1), upload(2), upload(3)], docs, {});
      assert.equal(r.ok, true);
      assert.equal(r.confidence, 'high');
      assert.deepEqual(r.mappings.map(m => m.doc_code), ['civil_id', 'passport', 'photo']);
    });

    test('"تمام" + vision-best on file 1 → uses vision for file 1, positional for file 2', () => {
      const r = parseUploadDescriptions(
        'تمام',
        [upload(1, 'passport'), upload(2)],
        docs, {}
      );
      assert.equal(r.ok, true);
      assert.deepEqual(r.mappings, [
        { idx: 1, doc_code: 'passport' },     // vision win
        { idx: 2, doc_code: 'civil_id' }      // positional next-empty (passport already consumed)
      ]);
    });

    test('"نعم" when civil_id already collected → starts at next empty slot (passport)', () => {
      const r = parseUploadDescriptions(
        'نعم',
        [upload(1)],
        docs,
        { civil_id: { storage_url: '/uploads/x.jpg' } }
      );
      assert.equal(r.ok, true);
      assert.deepEqual(r.mappings, [{ idx: 1, doc_code: 'passport' }]);
    });

    test('non-yes free text still parses positionally as before (no regression)', () => {
      const r = parseUploadDescriptions(
        'civil id, passport',
        [upload(1), upload(2)],
        docs, {}
      );
      assert.equal(r.ok, true);
      assert.deepEqual(r.mappings.map(m => m.doc_code), ['civil_id', 'passport']);
    });

    // Regression: trace from prod (+96892888715, 13:54 UTC, commit 15a2af2)
    // showed 4 buffered files recorded as EXTRAS with caption "تم" because
    // "تم" wasn't in the yes-fallback regex. Citizen typed "تم" meaning
    // "I'm done", parser treated it as a description, files went to extras.
    test('"تم" with buffered files → records into pending slots (not extras)', () => {
      const r = parseUploadDescriptions('تم', [upload(1), upload(2)], docs, {});
      assert.equal(r.ok, true);
      assert.equal(r.method, 'yes_positional',
        'trigger word "تم" must hit the yes-fallback path, not comma-parse');
      assert.deepEqual(r.mappings.map(m => m.doc_code), ['civil_id', 'passport']);
    });
    test('"خلصت" / "done" / "finished" / "ما عندي" all hit yes-fallback', () => {
      for (const word of ['خلصت', 'انتهيت', 'done', 'finished', 'ما عندي']) {
        const r = parseUploadDescriptions(word, [upload(1)], docs, {});
        assert.equal(r.ok, true, `"${word}" should hit yes-fallback`);
        assert.equal(r.method, 'yes_positional', `"${word}" via yes_positional`);
        assert.deepEqual(r.mappings, [{ idx: 1, doc_code: 'civil_id' }]);
      }
    });
  });

  describe('looksLikeYesNoAsk (generic confirm-button auto-attach trigger)', () => {
    test('matches "اكتب نعم أو لا" / "type yes/no" instructions', () => {
      assert.equal(looksLikeYesNoAsk('اكتب نعم أو لا للاستمرار'), true);
      assert.equal(looksLikeYesNoAsk('اكتب نعم/لا'), true);
      assert.equal(looksLikeYesNoAsk('Type yes / no to confirm.'), true);
      assert.equal(looksLikeYesNoAsk('reply yes or no'), true);
    });
    test('matches Arabic "هل تؤكد؟" style asks', () => {
      assert.equal(looksLikeYesNoAsk('هل تؤكد البدء؟'), true);
      assert.equal(looksLikeYesNoAsk('هل تريد المتابعة؟'), true);
      assert.equal(looksLikeYesNoAsk('هل ترغب في إرسال الطلب؟'), true);
      assert.equal(looksLikeYesNoAsk('هل تكمل أم لا؟'), true);
    });
    test('matches trailing "نتابع؟" / "نُرسل؟" question prompts', () => {
      assert.equal(looksLikeYesNoAsk('الملف اكتمل. نُرسل؟'), true);
      assert.equal(looksLikeYesNoAsk('جاهز. نتابع؟'), true);
      assert.equal(looksLikeYesNoAsk('Submit?'), true);
      assert.equal(looksLikeYesNoAsk('Confirm?'), true);
    });
    test('does NOT match free-form "describe the file" asks', () => {
      assert.equal(looksLikeYesNoAsk('وضّح ما يحتوي هذا الملف.'), false);
      assert.equal(looksLikeYesNoAsk('اكتب اسم الخدمة التي تريدها.'), false);
      assert.equal(looksLikeYesNoAsk('Tell me what each file contains.'), false);
    });
    test('does NOT match plain statements / acks', () => {
      assert.equal(looksLikeYesNoAsk('✅ حفظت الملف.'), false);
      assert.equal(looksLikeYesNoAsk('📥 استلمت 3 ملفات.'), false);
      assert.equal(looksLikeYesNoAsk(''), false);
      assert.equal(looksLikeYesNoAsk(null), false);
    });
  });

  // Regression for the fetchMedia race that produced the doubled-message
  // bug (trace +96892888715 #1231/#1233): file 1 finished runTurn and
  // dropped inflight to 0 WHILE file 2 was still inside fetchMedia (which
  // runs in routes/whatsapp.js, BEFORE runTurn bumps inflight). The
  // burst-quiet timer fired in that gap, draining file 1 alone.
  // Fix: routes/whatsapp.js holds an inflight bump from BEFORE fetchMedia
  // through AFTER runTurn (via trackInflightMedia). This test simulates
  // the exact scenario.
  test('inflight gate covers route-side fetch span — no double drain on overlapping fetches', async () => {
    const sid = 'wa:+fetchrace-' + Date.now();
    const { trackInflightMedia } = await import('../lib/agent.js');

    // Simulate file 1's webhook: route bumps before fetchMedia.
    trackInflightMedia(sid, +1);                 // route: file 1 fetch starts
    // ... fetchMedia for file 1 finishes, runTurn runs, armBurst …
    armBurst(sid, { reply: 'file 1 ack' });
    // ... runTurn returns, route's finally decrements (file 1 done end-to-end).
    trackInflightMedia(sid, -1);                 // route: file 1 fully done

    // INSTANT: file 2's webhook arrives. Route bumps BEFORE fetchMedia
    // even though we haven't actually called runTurn yet — this is the
    // protection. Old code wouldn't bump until INSIDE runTurn (much later).
    trackInflightMedia(sid, +1);                 // route: file 2 fetch starts

    // Wait past the quiet window. Old code: inflight=0 here because file
    // 2's runTurn hasn't yet bumped — drain would flush file 1 alone.
    // New code: inflight=1 (held by route) — drain defers.
    await sleep(120); // > BURST_QUIET_MS=50
    assert.equal(inflightFilesFor(sid), 1,
      'route-side bump must keep inflight > 0 across the fetch window');
    assert.ok(pendingBurst(sid),
      'burst entry MUST still be present — drain must not have flushed');

    // File 2's runTurn finally fires armBurst (merging into burst).
    armBurst(sid, { reply: 'file 2 ack' });
    // Route's finally decrements after runTurn returns.
    trackInflightMedia(sid, -1);
    assert.equal(inflightFilesFor(sid), 0);

    // Wait past quiet + cooldown so drain can fire.
    await sleep(450);
    assert.equal(pendingBurst(sid), null,
      'with both fetches done, the merged burst drains as ONE message');
  });

  // Regression for prod trace +96892888715 #1231 + #1233 (2026-05-06):
  // citizen sent file 1, bot acked at +1.2s; citizen sent file 2 three
  // seconds later → bot acked AGAIN as a separate n=1 burst. The fix is
  // a per-session post-drain cooldown so a late-arriving file's drain
  // is deferred to coalesce with whatever else lands in the cooldown
  // window (or just delays the second ack so it merges with file 3).
  test('post-drain cooldown defers the next drain to coalesce stragglers', async () => {
    const sid = 'wa:+cooldown-' + Date.now();
    SESSION_LAST_DRAIN_AT.delete(sid);
    armBurst(sid, { reply: 'file 1 ack' });
    await sleep(120); // > BURST_QUIET_MS=50, drain fires + stamps last_drain_at
    assert.equal(pendingBurst(sid), null, 'first burst drained');
    assert.ok(SESSION_LAST_DRAIN_AT.get(sid), 'last_drain_at stamped');

    // Immediately arm a SECOND burst. With cooldown=300ms in tests + a
    // first drain at ~t=50, the cooldown ends at ~t=350. Second arm at
    // t=120 (right after assertion 1) → its natural drain at t=170 hits
    // the cooldown gate and defers until t=350.
    armBurst(sid, { reply: 'file 2 ack' });
    await sleep(80); // t≈200, well past natural drain (170) but still in cooldown
    assert.ok(pendingBurst(sid),
      'cooldown must defer the second drain — burst entry still present');

    // Wait past the cooldown end.
    await sleep(250); // t≈450, cooldown (350) cleared, drain fires
    assert.equal(pendingBurst(sid), null,
      'after cooldown elapses, the second drain fires');
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
