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
