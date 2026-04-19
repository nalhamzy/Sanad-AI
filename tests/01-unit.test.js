// Pure-function unit tests — no DB, no HTTP.
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { normalize } = await import('../lib/catalogue.js');
const { expandQuery } = await import('../lib/query_rewriter.js');

describe('normalize()', () => {
  test('strips Arabic diacritics (tashkeel)', () => {
    assert.equal(normalize('جَوَازْ سَفَرٍ'), 'جواز سفر');
  });
  test('unifies alef variants (إ أ آ → ا)', () => {
    assert.equal(normalize('إصدار أحمد آدم'), 'اصدار احمد ادم');
  });
  test('unifies yaa ى → ي and taa-marbuta ة → ه', () => {
    assert.equal(normalize('بطاقة ذكرى'), 'بطاقه ذكري');
  });
  test('lowercases and strips punctuation (English)', () => {
    assert.equal(normalize('  Hello, World!!!  '), 'hello world');
  });
  test('handles typo with stray =', () => {
    // the typo from a real user trace
    assert.equal(normalize('تح=جديد'), 'تح جديد');
  });
  test('empty input returns empty string', () => {
    assert.equal(normalize(''), '');
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
  });
});

describe('expandQuery() — heuristic synonyms', () => {
  test('dialectal "بطاقة عامل" expands to work-permit vocabulary', async () => {
    const v = await expandQuery('بطاقة عامل', { useLLM: false });
    // Should produce variants that include work-permit synonyms
    assert.ok(v.length >= 2, 'expected ≥ 2 variants, got ' + v.length);
    const joined = v.join('|').toLowerCase();
    assert.ok(/work permit|تصريح عمل|labour card/.test(joined),
      'expected work-permit synonym in variants: ' + joined);
  });
  test('English "driving licence" returns Arabic equivalents', async () => {
    const v = await expandQuery('driving licence', { useLLM: false });
    const joined = v.join('|');
    assert.ok(/رخصه قياده|رخصه سياقه|driving license/.test(joined),
      'cross-language variants missing: ' + joined);
  });
  test('unknown words still return the original', async () => {
    const v = await expandQuery('xyz123abc', { useLLM: false });
    assert.ok(v.length >= 1);
    assert.ok(v.some(x => x.includes('xyz123abc')));
  });
  test('empty input returns empty array', async () => {
    const v = await expandQuery('', { useLLM: false });
    assert.deepEqual(v, []);
  });
});
