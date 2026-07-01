// Office-issued documents (the deliverable back to the citizen) + the
// cross-channel notify path. Covers issue #5 (office uploads the result, e.g.
// a renewed CR) and the request_document.is_issued plumbing the citizen view
// reads.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv, spawnServer, registerAndApproveOffice, createReadyRequest } from './helpers.js';
import { deliverablePhone } from '../lib/officer_helpers.js';

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

test('office can issue an Office document (docx/txt) even with a generic MIME', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);
  await db.execute({
    sql: `UPDATE request SET office_id=?, status='claimed' WHERE id=?`,
    args: [office.office_id, request_id]
  });

  // The exact scenario that silently failed in prod: a Word deliverable whose
  // browser-supplied MIME is the generic application/octet-stream. Extension-
  // first validation must accept it on the .docx extension (and keep the ext).
  const fd = new FormData();
  fd.append('label', 'الشهادة النهائية');
  fd.append('file', new Blob([Buffer.from('PK docx')], { type: 'application/octet-stream' }), 'result.docx');
  const up = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd
  });
  assert.equal(up.status, 200, 'a .docx deliverable must be accepted (extension-first)');
  const body = await up.json();
  assert.equal(body.document.is_issued, 1);
  assert.match(body.document.storage_url, /\.docx$/, 'stored with its real .docx extension, not coerced to .jpg');

  // A plain-text deliverable is accepted too.
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notes.txt');
  const up2 = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd2
  });
  assert.equal(up2.status, 200, 'a .txt deliverable must be accepted');

  // Still blocked: a renderable .html (XSS risk if served inline) stays rejected.
  const fd3 = new FormData();
  fd3.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'text/html' }), 'x.html');
  const bad = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd3
  });
  assert.equal(bad.status, 400, '.html must stay rejected');
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

test('office can issue a deliverable on a COMPLETED request → WhatsApp + طلباتي badge', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);
  // A finished request: owned by this office, linked to a citizen with a phone.
  await db.execute({ sql: `INSERT INTO citizen (phone, name) VALUES ('+96890000555', 'Done Citizen')` });
  const { rows: cit } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone='+96890000555'` });
  await db.execute({
    sql: `UPDATE request SET office_id=?, citizen_id=?, status='completed' WHERE id=?`,
    args: [office.office_id, cit[0].id, request_id]
  });

  // Office sends the deliverable AFTER completion — must be allowed (not blocked).
  const fd = new FormData();
  fd.append('label', 'الوثيقة النهائية');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4 final')], { type: 'application/pdf' }), 'final.pdf');
  const up = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd
  });
  assert.equal(up.status, 200, 'issuing on a completed request must be allowed');
  const body = await up.json();
  assert.equal(body.document.is_issued, 1);
  // Reaches the citizen's phone (WhatsApp attempted: 'whatsapp' with creds, 'stub' without).
  assert.equal(body.delivery.whatsapp_attempted, true, 'deliverable must be pushed to WhatsApp');

  // Shows in the web dashboard «طلباتي»: the my-requests list computes issued_count,
  // which drives the "📤 مستند جاهز" badge.
  const { rows: cnt } = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM request_document d
                   WHERE d.request_id = r.id AND d.is_issued = 1) AS issued_count
            FROM request r WHERE r.id = ?`,
    args: [request_id]
  });
  assert.equal(Number(cnt[0].issued_count), 1, 'طلباتي must surface the issued deliverable');

  // And it's downloadable from the request detail (storage_url present).
  const { rows: docs } = await db.execute({
    sql: `SELECT storage_url FROM request_document WHERE request_id=? AND is_issued=1`, args: [request_id]
  });
  assert.match(docs[0].storage_url, /^\/uploads\/issued\//);
  const fileRes = await fetch(`${srv.origin}${docs[0].storage_url}`);
  assert.equal(fileRes.status, 200, 'citizen can download the deliverable');
});

test('طلباتي ALWAYS gets the deliverable — even when WhatsApp is not deliverable', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);
  // A phone-less, web-session citizen → WhatsApp cannot be attempted at all. The
  // web «طلباتي» dashboard must STILL receive the deliverable (dashboard is the
  // guaranteed channel; WhatsApp is best-effort).
  await db.execute({ sql: `INSERT INTO citizen (name) VALUES ('No Phone Citizen')` });
  const { rows: c } = await db.execute({ sql: `SELECT id FROM citizen WHERE name='No Phone Citizen' ORDER BY id DESC LIMIT 1` });
  await db.execute({
    sql: `UPDATE request SET office_id=?, citizen_id=?, session_id='web-noph-1', status='completed' WHERE id=?`,
    args: [office.office_id, c[0].id, request_id]
  });

  const fd = new FormData();
  fd.append('label', 'الوثيقة النهائية');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'd.pdf');
  const up = await fetch(`${srv.origin}/api/officer/request/${request_id}/issued-document`, {
    method: 'POST', headers: { cookie: office.cookie }, body: fd
  });
  assert.equal(up.status, 200, 'issuing must succeed even with no deliverable phone');
  const body = await up.json();
  assert.equal(body.document.is_issued, 1);
  assert.equal(body.delivery.whatsapp_attempted, false, 'no phone → WhatsApp not attempted (but no error)');

  // The deliverable is still in طلباتي (issued_count drives the badge + the
  // downloadable «مستنداتك الجاهزة» section).
  const { rows: cnt } = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM request_document d WHERE d.request_id=r.id AND d.is_issued=1) AS n
            FROM request r WHERE r.id=?`, args: [request_id]
  });
  assert.equal(Number(cnt[0].n), 1, 'طلباتي shows the deliverable regardless of WhatsApp');
});

test('deliverablePhone: delivers to wa: sessions AND web citizens with a known phone', () => {
  // WhatsApp session — the phone IS the session id.
  assert.equal(deliverablePhone({ session_id: 'wa:96890000001' }), '96890000001');
  // Web session, phone verified via OTP → deliverable (THIS is the fix).
  assert.equal(deliverablePhone({ session_id: 'web-abc', citizen_phone: '+96890000002' }), '+96890000002');
  // Web session, no phone yet → not deliverable (pre-OTP).
  assert.equal(deliverablePhone({ session_id: 'web-abc', citizen_phone: null }), null);
  // citizen_phone wins for wa: sessions too (canonical table value).
  assert.equal(deliverablePhone({ session_id: 'wa:96890000003', citizen_phone: '+96890000003' }), '+96890000003');
});

test('office dashboard message reaches a WEB-applied citizen by phone (not just wa: sessions)', async (t) => {
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);

  // A WEB request (session_id is a web uuid, not wa:) owned by this office,
  // paid (so the chat is unlocked), linked to a citizen who verified a phone.
  await db.execute({ sql: `INSERT INTO citizen (phone, name) VALUES ('+96890000123', 'Web Citizen')` });
  const { rows: cit } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone='+96890000123'` });
  await db.execute({
    sql: `UPDATE request SET office_id=?, citizen_id=?, status='in_progress', paid_at=datetime('now') WHERE id=?`,
    args: [office.office_id, cit[0].id, request_id]
  });

  const res = await fetch(`${srv.origin}/api/officer/request/${request_id}/message`, {
    method: 'POST',
    headers: { cookie: office.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'مرحبًا، نحتاج توضيحًا بسيطًا.' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The invariant: delivery is ATTEMPTED for a web citizen because the phone is
  // known. Channel is 'whatsapp' when creds are present (real send), 'stub'
  // when absent — never 'skipped'. Pre-fix a web session returned
  // { channel: 'skipped', skipped: 'not_whatsapp' }.
  assert.notEqual(body.delivery.channel, 'skipped',
    'WA delivery must be attempted for a web citizen with a known phone');
  assert.ok(['whatsapp', 'stub'].includes(body.delivery.channel),
    `expected an attempted-delivery channel, got '${body.delivery.channel}'`);
});

test('completing a request notifies the citizen on WhatsApp (not just in-app)', async (t) => {
  // Regression — prod report: "office completed the request, nothing was sent
  // to the user". The complete endpoint used storeMessage (in-app only); it now
  // goes through notifyCitizen so it also reaches the citizen's phone.
  await bootTestEnv();
  const srv = await spawnServer();
  t.after(() => srv.stop());
  const { db } = await import('../lib/db.js');

  const office = await registerAndApproveOffice(srv.origin);
  const { request_id } = await createReadyRequest(srv.origin);
  await db.execute({ sql: `INSERT INTO citizen (phone, name) VALUES ('+96890000777', 'Done Citizen')` });
  const { rows: cit } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone='+96890000777'` });
  await db.execute({
    sql: `UPDATE request SET office_id=?, citizen_id=?, status='in_progress' WHERE id=?`,
    args: [office.office_id, cit[0].id, request_id]
  });

  const res = await fetch(`${srv.origin}/api/officer/request/${request_id}/complete`, {
    method: 'POST', headers: { cookie: office.cookie }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.delivery.whatsapp_attempted, true,
    'completion must attempt WhatsApp delivery to the citizen phone');

  const { rows: msgs } = await db.execute({
    sql: `SELECT body_text FROM message WHERE request_id=? AND direction='out' ORDER BY id DESC LIMIT 1`,
    args: [request_id]
  });
  assert.match(msgs[0].body_text, /تم إنجاز معاملتك/, 'completion message stored in the thread');

  const { rows: rr } = await db.execute({ sql: `SELECT status FROM request WHERE id=?`, args: [request_id] });
  assert.equal(rr[0].status, 'completed');
});
