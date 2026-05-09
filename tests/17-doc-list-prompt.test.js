// renderDocListOrPrompt() — guards against the +96892888715 trace bug
// from 2026-05-09: when a catalogue row has no real Arabic doc labels,
// the "Required documents:" block was rendering "1) مستند 2) مستند 3) مستند"
// (literally "1) document 2) document"), giving the citizen zero signal
// about what to send.
//
// Contract:
//   - At least half the docs have real Arabic labels  → return numbered list.
//   - Most/all resolve to the generic "مستند" fallback → return one open
//     prompt instead, asking for "the documents needed for {service}".
//   - Empty/null input is safe.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { renderDocListOrPrompt } = await import('../lib/agent.js');

describe('renderDocListOrPrompt() — generic-doc fallback', () => {
  test('renders numbered list when most docs have real labels', () => {
    const out = renderDocListOrPrompt([
      { code: 'civil_id',     label_ar: 'البطاقة المدنية' },
      { code: 'passport',     label_ar: 'جواز السفر' },
      { code: 'photo',        label_ar: 'صورة شخصية' }
    ], 'تجديد جواز السفر');
    assert.equal(out.kind, 'list');
    assert.match(out.text, /1\) البطاقة المدنية/);
    assert.match(out.text, /2\) جواز السفر/);
    assert.match(out.text, /3\) صورة شخصية/);
  });
  test('still renders list when at least half have real labels', () => {
    const out = renderDocListOrPrompt([
      { code: 'civil_id', label_ar: 'البطاقة المدنية' },
      { code: 'photo',    label_ar: 'صورة شخصية' },
      { /* empty — generic fallback */ },
      { /* empty — generic fallback */ }
    ], 'خدمة');
    assert.equal(out.kind, 'list');
  });
  test('switches to one open prompt when all docs are generic', () => {
    // The exact prod scenario: CR Renewal catalogue row had no real labels.
    const out = renderDocListOrPrompt([
      { /* no code, no labels */ },
      { /* no code, no labels */ },
      { /* no code, no labels */ }
    ], 'تجديد السجل التجاري');
    assert.equal(out.kind, 'prompt');
    assert.match(out.text, /أرسل لي المستندات اللازمة/);
    assert.match(out.text, /تجديد السجل التجاري/);
    // Critically: the bot must NOT render "1) مستند 2) مستند 3) مستند".
    assert.ok(!/1\)\s*مستند/.test(out.text), 'must not fall back to "1) مستند"');
  });
  test('switches to prompt when more than half are generic', () => {
    const out = renderDocListOrPrompt([
      { code: 'civil_id', label_ar: 'البطاقة المدنية' },
      { /* generic */ },
      { /* generic */ },
      { /* generic */ }
    ]);
    assert.equal(out.kind, 'prompt');
  });
  test('handles empty input safely', () => {
    const out = renderDocListOrPrompt([], 'X');
    assert.equal(out.kind, 'prompt');
  });
  test('handles null/undefined input safely', () => {
    assert.equal(renderDocListOrPrompt(null).kind, 'prompt');
    assert.equal(renderDocListOrPrompt(undefined).kind, 'prompt');
  });
  test('omits the service-name suffix when not provided', () => {
    const out = renderDocListOrPrompt([{}, {}, {}]);
    assert.equal(out.kind, 'prompt');
    assert.ok(!/\s+لـ/.test(out.text), 'should not include "لـ" prefix without name');
  });
});
