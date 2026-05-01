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
import { createPaymentLink, newMerchantRef, AMWAL_ENABLED } from '../lib/amwal.js';
import { SLA_MINUTES, REVIEW_SLA_MINUTES } from '../lib/sla.js';

export const officerRouter = Router();

// All officer routes require an active, approved office.
officerRouter.use(requireOfficer());

// ─── GET /reports — operational analytics for the office ───
// Returns daily/weekly counts of pipeline events + averages so the office
// can see throughput at a glance. Filtered to req.office.id only.
officerRouter.get('/reports', async (req, res) => {
  const office_id = req.office.id;
  // Counts by lifecycle stage over the last 7 days (UTC).
  const { rows: byStatus } = await db.execute({
    sql: `SELECT status, COUNT(*) AS n FROM request
           WHERE office_id = ?
             AND created_at >= datetime('now', '-7 days')
           GROUP BY status`,
    args: [office_id]
  });
  // Daily pipeline (last 14 days) — claimed, paid, completed.
  const { rows: daily } = await db.execute({
    sql: `SELECT date(claimed_at) AS day,
                 COUNT(CASE WHEN claimed_at IS NOT NULL THEN 1 END) AS claimed,
                 COUNT(CASE WHEN paid_at IS NOT NULL THEN 1 END)    AS paid,
                 COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) AS completed
            FROM request
           WHERE office_id = ?
             AND claimed_at >= datetime('now', '-14 days')
           GROUP BY day ORDER BY day DESC`,
    args: [office_id]
  });
  // Average minutes from claim → completion (for completed only, last 30d).
  const { rows: avgRows } = await db.execute({
    sql: `SELECT AVG((julianday(completed_at) - julianday(claimed_at)) * 24 * 60) AS avg_minutes,
                 COUNT(*) AS n
            FROM request
           WHERE office_id = ?
             AND completed_at IS NOT NULL
             AND claimed_at >= datetime('now', '-30 days')`,
    args: [office_id]
  });
  // SLA expirations (auto-release) from audit log, last 30 days.
  const { rows: slaRows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_log
           WHERE action = 'sla_auto_release'
             AND target_type = 'request'
             AND target_id IN (SELECT id FROM request WHERE office_id = ?)
             AND created_at >= datetime('now', '-30 days')`,
    args: [office_id]
  });
  // Currently in-flight (status='claimed' / 'awaiting_payment' / 'in_progress')
  // with their elapsed time since claim — useful for the dashboard's "active
  // SLA timers" surface.
  const { rows: inflight } = await db.execute({
    sql: `SELECT id, status, payment_status, claimed_at,
                 CAST((julianday('now') - julianday(claimed_at)) * 24 * 60 AS INTEGER) AS minutes_elapsed
            FROM request
           WHERE office_id = ?
             AND status IN ('claimed','awaiting_payment','in_progress','needs_more_info','on_hold')
           ORDER BY claimed_at DESC LIMIT 20`,
    args: [office_id]
  });
  res.json({
    sla_minutes: SLA_MINUTES,
    review_sla_minutes: REVIEW_SLA_MINUTES,
    by_status_7d: byStatus,
    daily_14d: daily,
    avg_minutes_30d: avgRows[0]?.avg_minutes ? Math.round(avgRows[0].avg_minutes) : null,
    completed_30d: avgRows[0]?.n || 0,
    sla_expired_30d: slaRows[0]?.n || 0,
    inflight
  });
});

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

  // Marketplace visibility ladder (per spec §3.1):
  //   • 0–20 min after creation → only offices in the same governorate
  //   • 20–60 min               → same gov + adjacent govs
  //   • 60+ min                 → open to all Oman
  // Offices that have FLAGGED a request never see it again; flagging is also
  // counted across offices — once a request hits FLAG_AUTO_REMOVE_THRESHOLD
  // distinct office flags, it's auto-quarantined (status='flagged') and falls
  // out of every marketplace.
  //
  // Adjacency is a static map (governorate borders); if the office's gov
  // isn't in the map we degrade to "show everything in the same gov".
  const ADJACENT = {
    'Muscat':            ['Al Batinah North','Al Batinah South','Ad Dakhiliyah','Ash Sharqiyah North'],
    'Al Batinah North':  ['Muscat','Al Batinah South','Ad Dhahirah'],
    'Al Batinah South':  ['Muscat','Al Batinah North','Ad Dakhiliyah'],
    'Ad Dakhiliyah':     ['Muscat','Al Batinah South','Ad Dhahirah','Ash Sharqiyah North'],
    'Ad Dhahirah':       ['Al Batinah North','Ad Dakhiliyah'],
    'Ash Sharqiyah North':['Muscat','Ad Dakhiliyah','Ash Sharqiyah South'],
    'Ash Sharqiyah South':['Ash Sharqiyah North','Al Wusta'],
    'Al Wusta':          ['Ash Sharqiyah South','Dhofar'],
    'Dhofar':            ['Al Wusta'],
    'Musandam':          [],
    'Al Buraimi':        ['Ad Dhahirah']
  };
  const myGov = req.office.governorate || 'Muscat';
  const adj = ADJACENT[myGov] || [];

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
             CAST((julianday('now') - julianday(r.created_at)) * 24 * 60 AS INTEGER) AS minutes_old,
             (SELECT COUNT(*) FROM request_document d WHERE d.request_id = r.id) AS doc_count,
             (SELECT COUNT(*) FROM request_flag rf WHERE rf.request_id = r.id) AS flag_count,
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
         AND NOT EXISTS (SELECT 1 FROM request_flag rf
                          WHERE rf.request_id = r.id AND rf.office_id = ?)
         AND (
              -- 60+ minutes old → open to all
              (julianday('now') - julianday(r.created_at)) * 24 * 60 >= 60
              -- 20–60 minutes → same gov + adjacent
              OR ((julianday('now') - julianday(r.created_at)) * 24 * 60 >= 20
                   AND (r.governorate = ? OR r.governorate IN (${adj.map(() => '?').join(',') || "''"})))
              -- 0–20 minutes → same governorate only
              OR (r.governorate = ?)
              -- Always include requests with no governorate set (legacy / web form fallback)
              OR r.governorate IS NULL OR r.governorate = ''
         )
       ORDER BY r.created_at ASC
       LIMIT 50`,
    args: [office_id, office_id, office_id, myGov, ...adj, myGov]
  });

  // My board: requests my office has claimed. Now grouped by lifecycle stage:
  //   • reviewing — claimed, no payment link yet
  //   • awaiting_payment — link sent, citizen hasn't paid
  //   • in_progress — paid, chat unlocked, work in flight
  //   • on_hold / needs_more_info — paused
  // Each row carries paid_at + payment_status + payment_link so the UI can
  // render the right action button per row without a second round-trip.
  const { rows: mine } = await db.execute({
    sql: `
      SELECT r.id, r.status, r.quoted_fee_omr, r.office_fee_omr, r.government_fee_omr,
             r.claimed_at, r.created_at, r.last_event_at,
             r.payment_status, r.payment_link, r.payment_amount_omr, r.paid_at,
             r.claim_review_started_at,
             s.name_en AS service_name, s.name_ar AS service_name_ar
        FROM request r
        LEFT JOIN service_catalog s ON s.id = r.service_id
       WHERE r.office_id = ?
         AND r.status NOT IN ('completed','cancelled_by_citizen','cancelled_by_office')
       ORDER BY r.last_event_at DESC
       LIMIT 100`,
    args: [office_id]
  });

  // Bucket the rows by lifecycle stage for cleaner client rendering.
  const buckets = { reviewing: [], awaiting_payment: [], in_progress: [], on_hold: [] };
  for (const r of mine) {
    if (r.status === 'claimed') buckets.reviewing.push(r);
    else if (r.status === 'awaiting_payment') buckets.awaiting_payment.push(r);
    else if (r.status === 'in_progress') buckets.in_progress.push(r);
    else buckets.on_hold.push(r);
  }

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
    // SLA windows surfaced to the client so countdown badges always reflect
    // the live config (env-overrides for tests show through correctly).
    sla: {
      review_minutes: REVIEW_SLA_MINUTES,
      work_minutes:   SLA_MINUTES
    },
    marketplace,
    my_offers: myOffers,
    mine,
    lifecycle: buckets
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

  // Full detail — my office claimed it.
  // IMPORTANT: even after claiming, the office NEVER sees the citizen's phone
  // number. All communication runs through the relayed chat (this app) or
  // WhatsApp via the bot. Only docs, service info, and messages are exposed.
  //
  // CHAT GATE: pre-payment (paid_at IS NULL) the office sees only the
  // documents — NO message history. The office cannot influence the citizen
  // until payment is committed. After paid_at, the full thread unlocks.
  const { rows: docs } = await db.execute({
    sql: `SELECT id, doc_code, label, storage_url, mime, size_bytes, status,
                 caption, matched_via, original_name,
                 verified_by, verified_at, reject_reason, uploaded_at
            FROM request_document WHERE request_id=? ORDER BY id ASC`,
    args: [id]
  });
  const chatUnlocked = !!r.paid_at;
  const messages = chatUnlocked
    ? (await db.execute({
        sql: `SELECT id, direction, actor_type, body_text, media_url, created_at
                FROM message
               WHERE request_id=? OR session_id=?
               ORDER BY id ASC`,
        args: [id, r.session_id]
      })).rows
    : [];
  // Strip citizen_id / session_id from the response — they aren't needed on
  // the client and leaking session_id would let an office forge citizen-side
  // accept calls.
  const { citizen_id, session_id, ...safeReq } = r;
  res.json({
    request: safeReq,
    documents: docs,
    messages,
    chat_unlocked: chatUnlocked
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
// Officer → citizen chat. Owner-office only AND only after payment.
// The citizen's chat thread is sealed pre-payment so the office cannot
// influence the citizen until they've actually committed money.
officerRouter.post('/request/:id/message', async (req, res) => {
  const id = Number(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const { rows } = await db.execute({
    sql: `SELECT r.session_id, r.office_id, r.paid_at, r.status,
                 c.phone AS citizen_phone
            FROM request r
            LEFT JOIN citizen c ON c.id = r.citizen_id
           WHERE r.id=?`,
    args: [id]
  });
  const r = rows[0];
  if (!r || r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
  // Pre-payment chat is sealed in production — only DEBUG_MODE bypasses for tests.
  if (!r.paid_at && process.env.DEBUG_MODE !== 'true') {
    return res.status(403).json({
      error: 'chat_locked_until_paid',
      hint: 'Send the payment link first; chat unlocks automatically when the citizen pays.'
    });
  }

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

// ─── POST /request/:id/request-info ────────────────────────
// Office tells the citizen "we need more / different documents". Flips
// status to 'needs_more_info' (which is excluded from the SLA review
// sweep — the office is no longer holding the citizen up; the citizen
// is). Sends a structured message into the citizen thread so it shows
// in /request.html AND on WhatsApp.
//
// Body: { reason: "...", missing: ["civil_id","contract"] (optional) }
// Only the OFFICE that holds the request can call this. Status must be
// 'claimed' (pre-pay) or 'in_progress' (post-pay) — both are valid
// "we need more from you" moments.
officerRouter.post('/request/:id/request-info',
  requireOfficer({ roles: ['owner', 'manager', 'officer'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const reason  = String(req.body?.reason  || '').trim();
    const missing = Array.isArray(req.body?.missing) ? req.body.missing.filter(Boolean).slice(0, 12) : [];
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    const { rows } = await db.execute({
      sql: `SELECT r.session_id, r.office_id, r.status, r.paid_at,
                   s.name_en AS service_name, s.name_ar AS service_name_ar
              FROM request r
              LEFT JOIN service_catalog s ON s.id = r.service_id
             WHERE r.id=?`,
      args: [id]
    });
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
    const ok = ['claimed','awaiting_payment','in_progress'].includes(r.status);
    if (!ok) return res.status(409).json({ error: 'bad_state', status: r.status });

    const upd = await db.execute({
      sql: `UPDATE request
               SET status='needs_more_info',
                   last_event_at=datetime('now')
             WHERE id=? AND office_id=?`,
      args: [id, req.office.id]
    });
    if (!upd.rowsAffected) return res.status(404).json({ error: 'not_found' });

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'request_more_info', 'request', ?, ?)`,
      args: [req.officer.officer_id, id, JSON.stringify({ from_status: r.status, reason, missing })]
    });

    // Compose the citizen-facing message. Keep it tight: a one-liner
    // headline, the office's reason, and an itemised list if `missing`
    // was provided. WhatsApp / web both render this verbatim.
    const sname = r.service_name_ar || r.service_name || '';
    const lines = [
      `📝 مكتب سند يحتاج معلومات إضافيّة لطلبك "${sname}":`,
      reason
    ];
    if (missing.length) {
      lines.push('');
      lines.push('المطلوب:');
      missing.forEach(m => lines.push(`• ${m}`));
    }
    lines.push('');
    lines.push('برجاء الردّ هنا أو على واتساب بأقرب وقت لاستئناف المعالجة.');
    await storeMessage({
      session_id: r.session_id, request_id: id,
      direction: 'out', actor_type: 'officer',
      body_text: lines.join('\n'),
      meta: { officer_id: req.officer.officer_id, missing }
    });
    res.json({ ok: true });
  }
);

// ─── POST /request/:id/reclassify ──────────────────────────
// Office decides the citizen actually needs a DIFFERENT service from the
// catalogue (common: "you applied for X but you really need Y"). The
// service_id flips, but ALL request_document rows stay attached — they
// were uploaded against this request, not against the service. Pricing
// is recomputed from the new service's catalog row + the office's
// per-service overrides.
//
// Body: { new_service_id, reason }
// Allowed in 'claimed' / 'needs_more_info' (pre-pay reclassification only).
// We refuse after payment because that would change what the citizen paid for.
officerRouter.post('/request/:id/reclassify',
  requireOfficer({ roles: ['owner', 'manager'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const newServiceId = Number(req.body?.new_service_id || 0);
    const reason = String(req.body?.reason || '').trim() || 'service mismatch';
    if (!newServiceId) return res.status(400).json({ error: 'new_service_id_required' });

    const { rows } = await db.execute({
      sql: `SELECT r.session_id, r.office_id, r.status, r.paid_at, r.service_id AS old_service_id,
                   s.name_en AS new_service_name, s.name_ar AS new_service_name_ar, s.fee_omr AS new_catalog_fee
              FROM request r
              LEFT JOIN service_catalog s ON s.id = ?
             WHERE r.id=?`,
      args: [newServiceId, id]
    });
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (!r.new_service_name && !r.new_service_name_ar) return res.status(404).json({ error: 'service_not_found' });
    if (r.office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
    if (r.paid_at) return res.status(409).json({ error: 'already_paid' });
    if (!['claimed','needs_more_info'].includes(r.status)) {
      return res.status(409).json({ error: 'bad_state', status: r.status });
    }

    // Re-resolve pricing for the new service (per-service override → office
    // default → 5.0 OMR fallback), then update the request row.
    const { rows: priceRows } = await db.execute({
      sql: `SELECT COALESCE(osp.office_fee_omr, off.default_office_fee_omr, 5.0) AS office_fee,
                   COALESCE(osp.government_fee_omr, ?, 0)                       AS gov_fee
              FROM office off
              LEFT JOIN office_service_price osp ON osp.office_id = off.id AND osp.service_id = ?
             WHERE off.id = ?`,
      args: [r.new_catalog_fee, newServiceId, req.office.id]
    });
    const office_fee = Number(priceRows[0]?.office_fee || 0);
    const gov_fee    = Number(priceRows[0]?.gov_fee || 0);
    const total      = office_fee + gov_fee;

    await db.execute({
      sql: `UPDATE request
               SET service_id=?, office_fee_omr=?, government_fee_omr=?, quoted_fee_omr=?,
                   status='claimed',
                   claim_review_started_at=datetime('now'),
                   last_event_at=datetime('now')
             WHERE id=? AND office_id=?`,
      args: [newServiceId, office_fee, gov_fee, total, id, req.office.id]
    });

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'request_reclassify', 'request', ?, ?)`,
      args: [req.officer.officer_id, id,
             JSON.stringify({ from_service: r.old_service_id, to_service: newServiceId, reason, new_total: total })]
    });

    const newName = r.new_service_name_ar || r.new_service_name;
    await storeMessage({
      session_id: r.session_id, request_id: id,
      direction: 'out', actor_type: 'officer',
      body_text: `🔄 المكتب أعاد تصنيف طلبك إلى الخدمة الصحيحة: "${newName}". مستنداتك انتقلت كما هي. السبب: ${reason}.\nالإجمالي الجديد: ${total.toFixed(3)} ر.ع.`,
      meta: { officer_id: req.officer.officer_id, from_service: r.old_service_id, to_service: newServiceId }
    });
    res.json({ ok: true, new_service_id: newServiceId, pricing: { office_fee, government_fee: gov_fee, total } });
  }
);

// ─── POST /request/:id/release ─────────────────────────────
// Office voluntarily releases a request back to the marketplace.
// In the single-claim model this is the standard "I changed my mind" exit:
// • from 'claimed' (review phase, no payment yet) — clean release, no penalty
// • from 'awaiting_payment' (payment link sent, citizen hasn't paid) — same
// • from 'in_progress' (citizen already paid) — refund-required path; this
//   route still releases but flags the request as needing manual refund. We
//   don't wipe paid_at so a finance review can reconcile.
officerRouter.post('/request/:id/release',
  requireOfficer({ roles: ['owner', 'manager'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const { rows: cur } = await db.execute({
      sql: `SELECT status, office_id, paid_at FROM request WHERE id=?`, args: [id]
    });
    if (!cur[0]) return res.status(404).json({ error: 'not_found' });
    if (cur[0].office_id !== req.office.id) return res.status(403).json({ error: 'not_your_request' });
    const releasable = ['claimed','awaiting_payment','in_progress','needs_more_info','on_hold'];
    if (!releasable.includes(cur[0].status)) return res.status(409).json({ error: 'bad_state', status: cur[0].status });

    // Wipe office assignment + payment fields. Keep paid_at if money already
    // moved — a follow-up refund flow handles reimbursement. Also clear the
    // legacy offer columns and re-open any accepted offer to 'pending' so
    // legacy data stays sane.
    const wipePay = !cur[0].paid_at;
    await db.execute({
      sql: `UPDATE request
               SET status='ready', officer_id=NULL, office_id=NULL,
                   accepted_offer_id=NULL, quoted_fee_omr=NULL,
                   office_fee_omr=NULL, government_fee_omr=NULL,
                   claimed_at=NULL, claim_review_started_at=NULL,
                   ${wipePay ? "payment_status='none', payment_link=NULL, payment_ref=NULL, payment_amount_omr=NULL," : ""}
                   released_count = COALESCE(released_count,0) + 1,
                   last_event_at=datetime('now')
             WHERE id=?`,
      args: [id]
    });
    await db.execute({
      sql: `UPDATE request_offer SET status='pending', updated_at=datetime('now')
             WHERE request_id=? AND status='accepted'`,
      args: [id]
    });
    await db.execute({
      sql: `UPDATE office SET offers_abandoned=COALESCE(offers_abandoned,0)+1 WHERE id=?`,
      args: [req.office.id]
    });
    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'request_release', 'request', ?, ?)`,
      args: [req.officer.officer_id, id, JSON.stringify({ from_status: cur[0].status, paid_at: cur[0].paid_at })]
    });
    res.json({ ok: true, refund_required: !wipePay });
  }
);

// ─── POST /request/:id/claim ───────────────────────────────
// Atomic single-office claim. WHERE office_id IS NULL AND status='ready'
// guarantees only ONE office can lock a given request — concurrent claim
// races resolve cleanly: the first UPDATE that flips office_id wins, the
// rest get rowsAffected=0 and return 409.
//
// Office fee + government fee are PRE-DEFINED (no bidding):
//   • office_fee = office_service_price.office_fee_omr (per-service override)
//                  → office.default_office_fee_omr (office-wide default)
//                  → 5.0 OMR (system default)
//   • government_fee = office_service_price.government_fee_omr (per-service)
//                       → service_catalog.fee_omr (catalogue default)
//
// Status flow: ready → claimed (review docs, decide). Citizen is notified.
// To begin work, the office calls /payment/start which transitions to
// 'awaiting_payment'.
officerRouter.post('/request/:id/claim',
  requireOfficer({ roles: ['owner', 'manager', 'officer'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const office_id = req.office.id;
    const officer_id = req.officer.officer_id;

    // Resolve the predefined pricing in one read so we have it for the audit
    // entry and the citizen-facing notification. Also pull paid_at: if a
    // previous office had this request and the SLA timer auto-transferred
    // it, paid_at is still set — we'll land the new office directly in
    // 'in_progress' (skip the payment-link step; the citizen already paid).
    const { rows: priceRows } = await db.execute({
      sql: `SELECT r.session_id, r.service_id, r.status, r.office_id,
                   r.paid_at, r.payment_amount_omr, r.payment_ref,
                   c.phone AS citizen_phone, c.language_pref,
                   s.fee_omr AS catalog_gov_fee, s.name_en AS service_name, s.name_ar AS service_name_ar,
                   COALESCE(osp.office_fee_omr, off.default_office_fee_omr, 5.0) AS office_fee,
                   COALESCE(osp.government_fee_omr, s.fee_omr, 0) AS gov_fee
              FROM request r
              LEFT JOIN service_catalog s ON s.id = r.service_id
              LEFT JOIN office off        ON off.id = ?
              LEFT JOIN office_service_price osp
                     ON osp.office_id = ? AND osp.service_id = r.service_id
              LEFT JOIN citizen c         ON c.id = r.citizen_id
             WHERE r.id = ?`,
      args: [office_id, office_id, id]
    });
    const r = priceRows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.status !== 'ready') {
      return res.status(409).json({
        error: r.office_id ? 'already_claimed' : 'bad_state',
        status: r.status
      });
    }

    const office_fee = Number(r.office_fee) || 0;
    const gov_fee    = Number(r.gov_fee) || 0;
    const total      = office_fee + gov_fee;
    const isTransfer = !!r.paid_at;  // payment already received — transfer claim

    // ATOMIC: only the first concurrent caller wins. WHERE office_id IS NULL
    // is the lock. On a transfer claim (paid_at preserved) we skip straight
    // to status='in_progress' so the new office sees the Complete button,
    // not the Send-payment-link button.
    const newStatus = isTransfer ? 'in_progress' : 'claimed';
    const upd = await db.execute({
      sql: `UPDATE request
               SET status=?, office_id=?, officer_id=?,
                   office_fee_omr=?, government_fee_omr=?, quoted_fee_omr=?,
                   claimed_at=datetime('now'),
                   claim_review_started_at=datetime('now'),
                   last_event_at=datetime('now')
             WHERE id=? AND status='ready' AND office_id IS NULL`,
      args: [newStatus, office_id, officer_id, office_fee, gov_fee, total, id]
    });
    if (!upd.rowsAffected) {
      // Lost the race — re-read to give the loser a precise reason.
      const { rows: rd } = await db.execute({
        sql: `SELECT status, office_id FROM request WHERE id=?`, args: [id]
      });
      return res.status(409).json({ error: 'already_claimed', status: rd[0]?.status, office_id: rd[0]?.office_id });
    }

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, ?, 'request', ?, ?)`,
      args: [
        officer_id,
        isTransfer ? 'request_claim_transfer' : 'request_claim',
        id,
        JSON.stringify({ office_fee, gov_fee, total, transfer: isTransfer })
      ]
    });

    // Notify the citizen. Two messages depending on whether this is a fresh
    // claim or a transfer-claim of an already-paid request:
    //   • fresh:    "an office picked up your request, payment link coming"
    //   • transfer: "another office took over (no re-payment); they're working on it now"
    const lang = (r.language_pref || 'ar') === 'en' ? 'en' : 'ar';
    const sname = (lang === 'ar' && r.service_name_ar) ? r.service_name_ar : (r.service_name || '');
    const claimMsg = isTransfer
      ? (lang === 'ar'
          ? `🤝 مكتب سند جديد استلم طلبك "${sname}" وبدأ المعالجة فوراً (الدفع قائم — لن تدفع مجدداً).`
          : `🤝 A new Sanad office took over your "${sname}" request and started working immediately (payment is preserved — you won't be charged again).`)
      : (lang === 'ar'
          ? `📥 تم استلام طلبك "${sname}" من قِبَل أحد مكاتب سند المرخّصة. يراجع الموظف مستنداتك الآن وسيرسل لك رابط الدفع قريباً.`
          : `📥 Your request "${sname}" was picked up by a licensed Sanad office. The officer is reviewing your documents and will send you a payment link shortly.`);
    await storeMessage({
      session_id: r.session_id, request_id: id,
      direction: 'out', actor_type: 'bot',
      body_text: claimMsg
    });
    if (isWhatsAppSession(r.session_id)) {
      const phone = r.citizen_phone || r.session_id.replace(/^wa:/, '');
      sendWhatsAppText(phone, claimMsg).catch(() => {});
    }

    res.json({
      ok: true,
      request_id: id,
      status: newStatus,
      transfer: isTransfer,
      pricing: { office_fee, government_fee: gov_fee, total }
    });
  }
);

// ─── POST /request/:id/payment/start ──────────────────────
// After review, the office triggers payment. We:
//   1. Generate an Amwal payment link (or a stub link in dev)
//   2. Flip status='awaiting_payment', payment_status='awaiting',
//      payment_link, payment_amount_omr, payment_ref
//   3. Send the citizen a WhatsApp template + relayed bot message with the link
//
// Idempotent: re-calling on the same request returns the existing link.
officerRouter.post('/request/:id/payment/start',
  requireOfficer({ roles: ['owner', 'manager', 'officer'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const office_id = req.office.id;
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.status, r.office_id, r.session_id, r.payment_status,
                   r.payment_link, r.payment_amount_omr, r.payment_ref,
                   r.office_fee_omr, r.government_fee_omr,
                   c.phone AS citizen_phone, c.email AS citizen_email, c.language_pref,
                   s.name_en AS service_name, s.name_ar AS service_name_ar
              FROM request r
              LEFT JOIN citizen c        ON c.id = r.citizen_id
              LEFT JOIN service_catalog s ON s.id = r.service_id
             WHERE r.id = ?`,
      args: [id]
    });
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.office_id !== office_id) return res.status(403).json({ error: 'not_your_request' });
    // 'needs_more_info' is a valid pre-payment state too — once the citizen
    // responds, the office can move forward to payment without first having
    // to re-claim. The response below also flips status='awaiting_payment'.
    if (!['claimed','awaiting_payment','needs_more_info'].includes(r.status))
      return res.status(409).json({ error: 'bad_state', status: r.status });
    if (r.payment_status === 'paid')
      return res.status(409).json({ error: 'already_paid' });

    // Idempotent: reuse the existing link if we already minted one for this
    // request and it hasn't been paid yet.
    if (r.payment_status === 'awaiting' && r.payment_link) {
      return res.json({
        ok: true, reused: true,
        payment_link: r.payment_link,
        amount_omr: r.payment_amount_omr,
        merchant_ref: r.payment_ref
      });
    }

    const total = Number(r.payment_amount_omr) || (Number(r.office_fee_omr) || 0) + (Number(r.government_fee_omr) || 0);
    if (!(total > 0)) return res.status(400).json({ error: 'bad_amount' });

    const merchantRef = newMerchantRef(`req${id}`);
    const link = await createPaymentLink({
      amountOmr: total,
      merchantReference: merchantRef,
      customerEmail: r.citizen_email || `citizen-${id}@saned.local`,
      description: `Saned · ${r.service_name || r.service_name_ar || 'Sanad request'} (req #${id})`
    });

    await db.execute({
      sql: `UPDATE request
               SET status='awaiting_payment',
                   payment_status='awaiting',
                   payment_link=?,
                   payment_ref=?,
                   payment_amount_omr=?,
                   last_event_at=datetime('now')
             WHERE id=?`,
      args: [link.url, merchantRef, total, id]
    });
    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'payment_start', 'request', ?, ?)`,
      args: [req.officer.officer_id, id, JSON.stringify({ amount_omr: total, merchant_ref: merchantRef, stubbed: !AMWAL_ENABLED })]
    });

    // Notify the citizen (web + WhatsApp). Same bot voice — preserves the
    // single-thread illusion until payment unlocks the office.
    const lang = (r.language_pref || 'ar') === 'en' ? 'en' : 'ar';
    const sname = (lang === 'ar' && r.service_name_ar) ? r.service_name_ar : (r.service_name || '');
    const payMsg = lang === 'ar'
      ? `💳 طلبك "${sname}" جاهز للبدء.\nالمبلغ الإجمالي: ${total.toFixed(3)} OMR\nادفع الآن من هذا الرابط لنبدأ التنفيذ:\n${link.url}`
      : `💳 Your request "${sname}" is ready to start.\nTotal: ${total.toFixed(3)} OMR\nPay here to begin:\n${link.url}`;
    await storeMessage({
      session_id: r.session_id, request_id: id,
      direction: 'out', actor_type: 'bot',
      body_text: payMsg,
      meta: { payment_link: link.url, amount_omr: total }
    });
    if (isWhatsAppSession(r.session_id)) {
      const phone = r.citizen_phone || r.session_id.replace(/^wa:/, '');
      sendWhatsAppText(phone, payMsg).catch(() => {});
    }

    res.json({
      ok: true,
      reused: false,
      payment_link: link.url,
      amount_omr: total,
      merchant_ref: merchantRef,
      stubbed: !AMWAL_ENABLED
    });
  }
);

// ─── POST /request/:id/flag ────────────────────────────────
// Office reports that a request in the marketplace is junk: wrong service,
// fake/forged docs, abusive content, or a duplicate. The first flag only
// hides the request from THIS office's marketplace. Once distinct offices
// flag it >= FLAG_AUTO_REMOVE_THRESHOLD (default 2) the request is
// auto-quarantined (status='flagged'); the citizen is notified to fix or
// switch services, and the request stops appearing for any office.
//
// Body: { reason: 'wrong_service'|'fake_docs'|'abusive'|'duplicate'|'other', note? }
const FLAG_AUTO_REMOVE_THRESHOLD = Number(process.env.SANAD_FLAG_THRESHOLD || 2);
const VALID_FLAG_REASONS = new Set(['wrong_service','fake_docs','abusive','duplicate','other']);

officerRouter.post('/request/:id/flag',
  requireOfficer({ roles: ['owner','manager','officer'] }),
  async (req, res) => {
    const id = Number(req.params.id);
    const office_id = req.office.id;
    const reason = String(req.body?.reason || '').trim().toLowerCase();
    const note   = String(req.body?.note || '').trim().slice(0, 400) || null;
    if (!VALID_FLAG_REASONS.has(reason)) {
      return res.status(400).json({ error: 'bad_reason', allowed: [...VALID_FLAG_REASONS] });
    }

    const { rows } = await db.execute({
      sql: `SELECT id, status, session_id, citizen_id FROM request WHERE id=?`,
      args: [id]
    });
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    // Only flag while in the open marketplace — once claimed, use release/reclassify instead.
    if (r.status !== 'ready') {
      return res.status(409).json({ error: 'bad_state', status: r.status });
    }

    try {
      await db.execute({
        sql: `INSERT INTO request_flag (request_id, office_id, officer_id, reason, note)
              VALUES (?,?,?,?,?)`,
        args: [id, office_id, req.officer.officer_id, reason, note]
      });
    } catch (e) {
      // UNIQUE(request_id, office_id) — already flagged by this office.
      return res.status(409).json({ error: 'already_flagged' });
    }

    // Count distinct offices that flagged this request.
    const { rows: cntRows } = await db.execute({
      sql: `SELECT COUNT(DISTINCT office_id) AS n FROM request_flag WHERE request_id=?`,
      args: [id]
    });
    const flagCount = cntRows[0]?.n || 0;

    let removed = false;
    if (flagCount >= FLAG_AUTO_REMOVE_THRESHOLD) {
      // Atomically pull the request out of the marketplace.
      const upd = await db.execute({
        sql: `UPDATE request
                 SET status='flagged', last_event_at=datetime('now')
               WHERE id=? AND status='ready'`,
        args: [id]
      });
      if (upd.rowsAffected) {
        removed = true;
        await db.execute({
          sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
                VALUES ('system', NULL, 'request_auto_quarantined', 'request', ?, ?)`,
          args: [id, JSON.stringify({ flag_count: flagCount, threshold: FLAG_AUTO_REMOVE_THRESHOLD })]
        });
        // Notify the citizen so they understand and can fix.
        await storeMessage({
          session_id: r.session_id, request_id: id,
          direction: 'out', actor_type: 'bot',
          body_text: '⚠️ تمت مراجعة طلبك من قبل أكثر من مكتب وتم الإبلاغ عن وجود مشكلة (خدمة خاطئة أو مستندات غير مكتملة). الطلب تم إيقافه مؤقتاً. اكتب "تعديل" لتغيير الخدمة أو إرسال مستندات صحيحة، أو "إلغاء" للإلغاء.'
        });
      }
    }

    await db.execute({
      sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
            VALUES ('officer', ?, 'request_flag', 'request', ?, ?)`,
      args: [req.officer.officer_id, id, JSON.stringify({ reason, note, flag_count: flagCount })]
    });

    res.json({
      ok: true,
      flag_count: flagCount,
      threshold: FLAG_AUTO_REMOVE_THRESHOLD,
      removed
    });
  }
);
