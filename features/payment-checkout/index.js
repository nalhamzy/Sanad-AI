// payment-checkout · vertical slice
// =================================
// All HTTP, business, and provider code for the citizen-pays-the-office
// money flow lives in this folder:
//
//   features/payment-checkout/
//     index.js               ← public entry (this file)
//     routes.js              ← Express router (mounted at /api/payments)
//     payments.test.js       ← signature-verify unit tests
//     providers/
//       amwal.js             ← Amwal provider integration
//       thawani.js           ← Thawani Pay provider integration
//
// Cross-feature dependencies (legitimately shared infra):
//   • lib/db.js, lib/auth.js, lib/officer_helpers.js (audit), lib/agent.js
//     (storeMessage), lib/whatsapp_send.js
//
// Pilot extracted per the architecture review (2026-05) — chosen because the
// payment subsystem already had clear seams (two provider files + one route
// file + one officer.js call site). If this pattern proves out we extract
// `officer-document-review` next; otherwise we stop and keep the rest in the
// horizontal layout.

export { paymentsRouter, markRequestPaid } from './routes.js';

// Re-export provider primitives so callers outside the slice (e.g.
// routes/officer.js's /payment/start) speak to the slice through one entry
// point instead of reaching into provider files directly.
export {
  createPaymentLink,
  newMerchantRef,
  AMWAL_ENABLED,
  verifyWebhookSignature
} from './providers/amwal.js';

export {
  THAWANI_ENABLED,
  createThawaniSession,
  retrieveThawaniSession,
  isThawaniPaid,
  verifyThawaniSignature
} from './providers/thawani.js';
