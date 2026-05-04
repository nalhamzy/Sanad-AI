// WhatsApp webhook signature verification — unit tests for the HMAC-SHA256
// gate that wraps the Meta WhatsApp Cloud API webhook. A forged signature
// here means an attacker can inject citizen messages into the agent loop
// (creating fake requests, triggering uploads, etc.). Same risk shape as
// the Thawani signature gate; same defensive contract.
//
// Coverage:
//   • soft mode (no APP_SECRET configured) → trusts caller
//   • missing / malformed prefix          → rejected
//   • wrong key signature                  → rejected
//   • length mismatch                      → rejected without throwing
//   • valid signature                      → accepted
//   • non-hex prefix passes regex but bad hex doesn't crash timingSafeEqual
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { verifyMetaSignature } = await import('../routes/whatsapp.js');

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('routes/whatsapp.js · verifyMetaSignature()', () => {

  test('soft mode — empty secret → trusts the caller (dev / web-only mode)', () => {
    assert.equal(verifyMetaSignature(Buffer.from('{}'), 'anything', ''), true);
    assert.equal(verifyMetaSignature(Buffer.from('{}'), null, ''), true);
    assert.equal(verifyMetaSignature(Buffer.from('{}'), undefined, ''), true);
  });

  test('strict mode — missing header → rejected', () => {
    assert.equal(verifyMetaSignature(Buffer.from('{}'), null, 'secret'), false);
    assert.equal(verifyMetaSignature(Buffer.from('{}'), '', 'secret'), false);
    assert.equal(verifyMetaSignature(Buffer.from('{}'), undefined, 'secret'), false);
  });

  test('strict mode — header without sha256= prefix → rejected', () => {
    // Old-style "sha1=..." or no prefix at all must not slip through.
    const body = Buffer.from('{"x":1}');
    const expected = crypto.createHmac('sha256', 'secret').update(body).digest('hex');
    assert.equal(verifyMetaSignature(body, expected, 'secret'), false,
      'raw hex without sha256= prefix must be rejected');
    assert.equal(verifyMetaSignature(body, 'sha1=' + expected, 'secret'), false,
      'sha1= prefix must be rejected even if rest is valid hex');
    assert.equal(verifyMetaSignature(body, 'md5=' + expected, 'secret'), false);
  });

  test('strict mode — wrong secret → rejected', () => {
    const body = Buffer.from('{"webhook":"event"}');
    const wrongSig = sign('NOT-THE-RIGHT-SECRET', body);
    assert.equal(verifyMetaSignature(body, wrongSig, 'real-secret'), false,
      'forged HMAC with wrong key must be rejected');
  });

  test('strict mode — length mismatch → rejected without throwing', () => {
    // crypto.timingSafeEqual throws on mismatched buffer sizes; the helper's
    // length check must guard it. A regression here would crash the webhook
    // handler under attack instead of returning 403.
    assert.equal(verifyMetaSignature(Buffer.from('{}'), 'sha256=short', 'secret'), false);
    assert.equal(verifyMetaSignature(Buffer.from('{}'), 'sha256=' + 'a'.repeat(2000), 'secret'), false);
  });

  test('strict mode — non-hex chars after prefix → rejected without throwing', () => {
    // Buffer.from(s, 'hex') silently truncates on bad chars. Confirm we
    // still return a boolean, not a thrown exception.
    const body = Buffer.from('{}');
    const result = verifyMetaSignature(body, 'sha256=' + 'zz'.repeat(32), 'secret');
    assert.equal(typeof result, 'boolean');
    assert.equal(result, false);
  });

  test('strict mode — valid signature → accepted', () => {
    const secret = 'meta-app-secret-test-1';
    const body = Buffer.from('{"entry":[{"id":"123","changes":[{"value":{"messages":[]}}]}]}');
    const validSig = sign(secret, body);
    assert.equal(verifyMetaSignature(body, validSig, secret), true);
  });

  test('strict mode — accepts empty body (Meta sends GET-style probes)', () => {
    const secret = 'meta-app-secret-test-2';
    const validSig = sign(secret, Buffer.alloc(0));
    assert.equal(verifyMetaSignature(Buffer.alloc(0), validSig, secret), true);
    // null/undefined body should be coerced to an empty buffer, not throw.
    assert.equal(verifyMetaSignature(null, validSig, secret), true);
    assert.equal(verifyMetaSignature(undefined, validSig, secret), true);
  });
});
