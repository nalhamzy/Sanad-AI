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

export const paymentsRouter = Router();

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

    const { rows } = await db.execute({
      sql: `SELECT * FROM office_subscription WHERE amwal_merchant_ref=? LIMIT 1`,
      args: [ref]
    });
    const sub = rows[0];
    if (!sub) return res.status(404).json({ error: 'unknown_ref' });

    const status = String(body.status || body.Status || '').toLowerCase();
    if (status === 'paid' || status === 'success' || status === 'succeeded') {
      await activateSubscription(sub, body);
      return res.json({ ok: true });
    }
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
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
