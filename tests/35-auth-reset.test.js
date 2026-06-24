// Office account security: +968 phone enforcement at signup, the WhatsApp-OTP
// "forgot password" flow, logged-in change-password, and admin-initiated reset.
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { spawnServer, registerAndApproveOffice, fetchJSON } = await import('./helpers.js');
const { db } = await import('../lib/db.js');

let srv;
before(async () => { srv = await spawnServer(); });
after(async () => { await srv.stop(); });

const J = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const login = (email, password) => fetchJSON(srv.origin, '/api/auth/login', J({ email, password }));

// Insert a known reset OTP straight into the table so we can drive
// /reset-password with a code we actually know (real codes are random + hashed).
async function seedOtp(officer_id, code, { expires = '+10 minutes' } = {}) {
  const code_hash = await bcrypt.hash(code, 8);
  await db.execute({
    sql: `INSERT INTO password_reset_otp(officer_id, code_hash, expires_at)
          VALUES (?,?, datetime('now', ?))`,
    args: [officer_id, code_hash, expires]
  });
}

describe('signup — +968 phone enforcement', () => {
  test('rejects a non-Oman phone', async () => {
    const r = await fetchJSON(srv.origin, '/api/auth/signup', J({
      office_name_en: 'PhoneBad', governorate: 'Muscat', cr_number: 'CR-PB-' + Date.now(),
      email: `pb-${Date.now()}@test.om`, full_name: 'X', password: 'TestPass2026!',
      phone: '+12025551234'   // US number — not +968
    }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'validation');
    assert.ok(r.body.missing.some(m => m.startsWith('phone:')), 'phone flagged: ' + JSON.stringify(r.body.missing));
  });

  test('rejects a missing phone', async () => {
    const r = await fetchJSON(srv.origin, '/api/auth/signup', J({
      office_name_en: 'NoPhone', governorate: 'Muscat', cr_number: 'CR-NP-' + Date.now(),
      email: `np-${Date.now()}@test.om`, full_name: 'X', password: 'TestPass2026!'
    }));
    assert.equal(r.status, 400);
    assert.ok(r.body.missing.includes('phone:required'));
  });

  test('accepts + normalizes a bare 8-digit local number to +968…', async () => {
    const email = `norm-${Date.now()}@test.om`;
    const r = await fetchJSON(srv.origin, '/api/auth/signup', J({
      office_name_en: 'NormPhone', governorate: 'Muscat', cr_number: 'CR-NM-' + Date.now(),
      email, full_name: 'X', password: 'TestPass2026!', phone: '92345678'
    }));
    assert.equal(r.status, 201);
    const { rows } = await db.execute({ sql: `SELECT phone FROM officer WHERE lower(email)=?`, args: [email] });
    assert.equal(rows[0].phone, '+96892345678');
  });
});

describe('forgot-password', () => {
  test('registered office → ok + an OTP row is created', async () => {
    const { officer } = await registerAndApproveOffice(srv.origin);
    const r = await fetchJSON(srv.origin, '/api/auth/forgot-password', J({ email: officer.email }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const { rows } = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM password_reset_otp WHERE officer_id=?`, args: [officer.id]
    });
    assert.equal(Number(rows[0].n), 1, 'one reset OTP row created');
  });

  test('unknown email → still ok, but no OTP row (no enumeration)', async () => {
    const r = await fetchJSON(srv.origin, '/api/auth/forgot-password', J({ email: 'nobody-xyz@nowhere.om' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM password_reset_otp`);
    // exactly the rows created by the registered-office tests, none for the unknown email
    assert.ok(Number(rows[0].n) >= 1);
  });
});

describe('reset-password', () => {
  test('correct code sets the new password (old one stops working)', async () => {
    const { officer } = await registerAndApproveOffice(srv.origin);
    await seedOtp(officer.id, '654321');
    const r = await fetchJSON(srv.origin, '/api/auth/reset-password',
      J({ email: officer.email, code: '654321', password: 'BrandNew2026x' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal((await login(officer.email, 'BrandNew2026x')).status, 200, 'new password works');
    assert.equal((await login(officer.email, 'TestPass2026!')).status, 401, 'old password rejected');
  });

  test('wrong code → 400 invalid_code', async () => {
    const { officer } = await registerAndApproveOffice(srv.origin);
    await seedOtp(officer.id, '111111');
    const r = await fetchJSON(srv.origin, '/api/auth/reset-password',
      J({ email: officer.email, code: '999999', password: 'WhateverPass9' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_code');
  });

  test('expired code → 400 code_expired', async () => {
    const { officer } = await registerAndApproveOffice(srv.origin);
    await seedOtp(officer.id, '222222', { expires: '-1 minutes' });
    const r = await fetchJSON(srv.origin, '/api/auth/reset-password',
      J({ email: officer.email, code: '222222', password: 'WhateverPass9' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'code_expired');
  });

  test('weak new password → 400 weak_password', async () => {
    const { officer } = await registerAndApproveOffice(srv.origin);
    await seedOtp(officer.id, '333333');
    const r = await fetchJSON(srv.origin, '/api/auth/reset-password',
      J({ email: officer.email, code: '333333', password: 'short' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'weak_password');
  });
});

describe('change-password (logged in)', () => {
  test('wrong old → 401; correct → updates, new password works', async () => {
    const { cookie, officer } = await registerAndApproveOffice(srv.origin);
    const post = (body) => fetchJSON(srv.origin, '/api/office/change-password', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body)
    });

    const wrong = await post({ old_password: 'NopeNope123', new_password: 'FreshPass2026' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'wrong_old_password');

    const weak = await post({ old_password: 'TestPass2026!', new_password: 'sml' });   // < 8 chars
    assert.equal(weak.status, 400);

    const ok = await post({ old_password: 'TestPass2026!', new_password: 'FreshPass2026' });
    assert.equal(ok.status, 200);
    assert.equal((await login(officer.email, 'FreshPass2026')).status, 200);
  });
});

describe('admin-initiated reset', () => {
  test('admin resets an office → temp password is returned and works', async () => {
    const admin = await registerAndApproveOffice(srv.origin);          // DEBUG_MODE → admin
    const target = await registerAndApproveOffice(srv.origin);
    const r = await fetchJSON(srv.origin, `/api/platform-admin/office/${target.office_id}/reset-password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: '{}'
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.temp_password && r.body.temp_password.length >= 10, 'temp password returned');
    assert.equal((await login(target.officer.email, r.body.temp_password)).status, 200, 'temp password logs in');
    assert.equal((await login(target.officer.email, 'TestPass2026!')).status, 401, 'old password rejected');
  });
});

describe('standalone platform admin (no office)', () => {
  async function seedNoOfficeOfficer(role, pw) {
    const { hashPassword } = await import('../lib/auth.js');
    const email = `${role.replace('_', '')}-${Date.now()}@saned.test`;
    const hash = await hashPassword(pw);
    await db.execute({
      sql: `INSERT INTO officer(office_id, full_name, email, role, password_hash, status)
            VALUES (NULL, ?, ?, ?, ?, 'active')`,
      args: ['Test Platform Admin', email, role, hash]
    });
    const res = await fetch(srv.origin + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw })
    });
    return { email, status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  }
  // Force the role path (not the DEBUG admin fallback): an ADMIN_EMAILS list that
  // excludes our test accounts, so ONLY role='platform_admin' can grant access.
  async function withAdminEmails(fn) {
    const prev = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'someone-else@nowhere.om';
    try { return await fn(); }
    finally { if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev; }
  }

  test('no-office officer with role=platform_admin logs in + reaches admin routes', async () => {
    const a = await seedNoOfficeOfficer('platform_admin', 'AdminPass2026x');
    assert.equal(a.status, 200, 'no-office admin can log in (loadOfficer LEFT JOIN)');
    await withAdminEmails(async () => {
      const r = await fetchJSON(srv.origin, '/api/platform-admin/offices?status=all', { headers: { cookie: a.cookie } });
      assert.equal(r.status, 200, 'role=platform_admin grants admin access without an office or ADMIN_EMAILS');
    });
  });

  test('no-office officer WITHOUT the admin role is rejected by the admin API', async () => {
    const o = await seedNoOfficeOfficer('officer', 'PlainPass2026x');
    assert.equal(o.status, 200);
    await withAdminEmails(async () => {
      const r = await fetchJSON(srv.origin, '/api/platform-admin/offices?status=all', { headers: { cookie: o.cookie } });
      assert.equal(r.status, 403, 'a plain no-office officer is not an admin');
    });
  });
});
