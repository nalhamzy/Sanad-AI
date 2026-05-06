// Regression tests for the deterministic button-intent dispatcher and the
// Arabic-label fallback. Both fix bugs found in the prod trace
// +96892888715 (2026-05-06).
//
// Bug A: tapping "+ سأرسل المزيد" → text "سأرسل المزيد" → parseUploadDescriptions
//        ate it as a caption and shoved buffered files into extras.
// Bug B: catalog services with empty label_ar caused English-only labels
//        to render mid-Arabic conversation ("Civil ID", "Passport").
// Bug C: record_document accepted attachments with no URL → state corruption.

import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { bootTestEnv } = await import('./helpers.js');
await bootTestEnv();

const { __testBurst } = await import('../lib/agent.js');
const { handleButtonIntent, arabicLabelFor, SESSION_BURST, SESSION_INFLIGHT_FILES } = __testBurst;
const { TOOL_IMPL_V2 } = await import('../lib/agent_tools.js');

before(() => {
  SESSION_BURST.clear();
  SESSION_INFLIGHT_FILES.clear();
});

describe('lib/agent.js · arabicLabelFor (Arabic-label fallback)', () => {
  test('returns label_ar verbatim when present', () => {
    assert.equal(
      arabicLabelFor({ code: 'civil_id', label_en: 'Civil ID', label_ar: 'البطاقة المدنية' }),
      'البطاقة المدنية'
    );
  });
  test('falls back to ARABIC_DOC_LABELS map when label_ar empty', () => {
    assert.equal(
      arabicLabelFor({ code: 'civil_id', label_en: 'Civil ID', label_ar: '' }),
      'البطاقة المدنية'
    );
    assert.equal(
      arabicLabelFor({ code: 'passport', label_en: 'Passport', label_ar: '' }),
      'جواز السفر'
    );
  });
  test('handles SQL-truncated codes via prefix lookup', () => {
    // Real catalog code from service 110102 — truncated at 40 chars.
    assert.equal(
      arabicLabelFor({
        code: 'employment_contract_approved_by_the_mini',
        label_en: 'Employment contract approved by the Ministry of Health',
        label_ar: ''
      }),
      'عقد العمل المعتمد من وزارة الصحة'
    );
    assert.equal(
      arabicLabelFor({
        code: 'appointment_letter_from_the_concerned_he',
        label_ar: ''
      }),
      'خطاب التعيين من الجهة الصحية'
    );
  });
  test('falls back to label_en when no Arabic mapping exists (wrapped in Arabic guillemets)', () => {
    // Codex Q4: wrap fallback in Arabic guillemets + LRM so it doesn't
    // bidi-flip mid-Arabic. Multi-word labels get wrapped; single-token
    // labels stay bare.
    assert.equal(
      arabicLabelFor({ code: 'unknown_doc_xyz', label_en: 'Some Niche Cert', label_ar: '' }),
      '«Some Niche Cert»‎'
    );
    assert.equal(
      arabicLabelFor({ code: 'singletoken', label_en: 'SingleToken', label_ar: '' }),
      'SingleToken'
    );
  });
  test('null / placeholder docs return empty string', () => {
    assert.equal(arabicLabelFor(null), '');
    assert.equal(arabicLabelFor({ code: '', label_en: '', label_ar: '' }), '');
  });
});

describe('lib/agent.js · handleButtonIntent — deterministic button dispatch', () => {

  function freshState(overrides = {}) {
    return {
      status: 'collecting',
      docs: [
        { code: 'civil_id',  label_en: 'Civil ID',  label_ar: '' },
        { code: 'passport',  label_en: 'Passport',  label_ar: '' },
        { code: 'photo',     label_en: 'Photo',     label_ar: '' }
      ],
      collected: {},
      pending_doc_index: 0,
      ...overrides
    };
  }

  test('burst:more lists pending slots in Arabic, NEVER passes through caption parser', async () => {
    const state = freshState({
      collected: {
        civil_id: { storage_url: '/u/x.jpg' }
      }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test1', state, btn_id: 'burst:more',
      attachment: null, citizen_phone: '+test1', trace: []
    });
    assert.ok(r, 'should be handled deterministically');
    assert.match(r.reply, /المتبقي.*\(2\)/);
    assert.match(r.reply, /جواز السفر/);  // arabicLabelFor mapping
    assert.match(r.reply, /صورة شخصية/);
    // Buttons present
    assert.ok(r._buttons?.length, 'should include nav buttons');
    const ids = r._buttons.map(b => b.id);
    assert.ok(ids.includes('doc:list'));
    assert.ok(ids.includes('service:cancel'));
  });

  test('burst:more with all docs already collected → moves to reviewing', async () => {
    const state = freshState({
      collected: {
        civil_id: { storage_url: '/u/a.jpg' },
        passport: { storage_url: '/u/b.jpg' },
        photo:    { storage_url: '/u/c.jpg' }
      }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test2', state, btn_id: 'burst:more',
      attachment: null, citizen_phone: '+test2', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.status, 'reviewing');
    assert.match(r.reply, /كل المستندات المطلوبة/);
    assert.ok(r._buttons.some(b => b.id === 'review:submit'));
  });

  test('burst:done with missing required docs blocks transition + lists missing', async () => {
    const state = freshState({
      collected: { civil_id: { storage_url: '/u/x.jpg' } }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test3', state, btn_id: 'burst:done',
      attachment: null, citizen_phone: '+test3', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.status, 'collecting', 'must NOT advance with missing docs');
    assert.match(r.reply, /لا يمكنني الإرسال للمراجعة/);
    assert.match(r.reply, /جواز السفر/); // names what's missing
  });

  test('burst:done with all required collected → advances to reviewing', async () => {
    const state = freshState({
      collected: {
        civil_id: { storage_url: '/u/a.jpg' },
        passport: { storage_url: '/u/b.jpg' },
        photo:    { storage_url: '/u/c.jpg' }
      }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test4', state, btn_id: 'burst:done',
      attachment: null, citizen_phone: '+test4', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.status, 'reviewing');
    assert.match(r.reply, /جاهز للمراجعة/);
  });

  test('service:cancel does NOT immediately discard — sets pending_cancel + asks confirm', async () => {
    const state = freshState({
      service_id: 110102,
      collected: { civil_id: { storage_url: '/u/x.jpg' } }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test5', state, btn_id: 'service:cancel',
      attachment: null, citizen_phone: '+test5', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.pending_cancel, true);
    assert.equal(r.state.status, 'collecting', 'state must NOT change yet');
    assert.match(r.reply, /هل تؤكد إلغاء/);
    const ids = r._buttons.map(b => b.id);
    assert.ok(ids.includes('confirm:yes'));
    assert.ok(ids.includes('confirm:no'));
  });

  test('confirm:yes after pending_cancel actually clears the draft', async () => {
    const state = freshState({
      service_id: 110102,
      pending_cancel: true,
      collected: { civil_id: { storage_url: '/u/x.jpg' } }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test6', state, btn_id: 'confirm:yes',
      attachment: null, citizen_phone: '+test6', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.status, 'idle');
    assert.deepEqual(r.state.collected, {});
    assert.match(r.reply, /ألغيت/);
  });

  test('confirm:no after pending_cancel keeps the draft', async () => {
    const state = freshState({
      service_id: 110102,
      pending_cancel: true,
      collected: { civil_id: { storage_url: '/u/x.jpg' } }
    });
    const r = await handleButtonIntent({
      session_id: 'wa:+test7', state, btn_id: 'confirm:no',
      attachment: null, citizen_phone: '+test7', trace: []
    });
    assert.ok(r);
    assert.equal(r.state.status, 'collecting', 'state preserved');
    assert.equal(r.state.collected.civil_id.storage_url, '/u/x.jpg', 'collected preserved');
    assert.equal(r.state.pending_cancel, undefined, 'flag cleared');
  });

  test('unknown button id returns null (falls through to LLM)', async () => {
    const state = freshState();
    const r = await handleButtonIntent({
      session_id: 'wa:+test8', state, btn_id: 'doc:yes',
      attachment: null, citizen_phone: '+test8', trace: []
    });
    assert.equal(r, null, 'doc:yes should fall through to LLM (still needs context)');
  });
});

describe('lib/agent_tools.js · record_document — state-corruption guard', () => {
  // Real prod bug from trace +96892888715 #1208: LLM called record_document
  // without a real attachment; state.collected.civil_id ended up with
  // storage_url=null. Officer dashboard then showed slot as "filled" with
  // a broken link. The tool must reject the call when no file is attached.

  test('rejects when no attachment AND slot not already filled', async () => {
    const state = {
      status: 'collecting',
      docs: [{ code: 'civil_id', label_en: 'Civil ID', label_ar: '' }],
      collected: {},
      pending_doc_index: 0
    };
    const ctx = { session_id: 'wa:+gtest', state, trace: [], attachment: null };
    const result = await TOOL_IMPL_V2.record_document(ctx, {
      doc_code: 'civil_id', filename: 'x.jpg', caption: 'civil id'
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no_file_attached');
    assert.equal(state.collected.civil_id, undefined,
      'must not write to state.collected when there is no file');
  });

  test('accepts when attachment has a real URL', async () => {
    const state = {
      status: 'collecting',
      docs: [{ code: 'civil_id', label_en: 'Civil ID', label_ar: '' }],
      collected: {},
      pending_doc_index: 0
    };
    const ctx = {
      session_id: 'wa:+gtest2', state, trace: [],
      attachment: { url: '/uploads/wa%3A%2Bgtest2/abc.jpg', mime: 'image/jpeg', size: 12345, name: 'x.jpg' }
    };
    const result = await TOOL_IMPL_V2.record_document(ctx, {
      doc_code: 'civil_id', filename: 'x.jpg', caption: 'civil id'
    });
    assert.equal(result.ok, true);
    assert.equal(state.collected.civil_id.storage_url, '/uploads/wa%3A%2Bgtest2/abc.jpg');
  });
});
