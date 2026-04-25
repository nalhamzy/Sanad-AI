import { Router } from 'express';
import { db } from '../lib/db.js';
import { LLM_ENABLED } from '../lib/llm.js';

export const debugRouter = Router();

debugRouter.get('/health', async (_req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({ ok: true, llm: LLM_ENABLED, debug: process.env.DEBUG_MODE === 'true' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

debugRouter.get('/state', async (_req, res) => {
  const counts = {};
  for (const t of ['service_catalog', 'request', 'request_document', 'message', 'citizen', 'office', 'officer', 'session']) {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  const { rows: latestRequests } = await db.execute(`SELECT id, status, fee_omr, officer_id, created_at FROM request ORDER BY id DESC LIMIT 10`);
  const { rows: latestMessages } = await db.execute(`SELECT id, session_id, actor_type, body_text, created_at FROM message ORDER BY id DESC LIMIT 20`);
  res.json({ counts, latestRequests, latestMessages });
});

// Reset a session (nuclear — wipes state; keeps messages for audit)
debugRouter.post('/reset/:session_id', async (req, res) => {
  await db.execute({ sql: `DELETE FROM session WHERE id=?`, args: [req.params.session_id] });
  res.json({ ok: true });
});

// Wipe ALL data tied to a phone number — sessions, messages, requests,
// documents, offers, citizen row. Only available in DEBUG_MODE so we don't
// expose a destructive endpoint in production. Lets the user start clean
// from WhatsApp without us having to SSH into the box.
debugRouter.post('/clear-phone', async (req, res) => {
  if (process.env.DEBUG_MODE !== 'true') return res.status(403).json({ error: 'debug_only' });
  const phone = (req.body?.phone || req.query?.phone || '').toString().trim();
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  const variants = Array.from(new Set([
    phone,
    phone.replace(/^\+/, ''),
    phone.replace(/^\+?968/, ''),
    phone.startsWith('+') ? phone : `+${phone}`,
  ].filter(Boolean)));

  const cit = await db.execute({
    sql: `SELECT id FROM citizen WHERE phone IN (${variants.map(()=>'?').join(',')})`,
    args: variants
  });
  const citIds = cit.rows.map(r => r.id);
  const waSessions = variants.map(v => `wa:${v}`);
  let extraSessions = [];
  if (citIds.length) {
    const r = await db.execute({
      sql: `SELECT DISTINCT session_id FROM request WHERE citizen_id IN (${citIds.map(()=>'?').join(',')})`,
      args: citIds
    });
    extraSessions = r.rows.map(x => x.session_id).filter(Boolean);
  }
  const sessions = Array.from(new Set([...waSessions, ...extraSessions]));
  const counts = { request_documents: 0, offers: 0, requests: 0, messages: 0, sessions: 0, citizens: 0 };

  if (sessions.length) {
    const ph = sessions.map(()=>'?').join(',');
    const reqs = await db.execute({ sql: `SELECT id FROM request WHERE session_id IN (${ph})`, args: sessions });
    const reqIds = reqs.rows.map(r => r.id);
    if (reqIds.length) {
      const rp = reqIds.map(()=>'?').join(',');
      counts.request_documents = (await db.execute({ sql: `DELETE FROM request_document WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0;
      try { counts.offers = (await db.execute({ sql: `DELETE FROM offer WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0; } catch {}
      counts.requests = (await db.execute({ sql: `DELETE FROM request WHERE id IN (${rp})`, args: reqIds })).rowsAffected || 0;
    }
    counts.messages = (await db.execute({ sql: `DELETE FROM message WHERE session_id IN (${ph})`, args: sessions })).rowsAffected || 0;
    counts.sessions = (await db.execute({ sql: `DELETE FROM session WHERE id IN (${ph})`, args: sessions })).rowsAffected || 0;
  }
  if (citIds.length) {
    counts.citizens = (await db.execute({
      sql: `DELETE FROM citizen WHERE id IN (${citIds.map(()=>'?').join(',')})`,
      args: citIds
    })).rowsAffected || 0;
  }

  res.json({ ok: true, phone, variants, sessions, counts });
});

// Inject a fake OTP (simulates the gov portal sending to the citizen's phone)
debugRouter.post('/simulate-otp/:request_id', async (req, res) => {
  const code = (req.body?.code || '').toString() || '123456';
  const id = Number(req.params.request_id);
  const { rows } = await db.execute({ sql: `SELECT session_id FROM request WHERE id=?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: 'no_such_request' });
  // Inject as citizen message so the agent captures it
  await db.execute({
    sql: `INSERT INTO message(session_id,request_id,direction,actor_type,body_text,channel) VALUES (?,?, 'in','citizen',?, 'web')`,
    args: [rows[0].session_id, id, code]
  });
  await db.execute({
    sql: `UPDATE otp_window SET code=?, consumed_at=datetime('now') WHERE request_id=? AND consumed_at IS NULL`,
    args: [code, id]
  });
  res.json({ ok: true, code });
});
