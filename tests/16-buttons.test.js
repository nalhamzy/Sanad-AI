// Canonical button table integrity + helpers.
//
// Why this matters: Before lib/buttons.js, agent.js had ~100 inline
// `{id, title}` button declarations and the same id was getting different
// titles in different places (`confirm:yes` had two different labels;
// `service:cancel` had THREE; one in-flight cancel title was 23 chars
// which silently failed the WhatsApp Cloud API 20-char limit).
//
// This test pins the new contract:
//   1. Every entry stays under the 20-char Cloud API hard limit.
//   2. button(id) throws on unknown id (catches typos at boot).
//   3. buttons([...]) refuses >3 ids (Cloud API ceiling for reply buttons).
//   4. pickButtons() truncates real service names sensibly and falls back
//      to canonical labels when names are missing.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { BUTTON_LABELS, BUTTON_TITLE_MAX, button, buttons, pickButtons } =
  await import('../lib/buttons.js');

describe('BUTTON_LABELS — Cloud API title-length contract', () => {
  test('every label fits under the 20-char Cloud API ceiling', () => {
    for (const [id, title] of Object.entries(BUTTON_LABELS)) {
      assert.ok(
        title.length <= BUTTON_TITLE_MAX,
        `BUTTON_LABELS["${id}"] = "${title}" is ${title.length} chars (max ${BUTTON_TITLE_MAX})`
      );
    }
  });
  test('every label is a non-empty trimmed string', () => {
    for (const [id, title] of Object.entries(BUTTON_LABELS)) {
      assert.equal(typeof title, 'string', `${id}: not a string`);
      assert.ok(title.length > 0, `${id}: empty`);
      assert.equal(title, title.trim(), `${id}: leading/trailing whitespace`);
    }
  });
  test('table is non-empty and contains the historically-used ids', () => {
    const required = [
      'burst:more', 'burst:done',
      'confirm:yes', 'confirm:no',
      'discover:cr', 'discover:license', 'discover:title',
      'doc:wrong',
      'pick:1', 'pick:2', 'pick:3',
      'review:submit',
      'service:switch', 'service:cancel',
      'status:check'
    ];
    for (const id of required) {
      assert.ok(BUTTON_LABELS[id], `missing canonical label for ${id}`);
    }
  });
  test('table is frozen (no accidental in-flight mutation)', () => {
    assert.ok(Object.isFrozen(BUTTON_LABELS), 'BUTTON_LABELS must be frozen');
  });
});

describe('button(id, override?)', () => {
  test('returns canonical title for known id', () => {
    assert.deepEqual(button('confirm:yes'), { id: 'confirm:yes', title: BUTTON_LABELS['confirm:yes'] });
  });
  test('throws on unknown id (catches typos at boot)', () => {
    assert.throws(() => button('confirm:maybe'), /Unknown button id/);
  });
  test('override < 20 chars is used as-is', () => {
    const b = button('confirm:yes', '✓ نعم، حذف الطلب');
    assert.equal(b.title, '✓ نعم، حذف الطلب');
    assert.ok(b.title.length <= BUTTON_TITLE_MAX);
  });
  test('override > 20 chars is truncated with ellipsis (no crash)', () => {
    const long = '✓ نعم، أرسل طلب الإلغاء الآن لمكتب سند المختار للمراجعة';
    const b = button('confirm:yes', long);
    assert.ok(b.title.length <= BUTTON_TITLE_MAX, `got ${b.title.length} chars: ${b.title}`);
    assert.ok(b.title.endsWith('…'), 'should end with ellipsis');
  });
});

describe('buttons([ids])', () => {
  test('builds an ordered array of canonical {id,title}', () => {
    const out = buttons(['review:submit', 'burst:more', 'service:cancel']);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'review:submit');
    assert.equal(out[2].id, 'service:cancel');
  });
  test('refuses >3 ids (Cloud API hard limit for reply buttons)', () => {
    assert.throws(
      () => buttons(['confirm:yes', 'confirm:no', 'service:cancel', 'status:check']),
      /max 3 reply buttons/
    );
  });
  test('refuses non-array input', () => {
    assert.throws(() => buttons('confirm:yes'), /expects an array/);
  });
});

describe('pickButtons(candidates) — search-result UX', () => {
  test('renders {N glyph} {service name} for each candidate', () => {
    const out = pickButtons([
      { name_ar: 'تجديد رخصة سياقة' },
      { name_ar: 'تجديد سجل المركبة' },
      { name_ar: 'إنشاء سجل تجاري' }
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'pick:1');
    assert.ok(out[0].title.startsWith('1️⃣'), 'must start with glyph');
    assert.ok(out[0].title.includes('تجديد'), 'must contain service name fragment');
  });
  test('strips generic prefixes "خدمة"/"خدمة طلب"/"طلب" to save room', () => {
    const out = pickButtons([{ name_ar: 'خدمة طلب تجديد رخصة سياقة' }]);
    // The "خدمة طلب " prefix should be gone so more of the meaningful
    // name fits in the 20-char ceiling.
    assert.ok(!out[0].title.includes('خدمة طلب'),
      `expected no "خدمة طلب" prefix in: ${out[0].title}`);
    assert.ok(out[0].title.includes('تجديد'));
  });
  test('long names are ellipsis-truncated, never crash', () => {
    const out = pickButtons([
      { name_ar: 'خدمة تسجيل وتوثيق عقود الزواج وعقود الإيجار التجارية' }
    ]);
    assert.ok(out[0].title.length <= BUTTON_TITLE_MAX);
    assert.ok(out[0].title.endsWith('…'));
  });
  test('falls back to canonical label when name is missing', () => {
    const out = pickButtons([{ /* no name */ }, {}]);
    assert.equal(out[0].title, BUTTON_LABELS['pick:1']);
    assert.equal(out[1].title, BUTTON_LABELS['pick:2']);
  });
  test('caps at 3 buttons regardless of input length', () => {
    const out = pickButtons([{name_ar:'A'},{name_ar:'B'},{name_ar:'C'},{name_ar:'D'},{name_ar:'E'}]);
    assert.equal(out.length, 3);
  });
  test('handles empty/null input safely', () => {
    assert.deepEqual(pickButtons([]), []);
    assert.deepEqual(pickButtons(null), []);
    assert.deepEqual(pickButtons(undefined), []);
  });
});
