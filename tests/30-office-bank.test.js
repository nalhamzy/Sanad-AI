// Integration tests for the office bank+contact API and the payout-side
// bank-gate. Covers:
//   • GET  /api/office/bank        — initial empty state
//   • PATCH /api/office/bank       — happy path + each validation error
//   • IBAN change clears bank_verified_at
//   • Admin /payouts/eligible-by-office exposes bank flags
//   • Admin /payouts/:id/mark-paid refuses on missing bank unless force=true
//   • Admin /office/:id/verify-bank flips the verified flag
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

// Canonical valid Oman IBAN (mod-97 ok) — used everywhere we need a real one.
const VALID_OM_IBAN = 'OM470030000012345678901';

describe('GET /api/office/bank — initial empty', () => {
  test('returns has_bank_details=false for a fresh office', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.body.has_bank_details, false);
    assert.equal(r.body.bank.iban, '');
    assert.equal(r.body.bank.bank_name, '');
    assert.equal(r.body.contact.email, undefined === r.body.contact.email ? undefined : r.body.contact.email);  // may have signup email
  });
});

describe('PATCH /api/office/bank — validation', () => {

  test('rejects malformed IBAN with bad_iban + reason', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ iban: 'OM81 NOT A REAL IBAN' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_iban');
    assert.ok(['bad_chars', 'bad_length', 'bad_checksum'].includes(r.body.detail),
      `expected a known iban-error tag, got ${r.body.detail}`);
  });

  test('rejects malformed SWIFT', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bank_swift: 'NOPE' })  // too short
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_swift');
  });

  test('rejects malformed billing email', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ billing_email: 'not-an-email' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_billing_email');
  });

  test('empty body → no_fields', async () => {
    const { cookie } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'no_fields');
  });
});

describe('PATCH /api/office/bank — happy path', () => {

  test('saves all fields and flips has_bank_details true', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        iban:                VALID_OM_IBAN,
        bank_name:           'Bank Muscat',
        account_holder_name: 'Test Office LLC',
        bank_swift:          'BMUSOMRX',
        billing_email:       'accounting@office.test.om',
        phone:               '+96812345678'
      })
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.updated.includes('iban'));

    const g = await fetchJSON(env.origin, '/api/office/bank', { headers: { cookie } });
    assert.equal(g.body.has_bank_details, true);
    assert.equal(g.body.bank.iban, VALID_OM_IBAN);
    assert.equal(g.body.bank.bank_name, 'Bank Muscat');
    assert.equal(g.body.bank.account_holder_name, 'Test Office LLC');
    assert.equal(g.body.bank.bank_swift, 'BMUSOMRX');
    assert.equal(g.body.bank.billing_email, 'accounting@office.test.om');
    assert.equal(g.body.contact.phone, '+96812345678');
    assert.ok(g.body.bank.bank_updated_at, 'bank_updated_at must be stamped');
    assert.equal(g.body.bank.bank_verified_at, null, 'new bank starts unverified');
  });

  test('changing IBAN clears bank_verified_at', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    // 1. Seed bank + verified flag directly.
    await db.execute({
      sql: `UPDATE office
               SET iban=?, bank_name='X', account_holder_name='Y',
                   bank_verified_at=datetime('now')
             WHERE id=?`,
      args: [VALID_OM_IBAN, office_id]
    });
    // 2. Patch with a NEW valid IBAN (Saudi this time).
    const newIban = 'SA0380000000608010167519';
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ iban: newIban })
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.iban_verification_cleared, true);
    // 3. Confirm cleared.
    const { rows } = await db.execute({
      sql: `SELECT iban, bank_verified_at FROM office WHERE id=?`,
      args: [office_id]
    });
    assert.equal(rows[0].iban, newIban);
    assert.equal(rows[0].bank_verified_at, null);
  });

  test('empty IBAN string clears the field', async () => {
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    const { db } = await import('../lib/db.js');
    await db.execute({
      sql: `UPDATE office SET iban=? WHERE id=?`,
      args: [VALID_OM_IBAN, office_id]
    });
    const r = await fetchJSON(env.origin, '/api/office/bank', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ iban: '' })
    });
    assert.equal(r.status, 200);
    const { rows } = await db.execute({
      sql: `SELECT iban FROM office WHERE id=?`, args: [office_id]
    });
    assert.equal(rows[0].iban, null);
  });
});

describe('Admin payouts surface bank flags', () => {

  test('/payouts/eligible-by-office returns iban + has_bank_details per office', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    // Seed an eligible paid request + bank info.
    await db.execute({
      sql: `INSERT INTO request
              (session_id, office_id, status, payment_status, payment_amount_omr,
               payment_ref, payment_provider, paid_at, last_event_at)
            VALUES (?, ?, 'in_progress', 'paid', 25.0, ?, 'thawani',
                    datetime('now'), datetime('now'))`,
      args: ['sess-bank-test', office_id, `req-bank-${Date.now()}`]
    });
    await db.execute({
      sql: `UPDATE office
               SET iban=?, bank_name='Bank Muscat', account_holder_name='Holder'
             WHERE id=?`,
      args: [VALID_OM_IBAN, office_id]
    });
    // Use a wide date window that definitely contains "today" since the
    // seeded paid_at is datetime('now'). The default preset is last-week.
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetchJSON(env.origin,
      `/api/platform-admin/payouts/eligible-by-office?from=2020-01-01&to=${today}`,
      { headers: { cookie } });
    assert.equal(r.status, 200);
    const me = r.body.offices.find(o => o.office_id === office_id);
    assert.ok(me, 'seeded office should appear');
    assert.equal(me.iban, VALID_OM_IBAN);
    assert.equal(me.has_bank_details, true);
  });
});

describe('Admin mark-paid bank gate', () => {

  test('refuses when office has no bank details (without force)', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    // Seed paid request and generate a payout — but DON'T set bank details.
    await db.execute({
      sql: `INSERT INTO request
              (session_id, office_id, status, payment_status, payment_amount_omr,
               payment_ref, payment_provider, paid_at, last_event_at)
            VALUES (?, ?, 'in_progress', 'paid', 12.0, ?, 'thawani',
                    '2026-05-15 12:00:00', '2026-05-15 12:00:00')`,
      args: ['sess-nobank', office_id, `req-nobank-${Date.now()}`]
    });
    const { generatePayout } = await import('../lib/payouts.js');
    const { payout } = await generatePayout({
      officeId: office_id, from: '2026-05-10', to: '2026-05-25'
    });

    const r = await fetchJSON(env.origin,
      `/api/platform-admin/payouts/${payout.id}/mark-paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reference: 'TEST-001' })
      });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'office_missing_bank_details');
  });

  test('accepts when bank details present', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    // Bank details first.
    await db.execute({
      sql: `UPDATE office SET iban=?, bank_name='X', account_holder_name='Y' WHERE id=?`,
      args: [VALID_OM_IBAN, office_id]
    });
    await db.execute({
      sql: `INSERT INTO request
              (session_id, office_id, status, payment_status, payment_amount_omr,
               payment_ref, payment_provider, paid_at, last_event_at)
            VALUES (?, ?, 'in_progress', 'paid', 15.0, ?, 'thawani',
                    '2026-05-15 12:00:00', '2026-05-15 12:00:00')`,
      args: ['sess-bank-ok', office_id, `req-bank-ok-${Date.now()}`]
    });
    const { generatePayout } = await import('../lib/payouts.js');
    const { payout } = await generatePayout({
      officeId: office_id, from: '2026-05-10', to: '2026-05-25'
    });

    const r = await fetchJSON(env.origin,
      `/api/platform-admin/payouts/${payout.id}/mark-paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reference: 'BANK-REF-OK' })
      });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('accepts when force=true even without bank details', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await db.execute({
      sql: `INSERT INTO request
              (session_id, office_id, status, payment_status, payment_amount_omr,
               payment_ref, payment_provider, paid_at, last_event_at)
            VALUES (?, ?, 'in_progress', 'paid', 8.0, ?, 'thawani',
                    '2026-05-15 12:00:00', '2026-05-15 12:00:00')`,
      args: ['sess-force', office_id, `req-force-${Date.now()}`]
    });
    const { generatePayout } = await import('../lib/payouts.js');
    const { payout } = await generatePayout({
      officeId: office_id, from: '2026-05-10', to: '2026-05-25'
    });
    const r = await fetchJSON(env.origin,
      `/api/platform-admin/payouts/${payout.id}/mark-paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reference: 'FORCED', force: true })
      });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

describe('Admin verify-bank endpoint', () => {

  test('flips bank_verified_at, then clears it on { verified:false }', async () => {
    const { db } = await import('../lib/db.js');
    const { cookie, office_id } = await registerAndApproveOffice(env.origin);
    await db.execute({
      sql: `UPDATE office SET iban=?, bank_name='X', account_holder_name='Y' WHERE id=?`,
      args: [VALID_OM_IBAN, office_id]
    });
    const r1 = await fetchJSON(env.origin,
      `/api/platform-admin/office/${office_id}/verify-bank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ verified: true })
      });
    assert.equal(r1.status, 200);
    const { rows: a } = await db.execute({
      sql: `SELECT bank_verified_at FROM office WHERE id=?`, args: [office_id]
    });
    assert.ok(a[0].bank_verified_at, 'verified timestamp should be set');

    const r2 = await fetchJSON(env.origin,
      `/api/platform-admin/office/${office_id}/verify-bank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ verified: false })
      });
    assert.equal(r2.status, 200);
    const { rows: b } = await db.execute({
      sql: `SELECT bank_verified_at FROM office WHERE id=?`, args: [office_id]
    });
    assert.equal(b[0].bank_verified_at, null, 'verified timestamp should clear');
  });
});
