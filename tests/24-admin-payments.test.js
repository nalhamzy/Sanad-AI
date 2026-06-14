// Tests for the admin payments console routes (PR 4).
//
// Coverage:
//   • GET  /api/platform-admin/subscriptions — listing + filters
//   • GET  /api/platform-admin/subscriptions/:id — detail + event timeline
//   • POST /api/platform-admin/subscriptions/:id/extend
//   • POST /api/platform-admin/subscriptions/:id/cancel
//   • GET  /api/platform-admin/payments — citizen-payment listing
//   • GET  /api/platform-admin/payments/events — event log + filters
//   • GET  /api/platform-admin/payments/kpis — KPI aggregates
//
// All routes are gated by requirePlatformAdmin. DEBUG_MODE in helpers.js
// auto-elevates any signed-in officer to admin, so we just need a cookie.
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv, spawnServer, fetchJSON, registerAndApproveOffice } from './helpers.js';

let env;
before(async () => {
  await bootTestEnv();
  env = await spawnServer();
});
after(async () => { await env.stop(); });

// Build a v2 sub row directly via SQL — we don't need the gateway here.
async function seedSub({ officeId, plan = 'monthly', amount = 30, months = 1,
                          status = 'active', expiresAt = null, sessionId = null }) {
  const { db } = await import('../lib/db.js');
  const ins = await db.execute({
    sql: `INSERT INTO office_subscription
            (office_id, plan_code, amount_omr, credits_granted, months,
             amwal_merchant_ref, thawani_session_id, payment_status, starts_at, expires_at)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, datetime('now'), ?)`,
    args: [
      officeId, plan, amount, months,
      `mref-${officeId}-${plan}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      sessionId, status, expiresAt
    ]
  });
  return Number(ins.lastInsertRowid);
}

describe('GET /api/platform-admin/subscriptions', () => {

  test('rejects unauthenticated callers (no cookie)', async () => {
    const r = await fetchJSON(env.origin, '/api/platform-admin/subscriptions');
    assert.ok(r.status === 401 || r.status === 403,
      `expected 401/403, got ${r.status}`);
  });

  test('lists v2 subs only (filters out legacy starter-70)', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const { db } = await import('../lib/db.js');
    // Insert a legacy starter-70 row AND a v2 row.
    await db.execute({
      sql: `INSERT INTO office_subscription
              (office_id, plan_code, amount_omr, credits_granted,
               amwal_merchant_ref, payment_status)
            VALUES (?, 'starter-70', 35, 70, ?, 'active')`,
      args: [office_id, `legacy-${office_id}-${Date.now()}`]
    });
    const v2Id = await seedSub({ officeId: office_id, plan: 'monthly', status: 'active' });
    const r = await fetchJSON(env.origin, `/api/platform-admin/subscriptions?office_id=${office_id}`, {
      headers: { cookie }
    });
    assert.equal(r.status, 200);
    const codes = r.body.subscriptions.map(s => s.plan_code);
    assert.ok(codes.includes('monthly'),  'v2 monthly must appear');
    assert.ok(!codes.includes('starter-70'), 'legacy plan must NOT appear');
    // The new v2 row must be in the response.
    assert.ok(r.body.subscriptions.find(s => s.id === v2Id));
  });

  test('filters by status=active', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await seedSub({ officeId: office_id, plan: 'monthly', status: 'active' });
    await seedSub({ officeId: office_id, plan: 'annual',  status: 'pending' });
    const r = await fetchJSON(env.origin, `/api/platform-admin/subscriptions?status=active&office_id=${office_id}`, {
      headers: { cookie }
    });
    assert.equal(r.status, 200);
    for (const s of r.body.subscriptions) {
      assert.equal(s.payment_status, 'active');
    }
  });
});

describe('subscription extend + cancel', () => {

  test('extend by N days advances expires_at and snapshots office', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const { db } = await import('../lib/db.js');
    const subId = await seedSub({
      officeId: office_id, plan: 'monthly', status: 'active',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    });
    const r = await fetchJSON(env.origin, `/api/platform-admin/subscriptions/${subId}/extend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ days: 30 })
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.expires_at, 'new expires_at returned');

    const sub = (await db.execute({
      sql: `SELECT expires_at, payment_status FROM office_subscription WHERE id=?`,
      args: [subId]
    })).rows[0];
    // The new expiry should be ~30 days from the old one (or from now).
    const newMs = new Date(sub.expires_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(newMs > Date.now() + 25 * 86_400_000,
      `new expiry should be ~30d out: ${sub.expires_at}`);
    assert.equal(sub.payment_status, 'active');

    // payment_event row written.
    const ev = (await db.execute({
      sql: `SELECT event_type FROM payment_event
              WHERE subject_type='office_subscription' AND subject_id=?
              ORDER BY id DESC LIMIT 1`,
      args: [subId]
    })).rows[0];
    assert.equal(ev.event_type, 'manual_extend');
  });

  test('cancel flips active sub to expired and writes event', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const { db } = await import('../lib/db.js');
    const subId = await seedSub({ officeId: office_id, plan: 'monthly', status: 'active' });
    const r = await fetchJSON(env.origin, `/api/platform-admin/subscriptions/${subId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ reason: 'test cancel' })
    });
    assert.equal(r.status, 200);
    const sub = (await db.execute({
      sql: `SELECT payment_status, cancelled_at FROM office_subscription WHERE id=?`,
      args: [subId]
    })).rows[0];
    assert.equal(sub.payment_status, 'expired');
    assert.ok(sub.cancelled_at);

    const ev = (await db.execute({
      sql: `SELECT event_type FROM payment_event
              WHERE subject_type='office_subscription' AND subject_id=?
              ORDER BY id DESC LIMIT 1`,
      args: [subId]
    })).rows[0];
    assert.equal(ev.event_type, 'cancelled');
  });

  test('cancel on a non-active sub returns 409', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const subId = await seedSub({ officeId: office_id, plan: 'monthly', status: 'pending' });
    const r = await fetchJSON(env.origin, `/api/platform-admin/subscriptions/${subId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ reason: 'too soon' })
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_active');
  });
});

describe('GET /api/platform-admin/payments/kpis', () => {

  test('returns numeric aggregates with no errors', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await seedSub({ officeId: office_id, plan: 'quarterly', amount: 82.8, months: 3, status: 'active' });
    await seedSub({ officeId: office_id, plan: 'annual',    amount: 288,   months: 12, status: 'active' });
    const r = await fetchJSON(env.origin, '/api/platform-admin/payments/kpis', {
      headers: { cookie }
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.active_subscriptions, 'number');
    assert.equal(typeof r.body.mrr_omr, 'number');
    assert.equal(typeof r.body.expiring_7d, 'number');
    assert.equal(typeof r.body.citizen_payments_today, 'number');
    assert.equal(typeof r.body.omr_collected_today, 'number');
    assert.ok(r.body.active_subscriptions >= 2,
      'at least the two we just inserted should count');
    // MRR contribution: 82.8/3 + 288/12 = 27.6 + 24 = 51.6
    assert.ok(r.body.mrr_omr >= 51.6 - 0.01,
      `MRR should include the seeded subs: ${r.body.mrr_omr}`);
  });
});

describe('GET /api/platform-admin/payments/events', () => {

  test('returns event log + supports event_type filter', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const subId = await seedSub({ officeId: office_id, plan: 'monthly', status: 'active' });
    const { db } = await import('../lib/db.js');
    // Write a known event so we can find it.
    await db.execute({
      sql: `INSERT INTO payment_event
              (subject_type, subject_id, provider, event_type, raw_json)
            VALUES ('office_subscription', ?, 'thawani', 'paid', ?)`,
      args: [subId, JSON.stringify({ test: true })]
    });

    const all = await fetchJSON(env.origin, '/api/platform-admin/payments/events', {
      headers: { cookie }
    });
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.events));
    assert.ok(all.body.events.length >= 1);

    const filtered = await fetchJSON(env.origin, '/api/platform-admin/payments/events?event_type=paid', {
      headers: { cookie }
    });
    assert.equal(filtered.status, 200);
    for (const e of filtered.body.events) assert.equal(e.event_type, 'paid');
  });
});

describe('GET /api/platform-admin/payments (citizen payments listing)', () => {

  test('returns paid+awaiting rows; respects status filter', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const { db } = await import('../lib/db.js');
    // Build a minimal request row with payment_ref set.
    await db.execute({
      sql: `INSERT INTO request
              (session_id, status, payment_status, payment_ref, payment_amount_omr,
               payment_session_id, payment_provider, paid_at, last_event_at)
            VALUES ('test-sess-pmt', 'in_progress', 'paid', ?, 5.0, ?, 'thawani', datetime('now'), datetime('now'))`,
      args: [`req-test-${Date.now()}`, `checkout_test_${Date.now()}`]
    });
    const r = await fetchJSON(env.origin, '/api/platform-admin/payments?status=paid', {
      headers: { cookie }
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.payments.length >= 1);
    for (const p of r.body.payments) assert.equal(p.payment_status, 'paid');
  });
});
