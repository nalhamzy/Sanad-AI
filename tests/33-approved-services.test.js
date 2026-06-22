// Office-approved services loader + verification flag.
//
// These ~29 Ministry-of-Labour services were confirmed by a real Sanad office
// (commission + required fields). The loader marks them verification_status=
// 'office_approved' (source 'office'), records the office commission, leaves the
// government fee unknown (gov_fee_tbd=1, fee_omr NULL), stores typed doc fields,
// and writes a validated annotation row. It's idempotent (keyed by source_url).
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { bootTestEnv } = await import('./helpers.js');
await bootTestEnv();

const { loadApprovedServices } = await import('../scripts/load_approved_services.mjs');
const { APPROVED_SERVICES } = await import('../data/approved_services.mjs');
const { db } = await import('../lib/db.js');

const N = APPROVED_SERVICES.length;

describe('approved-services loader', () => {

  test('apply loads every approved service as office-verified', async () => {
    const report = await loadApprovedServices({ apply: true });
    assert.equal(report.length, N);
    const { rows } = await db.execute(
      `SELECT COUNT(*) AS n FROM service_catalog
        WHERE verification_status='office_approved' AND verification_source='office'`);
    assert.equal(Number(rows[0].n), N);
  });

  test('a sample service carries commission, gov-fee-TBD, and TYPED docs', async () => {
    const { rows } = await db.execute({
      sql: `SELECT * FROM service_catalog WHERE source_url=? LIMIT 1`,
      args: ['approved:work_contract_omani']
    });
    const s = rows[0];
    assert.ok(s, 'work_contract_omani present');
    assert.equal(Number(s.office_fee_omr), 3);   // office commission
    assert.equal(s.fee_omr, null);               // government fee unknown
    assert.equal(Number(s.gov_fee_tbd), 1);
    assert.equal(Number(s.is_active), 1);
    const docs = JSON.parse(s.required_documents_json);
    assert.ok(docs.some(d => d.type === 'date'), 'has a date field');
    assert.ok(docs.some(d => d.type === 'text'), 'has a text field');
    assert.ok(docs.some(d => d.type === 'file'), 'has a file field');
  });

  test('each approved service has a validated annotation row (shows verified in annotator)', async () => {
    const { rows } = await db.execute(
      `SELECT COUNT(DISTINCT v.service_id) AS n
         FROM service_validation v
         JOIN service_catalog s ON s.id = v.service_id
        WHERE s.verification_source='office' AND v.status='validated'`);
    assert.equal(Number(rows[0].n), N);
  });

  test('idempotent — re-applying does not duplicate', async () => {
    await loadApprovedServices({ apply: true });
    const { rows } = await db.execute(
      `SELECT COUNT(*) AS n FROM service_catalog WHERE verification_source='office'`);
    assert.equal(Number(rows[0].n), N);
  });

  test('dry run writes nothing', async () => {
    const before = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
    const report = await loadApprovedServices({ apply: false });
    const after = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
    assert.equal(Number(before.rows[0].n), Number(after.rows[0].n));
    assert.equal(report.length, N);
  });
});
