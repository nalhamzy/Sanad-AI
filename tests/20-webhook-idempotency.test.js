// Regression test for the prod bug from +96892888715 (2026-05-09 15:07:47):
// citizen sent ONE attachment, bot replied "📥 استلمت 2 ملفين". Root cause:
// Meta retried webhook delivery (network blip / slow ACK / container blip)
// and the route had no idempotency check. Each delivery → runTurn → armBurst
// → cur.count++. Net result: count=2 for one logical citizen action.
//
// Fix: SEEN_WEBHOOK_IDS Map keyed on msg.id (Meta's stable per-message id).
// First delivery → process + remember id with 5-min TTL.
// Subsequent deliveries with same id → drop silently (still ACK 200).

import './helpers.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { isDuplicateWebhook, _resetSeenWebhookIds } = await import('../routes/whatsapp.js');

describe('isDuplicateWebhook(id) — Meta retry suppression', () => {
  beforeEach(() => _resetSeenWebhookIds());

  test('first time seeing an id → not a duplicate', () => {
    assert.equal(isDuplicateWebhook('wamid.AAAA1'), false);
  });

  test('second time same id → flagged as duplicate', () => {
    isDuplicateWebhook('wamid.BBBB2');
    assert.equal(isDuplicateWebhook('wamid.BBBB2'), true);
  });

  test('different ids treated independently', () => {
    isDuplicateWebhook('wamid.X');
    assert.equal(isDuplicateWebhook('wamid.Y'), false);
    assert.equal(isDuplicateWebhook('wamid.X'), true);
  });

  test('null / undefined / empty id → never a duplicate (no false positives)', () => {
    assert.equal(isDuplicateWebhook(null), false);
    assert.equal(isDuplicateWebhook(undefined), false);
    assert.equal(isDuplicateWebhook(''), false);
    assert.equal(isDuplicateWebhook(null), false); // still false on retry of null
  });

  test('regression: the +96892888715 scenario', () => {
    // Meta delivers the SAME attachment twice (retry). Without dedup, both
    // hit runTurn and armBurst increments to 2 for one citizen action.
    const metaMsgId = 'wamid.HBgLOTY4OTI4ODg3MTUVAgARGBI3RjlBQTM3RjQ1ODE5NjUyMzAA';
    assert.equal(isDuplicateWebhook(metaMsgId), false, 'first delivery: process');
    assert.equal(isDuplicateWebhook(metaMsgId), true,  'second delivery (Meta retry): drop');
    assert.equal(isDuplicateWebhook(metaMsgId), true,  'third delivery: still drop');
  });
});
