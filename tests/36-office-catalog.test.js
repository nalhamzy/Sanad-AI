// Offices add services to the GLOBAL catalog. Services are shared across all
// offices with one consistent commission; an added service goes live + becomes
// searchable for everyone immediately (verification_source 'office').
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { spawnServer, registerAndApproveOffice, fetchJSON } = await import('./helpers.js');
const { db } = await import('../lib/db.js');

let srv;
before(async () => { srv = await spawnServer(); });
after(async () => { await srv.stop(); });

const addSvc = (cookie, body) => fetchJSON(srv.origin, '/api/office/catalog/service', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body)
});

describe('office → global catalog', () => {
  test('owner adds a service → live, office-verified, searchable for everyone', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const word = 'Zebrafishservice';
    const r = await addSvc(cookie, {
      name_ar: 'خدمة حمار الوحش ' + Date.now(), name_en: word,
      entity_ar: 'وزارة الاختبار', entity_en: 'Ministry of Test',
      office_fee_omr: 4.5,
      documents: [{ label_ar: 'بطاقة العمل', type: 'file' }, { label_ar: 'جواز السفر', type: 'file' }]
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.service_id);

    const { rows } = await db.execute({ sql: `SELECT * FROM service_catalog WHERE id=?`, args: [r.body.service_id] });
    const s = rows[0];
    assert.equal(s.verification_status, 'office_approved');
    assert.equal(s.verification_source, 'office');
    assert.equal(Number(s.office_fee_omr), 4.5);
    assert.equal(s.fee_omr, null);            // government fee unknown → set per request
    assert.equal(Number(s.gov_fee_tbd), 1);
    assert.equal(Number(s.is_active), 1);
    assert.equal(JSON.parse(s.required_documents_json).length, 2);

    // Searchable via the shared catalogue search (proves it's live for all offices).
    const { searchServices } = await import('../lib/hybrid_search.js');
    const found = await searchServices(word, {}, { k: 5 });
    assert.ok(found.services.some(x => x.id === r.body.service_id), 'newly added service is searchable');
  });

  test('duplicate name → 409 already_exists', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const name_ar = 'خدمة مكررة ' + Date.now();
    assert.equal((await addSvc(cookie, { name_ar, office_fee_omr: 3 })).status, 201);
    const dup = await addSvc(cookie, { name_ar, office_fee_omr: 3 });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'already_exists');
  });

  test('rejects bad commission and missing name', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    assert.equal((await addSvc(cookie, { name_ar: 'بلا عمولة', office_fee_omr: 0 })).status, 400);
    assert.equal((await addSvc(cookie, { office_fee_omr: 3 })).status, 400);   // no name
  });

  test('junior officer (role=officer) is blocked — owner/manager only', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const inviteEmail = `jr-${Date.now()}@t.om`;
    await fetchJSON(srv.origin, '/api/office/team/invite', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email: inviteEmail, full_name: 'Junior', role: 'officer', initial_password: 'JuniorPass#2026' })
    });
    const loginRes = await fetch(srv.origin + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, password: 'JuniorPass#2026' })
    });
    const jrCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    const r = await addSvc(jrCookie, { name_ar: 'محاولة موظف ' + Date.now(), office_fee_omr: 3 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'insufficient_role');
  });
});
