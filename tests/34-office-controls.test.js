// Office controls over a claimed request:
//   1. chat is OPEN from claim (no longer sealed until payment), but office→
//      citizen free text is sanitized (no phone / URL) to stop off-platform poaching
//   2. the office sets the payment TOTAL (custom amount wins)
//   3. a gov-fee-TBD service REQUIRES an explicit total before the link is sent
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { bootTestEnv, spawnServer, registerAndApproveOffice, fetchJSON } = await import('./helpers.js');
await bootTestEnv();

const { TOOL_IMPL_V2 } = await import('../lib/agent_tools.js');
const { ensureCitizen } = await import('../lib/agent.js');
const { loadApprovedServices } = await import('../scripts/load_approved_services.mjs');
const { db } = await import('../lib/db.js');

describe('office controls — open chat + office-set total', () => {
  let srv, cookie;
  before(async () => {
    srv = await spawnServer();
    ({ cookie } = await registerAndApproveOffice(srv.origin, { governorate: 'Muscat' }));
  });
  after(async () => { await srv.stop(); });

  // Create a service-less (triage) 'ready' request and claim it → status 'claimed', unpaid.
  async function claimedRequest(phone) {
    const r = await TOOL_IMPL_V2.submit_triage(
      { state: { status: 'triage', pending_uploads: [] }, session_id: 'wa:' + phone, citizen_phone: phone, trace: [] },
      { intent_summary: 'طلب اختبار' });
    const claim = await fetchJSON(srv.origin, `/api/officer/request/${r.request_id}/claim`, { method: 'POST', headers: { cookie } });
    assert.equal(claim.status, 200, 'claim ok: ' + JSON.stringify(claim.body));
    return r.request_id;
  }

  test('chat is OPEN pre-payment — office message is accepted (not 403)', async () => {
    const id = await claimedRequest('+96890001001');
    const res = await fetchJSON(srv.origin, `/api/officer/request/${id}/message`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'مرحباً، نحتاج توضيحاً بسيطاً قبل الدفع.' })
    });
    assert.equal(res.status, 200, 'message accepted pre-pay: ' + JSON.stringify(res.body));
  });

  test('office→citizen text is sanitized (phone + URL stripped)', async () => {
    const id = await claimedRequest('+96890001002');
    const res = await fetchJSON(srv.origin, `/api/officer/request/${id}/message`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'كلّمني على 91234567 أو عبر https://wa.me/968123 لو سمحت' })
    });
    assert.equal(res.status, 200);
    const { rows } = await db.execute({
      sql: `SELECT body_text FROM message WHERE request_id=? AND actor_type='officer' ORDER BY id DESC LIMIT 1`,
      args: [id]
    });
    assert.ok(rows[0], 'message stored');
    assert.ok(!/91234567/.test(rows[0].body_text), 'phone number stripped');
    assert.ok(!/wa\.me/.test(rows[0].body_text), 'URL stripped');
  });

  test('office sets the payment total — custom amount wins', async () => {
    const id = await claimedRequest('+96890001003');
    const res = await fetchJSON(srv.origin, `/api/officer/request/${id}/payment/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amount_omr: 13.5 })
    });
    assert.equal(res.status, 200, 'payment start ok: ' + JSON.stringify(res.body));
    assert.equal(Number(res.body.amount_omr), 13.5, 'custom total used');
  });

  test('gov-fee-TBD service requires an explicit total before sending', async () => {
    await loadApprovedServices({ apply: true });
    const { rows: svc } = await db.execute(`SELECT id FROM service_catalog WHERE source_url='approved:renew_worker_residence' LIMIT 1`);
    const serviceId = svc[0].id;
    const phone = '+96890001004';
    const cid = await ensureCitizen({ phone });
    const ins = await db.execute({
      sql: `INSERT INTO request(session_id,citizen_id,service_id,status,governorate) VALUES (?,?,?,'ready','Muscat')`,
      args: ['wa:' + phone, cid, serviceId]
    });
    const reqId = Number(ins.lastInsertRowid);
    const claim = await fetchJSON(srv.origin, `/api/officer/request/${reqId}/claim`, { method: 'POST', headers: { cookie } });
    assert.equal(claim.status, 200, 'claim ok: ' + JSON.stringify(claim.body));

    // No amount → blocked.
    const noAmt = await fetchJSON(srv.origin, `/api/officer/request/${reqId}/payment/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({})
    });
    assert.equal(noAmt.status, 400, 'blocked without amount');
    assert.equal(noAmt.body.error, 'amount_required');

    // With amount → ok.
    const withAmt = await fetchJSON(srv.origin, `/api/officer/request/${reqId}/payment/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ amount_omr: 13 })
    });
    assert.equal(withAmt.status, 200, 'ok with amount: ' + JSON.stringify(withAmt.body));
    assert.equal(Number(withAmt.body.amount_omr), 13);
  });
});
