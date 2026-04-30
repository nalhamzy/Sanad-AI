// Amwal Pay integration — link-based checkout.
//
// Flow for office subscription:
//   1. POST /api/payments/subscription/checkout  →  this module creates a
//      CreatePaymentLink request, stores the link in office_subscription,
//      returns the URL so the office browser redirects to the Amwal page.
//   2. User pays on Amwal's hosted page.
//   3. Amwal POSTs webhook → verifyWebhookSignature() → we flip the
//      office_subscription row to 'active' and grant 70 credits.
//   4. User returns to our /office-payment.html?ref=... which polls status.
//
// STUB MODE:
//   If AMWAL_MERCHANT_ID / AMWAL_SECRET aren't set, createPaymentLink returns
//   a fake /api/payments/_stub/{ref} URL that immediately marks the payment
//   active on visit. This lets the pilot run before Amwal onboarding finishes.
//
// Signing rules (per Amwal docs):
//   • collect all body fields (strings only, skip nulls)
//   • sort keys alphabetically A→Z
//   • build `key1=value1&key2=value2&...`
//   • HMAC-SHA256(secret = HEX-DECODED(AMWAL_SECRET), body)
//   • uppercase the hex digest → `signature` field

import crypto from 'crypto';

const AMWAL_ENABLED = Boolean(process.env.AMWAL_MERCHANT_ID && process.env.AMWAL_SECRET);
const AMWAL_HOST = process.env.AMWAL_HOST ||
  (process.env.NODE_ENV === 'production'
    ? 'https://webhook.amwalpg.com'
    : 'https://test.amwalpg.com:14443');
const OMR_CURRENCY = 512; // ISO-4217 numeric for Omani Rial
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:3030';

export { AMWAL_ENABLED };

// ─── Signature helpers ─────────────────────────────────────
// Sort keys; skip null/undefined/empty; stringify; HMAC-SHA256 with hex secret.
export function signPayload(payload, secretHex = process.env.AMWAL_SECRET || '') {
  const keys = Object.keys(payload).filter(k => payload[k] !== null && payload[k] !== undefined && payload[k] !== '').sort();
  const body = keys.map(k => `${k}=${payload[k]}`).join('&');
  const key = Buffer.from(secretHex, 'hex');
  return crypto.createHmac('sha256', key).update(body).digest('hex').toUpperCase();
}

export function verifyWebhookSignature(body, providedSig, secretHex = process.env.AMWAL_SECRET || '') {
  // The webhook body contains a `signature` key; re-sign without it and compare.
  const { signature, ...rest } = body || {};
  const expected = signPayload(rest, secretHex);
  if (!signature || !providedSig) return false;
  const a = Buffer.from(String(providedSig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// ─── Payment link creation ─────────────────────────────────
// Returns { url, merchantReference, amwalOrderId }.
export async function createPaymentLink({ amountOmr, merchantReference, customerEmail, description }) {
  if (!AMWAL_ENABLED) {
    // Stub mode: route the citizen through our own hosted-checkout page
    // instead of doing a silent redirect. This matches what Thawani / Amwal
    // give the merchant in production — a URL the user lands on, types
    // card details into, and confirms.
    //   • Request payments  → /pay.html?ref=…  (Thawani-style, citizen-facing)
    //   • Subscription pay  → /api/payments/_stub/pay  (legacy office sub flow)
    // Request payments are detected by the `req…` prefix that the officer
    // route uses (newMerchantRef('reqN')).
    const isRequestPayment = /^req\d+/i.test(merchantReference);
    const url = isRequestPayment
      ? `${PUBLIC_BASE}/pay.html?ref=${encodeURIComponent(merchantReference)}`
      : `${PUBLIC_BASE}/api/payments/_stub/pay?ref=${encodeURIComponent(merchantReference)}`;
    return {
      url,
      merchantReference,
      amwalOrderId: `stub-${merchantReference}`,
      stubbed: true
    };
  }

  const payload = {
    merchantId: process.env.AMWAL_MERCHANT_ID,
    merchantReference,
    amount: amountOmr.toFixed(3),       // Amwal wants 3 decimals for OMR
    currency: OMR_CURRENCY,
    customerEmail: customerEmail || '',
    description: description || 'Sanad-AI subscription',
    returnUrl:  `${PUBLIC_BASE}/office-payment.html?ref=${encodeURIComponent(merchantReference)}`,
    webhookUrl: `${PUBLIC_BASE}/api/payments/webhook`
  };
  payload.signature = signPayload(payload);

  const res = await fetch(`${AMWAL_HOST}/MerchantOrder/CreatePaymentLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`amwal_create_link_failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Amwal's response shape: { paymentUrl, orderId, ... } — adjust if docs differ.
  return {
    url: data.paymentUrl || data.PaymentUrl,
    merchantReference,
    amwalOrderId: data.orderId || data.OrderId || null
  };
}

// Short, URL-safe random reference.
export function newMerchantRef(prefix = 'sanad') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}
