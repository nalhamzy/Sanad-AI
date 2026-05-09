// Regression guards for the deterministic bot-reply templates that every
// citizen sees on first contact. These templates are written in code (not by
// the LLM), so they bypass the SYSTEM_V2 "no markdown" rule. They must obey
// the same constraint manually — WhatsApp renders **double asterisks** as
// literal text and ruins the message.
//
// Bug history this guards against:
//   • welcomeMessage() shipped with **ساند**, **Saned**, **600+ خدمة**, etc.
//   • helpMessage() shipped with **ساند** + bolded numbered list items.
//   • firstDocPrompt() shipped with **${name_ar}** and **${doc.label_ar}**.
// All of these displayed as `**asterisks**` on real WhatsApp.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { _welcomeMessage, _helpMessage, _firstDocPrompt, stripMarkdownEmphasis,
        isGreetingOrHelp, greetingIntent } = await import('../lib/agent.js');

// Reject **double-asterisk bold** anywhere in the string. Single asterisks
// are WhatsApp's bold marker (and we don't use them either) — so the simpler
// "no asterisks at all" rule is what we enforce.
function assertNoMarkdownBold(s, where) {
  assert.ok(!/\*\*/.test(s), `${where}: leaks **bold** markdown — WhatsApp renders this literally`);
  assert.ok(!/(?:^|\s)\*[^\s*][^*]*\*(?:\s|$)/.test(s),
    `${where}: leaks *italic/bold* markdown — WhatsApp renders this literally`);
}

describe('welcomeMessage()', () => {
  const w = _welcomeMessage();
  test('contains no markdown bold (** or *)', () => assertNoMarkdownBold(w, 'welcomeMessage'));
  test('mentions both languages (AR + EN)', () => {
    assert.ok(/ساند/.test(w), 'must contain Arabic brand name');
    assert.ok(/Saned/i.test(w), 'must contain English brand name');
  });
  test('does not use marketplace/competing-offers language (deprecated)', () => {
    // System prompt was revised to remove this framing — keep deterministic
    // templates aligned. "office" singular is fine; "offices claim" is not.
    assert.ok(!/offices?\s+claim/i.test(w), 'must not mention offices claiming');
    assert.ok(!/marketplace/i.test(w), 'must not mention marketplace');
    assert.ok(!/competing|first offer/i.test(w), 'must not mention competing offers');
  });
  test('respects the ≤ ~80-word brevity rule for first contact', () => {
    // Welcome contains AR + EN halves; system prompt suggests ≤40 words per
    // half on first contact. Allow 80 total as a generous ceiling.
    const wordCount = w.trim().split(/\s+/).length;
    assert.ok(wordCount <= 90, `welcomeMessage too long: ${wordCount} words (cap ~90)`);
  });
});

describe('helpMessage()', () => {
  const h = _helpMessage();
  test('contains no markdown bold (** or *)', () => assertNoMarkdownBold(h, 'helpMessage'));
  test('describes the 5-step prep + dispatch flow', () => {
    assert.ok(/1️⃣/.test(h) && /5️⃣/.test(h), 'must enumerate steps 1️⃣–5️⃣');
  });
});

describe('greeting/help/thanks classifier (runAgentV2 short-circuit)', () => {
  // Real prod regression: +96892888715 (2026-05-09) typed "مرحبا" and got
  // back "وجدت 3 خدمات تناسبك ..." because runAgentV2 went straight to the
  // LLM, which called search_services on the greeting. These cases pin the
  // deterministic catch in place so this can't regress.
  describe('isGreetingOrHelp() — true cases', () => {
    for (const t of [
      'مرحبا', 'مرحب بك', 'السلام عليكم', 'اهلا', 'أهلا', 'هاي', 'هلا',
      'صباح الخير', 'مساء الخير',
      'hi', 'hello', 'hey', 'Hi there!', 'salam', 'good morning',
      'help', '?', 'مساعدة', 'قدراتك',
      'thanks', 'thank you', 'شكرا', 'مشكور', 'تسلم'
    ]) {
      test(`"${t}" is a greeting/help/thanks`, () => assert.equal(isGreetingOrHelp(t), true, t));
    }
  });
  describe('isGreetingOrHelp() — false cases (no false positives)', () => {
    for (const t of [
      'أبغى أجدد رخصة القيادة',
      'كم رسوم تجديد جواز السفر؟',
      'I want to renew my passport',
      'civil id renewal',
      'تجديد رخصة',
      ''
    ]) {
      test(`"${t}" is NOT a greeting`, () => assert.equal(isGreetingOrHelp(t), false, t));
    }
  });
  describe('greetingIntent() — classifies intent correctly', () => {
    test('thanks beats greeting', () => assert.equal(greetingIntent('thank you'), 'thanks'));
    test('help', () => assert.equal(greetingIntent('help'), 'help'));
    test('arabic help', () => assert.equal(greetingIntent('مساعدة'), 'help'));
    test('greeting', () => assert.equal(greetingIntent('مرحبا'), 'greeting'));
    test('non-match returns null', () => assert.equal(greetingIntent('renew passport'), null));
  });
  test('handles non-string safely', () => {
    assert.equal(isGreetingOrHelp(null), false);
    assert.equal(isGreetingOrHelp(undefined), false);
    assert.equal(isGreetingOrHelp(123), false);
  });
});

describe('stripMarkdownEmphasis() — central scrub for outbound bot text', () => {
  test('strips **bold** anywhere in the string', () => {
    assert.equal(stripMarkdownEmphasis('hello **world**!'), 'hello world!');
    assert.equal(stripMarkdownEmphasis('**ساند** هنا'), 'ساند هنا');
    assert.equal(stripMarkdownEmphasis('**a** then **b**'), 'a then b');
  });
  test('strips __bold__', () => {
    assert.equal(stripMarkdownEmphasis('hello __world__!'), 'hello world!');
  });
  test('strips ***bold-italic*** as a triple-asterisk pair', () => {
    assert.equal(stripMarkdownEmphasis('***urgent***: read this'), 'urgent: read this');
  });
  test('strips *italic* when adjoining word characters', () => {
    assert.equal(stripMarkdownEmphasis('say *yes* or *no*'), 'say yes or no');
  });
  test('preserves bullet "* item" list lines', () => {
    const before = '* first\n* second\n* third';
    assert.equal(stripMarkdownEmphasis(before), before);
  });
  test('preserves Arabic content unchanged when no markdown is present', () => {
    const ar = 'هل تقصد تجديد رخصة القيادة؟ ✅';
    assert.equal(stripMarkdownEmphasis(ar), ar);
  });
  test('handles null/undefined safely', () => {
    assert.equal(stripMarkdownEmphasis(null), null);
    assert.equal(stripMarkdownEmphasis(undefined), undefined);
    assert.equal(stripMarkdownEmphasis(''), '');
  });
  test('regression: a real confirming-state reply renders cleanly', () => {
    const before = 'هل تقصد: **خدمة طلب تجديد رخصة سياقة** (شرطة عمان السلطانية)؟\n👉 اكتب **نعم** لنبدأ.';
    const after  = 'هل تقصد: خدمة طلب تجديد رخصة سياقة (شرطة عمان السلطانية)؟\n👉 اكتب نعم لنبدأ.';
    assert.equal(stripMarkdownEmphasis(before), after);
  });
});

describe('firstDocPrompt()', () => {
  test('contains no markdown bold for a known launch service', () => {
    const r = _firstDocPrompt('drivers_licence_renewal');
    assertNoMarkdownBold(r, 'firstDocPrompt(drivers_licence_renewal)');
  });
  test('renders the fee when the catalogue knows it (passport: 5 OMR)', () => {
    const r = _firstDocPrompt('passport_issuance_renewal');
    assert.ok(/5\.000/.test(r), 'expected fee 5.000 in firstDocPrompt for passport');
    assert.ok(/ر\.ع/.test(r), 'expected Arabic OMR unit "ر.ع"');
  });
  test('omits fee when the catalogue has none (drivers_licence_renewal)', () => {
    const r = _firstDocPrompt('drivers_licence_renewal');
    assert.ok(!/💰/.test(r), 'must NOT fabricate a fee when catalogue value is null');
  });
  test('mentions the first required document', () => {
    const r = _firstDocPrompt('drivers_licence_renewal');
    assert.ok(/البطاقة المدنية/.test(r), 'first doc label (AR) must appear');
  });
  test('falls back gracefully for unknown service codes', () => {
    const r = _firstDocPrompt('not_a_real_code');
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
    assertNoMarkdownBold(r, 'firstDocPrompt(unknown)');
  });
});
