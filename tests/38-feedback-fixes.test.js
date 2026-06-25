// Static regression pins for four citizen-feedback fixes (2026-06-26):
//   #1 public/request.html — pay-success toast + scroll to the status area
//   #2 routes/whatsapp.js  — type-aware empty-payload (silent on reactions)
//   #3 routes/chat.js      — web-apply doc labels Arabic-first
//   #4 public/i18n.js      — req.pay.confirmed in BOTH langs + clearer sub
//
// The behavioural paths (a multi-image WhatsApp album, the Thawani redirect)
// need live infra; these source pins ensure the fixes can't silently revert —
// same approach as tests/19-honest-counts.
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const read  = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = s => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const WA   = read('../routes/whatsapp.js');
const CHAT = read('../routes/chat.js');
const REQ  = read('../public/request.html');
const I18N = read('../public/i18n.js');

describe('#2 whatsapp empty-payload is type-aware', () => {
  test('the old "لم أستلم محتوى أتعرف عليه" wording is gone', () => {
    assert.ok(!/لم أستلم محتوى أتعرف عليه/.test(strip(WA)),
      'confusing empty-payload wording should be removed from whatsapp.js');
  });
  test('reactions / non-content events are dropped silently (no reply)', () => {
    assert.match(WA, /SILENT_TYPES\s*=\s*new Set\([^)]*'reaction'/);
    assert.match(WA, /SILENT_TYPES\.has\(mt\)/);
  });
  test('voice / video / sticker get a type-specific notice', () => {
    assert.match(WA, /TYPE_AR\s*=\s*\{/);
    assert.match(WA, /audio:/);
    assert.match(WA, /video:/);
    assert.match(WA, /sticker:/);
  });
});

describe('#3 web-apply doc labels are Arabic-first', () => {
  test('finalLabel prefers label_ar before label_en', () => {
    const m = CHAT.match(/const finalLabel =([\s\S]{0,300}?);/);
    assert.ok(m, 'finalLabel assignment found in routes/chat.js');
    const ar = m[1].indexOf('label_ar');
    const en = m[1].indexOf('label_en');
    assert.ok(ar > -1, 'label_ar must be referenced');
    assert.ok(en === -1 || ar < en, 'label_ar must come before label_en');
  });
});

describe('#1 citizen pay-success: notify + scroll', () => {
  test('onPaymentConfirmed toasts and scrolls to the status section', () => {
    assert.match(REQ, /function onPaymentConfirmed\s*\(/);
    assert.match(REQ, /scrollIntoView/);
  });
  test('fires on the not-paid -> paid transition', () => {
    assert.match(REQ, /const paidNow = req\.payment_status === 'paid'/);
    assert.match(REQ, /if \(paidNow && \(_wasPaid === false \|\| wasPaying\)\) onPaymentConfirmed\(\)/);
  });
});

describe('#4 payment wording in both languages', () => {
  test('req.pay.confirmed present in EN and AR blocks', () => {
    const n = (I18N.match(/'req\.pay\.confirmed'\s*:/g) || []).length;
    assert.equal(n, 2, 'req.pay.confirmed must exist in both en and ar');
  });
  test('payment sub mentions the secure gateway (clearer wording)', () => {
    assert.match(I18N, /بوابة ثواني الآمنة/);
    assert.match(I18N, /secure Thawani gateway/);
  });
});
