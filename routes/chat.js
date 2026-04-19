import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runTurn, loadSession, storeMessage } from '../lib/agent.js';
import { db } from '../lib/db.js';

const UPLOAD_DIR = path.resolve('./data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.session_id || '_shared');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 6);
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

export const chatRouter = Router();

// Create a session id client-side; server just accepts it.
chatRouter.post('/:session_id', upload.single('file'), async (req, res) => {
  const { session_id } = req.params;
  const text = (req.body.text || '').toString();
  const phone = (req.body.phone || '').toString().trim() || null;
  const debug = String(req.query.debug ?? process.env.DEBUG_MODE) === 'true';
  let attachment = null;
  if (req.file) {
    attachment = {
      url: `/uploads/${encodeURIComponent(session_id)}/${encodeURIComponent(req.file.filename)}`,
      mime: req.file.mimetype,
      size: req.file.size,
      name: req.file.originalname
    };
  }
  try {
    const out = await runTurn({ session_id, user_text: text, attachment, citizen_phone: phone });
    res.json({
      reply: out.reply,
      state: out.state,
      request_id: out.request_id ?? null,
      attachment,
      trace: debug ? out.trace : undefined
    });
  } catch (err) {
    console.error('[chat] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Transcript (both web + later whatsapp messages for this session)
chatRouter.get('/:session_id/history', async (req, res) => {
  const { session_id } = req.params;
  const { rows } = await db.execute({
    sql: `SELECT id, direction, actor_type, body_text, media_url, created_at
            FROM message WHERE session_id=? ORDER BY id ASC LIMIT 500`,
    args: [session_id]
  });
  res.json({ messages: rows });
});

// Poll for officer replies (web-tester analogue of WhatsApp push)
chatRouter.get('/:session_id/poll', async (req, res) => {
  const { session_id } = req.params;
  const afterId = Number(req.query.after || 0);
  const { rows } = await db.execute({
    sql: `SELECT id, direction, actor_type, body_text, media_url, created_at
            FROM message
           WHERE session_id=? AND id>? AND actor_type IN ('officer','bot','system')
           ORDER BY id ASC`,
    args: [session_id, afterId]
  });
  res.json({ messages: rows });
});

chatRouter.get('/:session_id/state', async (req, res) => {
  const state = await loadSession(req.params.session_id);
  res.json({ state });
});
