// ────────────────────────────────────────────────────────────
// Thawani Pay — eCommerce checkout sessions.
// Docs: https://docs.thawani.om/docs/thawani-ecommerce-api
//
// Flow we implement (the spec's "Hosted Checkout"):
//   1) POST {base}/api/v1/checkout/session
//        headers:  thawani-api-key: <secret>
//        body: {
//          client_reference_id, mode: 'payment',
//          products: [{ name, quantity, unit_amount }],   // unit_amount in baisa
//          success_url, cancel_url, metadata
//        }
//        → data.session_id
//   2) Redirect the citizen to:
//        {base}/pay/{session_id}?key={publishable_key}
//   3) After the citizen pays, Thawani redirects to success_url. Our
//      success endpoint calls GET {base}/api/v1/checkout/session/{id}
//      and only marks paid when payment_status === 'paid'. This is the
//      defensive verification — never trust a bare redirect.
//   4) (Optional) Thawani may also POST a webhook to the URL configured
//      on their dashboard. We expose POST /api/payments/webhook/thawani
//      that does the same retrieve-and-verify.
//
// Amounts: Thawani's `unit_amount` is in BAISA (1 OMR = 1000 baisa). We
// convert OMR→baisa here so callers stay in OMR.
//
// Demo / sandbox:
//   THAWANI_ENV=sandbox (default)  → https://uatcheckout.thawani.om
//   THAWANI_ENV=production         → https://checkout.thawani.om
//   Sandbox public test keys (rotate before production):
//     secret      = rRQ26GcsZzoEhbrP2HZvLYDbn9C9et
//     publishable = HGvTMLDssJghr9tlN9gr4DVYt0qyBy
// ────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

const SECRET_KEY      = (process.env.THAWANI_SECRET_KEY      || '').trim();
const PUBLISHABLE_KEY = (process.env.THAWANI_PUBLISHABLE_KEY || '').trim();
const ENV             = (process.env.THAWANI_ENV || 'sandbox').toLowerCase();
const PUBLIC_BASE     = (process.env.PUBLIC_BASE_URL || 'http://localhost:3030').replace(/\/+$/, '');

export const THAWANI_ENABLED = !!(SECRET_KEY && PUBLISHABLE_KEY);
export const THAWANI_ENV     = ENV;

const BASE = ENV === 'production'
  ? 'https://checkout.thawani.om'
  : 'https://uatcheckout.thawani.om';

const omrToBaisa = (n) => Math.max(0, Math.round(Number(n || 0) * 1000));

// ─── createSession ─────────────────────────────────────────
// Returns the same shape lib/amwal.js's createPaymentLink does so the
// officer route can use either provider transparently:
//   { url, merchantReference, amwalOrderId (=session_id), stubbed?: false }
//
// We also expose `provider` and `session_id` so the dispatcher can stash
// them on the request row for later retrieve/refund.
export async function createThawaniSession({
  amountOmr,
  merchantReference,
  customerEmail,
  description,
  productName
}) {
  if (!THAWANI_ENABLED) throw new Error('thawani_not_configured');

  const unit_amount = omrToBaisa(amountOmr);
  if (unit_amount < 100) throw new Error('amount_too_small'); // Thawani minimum is 100 baisa = 0.100 OMR

  const safeName = (productName || description || 'Sanad service request').slice(0, 100);
  const safeDesc = (description || '').slice(0, 200);

  const body = {
    client_reference_id: merchantReference,
    mode: 'payment',
    products: [{
      name: safeName,
      quantity: 1,
      unit_amount
    }],
    success_url: `${PUBLIC_BASE}/api/payments/thawani/success?ref=${encodeURIComponent(merchantReference)}`,
    cancel_url:  `${PUBLIC_BASE}/api/payments/thawani/cancel?ref=${encodeURIComponent(merchantReference)}`,
    metadata: {
      merchant_ref: merchantReference,
      description: safeDesc,
      customer_email: customerEmail || ''
    }
  };

  const r = await fetch(`${BASE}/api/v1/checkout/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'thawani-api-key': SECRET_KEY
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = data?.description || data?.message || `thawani-create ${r.status}`;
    throw new Error(`thawani_create_failed: ${err}`);
  }
  // Thawani envelope: { success, code, description, data: { session_id, ... } }
  const session_id = data?.data?.session_id || data?.session_id;
  if (!session_id) throw new Error('thawani_no_session_id');

  return {
    provider: 'thawani',
    session_id,
    url: `${BASE}/pay/${session_id}?key=${PUBLISHABLE_KEY}`,
    merchantReference,
    // alias for compatibility with the existing Amwal call sites
    amwalOrderId: session_id,
    stubbed: false
  };
}

// ─── retrieveSession ────────────────────────────────────────
// GET {base}/api/v1/checkout/session/{id} — used by:
//   • the success-redirect verifier (lib/payments)
//   • the optional webhook handler
//   • a manual "did this payment go through?" admin tool
// Returns the parsed `data` object (Thawani's envelope wraps it once).
export async function retrieveThawaniSession(session_id) {
  if (!THAWANI_ENABLED) throw new Error('thawani_not_configured');
  if (!session_id) throw new Error('no_session_id');
  const r = await fetch(`${BASE}/api/v1/checkout/session/${encodeURIComponent(session_id)}`, {
    headers: { 'thawani-api-key': SECRET_KEY }
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const err = json?.description || json?.message || `thawani-retrieve ${r.status}`;
    throw new Error(`thawani_retrieve_failed: ${err}`);
  }
  return json?.data || json;
}

// ─── isPaid ─────────────────────────────────────────────────
// Thawani uses the literal "paid" for completed sessions. Other documented
// values include 'unpaid', 'cancelled', 'expired'. Treat anything else as
// not paid.
export function isThawaniPaid(sessionData) {
  return String(sessionData?.payment_status || '').toLowerCase() === 'paid';
}

// ─── verifyWebhookSignature ────────────────────────────────
// Thawani's webhook signature scheme isn't formally documented — most
// integrators rely on the retrieve-session round-trip for trust. This
// helper is a defensive shell that returns true if either:
//   • THAWANI_WEBHOOK_SECRET is unset (no extra check), OR
//   • the X-Thawani-Signature header matches HMAC-SHA256 of the raw body
//     using THAWANI_WEBHOOK_SECRET.
// Either way the handler ALSO calls retrieveThawaniSession and that's the
// real source of truth.
export function verifyThawaniSignature(rawBody, signatureHeader) {
  const secret = process.env.THAWANI_WEBHOOK_SECRET || '';
  if (!secret) return true; // soft mode — retrieve is the truth
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
