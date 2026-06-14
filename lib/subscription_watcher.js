// Office subscription background watcher.
//
// Runs alongside lib/sla.js (which handles per-request SLAs). This one
// runs on a much slower cadence (default hourly) and is responsible for
// the SUBSCRIPTION lifecycle — not for individual requests.
//
// Two responsibilities, executed each sweep:
//
//   1. EXPIRE OVERDUE SUBSCRIPTIONS — subs whose expires_at is past
//      now() + GRACE_HOURS get their payment_status flipped to 'expired'
//      AND the owning office's subscription_status flips too. The next
//      claim attempt will fail with HTTP 402 subscription_expired.
//
//   2. SEND RENEWAL REMINDERS — for each day in SUBSCRIPTION_REMINDER_DAYS
//      (default 7, 3, 1), find subs whose expires_at falls on that date
//      and send a WhatsApp message + log a payment_event so we don't
//      double-send. PR 5 will swap the plain-text send for a Meta
//      template (sanad_payment_link / sanad_renewal_due); for now plain
//      text works in dev and in sandbox.
//
// Why a separate watcher instead of folding into lib/sla.js:
//   • Different cadence — subs change daily at most, requests change minute-to-minute.
//   • Different failure mode — a stuck sub-watcher doesn't drop a paid
//     request on the floor (and vice-versa); separation keeps each blast
//     radius small.
//   • Easier feature-flag — operators can turn one off (SANAD_SKIP_SUB_WATCHER)
//     while leaving the other on.
//
// Production-safe: skipped if NODE_ENV=test or SANAD_SKIP_SUB_WATCHER=true.
//
// Env overrides:
//   SUBSCRIPTION_WATCHER_INTERVAL_S — sweep interval, default 3600s (1h). Min 60s.
//   SUBSCRIPTION_REMINDER_DAYS      — CSV of days, default '7,3,1'
//   SUBSCRIPTION_GRACE_PERIOD_HOURS — grace before flipping expired, default 24h

import { db } from './db.js';
import { sendRenewalReminder } from './whatsapp_payment_messages.js';

const SWEEP_S = Math.max(60, Number(process.env.SUBSCRIPTION_WATCHER_INTERVAL_S || 3600));
const REMINDER_DAYS = String(process.env.SUBSCRIPTION_REMINDER_DAYS || '7,3,1')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
const GRACE_HOURS = Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_PERIOD_HOURS || 24));

let _timer = null;

/**
 * Run one sweep pass. Two phases (see file header). Always returns a
 * summary even if a phase errors — partial progress is better than no
 * progress (each row is independently transactional).
 *
 * @returns {Promise<{ expired:number, reminded:number, errors:number }>}
 */
export async function sweepSubscriptions() {
  let expired = 0, reminded = 0, errors = 0;

  // ── Phase 1: expire overdue subs ─────────────────────────
  // Cutoff = now() minus the grace window. A sub with expires_at < cutoff
  // is more than GRACE_HOURS past due and should be flipped.
  const expiredCutoff = new Date(Date.now() - GRACE_HOURS * 3600 * 1000)
    .toISOString().replace('T', ' ').replace(/\..+$/, '');
  let expRows = [];
  try {
    const { rows } = await db.execute({
      sql: `SELECT id, office_id, plan_code, expires_at, thawani_session_id, amount_omr
              FROM office_subscription
             WHERE payment_status='active'
               AND expires_at IS NOT NULL
               AND expires_at < ?
             LIMIT 50`,
      args: [expiredCutoff]
    });
    expRows = rows;
  } catch (e) { console.warn('[sub-watcher] expired scan failed:', e.message); errors++; }

  for (const sub of expRows) {
    try {
      // Flip the sub row. Guard on status='active' so we don't accidentally
      // re-expire a row another worker just touched.
      const upd = await db.execute({
        sql: `UPDATE office_subscription
                 SET payment_status='expired'
               WHERE id=? AND payment_status='active'`,
        args: [sub.id]
      });
      if (!upd.rowsAffected) continue;

      // Only flip the office snapshot if it still points at THIS plan —
      // a newer purchase may have superseded this row in between.
      await db.execute({
        sql: `UPDATE office
                 SET subscription_status='expired'
               WHERE id=? AND current_plan=? AND subscription_expires_at=?`,
        args: [sub.office_id, sub.plan_code, sub.expires_at]
      });

      await db.execute({
        sql: `INSERT INTO payment_event
                (subject_type, subject_id, provider, thawani_session_id, event_type, amount_omr, raw_json)
              VALUES ('office_subscription', ?, 'thawani', ?, 'expired', ?, ?)`,
        args: [
          sub.id, sub.thawani_session_id || null, sub.amount_omr || null,
          JSON.stringify({ source: 'sub-watcher', expires_at: sub.expires_at, grace_hours: GRACE_HOURS })
        ]
      });
      expired++;
    } catch (e) { console.warn('[sub-watcher] expire row failed:', e.message); errors++; }
  }

  // ── Phase 2: renewal reminders ───────────────────────────
  // For each configured reminder offset (default 7/3/1 days), find subs
  // whose expires_at falls on that calendar date and send. payment_event
  // is the dedupe table — one `reminder_sent_${N}d` row per (sub, day-offset).
  for (const days of REMINDER_DAYS) {
    const targetDate = new Date(Date.now() + days * 86_400_000)
      .toISOString().slice(0, 10);   // 'YYYY-MM-DD'
    const eventType = `reminder_sent_${days}d`;
    let dueRows = [];
    try {
      const { rows } = await db.execute({
        sql: `SELECT s.id, s.office_id, s.plan_code, s.expires_at, s.amount_omr,
                     o.email, o.phone, o.name_en, o.name_ar
                FROM office_subscription s
                JOIN office o ON o.id = s.office_id
               WHERE s.payment_status='active'
                 AND DATE(s.expires_at) = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM payment_event pe
                    WHERE pe.subject_type='office_subscription'
                      AND pe.subject_id   = s.id
                      AND pe.event_type   = ?
                 )
               LIMIT 100`,
        args: [targetDate, eventType]
      });
      dueRows = rows;
    } catch (e) { console.warn(`[sub-watcher] reminder scan ${days}d failed:`, e.message); errors++; continue; }

    for (const sub of dueRows) {
      try {
        // Three-tier fallback (template → CTA URL → plain text). See
        // lib/whatsapp_payment_messages.js. We still write the
        // payment_event dedupe row regardless of send outcome so a
        // transient WhatsApp 500 doesn't loop the office forever.
        if (sub.phone) {
          sendRenewalReminder({
            phone:     sub.phone,
            lang:      'ar',
            days,
            planLabel: sub.plan_code,
            expiresAt: sub.expires_at,
            renewUrl:  (process.env.PUBLIC_BASE_URL || 'https://saned.ai') + '/officer.html'
          }).then(r => {
            if (r?.tier && r.tier !== 'template') {
              console.log(`[sub-watcher] reminder sent via tier=${r.tier} for office ${sub.office_id}`);
            }
          }).catch(e =>
            console.warn(`[sub-watcher] WA send failed for office ${sub.office_id}:`, e.message)
          );
        }
        await db.execute({
          sql: `INSERT INTO payment_event
                  (subject_type, subject_id, provider, event_type, raw_json)
                VALUES ('office_subscription', ?, 'thawani', ?, ?)`,
          args: [sub.id, eventType,
                 JSON.stringify({ days_offset: days, expires_at: sub.expires_at, phone_used: !!sub.phone })]
        });
        reminded++;
      } catch (e) { console.warn(`[sub-watcher] reminder send ${days}d failed:`, e.message); errors++; }
    }
  }

  return { expired, reminded, errors };
}

/** Start the periodic sweep. No-op in tests or when SANAD_SKIP_SUB_WATCHER=true. */
export function startSubscriptionWatcher() {
  if (process.env.NODE_ENV === 'test' || process.env.SANAD_SKIP_SUB_WATCHER === 'true') {
    console.log('[sub-watcher] disabled (test or SANAD_SKIP_SUB_WATCHER)');
    return null;
  }
  if (_timer) return _timer;
  console.log(
    `[sub-watcher] sweep every ${SWEEP_S}s · reminders at ${REMINDER_DAYS.join('/')}d · grace ${GRACE_HOURS}h`
  );
  const tick = async () => {
    try {
      const r = await sweepSubscriptions();
      if (r.expired || r.reminded || r.errors) {
        console.log(`[sub-watcher] expired=${r.expired} reminded=${r.reminded} errors=${r.errors}`);
      }
    } catch (e) {
      console.warn('[sub-watcher] sweep crashed:', e.message);
    }
  };
  _timer = setInterval(tick, SWEEP_S * 1000);
  // Don't unref — Node should keep the process alive on its own through
  // express; the watcher dying when the server dies is the intended pair.
  return _timer;
}

export function stopSubscriptionWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
