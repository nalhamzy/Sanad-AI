// Unit tests for attachContextualButtons + looksLikeYesNoAsk additions.
//
// These helpers are pure — they don't touch the DB — so we skip the test
// DB boot. Only the in-memory `__testBurst` exports are used.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { __testBurst } = await import('../lib/agent.js');
const { attachContextualButtons, looksLikeYesNoAsk,
        replyExpectsFreeText, isWarningReply } = __testBurst;

describe('lib/agent.js · attachContextualButtons', () => {

  const baseDocs = [
    { code: 'civil_id', label_ar: 'البطاقة المدنية', label_en: 'Civil ID' },
    { code: 'passport', label_ar: 'جواز السفر', label_en: 'Passport' }
  ];

  test('returns null on empty reply', () => {
    const r = attachContextualButtons({
      state: { status: 'collecting', docs: baseDocs, collected: {} },
      finalReply: '',
      trace: []
    });
    assert.equal(r, null);
  });

  test('CASE 1 — file just buffered → 2-button confirm set (no داعم/extra)', () => {
    // Updated 2026-05-06 per user spec: drop the إضافي/داعم button from
    // the ambiguous-doc menu; citizen confirms slot or asks for re-route.
    const trace = [];
    const r = attachContextualButtons({
      state: { status: 'collecting', docs: baseDocs, collected: {} },
      finalReply: 'is this for civil id?',
      justBufferedThisFile: true,
      trace
    });
    assert.ok(r);
    assert.equal(r.length, 2);
    assert.equal(r[0].id, 'doc:yes');
    assert.equal(r[1].id, 'doc:wrong');
    // Title cap
    for (const b of r) assert.ok(b.title.length <= 20, `title "${b.title}" too long`);
    assert.match(trace[0].case, /buffered_no_caption|ambiguous_doc/);
  });

  test('CASE 2 — collecting + just recorded + slots remaining → nav buttons', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: {
        status: 'collecting',
        docs: baseDocs,
        collected: { civil_id: { url: '/u/x.pdf' } }
      },
      finalReply: '✅ استلمت البطاقة المدنية',
      recordedRequiredThisTurn: true,
      trace
    });
    assert.ok(r);
    // Unified set (user spec, 2026-05-06): same 3 buttons every turn
    // during collecting/reviewing — no surprise menus.
    assert.deepEqual(r.map(b => b.id), ['review:submit', 'burst:more', 'service:cancel']);
    assert.equal(trace[0].case, 'unified_collecting');
  });

  test('CASE 2b — collecting + all docs in → unified set still applies', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: {
        status: 'collecting',
        docs: baseDocs,
        collected: {
          civil_id: { url: '/u/a.pdf' },
          passport: { url: '/u/b.pdf' }
        }
      },
      finalReply: 'all done!',
      recordedRequiredThisTurn: true,
      trace
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['review:submit', 'burst:more', 'service:cancel']);
    assert.equal(trace[0].case, 'unified_collecting');
  });

  test('CASE 3 — collecting + zero files yet → cancel-only (user spec 2026-05-07)', () => {
    // No files received yet → "انتهيت من الرفع" / "سأرسل المزيد" make
    // no sense. Show only the cancel exit.
    const r = attachContextualButtons({
      state: { status: 'collecting', docs: baseDocs, collected: {} },
      finalReply: 'أحتاج الجواز',
      trace: []
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['service:cancel']);
  });

  test('CASE 3b — collecting + at least one file → unified 3-button set', () => {
    const r = attachContextualButtons({
      state: {
        status: 'collecting',
        docs: baseDocs,
        collected: { civil_id: { storage_url: '/u/x.jpg' } }
      },
      finalReply: 'أحتاج الجواز',
      trace: []
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['review:submit', 'burst:more', 'service:cancel']);
  });

  test('CASE 4 — reviewing + files → unified set (confirm/more/cancel)', () => {
    const r = attachContextualButtons({
      state: {
        status: 'reviewing',
        docs: baseDocs,
        collected: { civil_id: { storage_url: '/u/x.jpg' } }
      },
      finalReply: 'all set?',
      trace: []
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['review:submit', 'burst:more', 'service:cancel']);
  });

  test('CASE 5 — idle + yes/no phrasing → confirm:yes/no', () => {
    const r = attachContextualButtons({
      state: { status: 'idle', docs: [], collected: {} },
      finalReply: 'هل تؤكد البدء؟',
      trace: []
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['confirm:yes', 'confirm:no']);
  });

  test('idle + plain ack (no question) → null (no buttons)', () => {
    const r = attachContextualButtons({
      state: { status: 'idle', docs: [], collected: {} },
      finalReply: 'مرحباً بك في ساند.',
      trace: []
    });
    assert.equal(r, null);
  });
  test('idle + reply ending in ؟ → fallback confirm:yes/no buttons', () => {
    // Per user spec: "never allow a message without buttons for yes/no/go ahead".
    const trace = [];
    const r = attachContextualButtons({
      state: { status: 'idle', docs: [], collected: {} },
      finalReply: 'مرحباً، كيف أقدر أساعدك؟',
      trace
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['confirm:yes', 'confirm:no']);
    assert.equal(trace[0].case, 'fallback_question');
  });

  test('button title length is always ≤ 20 chars (Meta cap)', () => {
    for (const status of ['collecting', 'reviewing']) {
      const r = attachContextualButtons({
        state: { status, docs: baseDocs, collected: {} },
        finalReply: 'x',
        recordedRequiredThisTurn: true,
        trace: []
      });
      if (r) for (const b of r) {
        assert.ok(b.title.length <= 20, `${status}: "${b.title}" > 20 chars`);
      }
    }
  });
});

describe('lib/agent.js · looksLikeYesNoAsk new patterns', () => {
  test('"اكتب تم" / "اكتب موافق" / "اكتب أرسل" hit', () => {
    assert.equal(looksLikeYesNoAsk('من فضلك اكتب تم لمتابعة'), true);
    assert.equal(looksLikeYesNoAsk('اكتب موافق للاستمرار'), true);
    assert.equal(looksLikeYesNoAsk('اكتب أرسل لإرسال الطلب'), true);
  });
  test('"want me to" / "ready to" English patterns hit', () => {
    assert.equal(looksLikeYesNoAsk('Want me to submit your file?'), true);
    assert.equal(looksLikeYesNoAsk('Ready to send?'), true);
  });
  test('Arabic-boundary fix: "اختر" matches without \\b', () => {
    assert.equal(looksLikeYesNoAsk('اختر أحد الخيارات'), true);
    assert.equal(looksLikeYesNoAsk('اختر: نعم أو لا'), true);
  });
  test('"pick one" / "choose between" English hit', () => {
    assert.equal(looksLikeYesNoAsk('Pick one of the options'), true);
    assert.equal(looksLikeYesNoAsk('Choose between A and B'), true);
  });
  test('plain ack still NOT detected as yes/no', () => {
    assert.equal(looksLikeYesNoAsk('شكراً جزيلاً'), false);
    assert.equal(looksLikeYesNoAsk('استلمت الملف'), false);
  });
});

// Codex-suggested guards (2026-05-06 review): make sure buttons are
// suppressed when the bot is asking for free text or showing a warning.
describe('lib/agent.js · button-suppression guards', () => {
  test('replyExpectsFreeText: detects describe-style asks', () => {
    assert.equal(replyExpectsFreeText('صف لي محتوى الملف'), true);
    assert.equal(replyExpectsFreeText('Describe each file briefly.'), true);
    assert.equal(replyExpectsFreeText('ما هذا الملف؟'), true);
    assert.equal(replyExpectsFreeText('What is this file?'), true);
    assert.equal(replyExpectsFreeText('أخبرني ما هذا'), true);
    assert.equal(replyExpectsFreeText('اكتب وصف لكل ملف'), true);
    assert.equal(replyExpectsFreeText('أرسل اسمك الكامل'), true);
    assert.equal(replyExpectsFreeText('Type your address.'), true);
  });
  test('replyExpectsFreeText: NOT triggered on yes/no asks', () => {
    assert.equal(replyExpectsFreeText('هل تؤكد البدء؟'), false);
    assert.equal(replyExpectsFreeText('Submit?'), false);
    assert.equal(replyExpectsFreeText('✅ استلمت الملف. التالي: جواز السفر.'), false);
  });
  test('isWarningReply: ⚠️ prefix and "warning" word', () => {
    assert.equal(isWarningReply('⚠️ لم أستطع استلام الملف.'), true);
    assert.equal(isWarningReply('❌ خطأ في النظام.'), true);
    assert.equal(isWarningReply('Warning: file too large'), true);
    assert.equal(isWarningReply('Error: bad file'), true);
    assert.equal(isWarningReply('✅ استلمت'), false);
    assert.equal(isWarningReply('مرحباً'), false);
  });
  test('attachContextualButtons returns null when free text expected', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: {
        status: 'collecting',
        docs: [{ code: 'civil_id', label_ar: 'البطاقة المدنية', label_en: 'Civil ID' }],
        collected: {},
        pending_uploads: [{ url: 'wa://1', idx: 1 }]
      },
      finalReply: 'صف لي كل ملف من الملفات المرسلة',
      trace
    });
    assert.equal(r, null);
    assert.equal(trace[0].reason, 'free_text_expected');
  });
  test('attachContextualButtons returns null on warning reply', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: { status: 'collecting', docs: [], collected: {} },
      finalReply: '⚠️ لم أستطع معالجة الملف.',
      trace
    });
    assert.equal(r, null);
    assert.equal(trace[0].reason, 'warning_reply');
  });

  // Codex (gpt-5.2-codex) round 2 — finalized-state gates.
  test('finalized state (queued) suppresses submit/extra buttons', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: { status: 'queued', docs: [], collected: {}, request_id: 42 },
      finalReply: 'طلبك في الطابور — سيتولّاه أحد المكاتب قريباً.',
      trace
    });
    assert.equal(r, null);
    assert.equal(trace[0].reason, 'finalized_state');
    assert.equal(trace[0].status, 'queued');
  });
  test('finalized state still attaches confirm:yes/no for genuine y/n asks', () => {
    const trace = [];
    const r = attachContextualButtons({
      state: { status: 'in_progress', docs: [], collected: {}, request_id: 7 },
      finalReply: 'هل تؤكد إلغاء الطلب؟',
      trace
    });
    assert.ok(r);
    assert.deepEqual(r.map(b => b.id), ['confirm:yes', 'confirm:no']);
    assert.equal(trace[0].case, 'finalized_yes_no');
  });
  test('finalized states: claimed / needs_more_info / completed all suppress', () => {
    for (const status of ['claimed', 'needs_more_info', 'awaiting_payment', 'completed']) {
      const r = attachContextualButtons({
        state: { status, docs: [], collected: {}, request_id: 1 },
        finalReply: 'حالة الطلب محدّثة.',
        trace: []
      });
      assert.equal(r, null, `status=${status} must not attach nav buttons`);
    }
  });
});
