// Typed-value document fields over chat/WhatsApp.
//
// Regression — prod report (+96892888715, "خدمة تحديث رقم الهاتف"): a service
// whose required item is a TYPED value (the new phone number) could never be
// submitted. The LLM acknowledged the value ("✅ تم حفظ الرقم") without recording
// it, so the slot never filled, the state never reached 'reviewing', and
// submit_request never created a request — yet the bot said "sent to the office."
// The deterministic typed-value capture (runs before the LLM) fixes this.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv } from './helpers.js';
import { typedDocKind, typedValueValid, captureTypedDocValue, runTurn, saveSession, loadSession } from '../lib/agent.js';

test('typedDocKind detects value fields by label or type', () => {
  assert.equal(typedDocKind({ label_ar: 'الرقم الجديد', type: 'file' }), 'number');
  assert.equal(typedDocKind({ label_ar: 'ايميل/بريد إلكتروني ساري المفعول', type: 'file' }), 'email');
  assert.equal(typedDocKind({ label_ar: 'صورة من البطاقة الشخصية او بطاقة الإقامة', type: 'file' }), null);
  assert.equal(typedDocKind({ type: 'email' }), 'email');
  assert.equal(typedDocKind({ type: 'number' }), 'number');
});

test('typedValueValid validates by kind', () => {
  assert.equal(typedValueValid('number', '99887766'), true);
  assert.equal(typedValueValid('number', '+968 9200 1990'), true);
  assert.equal(typedValueValid('number', 'مرحبا كيف الحال'), false);
  assert.equal(typedValueValid('email', 'demo@saned.ai'), true);
  assert.equal(typedValueValid('email', 'demo@saned'), false);
});

test('a typed value is captured during collection → state reaches reviewing', async () => {
  await bootTestEnv();
  const sid = 'web-typed-capture';
  const state = {
    status: 'collecting', service_id: 1,
    docs: [{ code: 'new_number', label_ar: 'الرقم الجديد', label_en: 'New number', type: 'file' }],
    collected: {}, pending_doc_index: 0
  };
  const res = await captureTypedDocValue({ session_id: sid, state, raw: '99887766', trace: [] });
  assert.ok(res, 'a plausible typed value must be captured');
  assert.equal(res.state.status, 'reviewing');
  assert.equal(res.state.collected.new_number.caption, '99887766');
  assert.equal(res.state.collected.new_number.matched_via, 'typed');
  assert.match(res.reply, /تم الحفظ/);
});

test('a question (not a value) is NOT captured — falls through to the LLM', async () => {
  await bootTestEnv();
  const state = {
    status: 'collecting', service_id: 1,
    docs: [{ code: 'new_number', label_ar: 'الرقم الجديد', type: 'file' }],
    collected: {}, pending_doc_index: 0
  };
  const res = await captureTypedDocValue({ session_id: 'web-typed-q', state, raw: 'كم تكلفة الخدمة؟', trace: [] });
  assert.equal(res, null, 'a question must not be mistaken for the value');
});

test('full flow: typed value → submit creates a READY request carrying the value', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  const svcId = 90001;
  await db.execute({
    sql: `INSERT INTO service_catalog(id,name_ar,name_en,is_active,fee_omr,required_documents_json)
          VALUES (?,?,?,1,NULL,?)`,
    args: [svcId, 'خدمة تحديث رقم الهاتف', 'Phone number update',
           JSON.stringify([{ code: 'new_number', label_ar: 'الرقم الجديد', label_en: 'New number', type: 'file' }])]
  });
  const sid = 'web-typed-flow';
  await loadSession(sid); // create the session row first (saveSession is UPDATE-only)
  await saveSession(sid, {
    status: 'collecting', service_id: svcId,
    docs: [{ code: 'new_number', label_ar: 'الرقم الجديد', label_en: 'New number', type: 'file' }],
    collected: {}, pending_doc_index: 0
  });

  // 1) Citizen types the value → recorded; state advances to reviewing.
  const r1 = await runTurn({ session_id: sid, user_text: '99887766', citizen_phone: '+96890000888' });
  assert.match(r1.reply, /تم الحفظ/);
  assert.equal(r1.state.status, 'reviewing');

  // 2) Citizen confirms → deterministic submit creates the request (no LLM).
  const r2 = await runTurn({ session_id: sid, user_text: 'أرسل', citizen_phone: '+96890000888' });
  const reqId = r2.request_id || r2.state?.request_id;
  assert.ok(reqId, 'a request row must be created on submit');
  const { rows: reqRows } = await db.execute({ sql: 'SELECT status FROM request WHERE id=?', args: [reqId] });
  assert.equal(reqRows[0].status, 'ready', 'the request reaches the office (status=ready)');
  const { rows: docRows } = await db.execute({
    sql: "SELECT caption FROM request_document WHERE request_id=? AND doc_code='new_number'", args: [reqId]
  });
  assert.equal(docRows[0]?.caption, '99887766', 'the typed value is filed on the request');
});
