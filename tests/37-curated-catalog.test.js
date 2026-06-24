// Curated catalogue: only verified services (office-approved + annotator-
// validated + launch) stay active. deactivateUnverifiedServices() enforces it at
// boot; the annotator validate/unvalidate actions promote/demote a service so an
// annotator's work actually takes effect (and survives the boot gate).
//
// NOTE: deactivateUnverifiedServices() mutates is_active table-wide on the SHARED
// test DB, so before/after snapshot + restore the active set to stay order-safe.
import './helpers.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { spawnServer, fetchJSON } = await import('./helpers.js');
const { db, deactivateUnverifiedServices } = await import('../lib/db.js');

let srv, aid, savedActive = [];
before(async () => {
  srv = await spawnServer();
  aid = Number((await db.execute(`SELECT id FROM annotator ORDER BY id LIMIT 1`)).rows[0]?.id || 1);
  savedActive = (await db.execute(`SELECT id FROM service_catalog WHERE is_active=1`)).rows.map(r => Number(r.id));
});
after(async () => {
  // Restore the active set so this file doesn't disturb any other.
  try {
    if (savedActive.length) {
      const ph = savedActive.map(() => '?').join(',');
      await db.execute(`UPDATE service_catalog SET is_active=0`);
      await db.execute({ sql: `UPDATE service_catalog SET is_active=1 WHERE id IN (${ph})`, args: savedActive });
    }
  } catch {}
  await srv.stop();
});

async function addSvc({ name, status = 'unverified', source = null, active = 1, launch = 0 }) {
  const r = await db.execute({
    sql: `INSERT INTO service_catalog(name_ar,name_en,is_active,is_launch,verification_status,verification_source,search_blob)
          VALUES (?,?,?,?,?,?,?)`,
    args: [name, name, active, launch, status, source, String(name).toLowerCase()]
  });
  return Number(r.lastInsertRowid);
}
const isActive = async (id) => Number((await db.execute({ sql: `SELECT is_active FROM service_catalog WHERE id=?`, args: [id] })).rows[0].is_active);
const vStatus  = async (id) => (await db.execute({ sql: `SELECT verification_status FROM service_catalog WHERE id=?`, args: [id] })).rows[0].verification_status;
const validate = (id, body) => fetchJSON(srv.origin, `/api/annotator/services/${id}/validate`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-annotator-id': String(aid) }, body: JSON.stringify(body)
});

describe('curated catalogue', () => {
  test('keeps only office-approved + annotator-validated active (scraped + launch off)', async () => {
    const office   = await addSvc({ name: 'OfficeApproved ' + Date.now(), status: 'office_approved', source: 'office' });
    const annot    = await addSvc({ name: 'AnnotValidated ' + Date.now(), status: 'annotator_validated', source: 'annotator' });
    const launch   = await addSvc({ name: 'LaunchSvc ' + Date.now(), status: 'unverified', launch: 1 });
    const scraped  = await addSvc({ name: 'ScrapedSvc ' + Date.now(), status: 'unverified' });
    const nullStat = await addSvc({ name: 'NullStatusSvc ' + Date.now(), status: null });  // verification_status = NULL

    const res = await deactivateUnverifiedServices();
    assert.equal(res.skipped, false);
    assert.equal(await isActive(office), 1);
    assert.equal(await isActive(annot), 1);
    assert.equal(await isActive(launch), 0, 'launch-tagged scraped rows are NOT exempt — still unverified');
    assert.equal(await isActive(scraped), 0);
    assert.equal(await isActive(nullStat), 0, 'NULL verification_status is deactivated (COALESCE handles NULL NOT IN)');
  });

  test('annotator validate → service goes live + verified, survives the gate', async () => {
    const id = await addSvc({ name: 'AnnotTarget ' + Date.now(), status: 'unverified', active: 0 });
    const r = await validate(id, { status: 'validated', notes: 'looks good' });
    assert.equal(r.status, 200);
    assert.equal(await isActive(id), 1);
    assert.equal(await vStatus(id), 'annotator_validated');
    await deactivateUnverifiedServices();
    assert.equal(await isActive(id), 1, 'annotator-validated stays active after the curated gate');
  });

  test('annotator reject → deactivated', async () => {
    const id = await addSvc({ name: 'RejectTarget ' + Date.now(), status: 'unverified', active: 1 });
    const r = await validate(id, { status: 'rejected' });
    assert.equal(r.status, 200);
    assert.equal(await isActive(id), 0);
  });

  test('annotator unvalidate → reverts to unverified + inactive', async () => {
    const id = await addSvc({ name: 'UnvalTarget ' + Date.now(), status: 'unverified', active: 0 });
    await validate(id, { status: 'validated' });
    assert.equal(await isActive(id), 1);
    const u = await fetchJSON(srv.origin, `/api/annotator/services/${id}/unvalidate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-annotator-id': String(aid) }, body: '{}'
    });
    assert.equal(u.status, 200);
    assert.equal(await isActive(id), 0);
    assert.equal(await vStatus(id), 'unverified');
  });
});
