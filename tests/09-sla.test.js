// SLA watcher tests — exercises lib/sla.js sweepExpiredSLA() directly without
// HTTP. The sweeper has TWO independent windows (review + work) and PRESERVES
// payment data on post-pay transfer (citizen must not be re-charged). These
// invariants are money-bearing — silently regressing them causes either lost
// claims or double charges. No coverage existed before this file.
import './helpers.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { bootTestEnv } = await import('./helpers.js');
await bootTestEnv();
const { db } = await import('../lib/db.js');
const sla = await import('../lib/sla.js');
const { sweepExpiredSLA, REVIEW_SLA_MINUTES, SLA_MINUTES } = sla;

// Helper — insert a request row in a known state directly. Returns the new id.
async function insertRequest({ status, office_id = 1, claim_review_started_at = null,
                                paid_at = null, payment_status = 'none',
                                payment_amount_omr = null, payment_ref = null,
                                payment_link = null }) {
  const r = await db.execute({
    sql: `INSERT INTO request
            (session_id, status, office_id, claimed_at, claim_review_started_at,
             paid_at, payment_status, payment_amount_omr, payment_ref, payment_link,
             created_at, last_event_at)
          VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?,
                  datetime('now'), datetime('now'))`,
    args: ['sla-test-' + Math.random().toString(36).slice(2, 8), status, office_id,
           claim_review_started_at, paid_at, payment_status,
           payment_amount_omr, payment_ref, payment_link]
  });
  return Number(r.lastInsertRowid);
}

async function getRequest(id) {
  const { rows } = await db.execute({ sql: 'SELECT * FROM request WHERE id=?', args: [id] });
  return rows[0];
}

async function auditFor(id, action) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM audit_log WHERE target_type='request' AND target_id=? AND action=? ORDER BY id DESC LIMIT 1`,
    args: [id, action]
  });
  return rows[0];
}

// ISO 'YYYY-MM-DD HH:MM:SS' suitable for the comparator the sweeper uses.
function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000)
           .toISOString().replace('T', ' ').replace(/\..+$/, '');
}

before(async () => {
  // Make sure office 1 (demo) exists with the offers_abandoned column reset
  // so the "counter incremented" assertion has a clean baseline.
  await db.execute({
    sql: `UPDATE office SET offers_abandoned = 0 WHERE id = 1`,
    args: []
  });
});

beforeEach(async () => {
  // Each test inserts its own rows; clean any leftover SLA-test rows so
  // re-runs are deterministic (the test DB is wiped at process start, but
  // multiple tests share the same boot here).
  await db.execute(`DELETE FROM request WHERE session_id LIKE 'sla-test-%'`);
});

describe('lib/sla.js · sweepExpiredSLA()', () => {

  describe('pre-payment review window', () => {
    test('claimed > REVIEW_SLA minutes ago without payment → released to marketplace', async () => {
      const id = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES + 1),
        payment_status: 'none'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.pre_released, 1, 'expected exactly one pre-payment release');

      const r = await getRequest(id);
      assert.equal(r.status, 'ready', 'status should flip to ready');
      assert.equal(r.office_id, null, 'office_id should be cleared');
      assert.equal(r.officer_id, null, 'officer_id should be cleared');
      assert.equal(r.claim_review_started_at, null, 'review timestamp should be cleared');
      assert.equal(r.payment_link, null, 'payment_link should be cleared');
      assert.equal(r.payment_status, 'none');
      assert.ok((r.released_count || 0) >= 1, 'released_count should increment');
    });

    test('claimed but recent (within window) → untouched', async () => {
      const id = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES - 1), // still inside
        payment_status: 'none'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.pre_released, 0, 'recent claim must not be released');

      const r = await getRequest(id);
      assert.equal(r.status, 'claimed');
      assert.equal(r.office_id, 1, 'office_id should be untouched');
    });

    test('claimed AND payment link sent (payment_status != none) → not released even if old', async () => {
      // Office sent the payment link in time — they're now waiting on the
      // citizen, not the other way around. Pre-pay sweeper must skip these.
      const id = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES + 5),
        payment_status: 'awaiting'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.pre_released, 0, 'awaiting-payment must NEVER be auto-released');

      const r = await getRequest(id);
      assert.equal(r.status, 'claimed');
      assert.equal(r.office_id, 1);
    });

    test('writes sla_pre_pay_release audit row', async () => {
      const id = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES + 2),
        payment_status: 'none'
      });
      await sweepExpiredSLA();
      const a = await auditFor(id, 'sla_pre_pay_release');
      assert.ok(a, 'audit row should be created');
      assert.equal(a.actor_type, 'system');
      const diff = JSON.parse(a.diff_json);
      assert.equal(diff.previous_office_id, 1);
      assert.equal(diff.review_sla_minutes, REVIEW_SLA_MINUTES);
    });

    test('increments office.offers_abandoned counter on release', async () => {
      const before = await db.execute({ sql: 'SELECT offers_abandoned FROM office WHERE id=1' });
      const baseline = before.rows[0].offers_abandoned || 0;

      await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES + 2),
        payment_status: 'none'
      });
      await sweepExpiredSLA();

      const after = await db.execute({ sql: 'SELECT offers_abandoned FROM office WHERE id=1' });
      assert.equal((after.rows[0].offers_abandoned || 0), baseline + 1,
        'offers_abandoned must increment by exactly one');
    });
  });

  describe('post-payment work window', () => {
    test('in_progress > SLA minutes after paid_at → transferred BUT payment preserved', async () => {
      const PAID_AT = isoMinutesAgo(SLA_MINUTES + 1);
      const id = await insertRequest({
        status: 'in_progress',
        paid_at: PAID_AT,
        payment_status: 'paid',
        payment_amount_omr: 12.5,
        payment_ref: 'pay-ref-fixture-001'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.post_transferred, 1, 'expected exactly one transfer');

      const r = await getRequest(id);
      assert.equal(r.status, 'ready', 'status should flip back to ready');
      assert.equal(r.office_id, null, 'office_id should be cleared');
      assert.equal(r.officer_id, null, 'officer_id should be cleared');
      assert.equal(r.claim_review_started_at, null);

      // CRITICAL — citizen must not be re-charged, so payment fields stay.
      assert.equal(r.paid_at, PAID_AT, 'paid_at MUST be preserved on transfer');
      assert.equal(r.payment_amount_omr, 12.5, 'payment_amount_omr MUST be preserved');
      assert.equal(r.payment_ref, 'pay-ref-fixture-001', 'payment_ref MUST be preserved');
      assert.equal(r.payment_status, 'paid', 'payment_status MUST stay paid');
    });

    test('in_progress recent (within window) → untouched', async () => {
      const id = await insertRequest({
        status: 'in_progress',
        paid_at: isoMinutesAgo(SLA_MINUTES - 1),
        payment_status: 'paid',
        payment_amount_omr: 5.0,
        payment_ref: 'pay-recent'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.post_transferred, 0);

      const r = await getRequest(id);
      assert.equal(r.status, 'in_progress');
      assert.equal(r.office_id, 1);
    });

    test('writes sla_post_pay_transfer audit row with payment-preserved note', async () => {
      const id = await insertRequest({
        status: 'in_progress',
        paid_at: isoMinutesAgo(SLA_MINUTES + 3),
        payment_status: 'paid',
        payment_amount_omr: 8,
        payment_ref: 'pay-audit-test'
      });
      await sweepExpiredSLA();
      const a = await auditFor(id, 'sla_post_pay_transfer');
      assert.ok(a, 'audit row should be created');
      const diff = JSON.parse(a.diff_json);
      assert.equal(diff.previous_office_id, 1);
      assert.equal(diff.sla_minutes, SLA_MINUTES);
      assert.match(diff.note || '', /payment preserved/i,
        'audit note should explicitly state payment is preserved');
    });
  });

  describe('safety guards', () => {
    test('returns zero counts when there is nothing to sweep', async () => {
      const result = await sweepExpiredSLA();
      assert.equal(result.pre_released, 0);
      assert.equal(result.post_transferred, 0);
    });

    test('mixed batch: pre-release + post-transfer + untouched all work in one sweep', async () => {
      const oldClaimed = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(REVIEW_SLA_MINUTES + 5),
        payment_status: 'none'
      });
      const oldPaid = await insertRequest({
        status: 'in_progress',
        paid_at: isoMinutesAgo(SLA_MINUTES + 5),
        payment_status: 'paid',
        payment_amount_omr: 3,
        payment_ref: 'mixed-batch'
      });
      const recent = await insertRequest({
        status: 'claimed',
        claim_review_started_at: isoMinutesAgo(1), // fresh
        payment_status: 'none'
      });

      const result = await sweepExpiredSLA();
      assert.equal(result.pre_released, 1, 'one pre-release expected');
      assert.equal(result.post_transferred, 1, 'one post-transfer expected');

      assert.equal((await getRequest(oldClaimed)).status, 'ready');
      assert.equal((await getRequest(oldPaid)).status, 'ready');
      assert.equal((await getRequest(oldPaid)).payment_ref, 'mixed-batch'); // preserved
      assert.equal((await getRequest(recent)).status, 'claimed');           // untouched
    });
  });
});
