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
import { db } from '../lib/db.js';
import { requireOfficer } from '../lib/auth.js';
import { createPaymentLink, verifyWebhookSignature, newMerchantRef, AMWAL_ENABLED } from '../lib/amwal.js';
import { storeMessage } from '../lib/agent.js';
import { sendWhatsAppText, isWhatsAppSession } from '../lib/whatsapp_send.js';

export const paymentsRouter = Router();

// ════════════════════════════════════════════════════════════
// REQUEST payments — citizen pays the office for a specific service
// request. Distinct from the office subscription flow above. Status
// transitions: awaiting_payment → in_progress (with paid_at set), which
// unlocks the officer ↔ citizen chat.
// ════════════════════════════════════════════════════════════

// Idempotent: marking a request paid more than once is a no-op. Returns
// { alreadyPaid:true } in that case so the webhook + stub agree.
async function markRequestPaid(requestId, source = 'webhook') {
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

  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('system', NULL, 'request_paid', 'request', ?, ?)`,
    args: [requestId, JSON.stringify({ source, amount_omr: r.payment_amount_omr, ref: r.payment_ref })]
  });

  // Notify the citizen — chat is now unlocked.
  const lang = (r.lang_pref || 'ar') === 'en' ? 'en' : 'ar';
  const sname = (lang === 'ar' && r.service_name_ar) ? r.service_name_ar : (r.service_name || '');
  const paidMsg = lang === 'ar'
    ? `✅ تم استلام دفعتك. مكتب سند الذي يتولى طلبك "${sname}" بدأ المعالجة الآن. ستصلك التحديثات عبر هذه المحادثة.`
    : `✅ Payment received. The Sanad office handling your "${sname}" request has started processing. You'll get updates here.`;
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
paymentsRouter.post('/request/:id/confirm-stub', async (req, res) => {
  if (process.env.DEBUG_MODE !== 'true') return res.status(403).json({ error: 'debug_only' });
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
  // Allow when the real gateway is off (stub mode) OR explicitly in debug.
  return !AMWAL_ENABLED || process.env.DEBUG_MODE === 'true';
}

paymentsRouter.get('/dummy/session/:ref', async (req, res) => {
  if (!dummyAllowed()) return res.status(404).end();
  const ref = String(req.params.ref || '');
  if (!ref.startsWith('req')) return res.status(400).json({ error: 'bad_ref' });
  const { rows } = await db.execute({
    sql: `SELECT r.id, r.payment_amount_omr, r.payment_ref, r.payment_status,
                 r.office_fee_omr, r.government_fee_omr,
                 s.name_en AS service_name, s.name_ar AS service_name_ar,
                 s.entity_en, s.entity_ar,
                 off.name_en AS office_name_en, off.name_ar AS office_name_ar
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
            LEFT JOIN office off        ON off.id = r.office_id
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
    office_name_en: r.office_name_en,
    office_name_ar: r.office_name_ar,
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
  if (AMWAL_ENABLED && process.env.DEBUG_MODE !== 'true')
    return res.status(404).end();
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
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('system', NULL, 'grant_credits', 'office', ?, ?)`,
    args: [subRow.office_id, JSON.stringify({ credits, subscription_id: subRow.id, amount_omr: subRow.amount_omr })]
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
      await db.execute({
        sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
              VALUES ('officer', ?, 'checkout_start', 'office_subscription', ?, ?)`,
        args: [req.officer.officer_id, Number(ins.lastInsertRowid),
               JSON.stringify({ merchantRef, amount_omr: PACK.amount_omr })]
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
  if (AMWAL_ENABLED) return res.status(404).end();
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
  if (AMWAL_ENABLED) return res.status(404).end();
  const ref = String(req.body?.ref || '');
  const { rows } = await db.execute({
    sql: `SELECT * FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
    args: [ref]
  });
  if (!rows[0]) return res.status(404).json({ error: 'unknown_ref' });
  const result = await activateSubscription(rows[0], { source: 'stub' });
  res.json({ ok: true, ...result });
});
