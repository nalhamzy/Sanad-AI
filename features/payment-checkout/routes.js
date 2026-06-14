// Payment routes for office subscription (35 OMR = 70 credits).
//
// Endpoints:
//   POST /api/payments/subscription/checkout   — office owner initiates pack purchase
//   GET  /api/payments/subscription/status     — poll current status (for the
//                                                "waiting for payment" page)
//   POST /api/payments/webhook                 — Amwal posts here on status change
//   GET  /api/payments/_stub/pay?ref=…         — dev-only shortcut that fakes a paid webhook
//
// Credit logic:
//   On successful payment we grant `credits_granted` (default 70) to the office,
//   set `subscription_status='active'`, and write an audit row in credit_ledger.
//   We use a UNIQUE (office_id, request_id) index on credit_ledger to keep
//   per-request consumption idempotent; for the subscription grant row we
//   store request_id=NULL which the UNIQUE index allows to repeat intentionally
//   (one grant per subscription purchase).

import { Router } from 'express';
import { db } from '../../lib/db.js';
import { requireOfficer } from '../../lib/auth.js';
import { createPaymentLink, verifyWebhookSignature, newMerchantRef, AMWAL_ENABLED } from './providers/amwal.js';
import {
  THAWANI_ENABLED,
  createThawaniSession,
  retrieveThawaniSession,
  isThawaniPaid,
  verifyThawaniSignature,
} from './providers/thawani.js';
import {
  PLANS, PLAN_CODES, getPlan, isValidPlanCode,
  computeExpiry, toSqlDatetime
} from '../../lib/plans.js';
import { DEBUG_ENABLED } from '../../lib/env.js';
import { storeMessage } from '../../lib/agent.js';
import { sendWhatsAppText, isWhatsAppSession } from '../../lib/whatsapp_send.js';
import { audit } from '../../lib/officer_helpers.js';

// Feature flag for the time-based subscription plans (monthly/quarterly/
// semi-annual/annual). Off by default in production — flip it on per
// deploy as you roll out. DEBUG_MODE turns it on for local development.
// Legacy /subscription/checkout (starter-70 pack) keeps working either way.
const SUBS_V1_ENABLED =
  process.env.SANAD_SUBS_V1 === 'true' || process.env.DEBUG_MODE === 'true';

export const paymentsRouter = Router();

// ════════════════════════════════════════════════════════════
// REQUEST payments — citizen pays the office for a specific service
// request. Distinct from the office subscription flow above. Status
// transitions: awaiting_payment → in_progress (with paid_at set), which
// unlocks the officer ↔ citizen chat.
// ════════════════════════════════════════════════════════════

// Idempotent: marking a request paid more than once is a no-op. Returns
// { alreadyPaid:true } in that case so the webhook + stub agree.
export async function markRequestPaid(requestId, source = 'webhook') {
  const { rows } = await db.execute({
    sql: `SELECT id, session_id, office_id, status, payment_status, paid_at,
                 payment_amount_omr, payment_ref,
                 (SELECT phone FROM citizen WHERE citizen.id = request.citizen_id) AS citizen_phone,
                 (SELECT language_pref FROM citizen WHERE citizen.id = request.citizen_id) AS lang_pref,
                 (SELECT name_en FROM service_catalog WHERE service_catalog.id = request.service_id) AS service_name,
                 (SELECT name_ar FROM service_catalog WHERE service_catalog.id = request.service_id) AS service_name_ar
            FROM request WHERE id=?`,
    args: [requestId]
  });
  const r = rows[0];
  if (!r) return { error: 'not_found' };
  if (r.payment_status === 'paid' || r.paid_at) {
    return { alreadyPaid: true, request_id: r.id };
  }
  // Atomic flip — guard on payment_status='awaiting' to avoid resurrecting
  // a refunded or cancelled request.
  const upd = await db.execute({
    sql: `UPDATE request
             SET payment_status='paid',
                 paid_at=datetime('now'),
                 status=CASE WHEN status='awaiting_payment' THEN 'in_progress' ELSE status END,
                 last_event_at=datetime('now')
           WHERE id=? AND payment_status='awaiting'`,
    args: [requestId]
  });
  if (!upd.rowsAffected) return { error: 'bad_state' };

  await audit({
    actor: { type: 'system', id: null },
    action: 'request_paid',
    target: 'request',
    targetId: requestId,
    diff: { source, amount_omr: r.payment_amount_omr, ref: r.payment_ref }
  });

  // Notify the citizen — chat is now unlocked.
  // ANONYMITY: never name the office. Use platform voice ("we").
  const lang = (r.lang_pref || 'ar') === 'en' ? 'en' : 'ar';
  const sname = (lang === 'ar' && r.service_name_ar) ? r.service_name_ar : (r.service_name || '');
  const paidMsg = lang === 'ar'
    ? `✅ تم استلام دفعتك. نُنفّذ معاملتك "${sname}" الآن. ستصلك التحديثات عبر هذه المحادثة.`
    : `✅ Payment received. We're processing your "${sname}" request now. You'll get updates here.`;
  await storeMessage({
    session_id: r.session_id, request_id: requestId,
    direction: 'out', actor_type: 'bot',
    body_text: paidMsg
  });
  if (isWhatsAppSession(r.session_id) && r.citizen_phone) {
    sendWhatsAppText(r.citizen_phone, paidMsg).catch(() => {});
  }

  return { ok: true, request_id: requestId, office_id: r.office_id };
}

// Citizen confirms payment (used by /request.html if the gateway redirects
// back without a webhook in dev). DEBUG-mode shortcut — production trusts the
// webhook only. Returns 403 outside DEBUG_MODE.
// Marks a request paid without going through any gateway. Available in
// DEBUG_MODE OR when SANAD_TEST_PAY=true (a narrow kill-switch that doesn't
// open up the rest of the debug surface). Use during pilot demos so the
// post-pay flow can be exercised without typing card numbers.
paymentsRouter.post('/request/:id/confirm-stub', async (req, res) => {
  // DEBUG_ENABLED is hard-off in production. SANAD_TEST_PAY remains an
  // explicit opt-in escape hatch for a controlled pilot demo, but it too
  // is refused once NODE_ENV==='production' unless the operator also kept
  // a non-prod NODE_ENV. (Use a staging deploy for demos, not prod.)
  const allowed = DEBUG_ENABLED ||
    (process.env.SANAD_TEST_PAY === 'true' && process.env.NODE_ENV !== 'production');
  if (!allowed) return res.status(403).json({ error: 'test_pay_disabled' });
  const id = Number(req.params.id);
  const result = await markRequestPaid(id, 'stub-confirm');
  res.json(result);
});

// ────────────────────────────────────────────────────────────
// THAWANI-style hosted-checkout endpoints (dev / dummy gateway)
// ────────────────────────────────────────────────────────────
// In production the citizen would land on Thawani's hosted page; here we
// render our own /pay.html that mimics the experience (order summary +
// card form + confirm). The flow:
//
//   1. GET  /api/payments/dummy/session/:ref  → returns the order details
//      that /pay.html shows (amount, service, office, etc.)
//   2. POST /api/payments/dummy/pay           → marks the request paid +
//      returns { ok, redirect_to: '/request.html?id=N&paid=1' }
//
// Both endpoints work only when the request's payment_ref starts with
// "req" (so this can't be abused to flip a subscription payment) and
// only when DEBUG_MODE is on or AMWAL_ENABLED is off (i.e. we're in the
// dummy-gateway window).

function dummyAllowed() {
  // The dummy/stub gateway lets a caller mark a request PAID without real
  // money. That must NEVER be reachable in production. Previously this was
  // gated on `!AMWAL_ENABLED`, which is TRUE in production (we use Thawani,
  // not Amwal) — so the stubs were silently live. Now gated on DEBUG_ENABLED,
  // which is hard-off when NODE_ENV==='production'.
  return DEBUG_ENABLED;
}

paymentsRouter.get('/dummy/session/:ref', async (req, res) => {
  if (!dummyAllowed()) return res.status(404).end();
  const ref = String(req.params.ref || '');
  if (!ref.startsWith('req')) return res.status(400).json({ error: 'bad_ref' });
  // ANONYMITY: payment-page payload never names the office to the citizen.
  // Pricing breakdown (office vs government fee) is allowed and useful for trust;
  // office identity is not.
  const { rows } = await db.execute({
    sql: `SELECT r.id, r.payment_amount_omr, r.payment_ref, r.payment_status,
                 r.office_fee_omr, r.government_fee_omr,
                 s.name_en AS service_name, s.name_ar AS service_name_ar,
                 s.entity_en, s.entity_ar
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.payment_ref = ? LIMIT 1`,
    args: [ref]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'unknown_ref' });
  res.json({
    request_id: r.id,
    amount_omr: r.payment_amount_omr,
    office_fee_omr: r.office_fee_omr,
    government_fee_omr: r.government_fee_omr,
    payment_status: r.payment_status,
    service_name: r.service_name,
    service_name_ar: r.service_name_ar,
    entity_en: r.entity_en,
    entity_ar: r.entity_ar,
    merchant_ref: ref
  });
});

paymentsRouter.post('/dummy/pay', async (req, res) => {
  if (!dummyAllowed()) return res.status(404).end();
  const ref = String(req.body?.ref || '');
  if (!ref.startsWith('req')) return res.status(400).json({ error: 'bad_ref' });
  // Best-effort form validation: in real Thawani these fields are processed
  // by their hosted form. Here we just confirm at least SOMETHING was typed
  // so the dummy feels real (a totally empty form should fail).
  const card = String(req.body?.card || '').replace(/\s/g, '');
  if (card && card.length < 12) return res.status(400).json({ error: 'invalid_card' });

  const { rows } = await db.execute({
    sql: `SELECT id FROM request WHERE payment_ref=? LIMIT 1`,
    args: [ref]
  });
  if (!rows[0]) return res.status(404).json({ error: 'unknown_ref' });
  const result = await markRequestPaid(rows[0].id, 'dummy-checkout');
  res.json({
    ok: true,
    request_id: rows[0].id,
    redirect_to: `/request.html?id=${rows[0].id}${result.alreadyPaid ? '&already=1' : '&paid=1'}`,
    alreadyPaid: !!result.alreadyPaid
  });
});

// Dev-only: the stub payment URL from createPaymentLink() lands here for
// REQUEST payments (prefix req…). It marks the request paid + redirects to
// the citizen's tracking page. Distinct from /_stub/pay which handles the
// office-subscription stub.
paymentsRouter.get('/_stub/request_pay', async (req, res) => {
  // Stub mark-paid — debug-only, hard-off in production.
  if (!DEBUG_ENABLED) return res.status(404).end();
  const ref = String(req.query.ref || '');
  const { rows } = await db.execute({
    sql: `SELECT id FROM request WHERE payment_ref=? LIMIT 1`,
    args: [ref]
  });
  if (!rows[0]) return res.status(404).send('unknown ref');
  const result = await markRequestPaid(rows[0].id, 'stub-link');
  res.redirect(`/request.html?id=${rows[0].id}${result.alreadyPaid ? '&already=1' : '&paid=1'}`);
});

const PACK = {
  code: 'starter-70',
  amount_omr: 35.0,
  credits: 70
};

// Helper: grant credits + mark sub active. Transactional via ledger.
async function activateSubscription(subRow, rawWebhook = null) {
  // Idempotency — if already active, bail.
  if (subRow.payment_status === 'active') return { alreadyActive: true };

  const credits = subRow.credits_granted || PACK.credits;
  // 1) Flip the sub row.
  await db.execute({
    sql: `UPDATE office_subscription
             SET payment_status='active',
                 paid_at=datetime('now'),
                 raw_webhook_json=COALESCE(?, raw_webhook_json)
           WHERE id=? AND payment_status<>'active'`,
    args: [rawWebhook ? JSON.stringify(rawWebhook) : null, subRow.id]
  });
  // 2) Bump office balance.
  await db.execute({
    sql: `UPDATE office
             SET credits_remaining = COALESCE(credits_remaining,0) + ?,
                 subscription_status = 'active',
                 subscription_since  = COALESCE(subscription_since, datetime('now'))
           WHERE id=?`,
    args: [credits, subRow.office_id]
  });
  // 3) Fetch new balance for the ledger row.
  const { rows } = await db.execute({
    sql: `SELECT credits_remaining FROM office WHERE id=?`, args: [subRow.office_id]
  });
  const balance = rows[0]?.credits_remaining || 0;
  await db.execute({
    sql: `INSERT INTO credit_ledger(office_id, request_id, subscription_id, delta, reason, balance_after)
          VALUES (?, NULL, ?, ?, 'subscription_grant', ?)`,
    args: [subRow.office_id, subRow.id, credits, balance]
  });
  await audit({
    actor: { type: 'system', id: null },
    action: 'grant_credits',
    target: 'office',
    targetId: subRow.office_id,
    diff: { credits, subscription_id: subRow.id, amount_omr: subRow.amount_omr }
  });
  return { granted: credits, balance };
}

// ─── POST /subscription/checkout ───────────────────────────
// Owner starts a 35-OMR pack purchase. Returns the Amwal redirect URL.
// We allowPending here so a just-signed-up office (pending_review) can pay
// right away — approval and payment are independent gates.
paymentsRouter.post(
  '/subscription/checkout',
  requireOfficer({ roles: ['owner'], allowPending: true }),
  async (req, res) => {
    try {
      const office_id = req.office.id;

      // If there's already a 'pending' row, reuse it so the office doesn't
      // accidentally create dozens of half-done sessions.
      const { rows: existing } = await db.execute({
        sql: `SELECT id, amwal_merchant_ref, amwal_payment_link, payment_status
                FROM office_subscription
               WHERE office_id=? AND payment_status='pending'
               ORDER BY id DESC LIMIT 1`,
        args: [office_id]
      });
      if (existing[0] && existing[0].amwal_payment_link) {
        return res.json({
          url: existing[0].amwal_payment_link,
          merchant_ref: existing[0].amwal_merchant_ref,
          reused: true,
          stubbed: !AMWAL_ENABLED
        });
      }

      const merchantRef = newMerchantRef('sub');
      const link = await createPaymentLink({
        amountOmr: PACK.amount_omr,
        merchantReference: merchantRef,
        customerEmail: req.officer.email,
        description: `Sanad-AI ${PACK.code} (${PACK.credits} credits)`
      });

      const ins = await db.execute({
        sql: `INSERT INTO office_subscription
                (office_id, plan_code, amount_omr, credits_granted,
                 amwal_merchant_ref, amwal_order_id, amwal_payment_link, payment_status)
              VALUES (?,?,?,?,?,?,?, 'pending')`,
        args: [office_id, PACK.code, PACK.amount_omr, PACK.credits,
               link.merchantReference, link.amwalOrderId, link.url]
      });
      await audit({
        actor: { type: 'officer', id: req.officer.officer_id },
        action: 'checkout_start',
        target: 'office_subscription',
        targetId: Number(ins.lastInsertRowid),
        diff: { merchantRef, amount_omr: PACK.amount_omr }
      });
      res.json({ url: link.url, merchant_ref: link.merchantReference, stubbed: !AMWAL_ENABLED });
    } catch (e) {
      console.error('[payments/checkout]', e);
      res.status(500).json({ error: 'checkout_failed', detail: e.message });
    }
  }
);

// ─── GET /subscription/status ──────────────────────────────
// Polled by the waiting-for-payment page. Returns {status, credits_remaining}.
paymentsRouter.get(
  '/subscription/status',
  requireOfficer({ allowPending: true }),
  async (req, res) => {
    const { rows } = await db.execute({
      sql: `SELECT id, payment_status, plan_code, amount_omr, credits_granted, paid_at, created_at
              FROM office_subscription
             WHERE office_id=?
             ORDER BY id DESC LIMIT 1`,
      args: [req.office.id]
    });
    const { rows: o } = await db.execute({
      sql: `SELECT credits_remaining, credits_total_used, subscription_status, subscription_since
              FROM office WHERE id=?`,
      args: [req.office.id]
    });
    res.json({
      latest: rows[0] || null,
      office: o[0] || null
    });
  }
);

// ─── POST /webhook ─────────────────────────────────────────
// Amwal pings us on state change. Signature check before doing anything.
paymentsRouter.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    if (AMWAL_ENABLED) {
      const sig = body.signature || req.header('x-amwal-signature');
      if (!verifyWebhookSignature(body, sig)) {
        console.warn('[payments/webhook] bad signature', body.merchantReference);
        return res.status(401).json({ error: 'bad_signature' });
      }
    }
    const ref = body.merchantReference || body.MerchantReference;
    if (!ref) return res.status(400).json({ error: 'missing_reference' });

    const status = String(body.status || body.Status || '').toLowerCase();
    const isPaid   = status === 'paid' || status === 'success' || status === 'succeeded';
    const isFailed = status === 'failed' || status === 'cancelled' || status === 'canceled';

    // Request-payment route: refs minted in officer.js look like `req<ID>-…`.
    // Try the request table first; if no match, fall back to subscription.
    const { rows: reqMatch } = await db.execute({
      sql: `SELECT id FROM request WHERE payment_ref=? LIMIT 1`,
      args: [ref]
    });
    if (reqMatch[0]) {
      if (isPaid) {
        const result = await markRequestPaid(reqMatch[0].id, 'webhook');
        return res.json({ ok: true, request_id: reqMatch[0].id, ...result });
      }
      if (isFailed) {
        await db.execute({
          sql: `UPDATE request
                   SET payment_status='failed',
                       last_event_at=datetime('now')
                 WHERE id=? AND payment_status='awaiting'`,
          args: [reqMatch[0].id]
        });
        return res.json({ ok: true, request_id: reqMatch[0].id, failed: true });
      }
      return res.json({ ok: true, ignored: status });
    }

    const { rows } = await db.execute({
      sql: `SELECT * FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
      args: [ref]
    });
    const sub = rows[0];
    if (!sub) return res.status(404).json({ error: 'unknown_ref' });

    if (isPaid) {
      await activateSubscription(sub, body);
      return res.json({ ok: true });
    }
    if (isFailed) {
      await db.execute({
        sql: `UPDATE office_subscription
                 SET payment_status='failed', raw_webhook_json=?
               WHERE id=? AND payment_status='pending'`,
        args: [JSON.stringify(body), sub.id]
      });
      return res.json({ ok: true });
    }
    // Unknown status — just log it.
    await db.execute({
      sql: `UPDATE office_subscription SET raw_webhook_json=? WHERE id=?`,
      args: [JSON.stringify(body), sub.id]
    });
    res.json({ ok: true, ignored: status });
  } catch (e) {
    console.error('[payments/webhook]', e);
    res.status(500).json({ error: 'webhook_failed', detail: e.message });
  }
});

// ─── GET /_stub/pay ────────────────────────────────────────
// Dev-only: the stub payment URL from createPaymentLink() lands here. It flips
// the subscription to active immediately and redirects back to the client page.
paymentsRouter.get('/_stub/pay', async (req, res) => {
  if (!DEBUG_ENABLED) return res.status(404).end();
  const ref = String(req.query.ref || '');
  const { rows } = await db.execute({
    sql: `SELECT * FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
    args: [ref]
  });
  const sub = rows[0];
  if (!sub) return res.status(404).send('unknown ref');
  await activateSubscription(sub, { source: 'stub' });
  // Redirect back to the waiting page; it'll see 'active' on next poll.
  res.redirect('/office-payment.html?ref=' + encodeURIComponent(ref) + '&stub=1');
});

// Also expose stub as POST for the test suite to trigger without following redirects.
paymentsRouter.post('/_stub/activate', async (req, res) => {
  if (!DEBUG_ENABLED) return res.status(404).end();
  const ref = String(req.body?.ref || '');
  const { rows } = await db.execute({
    sql: `SELECT * FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
    args: [ref]
  });
  if (!rows[0]) return res.status(404).json({ error: 'unknown_ref' });
  const result = await activateSubscription(rows[0], { source: 'stub' });
  res.json({ ok: true, ...result });
});

// ════════════════════════════════════════════════════════════
// THAWANI PAY — request-payment routes
// ════════════════════════════════════════════════════════════
// Three endpoints:
//   • GET  /thawani/success?ref=…  — citizen lands here after paying;
//     we retrieve the session from Thawani, verify payment_status='paid',
//     mark our request paid, then redirect to /request.html.
//   • GET  /thawani/cancel?ref=…   — citizen abandoned; show /request.html
//     with a "payment cancelled" hint. We do NOT refund or alter status
//     beyond logging — they can retry.
//   • POST /webhook/thawani        — optional async confirmation. Same
//     verify-via-retrieve logic. Idempotent.
//
// Trust model: a redirect alone is NEVER trusted. We always call
// retrieveThawaniSession before flipping payment_status. So even if a
// malicious client crafts a fake success URL, we can't be tricked into
// marking unpaid requests paid.
// ────────────────────────────────────────────────────────────

// Resolve a request by our merchant_ref AND verify it's a Thawani-tracked
// row. Returns the request row or null. Used by all three endpoints.
async function loadThawaniRequest(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const { rows } = await db.execute({
    sql: `SELECT id, payment_provider, payment_session_id, payment_status, paid_at
            FROM request WHERE payment_ref=? LIMIT 1`,
    args: [ref]
  });
  return rows[0] || null;
}

// Verify with Thawani then mark paid. Returns { ok, paid?, alreadyPaid?, error? }.
async function thawaniConfirmAndMark(ref, source = 'thawani-redirect') {
  const r = await loadThawaniRequest(ref);
  if (!r) return { ok: false, error: 'unknown_ref' };
  if (r.payment_status === 'paid' || r.paid_at) {
    return { ok: true, alreadyPaid: true, request_id: r.id };
  }
  if (r.payment_provider && r.payment_provider !== 'thawani') {
    return { ok: false, error: 'wrong_provider', provider: r.payment_provider };
  }
  if (!r.payment_session_id) return { ok: false, error: 'no_session_id' };
  // Server-to-server verification — the only thing we trust.
  let session;
  try {
    session = await retrieveThawaniSession(r.payment_session_id);
  } catch (e) {
    console.warn('[thawani:verify]', e.message);
    return { ok: false, error: 'verify_failed', detail: e.message };
  }
  // Persist the raw payload for audit before deciding.
  try {
    await db.execute({
      sql: `UPDATE request SET payment_raw_webhook=? WHERE id=?`,
      args: [JSON.stringify(session).slice(0, 8000), r.id]
    });
  } catch {}
  if (!isThawaniPaid(session)) {
    return { ok: false, error: 'not_paid', payment_status: session?.payment_status || null };
  }
  // markRequestPaid handles atomic flip + citizen notification.
  const result = await markRequestPaid(r.id, source);
  return { ok: true, paid: !result.alreadyPaid, alreadyPaid: !!result.alreadyPaid, request_id: r.id };
}

paymentsRouter.get('/thawani/success', async (req, res) => {
  const ref = String(req.query.ref || '');
  const result = await thawaniConfirmAndMark(ref, 'thawani-redirect');
  if (!result.ok) {
    // Redirect to request page with a clear error flag so the UI can render
    // a "payment failed — please retry" banner without us leaking detail.
    const tag = result.error === 'not_paid' ? 'unpaid' : 'verify_error';
    return res.redirect(`/request.html?ref=${encodeURIComponent(ref)}&pay_error=${tag}`);
  }
  res.redirect(`/request.html?id=${result.request_id}${result.alreadyPaid ? '&already=1' : '&paid=1'}`);
});

paymentsRouter.get('/thawani/cancel', async (req, res) => {
  const ref = String(req.query.ref || '');
  const r = await loadThawaniRequest(ref);
  await audit({
    actor: { type: 'citizen', id: null },
    action: 'payment_cancelled',
    target: 'request',
    targetId: r?.id || 0,
    diff: { ref, provider: 'thawani' }
  }).catch(() => {});
  if (!r) return res.redirect('/');
  res.redirect(`/request.html?id=${r.id}&pay_cancelled=1`);
});

// ─── UNIFIED Thawani webhook ────────────────────────────────
// ONE endpoint for EVERY Thawani payment — both citizen request payments
// and office plan purchases. Thawani's merchant dashboard accepts a single
// webhook URL, so this is the only URL you configure there:
//
//     https://saned.ai/api/payments/webhook/thawani
//
// Routing: extract the session_id (or our merchant_ref) from the payload,
// look it up in the `request` table first, then `office_subscription`.
// Whichever matches gets its idempotent finalizer. The webhook body is
// NEVER trusted to mark anything paid — each finalizer re-fetches the
// session from Thawani server-to-server and only acts on payment_status
// === 'paid'. So a spoofed webhook can't flip an unpaid order.
//
// (`/webhook/thawani/sub` below is kept as a backward-compatible alias
// that delegates here, in case it was already configured on Thawani.)
async function handleThawaniWebhook(body) {
  const data = body?.data || body || {};
  const ref = data.client_reference_id || data.merchant_ref || data.ref || null;
  const sessionId = data.session_id || null;

  // ── 1) Citizen request payment ──────────────────────────
  // Resolve a merchant_ref: either the one in the payload, or look it up
  // from the session_id. If we find a matching request, finalize it.
  let requestRef = ref;
  if (!requestRef && sessionId) {
    const { rows } = await db.execute({
      sql: `SELECT payment_ref FROM request WHERE payment_session_id=? LIMIT 1`,
      args: [sessionId]
    });
    requestRef = rows[0]?.payment_ref || null;
  }
  if (requestRef) {
    const r = await thawaniConfirmAndMark(requestRef, 'thawani-webhook');
    // unknown_ref → not a request payment; fall through to plan lookup.
    if (r.ok || r.error !== 'unknown_ref') {
      if (!r.ok) console.warn('[thawani:webhook:request]', r);
      return { handled: 'request', result: r };
    }
  }

  // ── 2) Office plan purchase ──────────────────────────────
  if (SUBS_V1_ENABLED) {
    let planSessionId = sessionId;
    if (!planSessionId && ref) {
      const { rows } = await db.execute({
        sql: `SELECT thawani_session_id FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
        args: [ref]
      });
      planSessionId = rows[0]?.thawani_session_id || null;
    }
    if (planSessionId) {
      const r = await finalizeSubscriptionPayment(planSessionId, 'thawani-webhook');
      if (!r.ok) console.warn('[thawani:webhook:plan]', r);
      return { handled: 'plan', result: r };
    }
  }

  console.warn('[thawani:webhook] no resolvable request or plan', JSON.stringify(body).slice(0, 300));
  return { handled: 'none' };
}

// Signature check that NEVER drops a webhook. Thawani's webhook-signing
// scheme is undocumented, so if THAWANI_WEBHOOK_SECRET is set and our HMAC
// guess doesn't match their actual format, a hard 401 would silently kill
// ALL webhook delivery. Instead we log a mismatch and proceed — the real
// trust boundary is the server-to-server re-fetch inside the finalizers
// (we only mark paid when Thawani itself reports payment_status='paid', so
// a forged webhook just triggers a harmless re-fetch that finds nothing).
function softCheckThawaniSignature(req) {
  const sig = req.get('x-thawani-signature') || req.get('x-signature') || '';
  // Only meaningful when a secret is configured. When unset, verify returns
  // true (soft mode) and we skip the warning entirely.
  if (!(process.env.THAWANI_WEBHOOK_SECRET || '').trim()) return;
  if (!verifyThawaniSignature(req.rawBody, sig)) {
    console.warn('[thawani:webhook] signature mismatch — proceeding via re-fetch trust ' +
      '(Thawani\'s signing format may differ from our HMAC-SHA256 guess; payment is still ' +
      'verified server-side before anything is marked paid)');
  }
}

paymentsRouter.post('/webhook/thawani', async (req, res) => {
  softCheckThawaniSignature(req);
  // ACK fast (Thawani retries on timeout) then verify+dispatch async.
  res.json({ ok: true, received: true });
  try {
    await handleThawaniWebhook(req.body || {});
  } catch (e) {
    console.error('[thawani:webhook] error', e);
  }
});

// Demo helper — only when sandbox + DEBUG_MODE. Lets a tester force a
// "paid" verification without going through the real Thawani UI. Useful
// for the AR/EN happy-path screencast.
paymentsRouter.post('/thawani/_dev/mark-paid', async (req, res) => {
  if (!DEBUG_ENABLED) return res.status(404).end();
  const ref = String(req.body?.ref || req.query?.ref || '');
  const r = await loadThawaniRequest(ref);
  if (!r) return res.status(404).json({ error: 'unknown_ref' });
  const result = await markRequestPaid(r.id, 'thawani-dev-stub');
  res.json({ ok: true, ...result });
});

// ════════════════════════════════════════════════════════════
// SUBSCRIPTIONS v2 — time-based plans (monthly/quarterly/semi-annual/annual)
// ════════════════════════════════════════════════════════════
// Distinct from the legacy 'starter-70' credit pack above. Where the pack
// granted N credits, v2 grants TIME (the office's subscription_expires_at
// moves forward by the plan's months). Quota gating (100 claims/month) is
// done in routes/officer.js at claim-time — see PR 3.
//
// Hardening notes:
//   • Thawani webhooks aren't HMAC-signed. We dedupe via payment_event:
//     before doing anything mutating, check whether a 'paid' row already
//     exists for this session_id. If so, no-op. Both the success redirect
//     and the webhook converge on finalizeSubscriptionPayment() — that's
//     the only place that writes 'paid'.
//   • Pending-row reuse: if an office bounces off the checkout twice
//     within the same plan, we return the existing checkout URL instead
//     of spawning a parallel session.
//   • Feature flag SANAD_SUBS_V1 gates the WHOLE thing. When off, every
//     route in this block returns 404 — no behaviour change for anyone
//     still on the legacy pack.
// ────────────────────────────────────────────────────────────

// Write a row to payment_event. Best-effort — never throws. Used for both
// the audit dashboard AND idempotency dedupe.
async function logPaymentEvent({ subjectType, subjectId, sessionId = null, eventType, amountOmr = null, raw = null }) {
  try {
    await db.execute({
      sql: `INSERT INTO payment_event
              (subject_type, subject_id, provider, thawani_session_id, event_type, amount_omr, raw_json)
            VALUES (?, ?, 'thawani', ?, ?, ?, ?)`,
      args: [
        subjectType, subjectId, sessionId, eventType, amountOmr,
        raw ? JSON.stringify(raw).slice(0, 8000) : null
      ]
    });
  } catch (e) { console.warn('[payment_event]', e.message); }
}

// Idempotency dedupe — is there already a 'paid' event for this session?
// If yes, finalizeSubscriptionPayment short-circuits. Cheap (indexed lookup).
async function isSubscriptionAlreadyPaid(sessionId) {
  if (!sessionId) return false;
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM payment_event
           WHERE subject_type='office_subscription'
             AND thawani_session_id=?
             AND event_type='paid' LIMIT 1`,
    args: [sessionId]
  });
  return !!rows[0];
}

// The single source of truth for "this subscription got paid". Both
// /thawani/sub/success (browser redirect) and /webhook/thawani (server-
// to-server ping) call this with the same session_id. Safe to call any
// number of times — multiple concurrent calls converge on the same state
// thanks to the (a) payment_event dedupe and (b) WHERE payment_status<>'active'
// guard on the UPDATE.
//
// Returns { ok, alreadyActive?, subscription_id, expires_at, plan } on
// success, { ok:false, error } on failure. NEVER throws — callers can
// rely on the shape.
async function finalizeSubscriptionPayment(sessionId, source = 'thawani') {
  if (!sessionId) return { ok: false, error: 'no_session_id' };

  const { rows } = await db.execute({
    sql: `SELECT id, office_id, plan_code, amount_omr, months, payment_status
            FROM office_subscription
           WHERE thawani_session_id=? LIMIT 1`,
    args: [sessionId]
  });
  const sub = rows[0];
  if (!sub) return { ok: false, error: 'unknown_session' };

  // Fast-path idempotency: either the row is already active OR we've
  // already written a 'paid' event for this session.
  if (sub.payment_status === 'active') {
    return { ok: true, alreadyActive: true, subscription_id: sub.id };
  }
  if (await isSubscriptionAlreadyPaid(sessionId)) {
    return { ok: true, alreadyActive: true, subscription_id: sub.id };
  }

  // Server-to-server verify with Thawani. The only thing we trust.
  let session;
  try {
    session = await retrieveThawaniSession(sessionId);
  } catch (e) {
    await logPaymentEvent({
      subjectType: 'office_subscription', subjectId: sub.id,
      sessionId, eventType: 'fetch_verified', raw: { error: e.message }
    });
    return { ok: false, error: 'verify_failed', detail: e.message };
  }
  await logPaymentEvent({
    subjectType: 'office_subscription', subjectId: sub.id,
    sessionId, eventType: 'fetch_verified', raw: session
  });

  if (!isThawaniPaid(session)) {
    return { ok: false, error: 'not_paid', payment_status: session?.payment_status || null };
  }

  // Plan-driven expiry math. PR 1's lib/plans.js owns the calendar logic.
  const startsAt  = toSqlDatetime(new Date());
  const expiresAt = computeExpiry(sub.plan_code, new Date());

  // Atomic flip. WHERE payment_status<>'active' guards against a race where
  // two concurrent finalizers both passed the early idempotency check.
  const upd = await db.execute({
    sql: `UPDATE office_subscription
             SET payment_status='active',
                 paid_at=datetime('now'),
                 starts_at=?, expires_at=?,
                 thawani_invoice=?, thawani_payment_id=?,
                 raw_webhook_json=COALESCE(?, raw_webhook_json)
           WHERE id=? AND payment_status<>'active'`,
    args: [
      startsAt, expiresAt,
      session?.invoice || null,
      session?.payment_id || session?.session_id || null,
      JSON.stringify(session).slice(0, 8000),
      sub.id
    ]
  });
  if (!upd.rowsAffected) {
    // Lost the race — another worker activated this row between our
    // checks. That's fine; we treat it as already-active.
    return { ok: true, alreadyActive: true, subscription_id: sub.id };
  }

  // Snapshot the active plan on the office row so quota checks and the
  // admin dashboard don't have to join office_subscription every time.
  await db.execute({
    sql: `UPDATE office
             SET current_plan=?,
                 subscription_expires_at=?,
                 subscription_status='active',
                 subscription_since=COALESCE(subscription_since, datetime('now'))
           WHERE id=?`,
    args: [sub.plan_code, expiresAt, sub.office_id]
  });

  await audit({
    actor: { type: 'system', id: null },
    action: 'subscription_active',
    target: 'office_subscription',
    targetId: sub.id,
    diff: { plan: sub.plan_code, amount_omr: sub.amount_omr, expires_at: expiresAt, source }
  });
  await logPaymentEvent({
    subjectType: 'office_subscription', subjectId: sub.id, sessionId,
    eventType: 'paid', amountOmr: sub.amount_omr,
    raw: { source, plan: sub.plan_code, expires_at: expiresAt }
  });

  return {
    ok: true,
    subscription_id: sub.id,
    office_id: sub.office_id,
    plan: sub.plan_code,
    expires_at: expiresAt
  };
}

// ─── POST /sub/start ────────────────────────────────────────
// Office owner initiates a v2 plan purchase. Returns a Thawani hosted-
// checkout URL the browser should redirect to. The office row in
// office_subscription is created in 'pending' state and only flips to
// 'active' via finalizeSubscriptionPayment() once Thawani confirms.
//
// allowPending=true: a just-signed-up office (status='pending_review')
// is still allowed to subscribe — approval and payment are independent
// gates.
paymentsRouter.post(
  '/sub/start',
  requireOfficer({ roles: ['owner'], allowPending: true }),
  async (req, res) => {
    if (!SUBS_V1_ENABLED) return res.status(404).json({ error: 'subs_v1_disabled' });
    try {
      const planCode = String(req.body?.plan_code || '').trim();
      if (!isValidPlanCode(planCode)) {
        return res.status(400).json({ error: 'invalid_plan', allowed: PLAN_CODES });
      }
      const plan = getPlan(planCode);
      const office_id = req.office.id;

      // Pending-row reuse — if the office already has a pending row for
      // this exact plan, hand back its existing checkout URL instead of
      // spawning a parallel Thawani session. Avoids accidental double-
      // create when the user double-clicks the "Subscribe" button.
      const { rows: existing } = await db.execute({
        sql: `SELECT id, thawani_session_id, amwal_merchant_ref, amwal_payment_link
                FROM office_subscription
               WHERE office_id=? AND plan_code=? AND payment_status='pending'
               ORDER BY id DESC LIMIT 1`,
        args: [office_id, planCode]
      });
      if (existing[0] && existing[0].amwal_payment_link) {
        return res.json({
          checkout_url: existing[0].amwal_payment_link,
          session_id:   existing[0].thawani_session_id,
          merchant_ref: existing[0].amwal_merchant_ref,
          plan: planCode,
          amount_omr: plan.total_omr,
          reused: true,
          provider: 'thawani'
        });
      }

      // Real Thawani flow. We do NOT support a sandbox stub here — if the
      // env is missing keys we surface a clear 503 so the operator knows
      // to wire them up. (DEBUG-mode devs can use POST /sub/_stub/activate
      // below to skip the gateway entirely.)
      if (!THAWANI_ENABLED) {
        return res.status(503).json({
          error: 'thawani_not_configured',
          hint: 'Set THAWANI_SECRET_KEY and THAWANI_PUBLISHABLE_KEY in env.'
        });
      }

      const merchantRef = `sub2-${office_id}-${planCode}-${Date.now().toString(36)}`;
      const publicBase  = `${req.protocol}://${req.get('host')}`;

      // One-off plan purchase — a single Thawani charge for N months of
      // access. NOT a recurring subscription (Thawani doesn't support those):
      // when the plan expires the office simply buys again. The default
      // success/cancel URLs are overridden to land on the plan finalizer.
      const link = await createThawaniSession({
        amountOmr: plan.total_omr,
        merchantReference: merchantRef,
        customerEmail: req.officer.email,
        description:
          `Sanad-AI ${plan.label_en} plan — ${plan.months}mo, ${plan.claim_quota} claims/mo`,
        productName: `Sanad-AI ${plan.label_en}`,
        publicBase,
        successUrl: `{base}/api/payments/thawani/sub/success?ref={ref}`,
        cancelUrl:  `{base}/api/payments/thawani/sub/cancel?ref={ref}`,
        metadata: {
          subject_type: 'office_subscription',
          plan_code:    planCode,
          office_id:    String(office_id)
        }
      });

      // Persist the pending row. credits_granted=0 so the legacy credit
      // ledger doesn't count v2 plans. auto_renew is always 0 (no recurring).
      const ins = await db.execute({
        sql: `INSERT INTO office_subscription
                (office_id, plan_code, amount_omr, credits_granted, months,
                 amwal_merchant_ref, amwal_order_id, amwal_payment_link,
                 thawani_session_id, payment_status, auto_renew)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'pending', 0)`,
        args: [
          office_id, planCode, plan.total_omr, plan.months,
          merchantRef, link.session_id, link.url, link.session_id
        ]
      });
      const subId = Number(ins.lastInsertRowid);

      await audit({
        actor: { type: 'officer', id: req.officer.officer_id },
        action: 'sub_checkout_start',
        target: 'office_subscription',
        targetId: subId,
        diff: { plan: planCode, amount_omr: plan.total_omr, session_id: link.session_id }
      });
      await logPaymentEvent({
        subjectType: 'office_subscription', subjectId: subId,
        sessionId: link.session_id, eventType: 'session_created',
        amountOmr: plan.total_omr,
        raw: { plan: planCode, merchant_ref: merchantRef }
      });

      res.json({
        checkout_url: link.url,
        session_id:   link.session_id,
        merchant_ref: merchantRef,
        plan: planCode,
        amount_omr: plan.total_omr,
        months: plan.months,
        provider: 'thawani'
      });
    } catch (e) {
      console.error('[payments/sub/start]', e);
      res.status(500).json({ error: 'start_failed', detail: e.message });
    }
  }
);

// ─── GET /sub/status ────────────────────────────────────────
// Lightweight poller for the post-checkout waiting page. Returns the
// latest v2 subscription row for the calling office plus the office's
// current_plan / subscription_expires_at / subscription_status snapshot.
// Distinct from the legacy /subscription/status above (which returns
// credits-bearing rows). When SUBS_V1 is off, returns 404 so the
// dashboard knows to use the legacy endpoint.
paymentsRouter.get(
  '/sub/status',
  requireOfficer({ allowPending: true }),
  async (req, res) => {
    if (!SUBS_V1_ENABLED) return res.status(404).json({ error: 'subs_v1_disabled' });
    const { rows: subs } = await db.execute({
      sql: `SELECT id, plan_code, payment_status, amount_omr, months,
                   starts_at, expires_at, paid_at, created_at,
                   thawani_session_id, amwal_payment_link AS checkout_url
              FROM office_subscription
             WHERE office_id=? AND plan_code IN (?, ?, ?, ?)
             ORDER BY id DESC LIMIT 1`,
      args: [req.office.id, ...PLAN_CODES]
    });
    const { rows: o } = await db.execute({
      sql: `SELECT current_plan, subscription_status, subscription_expires_at,
                   subscription_since
              FROM office WHERE id=?`,
      args: [req.office.id]
    });
    res.json({ latest: subs[0] || null, office: o[0] || null });
  }
);

// ─── GET /thawani/sub/success ───────────────────────────────
// Thawani redirects the browser here after a successful checkout. We
// verify with Thawani, finalize the sub, then redirect to the office
// dashboard with a flag. Never trust the redirect's "success" — only
// trust the retrieve.
paymentsRouter.get('/thawani/sub/success', async (req, res) => {
  if (!SUBS_V1_ENABLED) return res.status(404).end();
  const ref = String(req.query.ref || '');
  // Look up the sub by merchant_ref so we can find the session_id we stashed.
  const { rows } = await db.execute({
    sql: `SELECT id, thawani_session_id, payment_status
            FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
    args: [ref]
  });
  const sub = rows[0];
  if (!sub) return res.redirect('/officer.html?sub_error=unknown_ref');

  const result = await finalizeSubscriptionPayment(sub.thawani_session_id, 'thawani-redirect');
  if (!result.ok) {
    const tag = result.error === 'not_paid' ? 'unpaid' : 'verify_error';
    return res.redirect(`/officer.html?sub_error=${tag}&ref=${encodeURIComponent(ref)}`);
  }
  res.redirect(
    `/officer.html?sub_active=1${result.alreadyActive ? '&already=1' : ''}` +
    `&plan=${encodeURIComponent(result.plan || '')}`
  );
});

// ─── GET /thawani/sub/cancel ────────────────────────────────
// Citizen abandoned checkout. We log it and bounce back to the dashboard
// with a clear flag so the UI can offer "try again". No state change.
paymentsRouter.get('/thawani/sub/cancel', async (req, res) => {
  if (!SUBS_V1_ENABLED) return res.status(404).end();
  const ref = String(req.query.ref || '');
  const { rows } = await db.execute({
    sql: `SELECT id, thawani_session_id FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
    args: [ref]
  });
  const sub = rows[0];
  if (sub) {
    await logPaymentEvent({
      subjectType: 'office_subscription', subjectId: sub.id,
      sessionId: sub.thawani_session_id, eventType: 'cancelled',
      raw: { source: 'thawani-redirect', ref }
    });
    await audit({
      actor: { type: 'officer', id: null },
      action: 'sub_payment_cancelled',
      target: 'office_subscription',
      targetId: sub.id,
      diff: { ref }
    }).catch(() => {});
  }
  res.redirect(`/officer.html?sub_cancelled=1&ref=${encodeURIComponent(ref)}`);
});

// Backward-compatible alias. The canonical webhook is /webhook/thawani
// (handles BOTH request payments and plan purchases — see handleThawaniWebhook).
// This /sub alias just delegates, so if Thawani's dashboard was already
// pointed here it keeps working. New deployments configure /webhook/thawani only.
paymentsRouter.post('/webhook/thawani/sub', async (req, res) => {
  softCheckThawaniSignature(req);
  res.json({ ok: true, received: true });
  try { await handleThawaniWebhook(req.body || {}); }
  catch (e) { console.error('[thawani:webhook alias] error', e); }
});

// ─── POST /sub/_stub/activate (DEBUG only) ──────────────────
// Lets a dev exercise the post-payment flow without a real Thawani key.
// Bypasses the verify-with-Thawani step by directly running the same
// activate-side logic finalizeSubscriptionPayment would run.
paymentsRouter.post(
  '/sub/_stub/activate',
  requireOfficer({ roles: ['owner'], allowPending: true }),
  async (req, res) => {
    if (!DEBUG_ENABLED) return res.status(404).end();
    if (!SUBS_V1_ENABLED) return res.status(404).end();
    const { subscription_id } = req.body || {};
    const id = Number(subscription_id);
    if (!id) return res.status(400).json({ error: 'missing_subscription_id' });

    const { rows } = await db.execute({
      sql: `SELECT id, office_id, plan_code, amount_omr, months, payment_status
              FROM office_subscription WHERE id=? AND office_id=? LIMIT 1`,
      args: [id, req.office.id]
    });
    const sub = rows[0];
    if (!sub) return res.status(404).json({ error: 'not_found' });
    if (sub.payment_status === 'active') return res.json({ ok: true, alreadyActive: true });

    const startsAt  = toSqlDatetime(new Date());
    const expiresAt = computeExpiry(sub.plan_code, new Date());
    await db.execute({
      sql: `UPDATE office_subscription
               SET payment_status='active', paid_at=datetime('now'),
                   starts_at=?, expires_at=?
             WHERE id=? AND payment_status<>'active'`,
      args: [startsAt, expiresAt, sub.id]
    });
    await db.execute({
      sql: `UPDATE office
               SET current_plan=?, subscription_expires_at=?,
                   subscription_status='active',
                   subscription_since=COALESCE(subscription_since, datetime('now'))
             WHERE id=?`,
      args: [sub.plan_code, expiresAt, sub.office_id]
    });
    await logPaymentEvent({
      subjectType: 'office_subscription', subjectId: sub.id,
      sessionId: null, eventType: 'paid', amountOmr: sub.amount_omr,
      raw: { source: 'stub', plan: sub.plan_code, expires_at: expiresAt }
    });
    res.json({ ok: true, subscription_id: sub.id, plan: sub.plan_code, expires_at: expiresAt });
  }
);

// Exported for tests — lets the test suite call the idempotent finalizer
// without spinning up a real HTTP request. Not part of the public API.
export const __test__ = { finalizeSubscriptionPayment, logPaymentEvent, isSubscriptionAlreadyPaid };
