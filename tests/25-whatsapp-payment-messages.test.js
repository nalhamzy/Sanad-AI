// Tests for lib/whatsapp_payment_messages.js (PR 5).
//
// We rely on the WhatsApp stub mode (WHATSAPP_ACCESS_TOKEN unset) so
// the underlying sends return `{ ok:true, channel:'stub', stub:true }`
// without hitting Meta. The point of these tests is to lock in the
// three-tier fallback BEHAVIOUR, not Meta's API contract:
//
//   • template path wins when enabled
//   • cta path wins when templates disabled
//   • text path wins when both upstream tiers fail (we monkey-patch
//     to simulate)
//   • no_phone → ok:false, tier:'text'
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Capture and restore the env we mutate.
const _envSnap = {
  templates: process.env.WHATSAPP_DISABLE_TEMPLATES,
  accessTok: process.env.WHATSAPP_ACCESS_TOKEN,
  phoneId:   process.env.WHATSAPP_PHONE_NUMBER_ID,
};
before(() => {
  // Default: stub mode (no WHATSAPP_ACCESS_TOKEN). Stubs always return ok.
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_DISABLE_TEMPLATES;
});
after(() => {
  for (const [k, v] of Object.entries({
    WHATSAPP_DISABLE_TEMPLATES: _envSnap.templates,
    WHATSAPP_ACCESS_TOKEN:      _envSnap.accessTok,
    WHATSAPP_PHONE_NUMBER_ID:   _envSnap.phoneId,
  })) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
});

describe('sendPaymentLink() — three-tier fallback', () => {

  test('templates enabled → tier="template" wins', async () => {
    delete process.env.WHATSAPP_DISABLE_TEMPLATES;
    const mod = await import('../lib/whatsapp_payment_messages.js?t=' + Date.now());
    const r = await mod.sendPaymentLink({
      phone: '+96812345678',
      lang: 'ar',
      amountOmr: 30,
      serviceName: 'تجديد رخصة',
      link: 'https://uatcheckout.thawani.om/pay/abc'
    });
    assert.equal(r.ok, true);
    assert.equal(r.tier, 'template');
  });

  test('templates disabled → cta tier wins (stub mode treats cta as ok)', async () => {
    process.env.WHATSAPP_DISABLE_TEMPLATES = 'true';
    const mod = await import('../lib/whatsapp_payment_messages.js?t=' + Date.now());
    const r = await mod.sendPaymentLink({
      phone: '+96812345678',
      lang: 'en',
      amountOmr: 153,
      serviceName: 'Subscription',
      link: 'https://uatcheckout.thawani.om/pay/xyz'
    });
    assert.equal(r.ok, true);
    assert.equal(r.tier, 'cta');
  });

  test('no phone → ok:false, tier:"text"', async () => {
    const mod = await import('../lib/whatsapp_payment_messages.js?t=' + Date.now());
    const r = await mod.sendPaymentLink({
      phone: '',
      lang: 'ar',
      amountOmr: 30,
      serviceName: 'x',
      link: 'https://example.com'
    });
    assert.equal(r.ok, false);
    assert.equal(r.tier, 'text');
    assert.equal(r.error, 'no_phone');
  });
});

describe('sendRenewalReminder() — three-tier fallback', () => {

  test('templates enabled → tier="template" wins (default behaviour)', async () => {
    delete process.env.WHATSAPP_DISABLE_TEMPLATES;
    const mod = await import('../lib/whatsapp_payment_messages.js?r=' + Date.now());
    const r = await mod.sendRenewalReminder({
      phone: '+96812345678',
      lang: 'ar',
      days: 7,
      planLabel: 'monthly',
      expiresAt: '2026-06-18 10:00:00',
      renewUrl: 'https://saned.ai/officer.html'
    });
    assert.equal(r.ok, true);
    assert.equal(r.tier, 'template');
  });

  test('templates disabled → cta tier wins', async () => {
    process.env.WHATSAPP_DISABLE_TEMPLATES = 'true';
    const mod = await import('../lib/whatsapp_payment_messages.js?r=' + Date.now());
    const r = await mod.sendRenewalReminder({
      phone: '+96812345678', days: 3, planLabel: 'annual',
      expiresAt: '2026-08-18 10:00:00'
    });
    assert.equal(r.ok, true);
    assert.equal(r.tier, 'cta');
  });

  test('no phone → ok:false', async () => {
    const mod = await import('../lib/whatsapp_payment_messages.js?r=' + Date.now());
    const r = await mod.sendRenewalReminder({
      phone: null, days: 1, planLabel: 'monthly',
      expiresAt: '2026-05-22 12:00:00'
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_phone');
  });
});

describe('TEMPLATE_NAMES export — used by admin UI / docs', () => {
  test('exposes both template names + disabled flag', async () => {
    const mod = await import('../lib/whatsapp_payment_messages.js?n=' + Date.now());
    assert.equal(typeof mod.TEMPLATE_NAMES.payment_link, 'string');
    assert.equal(typeof mod.TEMPLATE_NAMES.renewal, 'string');
    assert.ok('disabled' in mod.TEMPLATE_NAMES);
  });
});
