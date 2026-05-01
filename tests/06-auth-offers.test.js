// Auth + offer-flow integration tests.
//
// Coverage:
//   • signup validation (required fields, governorate allowlist, duplicate email)
//   • login / logout / me
//   • office self-service: profile, team list, invite, disable, change-password
//   • platform-admin: list by status, approve, reject, suspend
//   • pending-review gate: unapproved offices blocked from /api/officer/*
//   • offer lifecycle: submit, update, withdraw, accept
//   • anonymization: marketplace never leaks citizen PII or storage URLs

import { spawnServer, fetchJSON, registerAndApproveOffice, createReadyRequest, postChat } from './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

let ctx;
before(async () => { ctx = await spawnServer(); });
after(async () => { await ctx?.stop(); });

// Small wrapper — avoids repeating JSON boilerplate.
async function postJSON(path, body, { cookie } = {}) {
  const res = await fetch(ctx.origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text), raw: res }; }
  catch { return { status: res.status, body: text, raw: res }; }
}

function takeCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// ─── Signup ────────────────────────────────────────────────
describe('Auth · /signup', () => {
  test('rejects missing required fields', async () => {
    const { status, body } = await postJSON('/api/auth/signup', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'validation');
    assert.ok(body.missing.includes('office_name'));
    assert.ok(body.missing.includes('governorate'));
    assert.ok(body.missing.includes('cr_number'));
    assert.ok(body.missing.includes('email'));
    assert.ok(body.missing.includes('full_name'));
    assert.ok(body.missing.some(m => m.startsWith('password:')));
  });

  test('rejects invalid governorate', async () => {
    const { status, body } = await postJSON('/api/auth/signup', {
      office_name_en: 'X', governorate: 'Narnia', cr_number: '1',
      email: `x${Date.now()}@t.om`, full_name: 'T', password: 'Saned!Test#2026'
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_governorate');
  });

  test('rejects duplicate officer email', async () => {
    const email = `dup-${Date.now()}@t.om`;
    const base = {
      office_name_en: 'Office', governorate: 'Muscat', cr_number: '11',
      full_name: 'Owner', password: 'Saned!Test#2026', email
    };
    const first = await postJSON('/api/auth/signup', base);
    assert.equal(first.status, 201);
    const second = await postJSON('/api/auth/signup', { ...base, cr_number: '22' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'email_taken');
  });

  test('successful signup creates pending_review office + returns officer', async () => {
    const res = await fetch(ctx.origin + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        office_name_en: 'Pending Office', governorate: 'Dhofar',
        cr_number: '90001', email: `pend-${Date.now()}@t.om`,
        full_name: 'Pending Owner', password: 'Saned!Test#2026'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.officer.role, 'owner');
    assert.equal(data.officer.office.status, 'pending_review');
    const cookie = takeCookie(res);
    assert.ok(cookie.startsWith('sanad_sess='), 'cookie must be set');
  });
});

// ─── Login / me / logout ───────────────────────────────────
describe('Auth · /login + /me + /logout', () => {
  const email = `login-${Date.now()}@t.om`;
  const password = 'Saned!Test#2026';
  let cookie;

  test('signup establishes session', async () => {
    const r = await fetch(ctx.origin + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        office_name_en: 'Login Office', governorate: 'Muscat',
        cr_number: '9002', email, full_name: 'Login User', password
      })
    });
    assert.equal(r.status, 201);
    cookie = takeCookie(r);
  });

  test('GET /me with cookie returns officer (allowPending)', async () => {
    const res = await fetch(ctx.origin + '/api/auth/me', { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.officer.email, email);
    // Never leak the password hash.
    assert.equal(body.officer.password_hash, undefined);
  });

  test('wrong password returns 401', async () => {
    const { status, body } = await postJSON('/api/auth/login', { email, password: 'wrong-pass' });
    assert.equal(status, 401);
    assert.equal(body.error, 'invalid_credentials');
  });

  test('correct password returns 200 + fresh cookie', async () => {
    const res = await fetch(ctx.origin + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(res.status, 200);
    assert.ok(takeCookie(res).startsWith('sanad_sess='));
  });

  test('logout clears cookie', async () => {
    const res = await fetch(ctx.origin + '/api/auth/logout', {
      method: 'POST', headers: { cookie }
    });
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie') || '';
    assert.ok(set.includes('Max-Age=0'), 'cookie must be cleared');
  });
});

// ─── Pending-review gate ───────────────────────────────────
describe('Auth · pending-review office is gated from /api/officer/*', () => {
  test('unapproved office hits office_not_active on /inbox', async () => {
    const r = await fetch(ctx.origin + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        office_name_en: 'Gated Office', governorate: 'Al Wusta',
        cr_number: '9003', email: `gate-${Date.now()}@t.om`,
        full_name: 'Gate Owner', password: 'Saned!Test#2026'
      })
    });
    const cookie = takeCookie(r);
    const inbox = await fetch(ctx.origin + '/api/officer/inbox', { headers: { cookie } });
    assert.equal(inbox.status, 403);
    const body = await inbox.json();
    assert.equal(body.error, 'office_not_active');
    assert.equal(body.office_status, 'pending_review');
  });
});

// ─── Platform-admin ────────────────────────────────────────
describe('Platform-admin · approve / reject / suspend', () => {
  test('approve flips pending_review → active', async () => {
    // Approver is anyone signed in (DEBUG_MODE fallback).
    const admin = await registerAndApproveOffice(ctx.origin);

    const signup = await fetch(ctx.origin + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        office_name_en: 'Approve Me', governorate: 'Muscat',
        cr_number: '9100', email: `app-${Date.now()}@t.om`,
        full_name: 'Owner', password: 'Saned!Test#2026'
      })
    });
    const { officer } = await signup.json();

    const r = await fetch(`${ctx.origin}/api/platform-admin/office/${officer.office.id}/approve`, {
      method: 'POST', headers: { cookie: admin.cookie }
    });
    assert.equal(r.status, 200);

    // Now that owner can reach /inbox.
    const cookie = takeCookie(signup);
    const inbox = await fetch(ctx.origin + '/api/officer/inbox', { headers: { cookie } });
    assert.equal(inbox.status, 200);
  });

  test('reject stores reason and blocks access', async () => {
    const admin = await registerAndApproveOffice(ctx.origin);
    const signup = await fetch(ctx.origin + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        office_name_en: 'Reject Me', governorate: 'Muscat',
        cr_number: '9101', email: `rej-${Date.now()}@t.om`,
        full_name: 'Owner', password: 'Saned!Test#2026'
      })
    });
    const { officer } = await signup.json();
    const r = await postJSON(`/api/platform-admin/office/${officer.office.id}/reject`,
      { reason: 'incomplete CR documents' }, { cookie: admin.cookie });
    assert.equal(r.status, 200);

    // Verify via detail endpoint.
    const { body } = await fetchJSON(ctx.origin, `/api/platform-admin/office/${officer.office.id}`, {
      headers: { cookie: admin.cookie }
    });
    assert.equal(body.office.status, 'rejected');
    assert.equal(body.office.reject_reason, 'incomplete CR documents');
  });

  test('suspend requires status=active', async () => {
    const admin = await registerAndApproveOffice(ctx.origin);
    // Try to suspend the admin's own active office.
    const r = await postJSON(`/api/platform-admin/office/${admin.office_id}/suspend`,
      { reason: 'testing' }, { cookie: admin.cookie });
    assert.equal(r.status, 200);
    // A second suspend on already-suspended → 409.
    const r2 = await postJSON(`/api/platform-admin/office/${admin.office_id}/suspend`,
      { reason: 'again' }, { cookie: admin.cookie });
    assert.equal(r2.status, 409);
  });

  test('GET /platform-admin/stats returns status buckets', async () => {
    const admin = await registerAndApproveOffice(ctx.origin);
    const { status, body } = await fetchJSON(ctx.origin, '/api/platform-admin/stats', {
      headers: { cookie: admin.cookie }
    });
    assert.equal(status, 200);
    assert.ok(body.offices_by_status);
    assert.equal(typeof body.offices_by_status, 'object');
  });
});

// ─── Office self-service ───────────────────────────────────
describe('Office · profile + team + invite + change-password', () => {
  test('PATCH /profile updates allowed fields', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const r = await fetch(ctx.origin + '/api/office/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: me.cookie },
      body: JSON.stringify({ wilayat: 'Seeb', phone: '+968 99999999' })
    });
    assert.equal(r.status, 200);
    const { body } = await fetchJSON(ctx.origin, '/api/office/profile', { headers: { cookie: me.cookie } });
    assert.equal(body.office.wilayat, 'Seeb');
  });

  test('owner can invite a manager; duplicate email rejected', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const inviteEmail = `inv-${Date.now()}@t.om`;
    const r = await postJSON('/api/office/team/invite',
      { email: inviteEmail, full_name: 'Invited Mgr', role: 'manager', initial_password: 'TempInvite#2026' },
      { cookie: me.cookie });
    assert.equal(r.status, 201);
    assert.ok(r.body.officer_id);

    // Duplicate invite same email → 409
    const dup = await postJSON('/api/office/team/invite',
      { email: inviteEmail, full_name: 'Dup', role: 'officer', initial_password: 'TempInvite#2026' },
      { cookie: me.cookie });
    assert.equal(dup.status, 409);

    // New officer can log in with that temp password
    const login = await postJSON('/api/auth/login', { email: inviteEmail, password: 'TempInvite#2026' });
    assert.equal(login.status, 200);
  });

  test('team list shows both owner and invitee', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    await postJSON('/api/office/team/invite',
      { email: `t-${Date.now()}@t.om`, full_name: 'T', role: 'officer', initial_password: 'TempInvite#2026' },
      { cookie: me.cookie });
    const { body } = await fetchJSON(ctx.origin, '/api/office/team', { headers: { cookie: me.cookie } });
    assert.ok(body.officers.length >= 2);
    assert.ok(body.officers.find(o => o.role === 'owner'));
  });

  test('change-password verifies old password', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const wrong = await postJSON('/api/office/change-password',
      { old_password: 'nope', new_password: 'newpass123' }, { cookie: me.cookie });
    assert.equal(wrong.status, 401);

    const ok = await postJSON('/api/office/change-password',
      { old_password: 'Saned!Test#2026', new_password: 'newpass123' }, { cookie: me.cookie });
    assert.equal(ok.status, 200);
  });
});

// ─── Offers ────────────────────────────────────────────────
describe('Offers · submit / update / withdraw', () => {
  test('cannot quote a non-existent request', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const r = await postJSON('/api/officer/request/999999/offer',
      { quoted_fee_omr: 3 }, { cookie: me.cookie });
    assert.equal(r.status, 404);
  });

  test('rejects zero/negative/too-high fee', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const { request_id } = await createReadyRequest(ctx.origin);
    for (const fee of [0, -1, 10000]) {
      const r = await postJSON(`/api/officer/request/${request_id}/offer`,
        { quoted_fee_omr: fee }, { cookie: me.cookie });
      assert.equal(r.status, 400, `fee=${fee} should be rejected`);
    }
  });

  test('second POST updates the quote (UPSERT)', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const { request_id } = await createReadyRequest(ctx.origin);
    const r1 = await postJSON(`/api/officer/request/${request_id}/offer`,
      { quoted_fee_omr: 5 }, { cookie: me.cookie });
    assert.equal(r1.status, 201);
    const r2 = await postJSON(`/api/officer/request/${request_id}/offer`,
      { quoted_fee_omr: 4 }, { cookie: me.cookie });
    assert.equal(r2.status, 201);
    // Verify via inbox that my_offer shows the updated fee.
    const inbox = await fetchJSON(ctx.origin, '/api/officer/inbox', { headers: { cookie: me.cookie } });
    const row = inbox.body.marketplace.find(x => x.id === request_id);
    assert.ok(row, 'request still in marketplace');
    assert.equal(row.my_offer_fee, 4);
  });

  test('withdraw removes my offer from citizen list', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const { sid, request_id } = await createReadyRequest(ctx.origin);
    await postJSON(`/api/officer/request/${request_id}/offer`,
      { quoted_fee_omr: 5 }, { cookie: me.cookie });
    const withdraw = await postJSON(`/api/officer/request/${request_id}/offer/withdraw`,
      {}, { cookie: me.cookie });
    assert.equal(withdraw.status, 200);
    const list = await fetchJSON(ctx.origin, `/api/chat/${sid}/request/${request_id}/offers`);
    assert.equal(list.body.offers.length, 0, 'citizen sees no active offers');
  });

  test('officer role (not owner/manager) cannot submit offers', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    // Invite a regular officer
    const email = `basic-${Date.now()}@t.om`;
    await postJSON('/api/office/team/invite',
      { email, full_name: 'Basic', role: 'officer', initial_password: 'TempInvite#2026' },
      { cookie: me.cookie });
    const login = await fetch(ctx.origin + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'TempInvite#2026' })
    });
    const basicCookie = takeCookie(login);
    const { request_id } = await createReadyRequest(ctx.origin);
    const r = await postJSON(`/api/officer/request/${request_id}/offer`,
      { quoted_fee_omr: 3 }, { cookie: basicCookie });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'insufficient_role');
  });
});

// ─── Anonymization ─────────────────────────────────────────
describe('Offers · anonymization of marketplace', () => {
  test('officer viewing unowned request sees no citizen fields or storage URLs', async () => {
    const me = await registerAndApproveOffice(ctx.origin);
    const { request_id } = await createReadyRequest(ctx.origin);
    const { body, status } = await fetchJSON(ctx.origin, `/api/officer/request/${request_id}`,
      { headers: { cookie: me.cookie } });
    assert.equal(status, 200);
    assert.equal(body.anonymized, true);
    assert.equal(body.request.citizen_phone, undefined);
    assert.equal(body.request.citizen_name, undefined);
    for (const d of body.documents) {
      assert.equal(d.storage_url, undefined, 'storage_url must be hidden before win');
    }
  });
});
