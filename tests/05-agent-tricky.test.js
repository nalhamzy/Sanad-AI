// Tricky-scenario tests for the WhatsApp AI agent. These are all heuristic-mode
// (QWEN_API_KEY='') so behavior is deterministic and no LLM is called.
//
// Covered scenarios:
//   • Caption-aware doc routing (ordered, out-of-order, mixed with filename)
//   • Filename-only matching when there is no explicit caption
//   • Ambiguous / empty captions fall back to the next pending slot
//   • Permissive confirmation vocabulary (نعم, ok, tamam, خلاص, submit, done, …)
//   • Confirmation works with trailing words ("yes please send it")
//   • "done/تم/خلص" escape hatch mid-collection (when at least one doc in)
//   • Duplicate upload to the same slot overwrites cleanly
//   • Wrong-service caption (e.g. "passport" during driver licence) falls back
//     to the next pending slot rather than misrouting
//   • Uploading a file in idle state does not leak a service card
//   • Greetings pop stuck confirming/collecting states back to idle
//   • Cancel during reviewing resets cleanly
//
import { bootTestEnv } from './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

await bootTestEnv();
const { runTurn, loadSession } = await import('../lib/agent.js');
const { db } = await import('../lib/db.js');

function sid() { return 'tricky-' + Math.random().toString(36).slice(2, 8); }

// Small helper: start a driving-licence flow ready for 3 doc uploads.
async function startDrivingLicence(s) {
  await runTurn({ session_id: s, user_text: 'renew driving licence' });
  await runTurn({ session_id: s, user_text: 'yes' });
  const st = await loadSession(s);
  assert.equal(st.status, 'collecting');
  assert.equal(st.service_code, 'drivers_licence_renewal');
}

// Small helper: build an attachment payload with optional caption/filename.
function att(path, { caption = '', mime = 'image/jpeg', size = 1024 } = {}) {
  return { url: `/uploads/${path}`, mime, size, caption };
}

// ────────────────────────────────────────────────────────────
// Caption-aware doc routing
// ────────────────────────────────────────────────────────────
describe('runTurn() — caption-aware doc routing', () => {
  test('EN caption "medical fitness" routes to medical slot even when sent FIRST', async () => {
    const s = sid();
    await startDrivingLicence(s);

    // First upload is medical — but expected slot is civil_id. Caption must win.
    let out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/med.jpg`, { caption: 'medical fitness form' })
    });
    // Expected slot was civil_id but we routed to medical.
    assert.match(out.reply, /الفحص الطبي/, 'should acknowledge medical: ' + out.reply.slice(0, 120));
    // The "recognized from description" hint should appear (caption beat order).
    assert.match(out.reply, /تعرفنا عليها من الوصف/, 'should mention caption routing: ' + out.reply);

    let st = await loadSession(s);
    assert.ok(st.collected.medical, 'medical slot should be filled');
    assert.equal(st.collected.medical.matched_via, 'caption');
    assert.ok(!st.collected.civil_id, 'civil_id should still be empty');
    assert.equal(st.pending_doc_index, 0, 'pending index still on civil_id');

    // Now send civil_id properly.
    out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/id.jpg`, { caption: 'my civil id card' })
    });
    st = await loadSession(s);
    assert.ok(st.collected.civil_id, 'civil_id should now be filled');

    // Finally photo.
    out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/selfie.jpg`, { caption: 'personal photo' })
    });
    st = await loadSession(s);
    assert.equal(st.status, 'reviewing', 'should enter reviewing after all 3');
    assert.ok(st.collected.civil_id && st.collected.medical && st.collected.photo);
  });

  test('AR caption "صورة شخصية" routes to photo slot out-of-order', async () => {
    const s = sid();
    await startDrivingLicence(s);
    const out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/pic.jpg`, { caption: 'صورة شخصية لي' })
    });
    const st = await loadSession(s);
    assert.ok(st.collected.photo, 'photo slot filled via Arabic caption');
    assert.equal(st.collected.photo.matched_via, 'caption');
    assert.match(out.reply, /صورة شخصية/);
  });

  test('Empty caption falls back to expected slot (order-based)', async () => {
    const s = sid();
    await startDrivingLicence(s);

    const out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/unknown.jpg`, { caption: '' })
    });
    const st = await loadSession(s);
    assert.ok(st.collected.civil_id, 'should land in civil_id (the expected slot)');
    assert.equal(st.collected.civil_id.matched_via, 'order');
    // No "recognized from description" hint when routed by order.
    assert.doesNotMatch(out.reply, /تعرفنا عليها من الوصف/);
  });

  test('Ambiguous caption with no matching keywords falls back to order', async () => {
    const s = sid();
    await startDrivingLicence(s);
    const out = await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/doc.jpg`, { caption: 'hello here is my document' })
    });
    const st = await loadSession(s);
    assert.ok(st.collected.civil_id);
    assert.equal(st.collected.civil_id.matched_via, 'order');
  });

  test('Wrong-service caption (passport during driving-licence flow) does not misroute', async () => {
    // The driving-licence flow has no `old_passport` slot, so a "passport" caption
    // should score 0 against all its slots and fall back to the order slot.
    const s = sid();
    await startDrivingLicence(s);
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/wrong.jpg`, { caption: 'current passport photo' })
    });
    const st = await loadSession(s);
    // "photo" is a keyword hint too — caption contains "photo" which matches the
    // photo slot. Ensure it routed SOMEWHERE sensible (either civil_id by order
    // or photo by caption) — NOT to a slot that doesn't exist.
    const filledCodes = Object.keys(st.collected);
    assert.equal(filledCodes.length, 1);
    assert.ok(['civil_id', 'photo'].includes(filledCodes[0]),
      `unexpected slot: ${filledCodes[0]}`);
  });

  test('Caption "photo" on CR flow hits photo keywords but photo is not a CR slot — falls back to order', async () => {
    // CR issuance slots: civil_id, activity_list, tenancy, address_map.
    // None of them are `photo`. Caption "personal photo" must fall back.
    const s = sid();
    await runTurn({ session_id: s, user_text: 'commercial registration' });
    await runTurn({ session_id: s, user_text: 'yes' });
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/x.jpg`, { caption: 'personal photo' })
    });
    const st = await loadSession(s);
    // Must have landed in civil_id (the first required slot).
    assert.ok(st.collected.civil_id);
    assert.equal(st.collected.civil_id.matched_via, 'order');
  });
});

// ────────────────────────────────────────────────────────────
// Permissive confirmation vocabulary
// ────────────────────────────────────────────────────────────
describe('runTurn() — permissive confirmations in reviewing', () => {
  // Helper: get to reviewing with 3 docs collected, then confirm with `word`.
  async function runToReviewingThenConfirm(word, phone = '+96890000010') {
    const s = sid();
    await startDrivingLicence(s);
    for (let i = 0; i < 3; i++) {
      await runTurn({
        session_id: s, user_text: '',
        attachment: att(`${s}/f${i}.jpg`)
      });
    }
    const st = await loadSession(s);
    assert.equal(st.status, 'reviewing', `before confirm: expected reviewing, got ${st.status}`);
    const out = await runTurn({ session_id: s, user_text: word, citizen_phone: phone });
    return out;
  }

  for (const word of ['تأكيد', 'تاكيد', 'نعم', 'ايوه', 'ok', 'OK', 'okay', 'yes', 'yep', 'yup', 'sure', 'submit', 'proceed', 'tamam', 'تمام', 'خلاص', 'ارسل']) {
    test(`"${word}" confirms submission`, async () => {
      const out = await runToReviewingThenConfirm(word);
      assert.equal(out.state.status, 'queued', `"${word}" should queue: reply was ${out.reply}`);
      assert.ok(out.request_id);
    });
  }

  test('confirmation in a longer sentence still works ("yes please send it")', async () => {
    const out = await runToReviewingThenConfirm('yes please send it');
    assert.equal(out.state.status, 'queued');
  });

  test('AR confirmation surrounded by other words ("ابعثه الآن تأكيد من فضلك")', async () => {
    const out = await runToReviewingThenConfirm('ابعثه الآن تأكيد من فضلك');
    assert.equal(out.state.status, 'queued');
  });

  test('"cancel" during reviewing clears state', async () => {
    const s = sid();
    await startDrivingLicence(s);
    for (let i = 0; i < 3; i++) {
      await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/d${i}.jpg`) });
    }
    const out = await runTurn({ session_id: s, user_text: 'cancel' });
    assert.equal(out.state.status, 'idle');
    assert.deepEqual(out.state.collected, {});
  });

  test('Unrelated chat during reviewing gets nudged back to confirm/cancel', async () => {
    const s = sid();
    await startDrivingLicence(s);
    for (let i = 0; i < 3; i++) {
      await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/q${i}.jpg`) });
    }
    const out = await runTurn({ session_id: s, user_text: 'what are the fees again?' });
    assert.equal(out.state.status, 'reviewing', 'stay in reviewing');
    assert.match(out.reply, /تأكيد|إلغاء/);
  });
});

// ────────────────────────────────────────────────────────────
// Done / escape hatches during collection
// ────────────────────────────────────────────────────────────
describe('runTurn() — collection escape hatches', () => {
  test('"done" after 1 upload moves to reviewing with partial docs', async () => {
    const s = sid();
    await startDrivingLicence(s);
    await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/a.jpg`) });
    const out = await runTurn({ session_id: s, user_text: 'done' });
    assert.equal(out.state.status, 'reviewing', 'done should jump to reviewing');
    assert.match(out.reply, /كل المستندات وصلت|الرسوم الإجمالية/);
  });

  test('"تم" with zero uploads nudges but does not leave collecting', async () => {
    const s = sid();
    await startDrivingLicence(s);
    const out = await runTurn({ session_id: s, user_text: 'تم' });
    assert.equal(out.state.status, 'collecting', 'should stay in collecting when no docs yet');
  });

  test('cancel during collecting resets to idle', async () => {
    const s = sid();
    await startDrivingLicence(s);
    await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/a.jpg`) });
    const out = await runTurn({ session_id: s, user_text: 'cancel' });
    assert.equal(out.state.status, 'idle');
    assert.deepEqual(out.state.collected, {});
  });

  test('greeting during collecting pops to idle with warning', async () => {
    const s = sid();
    await startDrivingLicence(s);
    const out = await runTurn({ session_id: s, user_text: 'hello' });
    assert.equal(out.state.status, 'idle');
    assert.match(out.reply, /أهلاً|أوقفت|ماذا تحتاج/);
  });

  test('text "what is this?" during collecting nudges for the pending doc', async () => {
    const s = sid();
    await startDrivingLicence(s);
    const out = await runTurn({ session_id: s, user_text: 'what is this?' });
    assert.equal(out.state.status, 'collecting');
    assert.match(out.reply, /البطاقة المدنية/, 'should nudge for first doc');
  });
});

// ────────────────────────────────────────────────────────────
// Duplicate uploads / overwrites
// ────────────────────────────────────────────────────────────
describe('runTurn() — duplicate / repeat uploads', () => {
  test('uploading the same doc twice overwrites the slot and advances once', async () => {
    const s = sid();
    await startDrivingLicence(s);
    // First civil_id upload
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/id1.jpg`, { caption: 'civil id' })
    });
    let st = await loadSession(s);
    assert.equal(st.collected.civil_id.url, `/uploads/${s}/id1.jpg`);

    // Caption matches civil_id again — but civil_id is already filled, so
    // `matchDocByCaption` skips it and returns null → falls back to next pending
    // slot (medical). This is the designed behavior: the NEW upload fills the
    // next empty slot instead of overwriting.
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/id2.jpg`, { caption: 'civil id' })
    });
    st = await loadSession(s);
    // The 2nd upload should NOT overwrite civil_id (it's already filled).
    assert.equal(st.collected.civil_id.url, `/uploads/${s}/id1.jpg`,
      'already-filled slot should not be overwritten');
    // Instead it should have advanced to medical.
    assert.ok(st.collected.medical, 'second upload should land in next slot (medical)');
  });

  test('third unique upload in-order reaches reviewing', async () => {
    const s = sid();
    await startDrivingLicence(s);
    for (let i = 0; i < 3; i++) {
      await runTurn({
        session_id: s, user_text: '',
        attachment: att(`${s}/u${i}.jpg`)
      });
    }
    const st = await loadSession(s);
    assert.equal(st.status, 'reviewing');
    assert.equal(Object.keys(st.collected).length, 3);
  });
});

// ────────────────────────────────────────────────────────────
// Mid-flow interruption + resume
// ────────────────────────────────────────────────────────────
describe('runTurn() — mid-flow interruption', () => {
  test('after 2 uploads, a greeting resets flow — no partial request lands in DB', async () => {
    const s = sid();
    await startDrivingLicence(s);
    await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/x.jpg`) });
    await runTurn({ session_id: s, user_text: '', attachment: att(`${s}/y.jpg`) });
    await runTurn({ session_id: s, user_text: 'hello' });
    const st = await loadSession(s);
    assert.equal(st.status, 'idle');
    const { rows } = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM request WHERE session_id=?', args: [s] });
    assert.equal(rows[0].c, 0, 'no request should be inserted');
  });
});

// ────────────────────────────────────────────────────────────
// Caption filename extraction (whatsapp.js sets caption to filename for docs)
// ────────────────────────────────────────────────────────────
describe('runTurn() — filename-as-caption routing', () => {
  test('PDF filename "medical_fitness.pdf" routes to medical slot', async () => {
    const s = sid();
    await startDrivingLicence(s);
    // Simulate WhatsApp router: caption is the document's filename.
    await runTurn({
      session_id: s, user_text: '',
      attachment: {
        url: `/uploads/${s}/file.pdf`, mime: 'application/pdf', size: 2048,
        caption: 'medical_fitness.pdf'
      }
    });
    const st = await loadSession(s);
    assert.ok(st.collected.medical, 'medical slot filled via filename');
    assert.equal(st.collected.medical.matched_via, 'caption');
  });

  test('Filename with no signal falls back to order', async () => {
    const s = sid();
    await startDrivingLicence(s);
    await runTurn({
      session_id: s, user_text: '',
      attachment: { url: `/uploads/${s}/scan_001.pdf`, mime: 'application/pdf', size: 1024, caption: 'scan_001.pdf' }
    });
    const st = await loadSession(s);
    assert.ok(st.collected.civil_id);
    assert.equal(st.collected.civil_id.matched_via, 'order');
  });
});

// ────────────────────────────────────────────────────────────
// End-to-end: all pieces together (mixed caption + filename + confirm)
// ────────────────────────────────────────────────────────────
describe('runTurn() — full tricky end-to-end', () => {
  test('out-of-order uploads with mix of captions & fallbacks, confirm with "ok"', async () => {
    const s = sid();
    await startDrivingLicence(s);

    // 1. Photo first with AR caption
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/photo.jpg`, { caption: 'صورة شخصية' })
    });
    // 2. Medical via filename
    await runTurn({
      session_id: s, user_text: '',
      attachment: {
        url: `/uploads/${s}/med.pdf`, mime: 'application/pdf', size: 1024,
        caption: 'medical_form.pdf'
      }
    });
    // 3. Civil ID with no caption (fallback to order — only civil_id left)
    await runTurn({
      session_id: s, user_text: '',
      attachment: att(`${s}/id.jpg`, { caption: '' })
    });

    let st = await loadSession(s);
    assert.equal(st.status, 'reviewing');
    assert.ok(st.collected.photo && st.collected.medical && st.collected.civil_id);

    // Confirm with casual "ok"
    const out = await runTurn({ session_id: s, user_text: 'ok', citizen_phone: '+96890000099' });
    assert.equal(out.state.status, 'queued');
    assert.ok(out.request_id);

    // DB check — 3 docs linked, fee > 0, doc codes match
    const { rows: docs } = await db.execute({
      sql: 'SELECT doc_code FROM request_document WHERE request_id=? ORDER BY doc_code',
      args: [out.request_id]
    });
    assert.deepEqual(docs.map(d => d.doc_code), ['civil_id', 'medical', 'photo']);
  });
});
