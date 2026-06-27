// Regression tests for the two prod bugs from +96892888715 trace
// 2026-05-10 10:19:27 → 10:20:45:
//
//   Bug A — "هلا توجد خدمات أخرى" was getting swallowed as a greeting
//           (regex matched "هلا" at start, deterministic catch fired
//           the welcome message and the bot ignored the actual question).
//
//   Bug B — "اريد الخدمات المقدمة من الشرطة" / "ارسلي كل خدمات الشرطه"
//           returned 3 random services that mention "الشرطة" instead of
//           routing to get_entity_services for ROP. Citizen complained
//           ("فقط ٣ خدمات؟") and the bot looped on the same useless
//           keyword search.
//
// These tests pin both fixes so they can't regress.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { isGreetingOrHelp, greetingIntent } = await import('../lib/agent.js');
const { normalize } = await import('../lib/catalogue.js');

describe('A — greeting catch is no longer too greedy', () => {
  describe('still classifies pure greetings as greetings', () => {
    for (const t of [
      'مرحبا', 'مرحب بك', 'السلام عليكم', 'اهلا',
      'أهلا', 'هاي', 'هلا', 'صباح الخير', 'مساء الخير',
      'hi', 'hello', 'hey', 'good morning', 'good afternoon'
    ]) {
      test(`"${t}" still treated as greeting`, () => {
        assert.equal(isGreetingOrHelp(t), true, t);
      });
    }
  });
  describe('does NOT swallow greeting + actual question', () => {
    for (const t of [
      'هلا توجد خدمات أخرى',         // the actual prod bug input
      'هلا توجد خدمات اهرى',         // typo variant from prod
      'مرحبا أبغى أجدد رخصة',
      'السلام عليكم، فقدت بطاقتي',
      'اهلا اريد جواز سفر',
      'hi I want to renew my licence',
      'hello can you list health services',
      'thanks but I still need help with my request'
    ]) {
      test(`"${t}" is NOT a pure greeting (must reach search)`, () => {
        assert.equal(isGreetingOrHelp(t), false, t);
        assert.equal(greetingIntent(t), null, t);
      });
    }
  });
  test('emoji-only after greeting still counts as greeting', () => {
    assert.equal(isGreetingOrHelp('مرحبا 👋'), true);
    assert.equal(isGreetingOrHelp('hi 🙏'), true);
    assert.equal(greetingIntent('hello!'), 'greeting');
  });
});

describe('B — entity-listing intent (regex shape only)', () => {
  // We can't easily exercise the full runAgentV2 entity-list branch
  // without a live DB + LLM mock — so this tests the DETECTOR REGEXES
  // directly, mirroring what's in lib/agent.js. If those regexes
  // change, update the literals here.
  // Mirrors lib/agent.js. After normalize() ة becomes ه, إ/أ become ا,
  // ى becomes ي. Hints are written in normalized form.
  const SERVICES_PLURAL = /(خدمات|services\b)/i;
  const ENTITY_HINTS = [
    /(شرطه|rop|police)/i,
    /(وزاره\s*الصحه|الصحه|moh|health\s*ministry)/i,
    /(وزاره\s*العمل|العمل|labou?r|mol)/i,
    /(وزاره\s*التجاره|التجاره|commerce|moc|invest\s*easy)/i,
    /(وزاره\s*الاسكان|الاسكان|housing|mohup)/i,
    /(بلديه\s*مسقط|بلديه|muscat\s*municipality|municipality)/i,
  ];
  function detectsEntityList(t) {
    const n = normalize(t);
    if (!SERVICES_PLURAL.test(n)) return false;
    return ENTITY_HINTS.some(re => re.test(n));
  }

  describe('catches the actual prod inputs', () => {
    for (const t of [
      'اريد الخدمات المقدمة من الشرطة',
      'ارسلي كل خدمات الشرطه',
      'ارسلي كل خدمات الشرطه،اللي معكم',
      'ايش خدمات وزارة الصحه',
      'كل خدمات وزارة العمل',
      'list all police services',
      'show me all health ministry services'
    ]) {
      test(`"${t}" → entity-list`, () => assert.equal(detectsEntityList(t), true, t));
    }
  });
  describe('does NOT fire on single-service searches', () => {
    for (const t of [
      'تجديد رخصة سياقة',           // single service
      'أبغى أجدد جواز السفر',       // single service
      'بدل فاقد سند ملكية',         // single service
      'مرحبا'                        // greeting
    ]) {
      test(`"${t}" → not entity-list`, () => assert.equal(detectsEntityList(t), false, t));
    }
  });
});

// C — thanks classification survives tashkeel + intensifiers/trailers.
// Live prod bug (2026-06-27): "شكراً جزيلاً لك" returned a 6-service search
// list instead of an acknowledgement — the fatHatan on "شكراً" broke the
// start-anchored regex, and "لك" wasn't a recognised filler.
describe('C — thanks is recognised despite tashkeel + trailing words', () => {
  describe('classifies polite thanks as thanks', () => {
    for (const t of [
      'شكراً جزيلاً لك', 'شكراً جزيلاً', 'شكرا', 'شكراً',
      'مشكور ما قصرت', 'يعطيك العافية', 'thanks a lot', 'thank you so much'
    ]) {
      test(`"${t}" → thanks`, () => assert.equal(greetingIntent(t), 'thanks', t));
    }
  });
  describe('does NOT swallow thanks + a real request', () => {
    for (const t of [
      'شكرا بس ابغى اجدد الرخصة',
      'شكراً، عندي سؤال عن جواز السفر'
    ]) {
      test(`"${t}" → not thanks`, () => assert.notEqual(greetingIntent(t), 'thanks', t));
    }
  });
});
