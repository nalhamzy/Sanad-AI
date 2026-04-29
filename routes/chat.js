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

// ─── GET /my-requests — list a signed-in citizen's requests ───
// Used by /account.html dashboard. Resolves the citizen via
// attachCitizenSession (req.citizen). Falls back to phone-only matching for
// legacy WhatsApp citizens that haven't yet been linked to a citizen_id row.
// Returns at most 50 most-recent.
chatRouter.get('/my-requests', async (req, res) => {
  if (!req.citizen) return res.status(401).json({ error: 'not_signed_in' });
  const c = req.citizen;
  // Match by citizen.id (the right way) OR by phone (for legacy rows whose
  // request.citizen_id was never set). Either way, never leak another
  // citizen's data.
  const { rows } = await db.execute({
    sql: `
      SELECT r.id, r.status, r.created_at, r.last_event_at,
             r.payment_status, r.payment_amount_omr, r.payment_link, r.paid_at,
             r.quoted_fee_omr, r.office_fee_omr, r.government_fee_omr,
             s.name_en AS service_name, s.name_ar AS service_name_ar,
             s.entity_en, s.entity_ar,
             off.name_en AS office_name_en, off.name_ar AS office_name_ar
        FROM request r
        LEFT JOIN service_catalog s ON s.id = r.service_id
        LEFT JOIN office off        ON off.id = r.office_id
       WHERE r.citizen_id = ?
          OR (? IS NOT NULL AND r.session_id = ?)
       ORDER BY r.last_event_at DESC, r.id DESC
       LIMIT 50`,
    args: [c.id, c.phone, c.phone ? `wa:${c.phone}` : null]
  });
  res.json({ requests: rows });
});

// ─── Citizen-side offer marketplace ────────────────────────
// The citizen sees anonymized-to-them offers: quoted fee, estimated hours,
// the office's public stats (name, governorate, rating, completed count).
// They never see which officer submitted — that's internal to the office.
chatRouter.get('/:session_id/request/:id/offers', async (req, res) => {
  const { session_id } = req.params;
  const id = Number(req.params.id);
  // Ownership check: the request must belong to this session.
  const { rows: own } = await db.execute({
    sql: `SELECT id, status, accepted_offer_id FROM request WHERE id=? AND session_id=?`,
    args: [id, session_id]
  });
  if (!own.length) return res.status(404).json({ error: 'not_found' });
  const { rows: offers } = await db.execute({
    sql: `SELECT o.id,
                 o.office_fee_omr, o.government_fee_omr, o.quoted_fee_omr,
                 o.estimated_hours, o.note_ar, o.note_en,
                 o.status, o.created_at,
                 off.id AS office_id, off.name_en, off.name_ar, off.governorate,
                 off.rating, off.total_completed
            FROM request_offer o
            JOIN office off ON off.id = o.office_id
           WHERE o.request_id=? AND o.status IN ('pending','accepted')
           ORDER BY o.quoted_fee_omr ASC, o.created_at ASC`,
    args: [id]
  });
  res.json({
    request: own[0],
    offers
  });
});

// Citizen picks a winner.
//
// Atomic: single UPDATE on request guarded by status='ready' (no double-accept);
// then mark the chosen offer 'accepted' and all others 'rejected'.
chatRouter.post('/:session_id/request/:id/offers/:offerId/accept', async (req, res) => {
  const { session_id } = req.params;
  const id = Number(req.params.id);
  const offerId = Number(req.params.offerId);

  const { rows: oRows } = await db.execute({
    sql: `SELECT o.id, o.office_id, o.officer_id,
                 o.office_fee_omr, o.government_fee_omr, o.quoted_fee_omr,
                 o.status,
                 r.session_id, r.status AS req_status
            FROM request_offer o
            JOIN request r ON r.id = o.request_id
           WHERE o.id=? AND o.request_id=?`,
    args: [offerId, id]
  });
  const offer = oRows[0];
  if (!offer) return res.status(404).json({ error: 'offer_not_found' });
  if (offer.session_id !== session_id) return res.status(403).json({ error: 'not_your_request' });
  if (offer.status !== 'pending')      return res.status(409).json({ error: 'offer_not_pending' });
  if (offer.req_status !== 'ready')    return res.status(409).json({ error: 'request_not_open' });

  // 1) Award the request (atomic guard against double-accept).
  const award = await db.execute({
    sql: `UPDATE request
             SET status='claimed', accepted_offer_id=?,
                 office_id=?, officer_id=?,
                 quoted_fee_omr=?, office_fee_omr=?, government_fee_omr=?,
                 claimed_at=datetime('now'),
                 last_event_at=datetime('now')
           WHERE id=? AND status='ready'`,
    args: [offerId, offer.office_id, offer.officer_id,
           offer.quoted_fee_omr, offer.office_fee_omr, offer.government_fee_omr, id]
  });
  if (!award.rowsAffected) return res.status(409).json({ error: 'already_awarded' });

  // 2) Flip offer statuses.
  await db.execute({
    sql: `UPDATE request_offer SET status='accepted', updated_at=datetime('now')
           WHERE id=?`, args: [offerId]
  });
  await db.execute({
    sql: `UPDATE request_offer SET status='rejected', updated_at=datetime('now')
           WHERE request_id=? AND id<>? AND status='pending'`,
    args: [id, offerId]
  });

  // 3) Score-keeping for the winning office.
  await db.execute({
    sql: `UPDATE office SET offers_won = COALESCE(offers_won,0)+1 WHERE id=?`,
    args: [offer.office_id]
  });

  // 4) Deduct 1 credit from the winning office (bypassed in DEBUG_MODE).
  //    The UNIQUE index on (office_id, request_id) guarantees we never charge
  //    the same request twice even if this endpoint is retried.
  if (process.env.DEBUG_MODE !== 'true') {
    try {
      // Atomic decrement — only fires if balance >= 1 so we can't go negative.
      const dec = await db.execute({
        sql: `UPDATE office
                 SET credits_remaining   = credits_remaining - 1,
                     credits_total_used  = COALESCE(credits_total_used,0) + 1
               WHERE id=? AND credits_remaining >= 1`,
        args: [offer.office_id]
      });
      if (dec.rowsAffected) {
        const { rows: balRows } = await db.execute({
          sql: `SELECT credits_remaining FROM office WHERE id=?`,
          args: [offer.office_id]
        });
        const balance = balRows[0]?.credits_remaining ?? 0;
        await db.execute({
          sql: `INSERT INTO credit_ledger(office_id, request_id, delta, reason, balance_after)
                VALUES (?,?,?, 'offer_accepted', ?)`,
          args: [offer.office_id, id, -1, balance]
        });
      } else {
        // Office had no credits — we still awarded the offer (they won the race)
        // but flag it for admin review. In prod the pre-offer guard in
        // routes/officer.js prevents this in practice.
        console.warn(`[chat/accept] office ${offer.office_id} had no credits when their offer was accepted on request ${id}`);
      }
    } catch (e) {
      // Unique-index collision = already charged; that's fine, treat as success.
      if (!/UNIQUE/i.test(String(e.message))) throw e;
    }
  }

  // 5) Audit + chat notification.
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('citizen', NULL, 'accept_offer', 'request', ?, ?)`,
    args: [id, JSON.stringify({
      offer_id: offerId, office_id: offer.office_id,
      office_fee_omr: offer.office_fee_omr,
      government_fee_omr: offer.government_fee_omr,
      fee_omr: offer.quoted_fee_omr
    })]
  });
  await storeMessage({
    session_id, request_id: id,
    direction: 'out', actor_type: 'system',
    body_text: `✅ تم قبول عرض المكتب. بدأنا العمل على معاملتك (الإجمالي ${offer.quoted_fee_omr} ر.ع — رسوم المكتب ${offer.office_fee_omr} + قيمة المعاملة ${offer.government_fee_omr}).`
  });

  res.json({
    ok: true,
    accepted_offer_id: offerId,
    office_id: offer.office_id,
    office_fee_omr: offer.office_fee_omr,
    government_fee_omr: offer.government_fee_omr,
    total_omr: offer.quoted_fee_omr
  });
});
