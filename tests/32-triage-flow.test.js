// Triage / "unsure which service" intake flow.
//
// Some citizens don't know the exact government service they need. Instead of
// forcing a guess, the agent lets them describe their need in free text (via
// the 🤔 button, a typed "لست متأكد", or the LLM auto-detecting uncertainty).
// submit_triage then dispatches a SERVICE-LESS request (service_id=NULL) to the
// marketplace carrying an intent_summary + any optional papers. The claiming
// office reads the summary, sets the correct service via reclassify, and
// continues the normal flow.
//
// This file covers:
//   1. the button labels exist
//   2. submit_triage creates a service-less request + attaches optional papers
//   3. the deterministic triage intake (describe → submit) via runTurn
//   4. an office can CLAIM a triage request and RECLASSIFY it to a real service
//      (the "office sets the right service" requirement)
import './helpers.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const { bootTestEnv, spawnServer, registerAndApproveOffice, fetchJSON } = await import('./helpers.js');
await bootTestEnv();

const { TOOL_IMPL_V2 } = await import('../lib/agent_tools.js');
const { runTurn, loadSession, saveSession } = await import('../lib/agent.js');
const { BUTTON_LABELS } = await import('../lib/buttons.js');
const { db } = await import('../lib/db.js');

describe('lib/agent · triage / unsure-service intake', () => {

  test('BUTTON_LABELS exposes the triage buttons', () => {
    assert.ok(BUTTON_LABELS['discover:unsure'], 'discover:unsure label missing');
    assert.ok(BUTTON_LABELS['triage:submit'], 'triage:submit label missing');
  });

  test('submit_triage creates a service-less request with intent_summary + optional papers', async () => {
    const session_id = 'wa:+96890000101';
    const state = {
      status: 'triage', intent_summary: '',
      pending_uploads: [
        { url: '/uploads/triage-a.jpg', mime: 'image/jpeg', name: 'a.jpg', caption: 'بطاقتي' }
      ]
    };
    const summary = 'أحتاج إنجاز معاملة تخص سيارتي لكنني لست متأكداً من الخدمة الصحيحة';
    const r = await TOOL_IMPL_V2.submit_triage(
      { state, session_id, citizen_phone: '+96890000101', trace: [] },
      { intent_summary: summary }
    );
    assert.equal(r.ok, true);
    assert.equal(r.triage, true);
    assert.equal(r.attachments_filed, 1);
    assert.ok(r.request_id);

    const { rows } = await db.execute({ sql: 'SELECT * FROM request WHERE id=?', args: [r.request_id] });
    const req = rows[0];
    assert.equal(req.service_id, null, 'triage request must have NO service');
    assert.equal(req.status, 'ready', 'triage request must land in the marketplace');
    assert.match(req.intent_summary, /سيارتي/);

    // The optional paper rode along as a supplementary (is_extra) doc.
    const { rows: docs } = await db.execute({
      sql: 'SELECT * FROM request_document WHERE request_id=?', args: [r.request_id]
    });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].is_extra, 1);

    // State advanced + buffer drained.
    assert.equal(state.status, 'queued');
    assert.equal(state.request_id, r.request_id);
    assert.deepEqual(state.pending_uploads, []);
  });

  test('submit_triage refuses an empty summary', async () => {
    const r = await TOOL_IMPL_V2.submit_triage(
      { state: { status: 'triage' }, session_id: 'wa:+96890000102', citizen_phone: '+96890000102', trace: [] },
      { intent_summary: '   ' }
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_summary');
  });

  test('deterministic triage intake via runTurn: describe (accumulates) → submit', async () => {
    const session_id = 'wa:+96890000103';
    await loadSession(session_id); // create the session row so saveSession (UPDATE-only) persists
    await saveSession(session_id, { status: 'triage', intent_summary: '', pending_uploads: [] });

    // First description turn — accumulates into intent_summary, stays in triage.
    await runTurn({ session_id, user_text: 'عندي معاملة تخص إقامتي', citizen_phone: '+96890000103' });
    let st = await loadSession(session_id);
    assert.equal(st.status, 'triage');
    assert.match(st.intent_summary, /إقامتي/);

    // Second turn appends more detail.
    await runTurn({ session_id, user_text: 'ولا أعرف هل هي تجديد أم تعديل', citizen_phone: '+96890000103' });
    st = await loadSession(session_id);
    assert.match(st.intent_summary, /إقامتي/);
    assert.match(st.intent_summary, /تجديد/);

    // Submit via the button — the __btn__ tap is mapped to a submit signal.
    await runTurn({ session_id, user_text: '__btn__:triage:submit', citizen_phone: '+96890000103' });
    st = await loadSession(session_id);
    assert.equal(st.status, 'queued');
    assert.ok(st.request_id);

    const { rows } = await db.execute({ sql: 'SELECT * FROM request WHERE id=?', args: [st.request_id] });
    assert.equal(rows[0].service_id, null);
    assert.match(rows[0].intent_summary, /إقامتي/);
  });

  test('triage intake can be abandoned with "إلغاء"', async () => {
    const session_id = 'wa:+96890000104';
    await loadSession(session_id); // create the session row so saveSession (UPDATE-only) persists
    await saveSession(session_id, { status: 'triage', intent_summary: 'شيء ما', pending_uploads: [] });
    await runTurn({ session_id, user_text: 'إلغاء', citizen_phone: '+96890000104' });
    const st = await loadSession(session_id);
    assert.equal(st.status, 'idle');
  });

  describe('office sets the service on a triage request', () => {
    let srv, cookie, serviceId;
    before(async () => {
      srv = await spawnServer();
      ({ cookie } = await registerAndApproveOffice(srv.origin, { governorate: 'Muscat' }));
      const { rows } = await db.execute({ sql: 'SELECT id FROM service_catalog LIMIT 1' });
      serviceId = rows[0].id;
    });

    test('claim + reclassify a triage request to a real service', async () => {
      // Citizen dispatches an unsure request.
      const r = await TOOL_IMPL_V2.submit_triage(
        { state: { status: 'triage', pending_uploads: [] }, session_id: 'wa:+96890000105', citizen_phone: '+96890000105', trace: [] },
        { intent_summary: 'لست متأكداً من الخدمة — أحتاج وثيقة حكومية' }
      );
      const id = r.request_id;

      // Office claims it (works despite NULL service — fees COALESCE to defaults).
      const claim = await fetchJSON(srv.origin, `/api/officer/request/${id}/claim`, {
        method: 'POST', headers: { cookie }
      });
      assert.equal(claim.status, 200, 'claim should succeed: ' + JSON.stringify(claim.body));

      // Office sets the correct service via reclassify.
      const recl = await fetchJSON(srv.origin, `/api/officer/request/${id}/reclassify`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ new_service_id: serviceId, reason: 'حُدّدت الخدمة بعد مراجعة طلب المواطن' })
      });
      assert.equal(recl.status, 200, 'reclassify should succeed: ' + JSON.stringify(recl.body));

      // The request now carries the proposed service awaiting citizen ack.
      const { rows } = await db.execute({ sql: 'SELECT status, pending_service_id FROM request WHERE id=?', args: [id] });
      assert.equal(rows[0].pending_service_id, serviceId);
      assert.equal(rows[0].status, 'awaiting_reclassify_ack');
    });

    test('reclassify onto an INACTIVE service activates it immediately', async () => {
      // Seed a deactivated (not-yet-verified) catalogue row.
      const ins = await db.execute({
        sql: `INSERT INTO service_catalog (entity_en, entity_ar, name_en, name_ar, fee_omr, is_active, version)
              VALUES ('Test Entity','جهة اختبار','Inactive Test Svc','خدمة اختبار غير مفعّلة', 3, 0, 1)`,
        args: []
      });
      const inactiveId = Number(ins.lastInsertRowid);
      let chk = await db.execute({ sql: 'SELECT is_active FROM service_catalog WHERE id=?', args: [inactiveId] });
      assert.equal(Number(chk.rows[0].is_active), 0, 'precondition: service starts inactive');

      // Citizen triage → office claim → reclassify ONTO the inactive service.
      const r = await TOOL_IMPL_V2.submit_triage(
        { state: { status: 'triage', pending_uploads: [] }, session_id: 'wa:+96890000106', citizen_phone: '+96890000106', trace: [] },
        { intent_summary: 'أحتاج خدمة غير مُدرجة بعد' }
      );
      const id = r.request_id;
      const claim = await fetchJSON(srv.origin, `/api/officer/request/${id}/claim`, { method: 'POST', headers: { cookie } });
      assert.equal(claim.status, 200, 'claim: ' + JSON.stringify(claim.body));
      const recl = await fetchJSON(srv.origin, `/api/officer/request/${id}/reclassify`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ new_service_id: inactiveId, reason: 'الخدمة الصحيحة لهذا الطلب' })
      });
      assert.equal(recl.status, 200, 'reclassify: ' + JSON.stringify(recl.body));

      // The office assigning it is the vetting step → it is now ACTIVE.
      chk = await db.execute({ sql: 'SELECT is_active FROM service_catalog WHERE id=?', args: [inactiveId] });
      assert.equal(Number(chk.rows[0].is_active), 1, 'assigning an inactive service must activate it');

      // …and the activation is audit-logged.
      const aud = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM audit_log WHERE action='service_activated_on_assign' AND target_id=?`,
        args: [inactiveId]
      });
      assert.ok(Number(aud.rows[0].n) >= 1, 'activation should be audit-logged');
    });

    test('request-info has NO pre-pay cap — office communicates freely from claim', async () => {
      const r = await TOOL_IMPL_V2.submit_triage(
        { state: { status: 'triage', pending_uploads: [] }, session_id: 'wa:+96890000107', citizen_phone: '+96890000107', trace: [] },
        { intent_summary: 'أحتاج عدة توضيحات قبل الدفع' }
      );
      const id = r.request_id;
      const claim = await fetchJSON(srv.origin, `/api/officer/request/${id}/claim`, { method: 'POST', headers: { cookie } });
      assert.equal(claim.status, 200, 'claim: ' + JSON.stringify(claim.body));
      // Pre-payment (paid_at NULL): send 4 clarifications — all must succeed
      // (the old 2-message pre-pay cap is gone).
      for (let i = 1; i <= 4; i++) {
        const ri = await fetchJSON(srv.origin, `/api/officer/request/${id}/request-info`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ reason: `توضيح رقم ${i}` })
        });
        assert.equal(ri.status, 200, `request-info #${i} must succeed pre-pay (no cap): ${JSON.stringify(ri.body)}`);
      }
    });

    test('cleanup: stop server', async () => { await srv.stop(); });
  });
});
