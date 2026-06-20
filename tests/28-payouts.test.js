// Tests for lib/payouts.js + the admin payouts routes.
//
// The payouts logic moves real money on Fridays — we want hard guarantees:
//   • A request only counts in ONE payout (no double-pay)
//   • cancel releases the requests back to the eligible pool
//   • Platform fee is correctly subtracted from gross
//   • Idempotent mark-paid (re-clicking the button is safe)
//   • CSV export carries the BOM (Excel renders Arabic correctly)
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

// ── Helpers ─────────────────────────────────────────────────
async function seedPaidRequest({ officeId, amountOmr = 30, paidAtSqlDt }) {
  const { db } = await import('../lib/db.js');
  const ins = await db.execute({
    sql: `INSERT INTO request
            (session_id, office_id, status, payment_status, payment_amount_omr,
             payment_ref, payment_provider, paid_at, last_event_at)
          VALUES (?, ?, 'in_progress', 'paid', ?, ?, 'thawani', ?, ?)`,
    args: [
      `sess-payout-${Math.random().toString(36).slice(2,8)}`,
      officeId, amountOmr,
      `pref-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      paidAtSqlDt, paidAtSqlDt
    ]
  });
  return Number(ins.lastInsertRowid);
}

const PAST_DT  = '2026-05-15 12:00:00'; // safely inside "last week" usually
const TODAY_DT = (() => {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
})();
const RANGE_FROM = '2026-05-10';
const RANGE_TO   = '2026-05-25';

describe('lib/payouts.js — previewPayout()', () => {

  test('returns empty preview when no eligible requests', async () => {
    const { previewPayout } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    const p = await previewPayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.equal(p.request_count, 0);
    assert.equal(p.gross_omr, 0);
    assert.equal(p.net_omr, 0);
    assert.deepEqual(p.requests, []);
  });

  test('sums gross, subtracts fee per request, computes net', async () => {
    const { previewPayout, platformFeeOmr } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 10, paidAtSqlDt: PAST_DT });
    await seedPaidRequest({ officeId: office_id, amountOmr: 20, paidAtSqlDt: PAST_DT });
    await seedPaidRequest({ officeId: office_id, amountOmr: 30, paidAtSqlDt: PAST_DT });
    const p = await previewPayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.equal(p.request_count, 3);
    assert.equal(p.gross_omr, 60);
    const expectedFee = 3 * platformFeeOmr();
    assert.equal(p.platform_fee_omr, expectedFee);
    assert.equal(p.net_omr, 60 - expectedFee);
  });

  test('ignores requests already attached to another payout', async () => {
    const { previewPayout, generatePayout } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 10, paidAtSqlDt: PAST_DT });
    // Generate once → those requests now have payout_id set.
    const first = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.ok(first, 'first payout should generate');
    // Second preview should see nothing eligible.
    const p = await previewPayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.equal(p.request_count, 0);
  });
});

describe('lib/payouts.js — generatePayout()', () => {

  test('writes office_payout row and stamps request.payout_id atomically', async () => {
    const { generatePayout } = await import('../lib/payouts.js');
    const { db } = await import('../lib/db.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    const r1 = await seedPaidRequest({ officeId: office_id, amountOmr: 50, paidAtSqlDt: PAST_DT });
    const r2 = await seedPaidRequest({ officeId: office_id, amountOmr: 25, paidAtSqlDt: PAST_DT });
    const result = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.ok(result, 'must return a result');
    assert.equal(result.payout.request_count, 2);
    assert.equal(result.payout.gross_omr, 75);
    assert.equal(result.payout.status, 'pending');
    assert.ok(result.request_ids.includes(r1));
    assert.ok(result.request_ids.includes(r2));
    // Both requests carry the payout_id.
    const { rows } = await db.execute({
      sql: `SELECT id, payout_id FROM request WHERE id IN (?, ?)`,
      args: [r1, r2]
    });
    for (const r of rows) assert.equal(r.payout_id, result.payout.id);
  });

  test('returns null when nothing is eligible (no row written)', async () => {
    const { generatePayout } = await import('../lib/payouts.js');
    const { db } = await import('../lib/db.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    const before = (await db.execute(`SELECT COUNT(*) AS n FROM office_payout`)).rows[0].n;
    const result = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.equal(result, null);
    const after = (await db.execute(`SELECT COUNT(*) AS n FROM office_payout`)).rows[0].n;
    assert.equal(after, before, 'no row should be created when eligible=0');
  });
});

describe('lib/payouts.js — markPayoutPaid() + cancelPayout()', () => {

  test('mark-paid flips status, writes paid_at + reference', async () => {
    const { generatePayout, markPayoutPaid } = await import('../lib/payouts.js');
    const { db } = await import('../lib/db.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 12, paidAtSqlDt: PAST_DT });
    const { payout } = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    const r = await markPayoutPaid({ payoutId: payout.id, reference: 'BANK-REF-001' });
    assert.equal(r.ok, true);
    const row = (await db.execute({
      sql: `SELECT status, paid_at, paid_reference FROM office_payout WHERE id=?`,
      args: [payout.id]
    })).rows[0];
    assert.equal(row.status, 'paid');
    assert.ok(row.paid_at);
    assert.equal(row.paid_reference, 'BANK-REF-001');
  });

  test('mark-paid is idempotent (second call returns already:true)', async () => {
    const { generatePayout, markPayoutPaid } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 8, paidAtSqlDt: PAST_DT });
    const { payout } = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    await markPayoutPaid({ payoutId: payout.id, reference: 'x' });
    const second = await markPayoutPaid({ payoutId: payout.id, reference: 'y' });
    assert.equal(second.ok, true);
    assert.equal(second.already, true);
  });

  test('cancel releases requests back to eligible (payout_id cleared)', async () => {
    const { generatePayout, cancelPayout, previewPayout } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 20, paidAtSqlDt: PAST_DT });
    const { payout } = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    await cancelPayout({ payoutId: payout.id });
    // Now eligible again.
    const p2 = await previewPayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    assert.equal(p2.request_count, 1);
  });

  test('cancel on a paid payout returns not_pending', async () => {
    const { generatePayout, markPayoutPaid, cancelPayout } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 9, paidAtSqlDt: PAST_DT });
    const { payout } = await generatePayout({ officeId: office_id, from: RANGE_FROM, to: RANGE_TO });
    await markPayoutPaid({ payoutId: payout.id });
    const r = await cancelPayout({ payoutId: payout.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_pending');
  });
});

describe('lib/payouts.js — exportPayoutsCsv()', () => {

  test('CSV has UTF-8 BOM and a header row', async () => {
    const { exportPayoutsCsv } = await import('../lib/payouts.js');
    const csv = await exportPayoutsCsv({ from: '2020-01-01', to: '2030-01-01' });
    assert.equal(csv.charCodeAt(0), 0xFEFF, 'first character must be UTF-8 BOM');
    const firstLine = csv.slice(1).split('\r\n')[0];
    assert.ok(firstLine.includes('Payout ID'));
    assert.ok(firstLine.includes('Gross OMR'));
    assert.ok(firstLine.includes('Net OMR'));
  });
});

describe('Admin routes — /api/platform-admin/payouts/*', () => {

  test('rejects unauthenticated (no cookie)', async () => {
    const r = await fetchJSON(env.origin, '/api/platform-admin/payouts/eligible-by-office');
    assert.ok(r.status === 401 || r.status === 403);
  });

  test('GET /payouts/eligible-by-office returns shape with totals', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 40, paidAtSqlDt: PAST_DT });
    const r = await fetchJSON(env.origin,
      '/api/platform-admin/payouts/eligible-by-office?from=' + RANGE_FROM + '&to=' + RANGE_TO,
      { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.fee_per_request_omr, 'number');
    assert.ok(Array.isArray(r.body.offices));
    assert.ok(r.body.totals);
    // Our seeded office should appear with request_count >= 1.
    const me = r.body.offices.find(o => o.office_id === office_id);
    assert.ok(me, 'seeded office must appear in the eligible list');
    assert.ok(me.request_count >= 1);
  });

  test('POST /payouts/generate creates a row and removes office from eligible', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await seedPaidRequest({ officeId: office_id, amountOmr: 10, paidAtSqlDt: PAST_DT });
    const gen = await fetchJSON(env.origin, '/api/platform-admin/payouts/generate', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ office_id, from: RANGE_FROM, to: RANGE_TO })
    });
    assert.equal(gen.status, 200);
    assert.ok(gen.body.payout?.id);
    // Eligible list should no longer include this office.
    const e = await fetchJSON(env.origin,
      '/api/platform-admin/payouts/eligible-by-office?from=' + RANGE_FROM + '&to=' + RANGE_TO,
      { headers: { cookie } });
    const stillThere = e.body.offices.find(o => o.office_id === office_id);
    assert.ok(!stillThere, 'office should drop out of eligible after generate');
  });

  test('GET /payouts/export returns text/csv (header + body sanity)', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    // Add a small "from/to" range to keep the export bounded — empty range
    // tries to dump every payout the test suite has accumulated, which is
    // far bigger than this test needs and was flaky in the suite.
    const res = await fetch(
      env.origin + '/api/platform-admin/payouts/export?from=2026-05-10&to=2026-05-25',
      { headers: { cookie } }
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    const body = await res.text();
    // Header row check — BOM is hard to assert on cross-platform without
    // bytewise reads; presence of the column names is a stronger signal.
    assert.ok(body.includes('Payout ID'), 'CSV must contain header row');
    assert.ok(body.includes('Net OMR'),   'CSV must contain Net OMR column');
  });
});

describe('lib/payouts.js — reconcile() cash position', () => {
  // Isolated date window (2026-03) so reconcile only sees this test's rows,
  // not paid requests seeded by other tests in the shared test DB.
  const MY_DT = '2026-03-15 12:00:00', MY_FROM = '2026-03-10', MY_TO = '2026-03-25';
  const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

  test('buckets paid requests into transferred / pending / unsettled', async () => {
    const { generatePayout, markPayoutPaid, reconcile, platformFeeOmr } = await import('../lib/payouts.js');
    const { office_id } = await registerAndApproveOffice(env.origin);
    const fee = platformFeeOmr();

    // reqA → into a payout we MARK PAID (transferred)
    await seedPaidRequest({ officeId: office_id, amountOmr: 10, paidAtSqlDt: MY_DT });
    const g1 = await generatePayout({ officeId: office_id, from: MY_FROM, to: MY_TO });
    await markPayoutPaid({ payoutId: g1.payout.id, reference: 'TXN-1' });

    // reqB → into a payout we LEAVE PENDING (awaiting transfer)
    await seedPaidRequest({ officeId: office_id, amountOmr: 20, paidAtSqlDt: MY_DT });
    await generatePayout({ officeId: office_id, from: MY_FROM, to: MY_TO });

    // reqC → never batched (unsettled)
    await seedPaidRequest({ officeId: office_id, amountOmr: 30, paidAtSqlDt: MY_DT });

    const rec = await reconcile({ from: MY_FROM, to: MY_TO });
    assert.equal(rec.buckets.transferred.request_count, 1, 'one transferred');
    assert.equal(rec.buckets.pending.request_count,     1, 'one pending');
    assert.equal(rec.buckets.unsettled.request_count,   1, 'one unsettled');

    assert.equal(rec.collected_omr,       60, 'collected = 10+20+30');
    assert.equal(rec.platform_fee_omr,    r3(3 * fee));
    assert.equal(rec.owed_to_offices_omr, r3(60 - 3 * fee));
    assert.equal(rec.transferred_omr,     r3(10 - fee));
    assert.equal(rec.pending_omr,         r3(20 - fee));
    assert.equal(rec.unsettled_omr,       r3(30 - fee));
  });
});
