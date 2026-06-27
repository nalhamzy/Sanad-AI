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

describe('office → catalog maintenance (full view + edit + activate/deactivate)', () => {
  async function seedInactive(name_ar, name_en) {
    const ins = await db.execute({
      sql: `INSERT INTO service_catalog (entity_en,entity_ar,name_en,name_ar,fee_omr,office_fee_omr,gov_fee_tbd,is_active,verification_status,version)
            VALUES ('Test Entity','جهة اختبار',?,?,NULL,3,1,0,'unverified',1)`,
      args: [name_en || (name_ar + '_en'), name_ar]
    });
    return Number(ins.lastInsertRowid);
  }
  const getCat = (cookie, qs = '') => fetchJSON(srv.origin, '/api/office/catalog/services' + qs, { headers: { cookie } });
  const patchSvc = (cookie, id, body) => fetchJSON(srv.origin, '/api/office/catalog/service/' + id, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body)
  });

  test('owner sees FULL catalog incl. inactive; citizen search does not', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const id = await seedInactive('خدمة غير مفعلة ' + Date.now());
    const r = await getCat(cookie, '?status=inactive&limit=500');
    assert.equal(r.status, 200);
    assert.ok(r.body.services.some(s => s.id === id), 'office sees the inactive service');
    const { searchServices } = await import('../lib/hybrid_search.js');
    const found = await searchServices('غير مفعلة', {}, { k: 8 });
    assert.ok(!found.services.some(s => s.id === id), 'citizen search hides inactive');
  });

  test('owner edits name + commission → version bumps', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const id = await seedInactive('خدمة للتعديل ' + Date.now());
    assert.equal((await patchSvc(cookie, id, { name_ar: 'اسم معدّل', office_fee_omr: 7 })).status, 200);
    const { rows } = await db.execute({ sql: 'SELECT name_ar, office_fee_omr, version FROM service_catalog WHERE id=?', args: [id] });
    assert.equal(rows[0].name_ar, 'اسم معدّل');
    assert.equal(Number(rows[0].office_fee_omr), 7);
    assert.ok(Number(rows[0].version) >= 2);
  });

  test('owner activates an inactive service → becomes citizen-searchable', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const word = 'Activateme' + Date.now();
    const id = await seedInactive('خدمة تفعيل', word);
    assert.equal((await patchSvc(cookie, id, { is_active: true })).status, 200);
    const { rows } = await db.execute({ sql: 'SELECT is_active FROM service_catalog WHERE id=?', args: [id] });
    assert.equal(Number(rows[0].is_active), 1);
    const { searchServices } = await import('../lib/hybrid_search.js');
    const found = await searchServices(word, {}, { k: 5 });
    assert.ok(found.services.some(s => s.id === id), 'activated service is citizen-searchable');
  });

  test('owner deactivates a service → removed from citizen search', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const word = 'Deactivateme' + Date.now();
    const add = await addSvc(cookie, { name_ar: 'خدمة لإيقاف ' + word, name_en: word, office_fee_omr: 3 });
    const id = add.body.service_id;
    assert.equal((await patchSvc(cookie, id, { is_active: false })).status, 200);
    const { searchServices } = await import('../lib/hybrid_search.js');
    const found = await searchServices(word, {}, { k: 5 });
    assert.ok(!found.services.some(s => s.id === id), 'deactivated service hidden from citizens');
  });

  test('junior officer blocked on list + edit (owner/manager only)', async () => {
    const { cookie } = await registerAndApproveOffice(srv.origin);
    const inviteEmail = `jr2-${Date.now()}@t.om`;
    await fetchJSON(srv.origin, '/api/office/team/invite', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email: inviteEmail, full_name: 'Jr', role: 'officer', initial_password: 'JuniorPass#2026' })
    });
    const lr = await fetch(srv.origin + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, password: 'JuniorPass#2026' })
    });
    const jr = (lr.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await getCat(jr)).status, 403);
    assert.equal((await patchSvc(jr, 1, { is_active: false })).status, 403);
  });
});
