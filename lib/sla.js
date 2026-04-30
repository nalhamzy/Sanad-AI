// Office SLA enforcement.
//
// Once an office claims a request the clock starts. If the request hasn't
// reached 'completed' (or terminal cancelled state) within OFFICE_SLA_MINUTES,
// we auto-release it back to the marketplace so another office can pick it
// up. The SLA timer counts from claim_review_started_at.
//
// Configurable via env:
//   OFFICE_SLA_MINUTES — default 45
//   OFFICE_SLA_SWEEP_S — sweep interval, default 60s (don't go below 30s)
//
// Production-safe: skipped if SANAD_SKIP_SLA=true or in tests.

import { db } from './db.js';

export const SLA_MINUTES = Number(process.env.OFFICE_SLA_MINUTES || 45);
const SWEEP_S = Math.max(30, Number(process.env.OFFICE_SLA_SWEEP_S || 60));

let _timer = null;

/**
 * Run one sweep pass — find every request whose office-side SLA has expired
 * (status NOT in a terminal/citizen-waiting state, and claim_review_started_at
 * older than SLA_MINUTES) and auto-release them. Returns the number released.
 */
export async function sweepExpiredSLA() {
  // Status whitelist: only release while the office is "actively holding"
  // the request. We DON'T release awaiting_payment (waiting on the citizen
  // to pay — not the office's fault) or paid in_progress (citizen committed
  // money; releasing without refund is forbidden — that's a manual flow).
  // We DO release plain 'claimed' (office sat on a review without action).
  const cutoffISO = new Date(Date.now() - SLA_MINUTES * 60_000)
                      .toISOString().replace('T', ' ').replace(/\..+$/, '');

  const { rows: stale } = await db.execute({
    sql: `SELECT id, office_id, claim_review_started_at
            FROM request
           WHERE status = 'claimed'
             AND claim_review_started_at IS NOT NULL
             AND claim_review_started_at < ?
             AND COALESCE(payment_status,'none') = 'none'
           LIMIT 50`,
    args: [cutoffISO]
  });
  if (!stale.length) return 0;

  for (const r of stale) {
    // Atomic UPDATE re-checks the conditions to avoid releasing a request
    // that flipped to 'awaiting_payment' between SELECT and UPDATE.
    const upd = await db.execute({
      sql: `UPDATE request
               SET status='ready',
                   office_id=NULL,
                   officer_id=NULL,
                   accepted_offer_id=NULL,
                   quoted_fee_omr=NULL,
                   office_fee_omr=NULL,
                   government_fee_omr=NULL,
                   claimed_at=NULL,
                   claim_review_started_at=NULL,
                   payment_link=NULL,
                   payment_ref=NULL,
                   payment_amount_omr=NULL,
                   payment_status='none',
                   released_count = COALESCE(released_count,0) + 1,
                   last_event_at=datetime('now')
             WHERE id = ?
               AND status = 'claimed'
               AND COALESCE(payment_status,'none') = 'none'`,
      args: [r.id]
    });
    if (upd.rowsAffected) {
      // Bump the office's abandonment count so the marketplace ranking
      // reflects offices that frequently sit on claims without acting.
      if (r.office_id) {
        await db.execute({
          sql: `UPDATE office SET offers_abandoned = COALESCE(offers_abandoned,0)+1 WHERE id=?`,
          args: [r.office_id]
        });
      }
      await db.execute({
        sql: `INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, diff_json)
              VALUES ('system', NULL, 'sla_auto_release', 'request', ?, ?)`,
        args: [r.id, JSON.stringify({
          sla_minutes: SLA_MINUTES,
          previous_office_id: r.office_id,
          claim_started: r.claim_review_started_at
        })]
      });
    }
  }
  return stale.length;
}

export function startSLAWatcher() {
  if (process.env.SANAD_SKIP_SLA === 'true' || process.env.NODE_ENV === 'test') return null;
  if (_timer) return _timer;
  console.log(`[sla] auto-release watcher: ${SLA_MINUTES} min SLA, sweep every ${SWEEP_S}s`);
  _timer = setInterval(() => {
    sweepExpiredSLA().then(n => {
      if (n > 0) console.log(`[sla] released ${n} expired claim(s)`);
    }).catch(e => console.warn('[sla] sweep failed:', e.message));
  }, SWEEP_S * 1000);
  _timer.unref?.();
  return _timer;
}

export function stopSLAWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
