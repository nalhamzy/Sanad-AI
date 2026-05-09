// Regression tests for the service-confirmation card flow + the
// search-result fees_text language filter.
//
// Real prod bugs from +96892888715 (2026-05-09):
//   1. Search results rendered "1️⃣ إنشاء سجل تجاري جديد —
//      The applicant is not entitled to refund" — Arabic name with
//      English fees_text concatenated (catalogue had non-fee English
//      stored in fees_text field).
//   2. Picking a search result jumped straight to "✅ بدأت طلب X" with
//      no doc list (because that catalogue row had only generic doc
//      labels). Citizen committed without seeing what they were
//      committing to.
//
// The fix:
//   - fragmentFor() now requires fees_text to contain a digit AND a fee
//     marker (ر.ع/ريال/OMR/مجاني) before rendering it.
//   - pick:N now shows a renderServiceConfirmCard() with full info
//     (service + entity + fee + time + doc list) BEFORE start_submission.
//   - confirm:yes (with state.pending_service_id set) is what triggers
//     the actual submission start.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { renderServiceConfirmCard, stripMarkdownEmphasis } = await import('../lib/agent.js');

describe('renderServiceConfirmCard() — pre-commit confirmation card', () => {
  test('renders all four sections when data is complete', () => {
    const row = {
      name_ar: 'إصدار جواز السفر',
      entity_ar: 'شرطة عمان السلطانية',
      fee_omr: 5,
      fees_text: null,
      avg_time_ar: '5 أيام عمل',
      required_documents_json: JSON.stringify([
        { code: 'civil_id', label_ar: 'البطاقة المدنية' },
        { code: 'photo',    label_ar: 'صورة شخصية' }
      ])
    };
    const out = renderServiceConfirmCard(row);
    assert.match(out, /📝 إصدار جواز السفر/);
    assert.match(out, /شرطة عمان السلطانية/);
    assert.match(out, /💰 5 ر\.ع/);
    assert.match(out, /⏱️ 5 أيام عمل/);
    assert.match(out, /📎 الملفات المطلوبة:/);
    assert.match(out, /1\) البطاقة المدنية/);
    assert.match(out, /2\) صورة شخصية/);
    assert.match(out, /هل نبدأ؟/);
  });

  test('falls back to "تُحدّد عند المراجعة" when fee is missing', () => {
    const out = renderServiceConfirmCard({ name_ar: 'X', entity_ar: 'Y', required_documents_json: '[]' });
    assert.match(out, /تُحدّد عند المراجعة/);
  });

  test('renders "مجانية" when fees_text indicates free', () => {
    const out = renderServiceConfirmCard({
      name_ar: 'X', fee_omr: null, fees_text: 'مجاناً - لا توجد رسوم', required_documents_json: '[]'
    });
    assert.match(out, /💰 مجانية/);
  });

  test('omits time line when not present', () => {
    const out = renderServiceConfirmCard({ name_ar: 'X', required_documents_json: '[]' });
    assert.ok(!/⏱️/.test(out), 'time emoji must not appear when no time data');
  });

  test('switches to open prompt when docs are all generic', () => {
    const out = renderServiceConfirmCard({
      name_ar: 'تجديد السجل التجاري',
      required_documents_json: JSON.stringify([{ code: 'a' }, { code: 'b' }, { code: 'c' }])
    });
    // Must NOT render the broken "1) مستند 2) مستند" list
    assert.ok(!/1\)\s*مستند/.test(out), 'must not fall back to "1) مستند"');
    // Must include the open prompt for the service name
    assert.match(out, /أرسل لي المستندات اللازمة/);
  });

  test('NEVER mixes English fees_text with Arabic name', () => {
    // The prod bug: row.fees_text was the English section header
    // "Renew Commercial Registrations Access and Delivery Time".
    // Card should NOT include that string verbatim.
    const out = renderServiceConfirmCard({
      name_ar: 'تجديد السجل التجاري',
      fee_omr: null,
      fees_text: 'Renew Commercial Registrations Access and Delivery Time',
      required_documents_json: '[]'
    });
    assert.ok(!/Renew Commercial Registrations/.test(out),
      'English non-fee text must not be appended');
  });

  test('all output is markdown-bold-free (would be scrubbed anyway)', () => {
    const row = { name_ar: 'X', entity_ar: 'Y', required_documents_json: '[]' };
    const out = stripMarkdownEmphasis(renderServiceConfirmCard(row));
    assert.equal(out, renderServiceConfirmCard(row), 'card should not contain markdown bold');
  });

  test('handles null/empty input safely', () => {
    assert.equal(renderServiceConfirmCard(null), '');
    assert.equal(renderServiceConfirmCard(undefined), '');
  });
});
