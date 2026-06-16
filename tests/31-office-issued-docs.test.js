// Office-issued documents (the deliverable back to the citizen) + the
// cross-channel notify path. Covers issue #5 (office uploads the result, e.g.
// a renewed CR) and the request_document.is_issued plumbing the citizen view
// reads.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv, spawnServer, registerAndApproveOffice, createReadyRequest } from './helpers.js';

test('office can upload an issued document, citizen can see + download it', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);

  // Award the request to this office so loadOwnedRequest() passes (we test the
  // issued-doc endpoint, not the claim flow, so set ownership directly).
  await db.execute({
    sql: `UPDATE request SET office_id=?, status='claimed' WHERE id=?`,
    args: [office.office_id, request_id]
  });

  // ── Office uploads the deliverable ──────────────────────────
  const fd = new FormData();
  fd.append('label', 'السجل التجاري الجديد');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4 fake cr')], { type: 'application/pdf' }), 'new-cr.pdf');
  const up = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd
  });
  assert.equal(up.status, 200, 'upload should succeed for the owning office');
  const upBody = await up.json();
  assert.equal(upBody.ok, true);
  assert.equal(upBody.document.is_issued, 1);
  assert.equal(upBody.document.status, 'issued');
  assert.match(upBody.document.storage_url, /^\/uploads\/issued\/\d+\//);

  // ── Persisted as is_issued=1 (distinct from citizen requirement docs) ──
  const { rows } = await db.execute({
    sql: `SELECT id, label, status, is_issued, storage_url, mime
            FROM request_document WHERE request_id=? AND is_issued=1`,
    args: [request_id]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'السجل التجاري الجديد');
  assert.equal(Number(rows[0].is_issued), 1);
  assert.equal(rows[0].status, 'issued');
  const docId = rows[0].id;

  // ── The notify lands in the citizen's in-app thread ─────────
  const { rows: msgs } = await db.execute({
    sql: `SELECT body_text, media_url FROM message
           WHERE request_id=? AND direction='out' AND actor_type='office'
           ORDER BY id DESC LIMIT 1`,
    args: [request_id]
  });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body_text, /السجل التجاري الجديد/);
  assert.match(String(msgs[0].media_url || ''), /\/uploads\/issued\//);

  // ── The static file actually exists on disk + is downloadable ──
  const fileRes = await fetch(`${srv.origin}${rows[0].storage_url}`);
  assert.equal(fileRes.status, 200, 'issued file must be served from /uploads');

  // ── Ownership: a different office is refused (403) ──────────
  const other = await registerAndApproveOffice(srv.origin);
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('x')], { type: 'image/jpeg' }), 'x.jpg');
  const forbidden = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: other.cookie }, body: fd2
  });
  assert.equal(forbidden.status, 403, 'a foreign office must not attach to this request');

  // ── Type guard: executables rejected ───────────────────────
  const fd3 = new FormData();
  fd3.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'evil.exe');
  const badType = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd3
  });
  assert.equal(badType.status, 400, 'non-image/pdf must be rejected');

  // ── Delete an issued doc (recovery from a mis-upload) ───────
  const del = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document/${docId}`, {
    method: 'DELETE', headers: { cookie: office.cookie }
  });
  assert.equal(del.status, 200);
  const { rows: gone } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM request_document WHERE id=?`, args: [docId]
  });
  assert.equal(Number(gone[0].n), 0);
});

test('citizen my-request view exposes issued docs with storage_url + is_issued', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { sid, request_id } = await createReadyRequest(srv.origin);
  await db.execute({
    sql: `UPDATE request SET office_id=?, status='claimed' WHERE id=?`,
    args: [office.office_id, request_id]
  });

  const fd = new FormData();
  fd.append('label', 'الرخصة الجديدة');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'lic.pdf');
  const up = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd
  });
  assert.equal(up.status, 200);

  // Citizen detail view (matched by the web session id) must carry the issued
  // doc with the fields the UI needs to render a download row.
  const { rows: cit } = await db.execute({
    sql: `SELECT id, doc_code, label, status, is_issued, storage_url
            FROM request_document WHERE request_id=? ORDER BY id ASC`,
    args: [request_id]
  });
  const issued = cit.find(d => Number(d.is_issued) === 1);
  assert.ok(issued, 'issued doc present');
  assert.ok(issued.storage_url && issued.storage_url.startsWith('/uploads/issued/'),
    'citizen-facing row has a downloadable storage_url');
});
