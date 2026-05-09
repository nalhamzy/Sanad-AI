// Regression tests for the three citizen-feedback fixes from
// 2026-05-09 evening (+96892888715):
//
//   A) "I got 4 files but it marks 3" — burst headline now reconciles
//      n (webhook count) vs accountedFor (slots filled + extras) and
//      surfaces the discrepancy explicitly when dropped > 0.
//   B) "I don't like 'لا قلق، سيتواصل معك المكتب'" — replaced with
//      a factual breakdown of what shipped vs what's missing.
//   C) Empty-payload notice rewritten from "لم أستلم محتوى" (felt
//      dismissive) to a more useful explanation of the likely cause.
//
// We can't easily test the burst aggregator's full async path here
// (it requires DB + session lock + timer drain). Instead these tests
// pin the WORDING and small helpers so the bug class can't return.

import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../lib/agent.js', import.meta.url), 'utf8');

describe('A — burst headline honesty (n vs filled+extras)', () => {
  test('the new "dropped > 0" branch exists and uses transparent wording', () => {
    assert.match(SRC, /وصلتني \$\{n\} \$\{wordFile\} — رتّبت \$\{accountedFor\} منها/,
      'expected the new transparent headline template');
  });
  test('dropped logic gates on docs.length so empty-state turns are unaffected', () => {
    // The conditional below ensures we don't flag "dropped" for a fresh
    // session where state.docs is empty (files just sit waiting).
    assert.match(SRC, /docs\.length > 0 \? Math\.max\(0, n - accountedFor\) : 0/);
  });
  test('"رتّبت N منها" wording is singular-aware (1 file dropped)', () => {
    assert.match(SRC, /لم يكتمل تحميله/);
    assert.match(SRC, /لم تكتمل تحميلاتها/);
  });
});

describe('B — partial-submit message replaces "لا قلق"', () => {
  test('the dismissive "لا قلق" wording is GONE from any user-facing template', () => {
    // Only consider non-comment lines (strip everything starting with //).
    const codeOnly = SRC
      .split('\n')
      .map(line => line.replace(/^\s*\/\/.*$/, ''))
      .join('\n');
    assert.ok(!/لا قلق،?\s*سيتواصل معك/.test(codeOnly),
      'old dismissive partial message should be removed from user-facing strings');
  });
  test('the new factual breakdown wording is present', () => {
    assert.match(SRC, /الملف المُرسل: \$\{haveCount\} من \$\{docs\.length\} مستندات/);
    assert.match(SRC, /المكتب سيراجع الملف ويُخبرك مباشرة إن احتاج إضافات/);
  });
  test('final receipt acknowledges extras explicitly when present', () => {
    assert.match(SRC, /\$\{haveCount\} ضمن المطلوب \+ \$\{extrasN\} ملف إضافي/);
  });
});

describe('C — empty-payload notice rewritten', () => {
  // Strip line comments for these checks so we can audit user-facing
  // strings without the historical-context comments triggering matches.
  const codeOnly = SRC
    .split('\n')
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  test('the old "لم أستلم محتوى أتعرف عليه" wording is GONE from user-facing text', () => {
    assert.ok(!/لم أستلم محتوى أتعرف عليه/.test(codeOnly),
      'old empty-payload wording should be removed from user-facing strings');
  });
  test('the new wording explains likely causes (voice / sticker)', () => {
    assert.match(SRC, /وصلتني رسالة لا أستطيع قراءتها/);
    assert.match(SRC, /(ربما تسجيل صوتي أو ملصق)/);
  });
});
