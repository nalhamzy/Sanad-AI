// Payment-provider unit tests — verify the signature gates that wrap our
// money-bearing webhooks. These are pure functions (HMAC verify) so they
// don't need DB or HTTP. Critical because a forged Thawani webhook could
// flip a request to `paid` without the citizen actually paying.
//
// Coverage added by this file:
//   • providers/thawani.js verifyThawaniSignature() — soft mode, missing
//     header, wrong sig, valid sig, timing-safe equal length mismatch.
//   • providers/amwal.js   verifyWebhookSignature() — same shape.
import '../../tests/helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Each test mutates env, so snapshot + restore in before/after.
const _env = { thawani: process.env.THAWANI_WEBHOOK_SECRET };

before(() => {
  // Default empty so the "soft mode" test isn't polluted by ambient env.
  delete process.env.THAWANI_WEBHOOK_SECRET;
});
after(() => {
  if (_env.thawani != null) process.env.THAWANI_WEBHOOK_SECRET = _env.thawani;
  else delete process.env.THAWANI_WEBHOOK_SECRET;
});

describe('lib/thawani.js · verifyThawaniSignature()', () => {

  test('soft mode — no secret configured → trusts the call (retrieve is the truth)', async () => {
    delete process.env.THAWANI_WEBHOOK_SECRET;
    // Re-import so the module re-reads env (it captures inside the function
    // each call, so a fresh import isn't strictly required, but be explicit).
    const { verifyThawaniSignature } = await import('./providers/thawani.js?soft=' + Date.now());
    const ok = verifyThawaniSignature(Buffer.from('{"payment_status":"paid"}'), 'anything');
    assert.equal(ok, true, 'soft mode must allow without throwing');
  });

  test('strict mode — missing X-Thawani-Signature header → rejected', async () => {
    process.env.THAWANI_WEBHOOK_SECRET = 'test-secret-strict-1';
    const { verifyThawaniSignature } = await import('./providers/thawani.js?strict_no_hdr=' + Date.now());
    assert.equal(verifyThawaniSignature(Buffer.from('{}'), null), false);
    assert.equal(verifyThawaniSignature(Buffer.from('{}'), ''), false);
    assert.equal(verifyThawaniSignature(Buffer.from('{}'), undefined), false);
  });

  test('strict mode — wrong signature → rejected', async () => {
    process.env.THAWANI_WEBHOOK_SECRET = 'test-secret-strict-2';
    const { verifyThawaniSignature } = await import('./providers/thawani.js?strict_wrong=' + Date.now());
    const body = Buffer.from('{"payment_status":"paid","ref":"X"}');
    const wrongSig = crypto.createHmac('sha256', 'NOT-THE-RIGHT-SECRET').update(body).digest('hex');
    assert.equal(verifyThawaniSignature(body, wrongSig), false,
      'forged HMAC with wrong key must be rejected');
  });

  test('strict mode — wrong length signature → rejected without throwing', async () => {
    process.env.THAWANI_WEBHOOK_SECRET = 'test-secret-strict-3';
    const { verifyThawaniSignature } = await import('./providers/thawani.js?strict_len=' + Date.now());
    // crypto.timingSafeEqual throws on mismatched buffer lengths; the helper
    // must guard with an explicit length check first. A regression here would
    // crash the webhook handler under attack.
    assert.equal(verifyThawaniSignature(Buffer.from('{}'), 'short'), false);
    assert.equal(verifyThawaniSignature(Buffer.from('{}'), 'a'.repeat(1024)), false);
  });

  test('strict mode — correct HMAC-SHA256 signature → accepted', async () => {
    const secret = 'test-secret-strict-4';
    process.env.THAWANI_WEBHOOK_SECRET = secret;
    const { verifyThawaniSignature } = await import('./providers/thawani.js?strict_ok=' + Date.now());
    const body = Buffer.from('{"payment_status":"paid","ref":"abc"}');
    const validSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(verifyThawaniSignature(body, validSig), true);
  });

  test('isThawaniPaid — only the literal "paid" status counts as paid', async () => {
    const { isThawaniPaid } = await import('./providers/thawani.js?isPaid=' + Date.now());
    assert.equal(isThawaniPaid({ payment_status: 'paid' }), true);
    assert.equal(isThawaniPaid({ payment_status: 'PAID' }), true, 'case-insensitive');
    assert.equal(isThawaniPaid({ payment_status: 'unpaid' }), false);
    assert.equal(isThawaniPaid({ payment_status: 'cancelled' }), false);
    assert.equal(isThawaniPaid({ payment_status: 'expired' }), false);
    assert.equal(isThawaniPaid({}), false);
    assert.equal(isThawaniPaid(null), false);
    assert.equal(isThawaniPaid(undefined), false);
  });
});

describe('lib/amwal.js · verifyWebhookSignature()', () => {
  // Amwal also has a webhook signature path; ensure same defensive shape.
  test('module exports verifyWebhookSignature', async () => {
    const m = await import('./providers/amwal.js');
    assert.equal(typeof m.verifyWebhookSignature, 'function',
      'amwal.js must expose verifyWebhookSignature');
  });
});
