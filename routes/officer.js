// Officer-side endpoints. Cookie-auth via requireOfficer() (see lib/auth.js).
//
// Two marketplace stages, reflected in this file:
//   1) Before a request is awarded — offices see an ANONYMIZED summary only
//      (governorate, service, doc count, # of offers, my offer if any).
//      No citizen phone, no citizen name, no exact fee, no wilayat.
//   2) After a request is awarded (accepted_offer_id set + status='claimed')
//      — ONLY the winning office sees the document contents and service
//      details needed to fulfil the request. The citizen's phone number is
//      NEVER returned to any office — all communication runs through the
//      relayed chat in this app (or WhatsApp via the bot).
//
// Offers carry two-part pricing:
//   • office_fee_omr      = the office's service margin
//   • government_fee_omr  = قيمة المعاملة (the actual government fee they'll pay on behalf)
//   The UI shows both to the citizen so quotes are comparable.
//
// Credit system:
//   When a citizen accepts an office's offer, 1 credit is consumed regardless
//   of whether the request later cancels or completes (per product spec).
//   Officers cannot submit or update offers when credits_remaining == 0 or
//   when their subscription is inactive.

import { Router } from 'express';
import { db } from '../lib/db.js';
import { storeMessage } from '../lib/agent.js';
import { requireOfficer } from '../lib/auth.js';
import { sendWhatsAppText, isWhatsAppSession } from '../lib/whatsapp_send.js';

export const officerRouter = Router();

// All officer routes require an active, approved office.
officerRouter.use(requireOfficer());

// ─── GET /inbox ────────────────────────────────────────────
// Anonymized marketplace + my in-flight board + credit status.
// Marketplace items never leak citizen PII — just enough for the office to
// decide whether to quote.
officerRouter.get('/inbox', async (req, res) => {
  const me = req.officer;
  const office_id = req.office.id;

  // Credit / subscription snapshot for the UI badge.
  // Also surface the office-level default service fee — the UI uses it as the
  // pre-fill value for the one-click "Send quote" button.
  const { rows: credRows } = await db.execute({
    sql: `SELECT credits_remaining, credits_total_used, subscription_status, subscription_since,
                 default_office_fee_omr
            FROM office WHERE id=?`,
    args: [office_id]
  });
  const credit = credRows[0] || {};

  // Marketplace: requests in status='ready' (docs submitted, not yet awarded).
  // Count docs + offers, and pull my office's own offer (if submitted) so the
  // UI can show "you already quoted 4.500 OMR" instead of hiding the request.
  // LEFT JOIN office_service_price (osp) so the UI can prefer the office's
  // own override over the default + catalog values when rendering cards. The
  // office may have set only one of the two fees — the remaining NULL falls
  // back (default_office_fee_omr or sc.fee_omr) on the client.
  const { rows: marketplace } = await db.execute({
    sql: `
      SELECT r.id,
             r.status,
             r.governorate,
             r.created_at,
             s.name_en  AS service_name,
             s.name_ar  AS service_name_ar,
             s.entity_en,
             s.fee_omr  AS catalog_fee_omr,
             osp.office_fee_omr      AS office_fee_override,
             osp.government_fee_omr  AS government_fee_override,
             (SELECT COUNT(*) FROM request_document d WHERE d.request_id = r.id) AS doc_count,
             (SELECT COUNT(*) FROM request_offer   o WHERE o.request_id = r.id AND o.status='pending') AS offer_count,
             mine.id                   AS my_offer_id,
             mine.office_fee_omr       AS my_office_fee,
             mine.government_fee_omr   AS my_gov_fee,
             mine.quoted_fee_omr       AS my_offer_fee,
             mine.estimated_hours      AS my_offer_hours,
             mine.status               AS my_offer_status
        FROM request r
        LEFT JOIN service_catalog s  ON s.id = r.service_id
        LEFT JOIN request_offer   mine
               ON mine.request_id = r.id AND mine.office_id = ?
        LEFT JOIN office_service_price osp
               ON osp.service_id = r.service_id AND osp.office_id = ?
       WHERE r.status='ready'
       ORDER BY r.created_at ASC
       LIMIT 50`,
    args: [office_id, office_id]
  });

  // My board: requests my office has won (accepted_offer_id belongs to me).
  // Full detail — but still no unnecessary fields, clients fetch the per-id
  // endpoint for drilldowns.
  const { rows: mine } = await db.execute({
    sql: `
      SELECT r.id, r.status, r.quoted_fee_omr, r.claimed_at, r.created_at,
             s.name_en AS service_name, s.name_ar AS service_name_ar
        FROM request r
        LEFT JOIN service_catalog s ON s.id = r.service_id
       WHERE r.office_id = ?
         AND r.status NOT IN ('completed','cancelled_by_citizen','cancelled_by_office')
       ORDER BY r.last_event_at DESC
       LIMIT 50`,
    args: [office_id]
  });

  // Offers I've submitted that are still pending decision.
  const { rows: myOffers } = await db.execute({
    sql: `
      SELECT o.id, o.request_id, o.quoted_fee_omr, o.estimated_hours,
             o.note_ar, o.note_en, o.status, o.created_at,
             s.name_en AS service_name, s.name_ar AS service_name_ar,
             r.governorate
        FROM request_offer o
        JOIN request r ON r.id = o.request_id
        LEFT JOIN service_catalog s ON s.id = r.service_id
       WHERE o.office_id = ? AND o.status='pending'
       ORDER BY o.created_at DESC
       LIMIT 50`,
    args: [office_id]
  });

  res.json({
    me: {
      id: me.officer_id, full_name: me.full_name, email: me.email,
      role: me.role, status: me.officer_status
    },
    office: {
      ...req.office,
      default_office_fee_omr: credit.default_office_fee_omr ?? 5.0
    },
    credits: {
      remaining: credit.credits_remaining || 0,
      used:      credit.credits_total_used || 0,
      subscription_status: credit.subscription_status || 'none',
      subscription_since:  credit.subscription_since || null
    },
    settings: {
      default_office_fee_omr: credit.default_office_fee_omr ?? 5.0
    },
    marketplace,
    my_offers: myOffers,
    mine
  });
});

// ─── GET /request/:id ──────────────────────────────────────
// Anonymized detail when the office hasn't won yet.
// Full detail (docs + messages + citizen contact) only after win.
officerRouter.get('/request/:id', async (req, res) => {
  const id = Number(req.params.id);
  const office_id = req.office.id;

  const { rows } = await db.execute({
    sql: `SELECT r.*, s.name_en AS service_name, s.name_ar AS service_name_ar,
                 s.entity_en, s.required_documents_json
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.id=?`,
    args: [id]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });

  const isMine = r.office_id === office_id;

  // Anonymized view — always show doc list (labels, sizes) but never the
  // citizen's phone/name, never the storage URLs of their docs.
  if (!isMine) {
    if (r.status !== 'ready') {
      // Already awarded to someone else → 403 to discourage scraping.
      return res.status(403).json({ error: 'not_available' });
    }
    const { rows: docs } = await db.execute({
      sql: `SELECT id, doc_code, label, mime, size_bytes, status, uploaded_at
              FROM request_document WHERE request_id=? ORDER BY id ASC`,
      args: [id]
    });
    const { rows: myOffer } = await db.execute({
      sql: `SELECT id, quoted_fee_omr, estimated_hours, note_ar, note_en, status, created_at
              FROM request_offer WHERE request_id=? AND office_id=? LIMIT 1`,
      args: [id, office_id]
    });
    return res.json({
      request: {
        id: r.id, status: r.status, governorate: r.governorate,
        service_name: r.service_name, service_name_ar: r.service_name_ar,
        entity_en: r.entity_en, required_documents_json: r.required_documents_json,
        created_at: r.created_at
      },
      documents: docs,
      my_offer: myOffer[0] || null,
      anonymized: true
    });
  }

  // Full detail — my office won.
  // IMPORTANT: even after winning, the office NEVER sees the citizen's phone
  // number. All communication runs through the relayed chat (this app) or
  // WhatsApp via the bot. Only docs, service info, and messages are exposed.
  const { rows: docs } = await db.execute({
    sql: `SELECT id, doc_code, label, storage_url, mime, size_bytes, status,
                 caption, matched_via, original_name,
                 verified_by, verified_at, reject_reason, uploaded_at
            FROM request_document WHERE request_id=? ORDER BY id ASC`,
    args: [id]
  });
  const { rows: messages } = await db.execute({
    sql: `SELECT id, direction, actor_type, body_text, media_url, created_at
            FROM message
           WHERE request_id=? OR session_id=?
           ORDER BY id ASC`,
    args: [id, r.session_id]
  });
  // Strip citizen_id / session_id from the response — they aren't needed on
  // the client and leaking session_id would let an office forge citizen-side
  // accept calls.
  const { citizen_id, session_id, ...safeReq } = r;
  res.json({
    request: safeReq,
    documents: docs,
    messages
  });
});

// ─── POST /request/:id/offer ───────────────────────────────
// Submit or update a quote for an anonymized request.
// Only owner/manager may quote; officer role is read-only.
//
// Body: { office_fee_omr, government_fee_omr, estimated_hours?, note_ar?, note_en? }
//
// Guards (in order):
//   • subscription_status must be 'active'
//   • credits_remaining > 0 (we don't deduct here — only on accept — but
//     we block quoting when balance is zero so offices must top up first)
//   • request must still be 'ready'
//   • fees: office ≥ 0, gov ≥ 0, at least one > 0, total ≤ 500
officerRouter.post(
  '/request/:id/offer',
  requireOfficer({ roles: ['owner', 'manager'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const office_id = req.office.id;
    // Accept both the new two-part shape and the legacy flat shape
    // (quoted_fee_omr only → treated as pure office fee, no gov portion).
    const legacyTotal = req.body?.quoted_fee_omr;
    const office_fee_omr = req.body?.office_fee_omr != null
      ? Number(req.body.office_fee_omr)
      : (legacyTotal != null ? Number(legacyTotal) : NaN);
    const government_fee_omr = Number(req.body?.government_fee_omr || 0);
    const estimated_hours = req.body?.estimated_hours != null ? Number(req.body.estimated_hours) : null;
    const note_ar = String(req.body?.note_ar || '').trim().slice(0, 400) || null;
    const note_en = String(req.body?.note_en || '').trim().slice(0, 400) || null;

    if (!Number.isFinite(office_fee_omr) || !Number.isFinite(government_fee_omr) ||
        office_fee_omr < 0 || government_fee_omr < 0)
      return res.status(400).json({ error: 'bad_fee' });
    const total = office_fee_omr + government_fee_omr;
    if (!(total > 0))         return res.status(400).json({ error: 'bad_fee' });
    if (total > 500)          return res.status(400).json({ error: 'fee_too_high' });
    if (estimated_hours != null && (estimated_hours < 0 || estimated_hours > 720))
      return res.status(400).json({ error: 'bad_hours' });

    // Subscription + credits guard (bypassed in DEBUG_MODE for local dev).
    if (process.env.DEBUG_MODE !== 'true') {
      const { rows: cRows } = await db.execute({
        sql: `SELECT credits_remaining, subscription_status FROM office WHERE id=?`,
        args: [office_id]
      });
      const c = cRows[0] || {};
      if (c.subscription_status !== 'active')
        return res.status(402).json({ error: 'subscription_required', subscription_status: c.subscription_status || 'none' });
      if ((c.credits_remaining || 0) < 1)
        return res.status(402).json({ error: 'no_credits', credits_remaining: 0 });
    }

    // Only quote requests still in the marketplace.
    const { rows } = await db.execute({
      sql: `SELECT status FROM request WHERE id=?`, args: [id]
    });
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].status !== 'ready') return res.status(409).json({ error: 'not_open' });

    // UPSERT (request_id, office_id unique index handles the dedup).
    await db.execute({
      sql: `INSERT INTO request_offer
              (request_id, office_id, officer_id, office_fee_omr, government_fee_omr,
               quoted_fee_omr, estimated_hours, note_ar, note_en, status)
            VALUES (?,?,?,?,?,?,?,?,?, 'pending')
            ON CONFLICT(request_id, office_id) DO UPDATE SET
              office_fee_omr=excluded.office_fee_omr,
              government_fee_omr=excluded.government_fee_omr,
              quoted_fee_omr=excluded.quoted_fee_omr,
              estimated_hours=excluded.estimated_hours,
              note_ar=excluded.note_ar,
              note_en=excluded.note_en,
              officer_id=excluded.officer_id,
              status='pending',
              updated_at=datetime('now')`,
      args: [id, office_id, req.officer.officer_id,
             office_fee_omr, government_fee_omr, total,
             estimated_hours, note_ar, note_en]
    });
    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'submit_offer', 'request', ?, ?)`,
      args: [req.officer.officer_id, id,
             JSON.stringify({ office_fee_omr, government_fee_omr, total, estimated_hours })]
    });

    // Auto-learn: remember this office's fee for this specific service, so
    // the next time the same service appears in the marketplace the card
    // pre-fills with what the office quoted last time. Government fee is NOT
    // cached here — it stays admin-owned via the catalog. (If the office
    // wants to lock a local gov-fee override they can do so explicitly on
    // /pricing.html; passing null here preserves any existing override.)
    try {
      const { rows: svcRows } = await db.execute({
        sql: `SELECT service_id FROM request WHERE id=?`, args: [id]
      });
      const service_id = svcRows[0]?.service_id;
      if (service_id) {
        await db.execute({
          sql: `
            INSERT INTO office_service_price (office_id, service_id, office_fee_omr, government_fee_omr, updated_at)
            VALUES (?, ?, ?, NULL, datetime('now'))
            ON CONFLICT(office_id, service_id) DO UPDATE SET
              office_fee_omr = excluded.office_fee_omr,
              updated_at     = datetime('now')
          `,
          args: [office_id, service_id, office_fee_omr]
        });
      }
    } catch (_) { /* best-effort; never block offer submission */ }

    res.status(201).json({ ok: true, office_fee_omr, government_fee_omr, total });
  }
);

// ─── POST /request/:id/offer/withdraw ─────────────────────
officerRouter.post(
  '/request/:id/offer/withdraw',
  requireOfficer({ roles: ['owner', 'manager'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const r = await db.execute({
      sql: `UPDATE request_offer SET status='withdrawn', updated_at=datetime('now')
             WHERE request_id=? AND office_id=? AND status='pending'`,
      args: [id, req.office.id]
    });
    if (!r.rowsAffected) return res.status(404).json({ error: 'no_active_offer' });
    // Bookkeeping: count abandonment against the office (discourages spam quoting).
    await db.execute({
      sql: `UPDATE office SET offers_abandoned = COALESCE(offers_abandoned,0)+1 WHERE id=?`,
      args: [req.office.id]
    });
    res.json({ ok: true });
  }
);

// ─── POST /request/:id/message ─────────────────────────────
// Officer → citizen chat. Winner only.
officerRouter.post('/request/:id/message', async (req, res) => {
  const id = Number(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  // Pull session_id (for the in-app relay) AND the citizen's phone (for the
  // WhatsApp push, when the original session came in via WhatsApp).
  const { rows } = await db.execute({
    sql: `SELECT r.session_id, r.office_id, c.phone AS citizen_phone
            FROM request r
            LEFT JOIN citizen c ON c.id = r.citizen_id
           WHERE r.id=?`,
    args: [id]
  });
  const r = rows[0];
  if (!r || r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });

  // Always store in DB so the in-app web chat polls pick it up.
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'officer',
    body_text: text,
    meta: { officer_id: req.officer.officer_id }
  });

  // Push to WhatsApp when the citizen's session is on WhatsApp. Uses citizen
  // table phone as the source of truth; falls back to the phone embedded in
  // session_id ("wa:+96890…") when the citizen row doesn't have one yet.
  let waResult = { ok: false, channel: 'skipped', skipped: 'not_whatsapp' };
  if (isWhatsAppSession(r.session_id)) {
    const phone = r.citizen_phone || r.session_id.replace(/^wa:/, '');
    waResult = await sendWhatsAppText(phone, text);
    if (!waResult.ok) {
      console.warn(`[officer→wa] send failed for request ${id}: ${waResult.error}`);
    }
  }

  await db.execute({
    sql: `UPDATE request
             SET last_event_at=datetime('now'),
                 status=CASE WHEN status='claimed' THEN 'in_progress' ELSE status END
           WHERE id=?`,
    args: [id]
  });
  res.json({
    ok: true,
    delivery: {
      channel: waResult.channel,
      whatsapp_ok: waResult.ok,
      whatsapp_message_id: waResult.message_id || null,
      whatsapp_error: waResult.error || null
    }
  });
});

// ─── POST /request/:id/otp-window ──────────────────────────
officerRouter.post('/request/:id/otp-window', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT session_id, office_id FROM request WHERE id=?`, args: [id]
  });
  const r = rows[0];
  if (!r || r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
  await db.execute({
    sql: `INSERT INTO otp_window(request_id,officer_id,expires_at)
          VALUES (?,?, datetime('now','+60 seconds'))`,
    args: [id, req.officer.officer_id]
  });
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'bot',
    body_text: '📲 أرسل لنا الرمز الذي وصلك من البوابة (صالح 60 ثانية).'
  });
  res.json({ ok: true });
});

officerRouter.get('/request/:id/otp', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: own } = await db.execute({
    sql: `SELECT office_id FROM request WHERE id=?`, args: [id]
  });
  if (!own[0] || own[0].office_id !== req.office.id)
    return res.status(403).json({ error: 'not_your_request' });
  const { rows } = await db.execute({
    sql: `SELECT code, consumed_at, expires_at FROM otp_window
           WHERE request_id=? ORDER BY id DESC LIMIT 1`,
    args: [id]
  });
  res.json({ otp: rows[0] || null });
});

// ─── POST /request/:id/complete ────────────────────────────
// Idempotent: the UPDATE is guarded on a non-terminal status so calling this
// twice doesn't double-bump the office stats or re-send the completion
// message to the citizen. A second call on an already-completed request is
// a no-op (returns {already:true}).
officerRouter.post('/request/:id/complete', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT session_id, office_id, status FROM request WHERE id=?`, args: [id]
  });
  const r = rows[0];
  if (!r || r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
  if (['completed', 'cancelled_by_citizen', 'cancelled_by_office'].includes(r.status)) {
    // Already in a terminal state — don't mutate, don't re-bill.
    return res.json({ ok: true, already: true, status: r.status });
  }
  const upd = await db.execute({
    sql: `UPDATE request
             SET status='completed', completed_at=datetime('now'),
                 last_event_at=datetime('now')
           WHERE id=? AND status NOT IN ('completed','cancelled_by_citizen','cancelled_by_office')`,
    args: [id]
  });
  if (!upd.rowsAffected) {
    // Raced with another completion — treat as already done.
    return res.json({ ok: true, already: true });
  }
  await db.execute({
    sql: `UPDATE office SET total_completed = COALESCE(total_completed,0)+1 WHERE id=?`,
    args: [req.office.id]
  });
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'bot',
    body_text: '✅ تم إنجاز معاملتك! شكراً لاستخدامك سند.'
  });
  res.json({ ok: true });
});

// ─── Per-document verify / reject ──────────────────────────
officerRouter.post('/request/:id/document/:docId/verify', async (req, res) => {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const { rows } = await db.execute({
    sql: `SELECT office_id FROM request WHERE id=?`, args: [id]
  });
  if (!rows[0] || rows[0].office_id !== req.office.id)
    return res.status(403).json({ error: 'not_your_request' });
  const r = await db.execute({
    sql: `UPDATE request_document
             SET status='verified', verified_by=?, verified_at=datetime('now'),
                 reject_reason=NULL
           WHERE id=? AND request_id=?`,
    args: [req.officer.officer_id, docId, id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

officerRouter.post('/request/:id/document/:docId/reject', async (req, res) => {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const reason = String(req.body?.reason || '').trim() || 'no reason given';
  const { rows } = await db.execute({
    sql: `SELECT office_id, session_id FROM request WHERE id=?`, args: [id]
  });
  if (!rows[0] || rows[0].office_id !== req.office.id)
    return res.status(403).json({ error: 'not_your_request' });
  const r = await db.execute({
    sql: `UPDATE request_document
             SET status='rejected', verified_by=?, verified_at=datetime('now'),
                 reject_reason=?
           WHERE id=? AND request_id=?`,
    args: [req.officer.officer_id, reason, docId, id]
  });
  if (!r.rowsAffected) return res.status(404).json({ error: 'not_found' });
  const { rows: dr } = await db.execute({
    sql: `SELECT label, doc_code FROM request_document WHERE id=?`, args: [docId]
  });
  if (dr[0]) {
    await storeMessage({
      session_id: rows[0].session_id, request_id: id,
      direction: 'out', actor_type: 'officer',
      body_text: `⚠️ الموظف رفض مستند "${dr[0].label || dr[0].doc_code}" — السبب: ${reason}. برجاء إعادة الإرسال.`,
      meta: { officer_id: req.officer.officer_id, rejected_doc_id: docId }
    });
  }
  res.json({ ok: true });
});

// ─── POST /request/:id/release ─────────────────────────────
// Office voluntarily releases a won request back to the marketplace.
// (Rare — used when the office realizes they can't fulfil.) Bumps
// offers_abandoned to keep scoring honest.
officerRouter.post('/request/:id/release',
  requireOfficer({ roles: ['owner', 'manager'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    // Guard on BOTH ownership AND a non-terminal status. Previously the WHERE
    // only matched office_id, which allowed an office to release a completed
    // or cancelled request — quietly resurrecting it back to 'ready' and
    // losing the completed_at / office_id / fee state. That's a data loss bug.
    const r = await db.execute({
      sql: `UPDATE request
               SET status='ready', officer_id=NULL, office_id=NULL,
                   accepted_offer_id=NULL, quoted_fee_omr=NULL,
                   claimed_at=NULL, last_event_at=datetime('now')
             WHERE id=? AND office_id=?
               AND status IN ('claimed','in_progress','needs_more_info','on_hold')`,
      args: [id, req.office.id]
    });
    if (!r.rowsAffected) {
      // Distinguish "not yours" from "terminal state" for the client.
      const { rows: cur } = await db.execute({
        sql: `SELECT status, office_id FROM request WHERE id=?`, args: [id]
      });
      if (!cur[0]) return res.status(404).json({ error: 'not_found' });
      if (cur[0].office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
      return res.status(409).json({ error: 'bad_state', status: cur[0].status });
    }
    // Re-open all of that request's offers (they may re-quote).
    await db.execute({
      sql: `UPDATE request_offer SET status='pending', updated_at=datetime('now')
             WHERE request_id=? AND status='accepted'`,
      args: [id]
    });
    await db.execute({
      sql: `UPDATE office SET offers_abandoned=COALESCE(offers_abandoned,0)+1 WHERE id=?`,
      args: [req.office.id]
    });
    res.json({ ok: true });
  }
);
