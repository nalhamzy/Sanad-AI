// Office SLA enforcement — TWO windows.
//
// Real-world flow when many offices compete:
//   ready → (office A claims, atomic lock) → claimed
//        → (office A reviews docs, decides)
//        → (sends payment link OR releases)
//
//   awaiting_payment → (citizen pays, status flips) → in_progress
//        → (office A completes the gov-side work)
//        → completed
//
// Two distinct timers:
//
//   REVIEW phase (claimed, no payment yet) — short (default 5 min). Forces
//      offices to make a quick yes/no decision after they lock a request,
//      so they can't grief-hold. If they don't act within 5 min, the
//      request is FULLY released back to the marketplace.
//
//   WORK phase (paid, in_progress) — longer (default 45 min). The office has
//      45 min from paid_at to complete the gov work. If they don't, the
//      request is TRANSFERRED to another office — paid_at + payment fields
//      are preserved, so the citizen does NOT pay again.
//
// Awaiting-payment is NEVER auto-released (citizen is the bottleneck there).
//
// Configurable via env:
//   OFFICE_REVIEW_SLA_MINUTES — review phase, default 5
//   OFFICE_SLA_MINUTES        — work phase, default 45
//   OFFICE_SLA_SWEEP_S        — sweep interval, default 60s (min 5s for tests)
//
// Production-safe: skipped if SANAD_SKIP_SLA=true or NODE_ENV=test.

import { db } from './db.js';

export const REVIEW_SLA_MINUTES = Number(process.env.OFFICE_REVIEW_SLA_MINUTES || 5);
export const SLA_MINUTES = Number(process.env.OFFICE_SLA_MINUTES || 45);
const SWEEP_S = Math.max(5, Number(process.env.OFFICE_SLA_SWEEP_S || 60));

let _timer = null;

/**
 * Run one sweep pass. Two SLA windows are enforced:
 *
 *   1. PRE-PAYMENT TIMEOUT — request is claimed but the office hasn't sent
 *      a payment link within SLA_MINUTES of claiming. Office is sitting on
 *      it. We FULLY release: clear office_id + payment fields + status='ready'.
 *
 *   2. POST-PAYMENT OVERDUE — citizen already paid but the office hasn't
 *      completed within SLA_MINUTES of paid_at. We TRANSFER: status='ready'
 *      + clear office_id but PRESERVE paid_at + payment_amount + payment_ref.
 *      The next office that claims gets it as 'in_progress' (no need to
 *      re-charge the citizen).
 *
 *   Awaiting-payment is NEVER auto-released (citizen is the bottleneck).
 *
 * Returns { pre_released, post_transferred }.
 */
export async function sweepExpiredSLA() {
  // Two distinct cutoffs so the review (5 min) and work (45 min) windows
  // can fire independently. SQLite stores datetimes as 'YYYY-MM-DD HH:MM:SS'
  // so we strip the ISO 'T' and trailing milliseconds for a clean compare.
  const reviewCutoffISO = new Date(Date.now() - REVIEW_SLA_MINUTES * 60_000)
                            .toISOString().replace('T', ' ').replace(/\..+$/, '');
  const cutoffISO       = new Date(Date.now() - SLA_MINUTES * 60_000)
                            .toISOString().replace('T', ' ').replace(/\..+$/, '');

  // ── 1. Pre-payment timeout — full release ────────────────
  // Window: REVIEW_SLA_MINUTES from claim_review_started_at. The office
  // had time to review docs and send a payment link; they didn't, so the
  // request goes back to the marketplace fully cleared.
  const { rows: pre } = await db.execute({
    sql: `SELECT id, office_id, claim_review_started_at
            FROM request
           WHERE status = 'claimed'
             AND claim_review_started_at IS NOT NULL
             AND claim_review_started_at < ?
             AND COALESCE(payment_status,'none') = 'none'
           LIMIT 50`,
    args: [reviewCutoffISO]
  });
  let preReleased = 0;
  for (const r of pre) {
    const upd = await db.execute({
      sql: `UPDATE request
               SET status='ready',
                   office_id=NULL, officer_id=NULL,
                   accepted_offer_id=NULL, quoted_fee_omr=NULL,
                   office_fee_omr=NULL, government_fee_omr=NULL,
                   claimed_at=NULL, claim_review_started_at=NULL,
                   payment_link=NULL, payment_ref=NULL, payment_amount_omr=NULL,
                   payment_status='none',
                   released_count = COALESCE(released_count,0) + 1,
                   last_event_at=datetime('now')
             WHERE id = ?
               AND status = 'claimed'
               AND COALESCE(payment_status,'none') = 'none'`,
      args: [r.id]
    });
    if (upd.rowsAffected) {
      preReleased++;
      if (r.office_id) {
        await db.execute({
          sql: `UPDATE office SET offers_abandoned = COALESCE(offers_abandoned,0)+1 WHERE id=?`,
          args: [r.office_id]
        });
      }
      await db.execute({
        sql: `INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, diff_json)
              VALUES ('system', NULL, 'sla_pre_pay_release', 'request', ?, ?)`,
        args: [r.id, JSON.stringify({
          review_sla_minutes: REVIEW_SLA_MINUTES,
          previous_office_id: r.office_id,
          claim_started: r.claim_review_started_at
        })]
      });
    }
  }

  // ── 2. Post-payment overdue — transfer (preserve payment) ──
  // SLA window starts at paid_at (citizen-payment moment), so the office
  // gets a fresh 45 min after the money lands.
  const { rows: post } = await db.execute({
    sql: `SELECT id, office_id, paid_at
            FROM request
           WHERE status = 'in_progress'
             AND paid_at IS NOT NULL
             AND paid_at < ?
           LIMIT 50`,
    args: [cutoffISO]
  });
  let postTransferred = 0;
  for (const r of post) {
    const upd = await db.execute({
      sql: `UPDATE request
               SET status='ready',
                   office_id=NULL, officer_id=NULL,
                   claim_review_started_at=NULL,
                   released_count = COALESCE(released_count,0) + 1,
                   last_event_at=datetime('now')
             WHERE id = ?
               AND status = 'in_progress'
               AND paid_at IS NOT NULL`,
      args: [r.id]
    });
    if (upd.rowsAffected) {
      postTransferred++;
      if (r.office_id) {
        await db.execute({
          sql: `UPDATE office SET offers_abandoned = COALESCE(offers_abandoned,0)+1 WHERE id=?`,
          args: [r.office_id]
        });
      }
      await db.execute({
        sql: `INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, diff_json)
              VALUES ('system', NULL, 'sla_post_pay_transfer', 'request', ?, ?)`,
        args: [r.id, JSON.stringify({
          sla_minutes: SLA_MINUTES,
          previous_office_id: r.office_id,
          paid_at: r.paid_at,
          note: 'payment preserved; citizen does not re-pay'
        })]
      });
      // ANONYMITY: silent SLA transfer. The citizen sees no message and no
      // status change in the citizen-facing display — from their perspective,
      // the same anonymous "platform" continues processing the request. The
      // audit_log row above is the operator-side trail. (Per Q14/anonymity
      // rule in MARKETPLACE_SCALING.md §11.2 — this notification was the last
      // place the post-pay handoff was leaking through to the citizen.)
    }
  }

  return { pre_released: preReleased, post_transferred: postTransferred };
}

export function startSLAWatcher() {
  if (process.env.SANAD_SKIP_SLA === 'true' || process.env.NODE_ENV === 'test') return null;
  if (_timer) return _timer;
  console.log(`[sla] auto-release watcher: review=${REVIEW_SLA_MINUTES}min, work=${SLA_MINUTES}min, sweep every ${SWEEP_S}s`);
  _timer = setInterval(() => {
    sweepExpiredSLA().then(({ pre_released, post_transferred }) => {
      if (pre_released > 0)    console.log(`[sla] pre-payment timeout — released ${pre_released} claim(s) back to marketplace`);
      if (post_transferred > 0) console.log(`[sla] post-payment overdue — transferred ${post_transferred} paid request(s) to a new office`);
    }).catch(e => console.warn('[sla] sweep failed:', e.message));
  }, SWEEP_S * 1000);
  _timer.unref?.();
  return _timer;
}

export function stopSLAWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
