import { Router } from 'express';
import { db } from '../lib/db.js';
import { storeMessage } from '../lib/agent.js';

export const officerRouter = Router();

// ── dev-only identity header ─────────────────────────────────
// Real system: JWT from Firebase Auth → RLS via `app.office_id`.
// For debugging, pass ?officer_id=1 or header x-officer-id.
function ident(req) {
  const id = Number(req.header('x-officer-id') || req.query.officer_id || 1);
  return id;
}

async function officer(id) {
  const { rows } = await db.execute({ sql: `SELECT * FROM officer WHERE id=?`, args: [id] });
  return rows[0];
}

// Marketplace + my-board
officerRouter.get('/inbox', async (req, res) => {
  const me = await officer(ident(req));
  if (!me) return res.status(401).json({ error: 'no such officer' });

  const { rows: marketplace } = await db.execute({
    sql: `SELECT r.id, r.status, r.fee_omr, r.governorate, r.created_at,
                 s.name_en AS service_name, s.name_ar AS service_name_ar, s.entity_en
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.status='ready'
           ORDER BY r.created_at ASC
           LIMIT 50`
  });

  const { rows: mine } = await db.execute({
    sql: `SELECT r.id, r.status, r.fee_omr, r.claimed_at, r.created_at,
                 s.name_en AS service_name, s.name_ar AS service_name_ar
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.officer_id=? AND r.status NOT IN ('completed','cancelled_by_citizen','cancelled_by_office')
           ORDER BY r.last_event_at DESC
           LIMIT 50`,
    args: [me.id]
  });

  res.json({ me, marketplace, mine });
});

// Claim — single atomic UPDATE (no double-claim).
officerRouter.post('/claim/:request_id', async (req, res) => {
  const me = await officer(ident(req));
  const reqId = Number(req.params.request_id);
  const result = await db.execute({
    sql: `UPDATE request
             SET status='claimed', officer_id=?, office_id=?, claimed_at=datetime('now'), last_event_at=datetime('now')
           WHERE id=? AND status='ready'`,
    args: [me.id, me.office_id, reqId]
  });
  if (result.rowsAffected === 0) {
    return res.status(409).json({ error: 'already_claimed' });
  }
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id) VALUES ('officer',?,?,?,?)`,
    args: [me.id, 'claim', 'request', reqId]
  });
  // Push a system note into the chat (visible on citizen side via poll)
  const { rows } = await db.execute({ sql: `SELECT session_id FROM request WHERE id=?`, args: [reqId] });
  const sid = rows[0]?.session_id;
  if (sid) await storeMessage({ session_id: sid, request_id: reqId, direction: 'out', actor_type: 'system', body_text: `مرحبا، معك ${me.full_name} من مكتب سند. سأبدأ المعاملة الآن.` });
  res.json({ ok: true });
});

// Request detail (full PII — post-claim only)
officerRouter.get('/request/:id', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT r.*, s.name_en AS service_name, s.name_ar AS service_name_ar,
                 s.entity_en, s.required_documents_json, c.phone AS citizen_phone, c.name AS citizen_name
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
            LEFT JOIN citizen c ON c.id = r.citizen_id
           WHERE r.id=?`,
    args: [id]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'ready' && r.officer_id !== me.id) {
    return res.status(403).json({ error: 'not_your_request' });
  }
  const { rows: docs } = await db.execute({
    sql: `SELECT id, doc_code, label, storage_url, mime, size_bytes, status,
                 caption, matched_via, original_name,
                 verified_by, verified_at, reject_reason, uploaded_at
            FROM request_document WHERE request_id=? ORDER BY id ASC`,
    args: [id]
  });
  const { rows: messages } = await db.execute({
    sql: `SELECT id, direction, actor_type, body_text, media_url, created_at FROM message WHERE request_id=? OR session_id=? ORDER BY id ASC`,
    args: [id, r.session_id]
  });
  res.json({ request: r, documents: docs, messages });
});

// Officer sends a chat reply to the citizen
officerRouter.post('/request/:id/message', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const { rows } = await db.execute({ sql: `SELECT session_id, officer_id FROM request WHERE id=?`, args: [id] });
  const r = rows[0];
  if (!r || r.officer_id !== me.id) return res.status(403).json({ error: 'not_your_request' });
  await storeMessage({ session_id: r.session_id, request_id: id, direction: 'out', actor_type: 'officer', body_text: text, meta: { officer_id: me.id } });
  await db.execute({ sql: `UPDATE request SET last_event_at=datetime('now'), status=CASE WHEN status='claimed' THEN 'in_progress' ELSE status END WHERE id=?`, args: [id] });
  res.json({ ok: true });
});

// OTP relay: officer opens a 60s window
officerRouter.post('/request/:id/otp-window', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const { rows } = await db.execute({ sql: `SELECT session_id, officer_id FROM request WHERE id=?`, args: [id] });
  const r = rows[0];
  if (!r || r.officer_id !== me.id) return res.status(403).json({ error: 'not_your_request' });
  await db.execute({
    sql: `INSERT INTO otp_window(request_id,officer_id,expires_at) VALUES (?,?, datetime('now','+60 seconds'))`,
    args: [id, me.id]
  });
  await storeMessage({ session_id: r.session_id, request_id: id, direction: 'out', actor_type: 'bot', body_text: '📲 أرسل لنا الرمز الذي وصلك من البوابة (صالح 60 ثانية).' });
  res.json({ ok: true });
});

officerRouter.get('/request/:id/otp', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT code, consumed_at, expires_at FROM otp_window WHERE request_id=? ORDER BY id DESC LIMIT 1`,
    args: [id]
  });
  res.json({ otp: rows[0] || null });
});

// Mark complete
officerRouter.post('/request/:id/complete', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const { rows } = await db.execute({ sql: `SELECT session_id, officer_id FROM request WHERE id=?`, args: [id] });
  const r = rows[0];
  if (!r || r.officer_id !== me.id) return res.status(403).json({ error: 'not_your_request' });
  await db.execute({
    sql: `UPDATE request SET status='completed', completed_at=datetime('now'), last_event_at=datetime('now') WHERE id=?`,
    args: [id]
  });
  await storeMessage({ session_id: r.session_id, request_id: id, direction: 'out', actor_type: 'bot', body_text: '✅ تم إنجاز معاملتك! شكراً لاستخدامك سند.' });
  res.json({ ok: true });
});

// ── Per-document verify / reject ────────────────────────────
// Officer reviews each uploaded document. Updating the status lets the UI
// show an at-a-glance grid of verified/rejected files.
officerRouter.post('/request/:id/document/:docId/verify', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const { rows } = await db.execute({ sql: `SELECT officer_id FROM request WHERE id=?`, args: [id] });
  if (!rows[0] || rows[0].officer_id !== me.id) return res.status(403).json({ error: 'not_your_request' });
  const r = await db.execute({
    sql: `UPDATE request_document
             SET status='verified', verified_by=?, verified_at=datetime('now'),
                 reject_reason=NULL
           WHERE id=? AND request_id=?`,
    args: [me.id, docId, id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

officerRouter.post('/request/:id/document/:docId/reject', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const reason = (req.body?.reason || '').toString().trim() || 'no reason given';
  const { rows } = await db.execute({
    sql: `SELECT officer_id, session_id FROM request WHERE id=?`, args: [id]
  });
  if (!rows[0] || rows[0].officer_id !== me.id) return res.status(403).json({ error: 'not_your_request' });
  const r = await db.execute({
    sql: `UPDATE request_document
             SET status='rejected', verified_by=?, verified_at=datetime('now'),
                 reject_reason=?
           WHERE id=? AND request_id=?`,
    args: [me.id, reason, docId, id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  // Let the citizen know (chat notification; they can re-upload)
  const { rows: dr } = await db.execute({
    sql: `SELECT label, doc_code FROM request_document WHERE id=?`, args: [docId]
  });
  if (dr[0]) {
    await storeMessage({
      session_id: rows[0].session_id, request_id: id,
      direction: 'out', actor_type: 'officer',
      body_text: `⚠️ الموظف رفض مستند "${dr[0].label || dr[0].doc_code}" — السبب: ${reason}. برجاء إعادة الإرسال.`,
      meta: { officer_id: me.id, rejected_doc_id: docId }
    });
  }
  res.json({ ok: true });
});

// Release (voluntary)
officerRouter.post('/request/:id/release', async (req, res) => {
  const me = await officer(ident(req));
  const id = Number(req.params.id);
  const r = await db.execute({
    sql: `UPDATE request SET status='ready', officer_id=NULL, claimed_at=NULL, last_event_at=datetime('now') WHERE id=? AND officer_id=?`,
    args: [id, me.id]
  });
  if (!r.rowsAffected) return res.status(403).json({ error: 'not_your_request' });
  res.json({ ok: true });
});
