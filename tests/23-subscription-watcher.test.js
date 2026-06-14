// Tests for PR 3 — claim-quota gate + lib/subscription_watcher.js.
//
// Coverage:
//   • checkClaimQuota() — legacy bypass, expired sub, over-quota, happy path.
//   • sweepSubscriptions() — flips overdue subs to 'expired', writes
//     payment_event, only flips when within grace period; sends reminders
//     for subs landing on day-7/3/1 and dedupes via payment_event.
//
// Strategy: drive sweepSubscriptions() directly (it's just SQL) and
// inspect DB state. checkClaimQuota() needs an office.current_plan +
// expires_at; we craft those via raw inserts.
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv } from './helpers.js';

before(async () => { await bootTestEnv(); });

const { db } = await import('../lib/db.js');
const { checkClaimQuota } = await import('../routes/officer.js');
const { sweepSubscriptions } = await import('../lib/subscription_watcher.js');
const { toSqlDatetime, computeExpiry } = await import('../lib/plans.js');

// Convenience: build an office at a specific subscription state and
// return its id. Avoids the full signup → approve flow (we don't need an
// officer cookie for these tests).
let _officeSeq = 100;
async function makeOffice({ currentPlan = null, expiresAt = null, status = 'active' } = {}) {
  _officeSeq += 1;
  const ins = await db.execute({
    sql: `INSERT INTO office
            (name_en, name_ar, governorate, wilayat, status,
             current_plan, subscription_expires_at, subscription_status)
          VALUES (?, ?, 'Muscat', 'Bawshar', 'active', ?, ?, ?)`,
    args: [
      `WatcherTest ${_officeSeq}`, `مكتب اختبار ${_officeSeq}`,
      currentPlan, expiresAt,
      currentPlan ? status : 'none'
    ]
  });
  return Number(ins.lastInsertRowid);
}

// Insert a v2 office_subscription row at a chosen status + dates.
async function makeSub({ officeId, planCode = 'monthly', amountOmr = 30, months = 1,
                         expiresAt, startsAt, paymentStatus = 'active' }) {
  const ins = await db.execute({
    sql: `INSERT INTO office_subscription
            (office_id, plan_code, amount_omr, credits_granted, months,
             amwal_merchant_ref, payment_status, starts_at, expires_at)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    args: [
      officeId, planCode, amountOmr, months,
      `sub2-${officeId}-${planCode}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      paymentStatus, startsAt || null, expiresAt || null
    ]
  });
  return Number(ins.lastInsertRowid);
}

describe('checkClaimQuota()', () => {

  test('legacy office (current_plan null) → ok with gate=legacy', async () => {
    const id = await makeOffice({ currentPlan: null });
    const r = await checkClaimQuota(id);
    assert.equal(r.ok, true);
    assert.equal(r.gate, 'legacy');
  });

  test('expired sub (subscription_status=expired) → 402 subscription_expired', async () => {
    const id = await makeOffice({
      currentPlan: 'monthly',
      expiresAt: toSqlDatetime(new Date(Date.now() - 7 * 86_400_000)),
      status: 'expired'
    });
    const r = await checkClaimQuota(id);
    assert.equal(r.ok, false);
    assert.equal(r.http, 402);
    assert.equal(r.reason, 'subscription_expired');
  });

  test('past expires_at even when status="active" → 402 (watcher hasn\'t run yet)', async () => {
    const id = await makeOffice({
      currentPlan: 'monthly',
      expiresAt: toSqlDatetime(new Date(Date.now() - 2 * 86_400_000)),
      status: 'active'  // pretend the watcher is asleep
    });
    const r = await checkClaimQuota(id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'subscription_expired');
  });

  test('over-quota → 402 quota_exceeded with usage stats', async () => {
    const id = await makeOffice({
      currentPlan: 'monthly',
      expiresAt: computeExpiry('monthly', new Date()),
      status: 'active'
    });
    // Backfill 100 claimed requests this month to hit the quota.
    const now = toSqlDatetime(new Date());
    for (let i = 0; i < 100; i++) {
      await db.execute({
        sql: `INSERT INTO request
                (status, office_id, claimed_at, last_event_at)
              VALUES ('completed', ?, ?, ?)`,
        args: [id, now, now]
      });
    }
    const r = await checkClaimQuota(id);
    assert.equal(r.ok, false);
    assert.equal(r.http, 402);
    assert.equal(r.reason, 'quota_exceeded');
    assert.equal(r.quota, 100);
    assert.ok(r.used >= 100, `used should be >= 100, got ${r.used}`);
  });

  test('within quota → ok with v2 details', async () => {
    const id = await makeOffice({
      currentPlan: 'quarterly',
      expiresAt: computeExpiry('quarterly', new Date()),
      status: 'active'
    });
    // 3 claims this month — well under 100.
    const now = toSqlDatetime(new Date());
    for (let i = 0; i < 3; i++) {
      await db.execute({
        sql: `INSERT INTO request (status, office_id, claimed_at, last_event_at)
              VALUES ('completed', ?, ?, ?)`,
        args: [id, now, now]
      });
    }
    const r = await checkClaimQuota(id);
    assert.equal(r.ok, true);
    assert.equal(r.gate, 'v2');
    assert.equal(r.plan, 'quarterly');
    assert.equal(r.used, 3);
    assert.equal(r.quota, 100);
  });
});

describe('sweepSubscriptions()', () => {

  test('flips an overdue active sub to expired and snapshots the office', async () => {
    // expires_at = 48h ago, default grace = 24h → past grace, should expire.
    const expiresAt = toSqlDatetime(new Date(Date.now() - 48 * 3600 * 1000));
    const officeId = await makeOffice({
      currentPlan: 'monthly',
      expiresAt,
      status: 'active'
    });
    const subId = await makeSub({
      officeId, planCode: 'monthly', expiresAt, paymentStatus: 'active'
    });

    const result = await sweepSubscriptions();
    assert.ok(result.expired >= 1, `expected >=1 expired, got ${result.expired}`);

    const sub = (await db.execute({
      sql: `SELECT payment_status FROM office_subscription WHERE id=?`,
      args: [subId]
    })).rows[0];
    assert.equal(sub.payment_status, 'expired');

    const office = (await db.execute({
      sql: `SELECT subscription_status FROM office WHERE id=?`,
      args: [officeId]
    })).rows[0];
    assert.equal(office.subscription_status, 'expired');

    const ev = (await db.execute({
      sql: `SELECT event_type FROM payment_event
              WHERE subject_type='office_subscription' AND subject_id=?
              ORDER BY id DESC LIMIT 1`,
      args: [subId]
    })).rows[0];
    assert.equal(ev.event_type, 'expired');
  });

  test('does NOT expire a sub still within the grace window', async () => {
    // expires_at = 4 hours ago, default grace = 24h → still in grace.
    const expiresAt = toSqlDatetime(new Date(Date.now() - 4 * 3600 * 1000));
    const officeId = await makeOffice({
      currentPlan: 'monthly', expiresAt, status: 'active'
    });
    const subId = await makeSub({
      officeId, expiresAt, paymentStatus: 'active'
    });
    await sweepSubscriptions();
    const sub = (await db.execute({
      sql: `SELECT payment_status FROM office_subscription WHERE id=?`,
      args: [subId]
    })).rows[0];
    assert.equal(sub.payment_status, 'active', 'within grace window must stay active');
  });

  test('sends one reminder per (sub, day-offset) — dedupes via payment_event', async () => {
    // expires_at = exactly 7 days from now (UTC date math).
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() + 7);
    const expiresAt = toSqlDatetime(dt);
    const officeId = await makeOffice({
      currentPlan: 'monthly', expiresAt, status: 'active'
    });
    const subId = await makeSub({
      officeId, expiresAt, paymentStatus: 'active'
    });
    await db.execute({
      sql: `UPDATE office SET phone='+96812345678' WHERE id=?`,
      args: [officeId]
    });

    // First sweep — sends 7d reminder.
    const r1 = await sweepSubscriptions();
    assert.ok(r1.reminded >= 1, `expected >=1 reminded on first sweep, got ${r1.reminded}`);

    // Second sweep — should NOT re-send (dedupe via payment_event).
    const r2 = await sweepSubscriptions();
    // We can't assert r2.reminded == 0 globally (other rows in the DB might
    // also trigger). But we CAN assert that this sub has exactly one
    // 'reminder_sent_7d' row.
    const ev = (await db.execute({
      sql: `SELECT COUNT(*) AS n FROM payment_event
              WHERE subject_type='office_subscription' AND subject_id=?
                AND event_type='reminder_sent_7d'`,
      args: [subId]
    })).rows[0];
    assert.equal(Number(ev.n), 1,
      'dedupe should keep reminder_sent_7d to exactly one row');
  });
});
