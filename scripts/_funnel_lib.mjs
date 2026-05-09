// Shared helpers for the WhatsApp/chat observability scripts:
//   scripts/dump_session.mjs       (microscope: one session)
//   scripts/funnel.mjs             (dashboard: aggregate funnel)
//   scripts/bucket_dropoffs.mjs    (work queue: per-stage drop-offs)
//
// Why a shared module: each script needs the same "what stage did this
// session reach?" classifier. Keeping it in one place avoids drift.
//
// Stage definitions (ordinal, monotonically increasing):
//
//   0 greeted    — at least one inbound citizen message in window
//   1 discovered — search happened OR session state has service_code OR ≥2 inbound msgs
//   2 confirming — state.status reached 'confirming' OR a request row exists
//   3 collecting — request row exists; or state.status was 'collecting'
//   4 reviewing  — state.status was 'reviewing' OR all required docs uploaded
//   5 queued     — request.status in (ready, claimed, in_progress, completed, …)
//                  meaning the citizen actually SUBMITTED
//   6 offered    — at least one request_offer row exists
//   7 claimed    — request.status in (claimed, in_progress, completed)
//   8 completed  — request.status = 'completed'
//
// We approximate stages from (a) current session.state_json (which can
// regress on cancel — we trust it as a *floor*, not a ceiling), and
// (b) request rows (the strongest historical signal — a request row
// exists ⇒ the citizen at least confirmed). The MAX of both wins.

import { db } from '../lib/db.js';

export const STAGES = [
  'greeted', 'discovered', 'confirming', 'collecting',
  'reviewing', 'queued', 'offered', 'claimed', 'completed'
];

export const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s, i]));

// Map a request.status string to the highest stage it implies.
function stageFromRequestStatus(status) {
  if (!status) return STAGE_INDEX.confirming;
  const s = String(status).toLowerCase();
  if (s === 'completed') return STAGE_INDEX.completed;
  if (s === 'claimed' || s === 'in_progress' || s === 'needs_more_info') return STAGE_INDEX.claimed;
  if (s === 'ready' || s === 'awaiting_payment' || s === 'paid') return STAGE_INDEX.queued;
  if (s === 'reviewing') return STAGE_INDEX.reviewing;
  if (s === 'collecting' || s === 'draft') return STAGE_INDEX.collecting;
  if (s === 'cancelled' || s === 'cancelled_by_citizen' || s === 'cancelled_by_office') {
    // Cancelled — leave at confirming so it shows up as a drop-off.
    return STAGE_INDEX.confirming;
  }
  return STAGE_INDEX.confirming;
}

// Map a session.state_json.status to a stage (used as a FLOOR — current
// state can regress to idle on cancel/new-service).
function stageFromSessionStatus(status) {
  if (!status) return STAGE_INDEX.greeted;
  const s = String(status).toLowerCase();
  if (s === 'completed') return STAGE_INDEX.completed;
  if (s === 'claimed' || s === 'in_progress') return STAGE_INDEX.claimed;
  if (s === 'queued' || s === 'awaiting_payment') return STAGE_INDEX.queued;
  if (s === 'reviewing') return STAGE_INDEX.reviewing;
  if (s === 'collecting') return STAGE_INDEX.collecting;
  if (s === 'confirming') return STAGE_INDEX.confirming;
  return STAGE_INDEX.greeted;
}

// Compute the furthest stage one session reached.
// Inputs: session.state_json (may be null), array of request rows for the session,
//         array of request_offer rows for the session, and inbound message count.
export function classifySession({ stateJson, requests = [], offers = [], inboundCount = 0 }) {
  let max = STAGE_INDEX.greeted;
  if (inboundCount === 0) max = -1; // no traffic at all in window

  // Floor from current session state.
  let parsed = null;
  if (stateJson) {
    try { parsed = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson; } catch {}
  }
  if (parsed) {
    if (parsed.service_code) max = Math.max(max, STAGE_INDEX.discovered);
    max = Math.max(max, stageFromSessionStatus(parsed.status));
  }

  // Strongest historical signal: a request row exists.
  if (requests && requests.length) {
    max = Math.max(max, STAGE_INDEX.confirming);
    for (const r of requests) {
      max = Math.max(max, stageFromRequestStatus(r.status));
    }
  }
  if (offers && offers.length) {
    max = Math.max(max, STAGE_INDEX.offered);
  }
  if (max < 0) return null;
  return STAGES[max];
}

// Pull all sessions touched in the last N days, with everything needed to classify.
// Returns: Map<session_id, { session_id, channel, first_at, last_at,
//                            inboundCount, outboundCount, state_json,
//                            requests: [...], offers: [...] }>
export async function loadSessionsForWindow({ days = 7 } = {}) {
  const cutoff = `datetime('now', '-${Number(days)} days')`;

  // 1. Sessions with any message in window.
  const msgRows = await db.execute(`
    SELECT session_id,
           SUM(CASE WHEN direction='in'  AND actor_type='citizen' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction='out' AND actor_type IN ('bot','officer','system') THEN 1 ELSE 0 END) AS outbound,
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at
      FROM message
     WHERE session_id IS NOT NULL
       AND created_at >= ${cutoff}
     GROUP BY session_id
  `);

  const sessions = new Map();
  for (const r of msgRows.rows) {
    const sid = String(r.session_id);
    sessions.set(sid, {
      session_id: sid,
      channel: sid.startsWith('wa:') ? 'whatsapp' : 'web',
      first_at: r.first_at,
      last_at: r.last_at,
      inboundCount: Number(r.inbound) || 0,
      outboundCount: Number(r.outbound) || 0,
      state_json: null,
      requests: [],
      offers: []
    });
  }
  if (sessions.size === 0) return sessions;

  // 2. Pull current session.state_json for each.
  const ids = [...sessions.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const sessRows = await db.execute({
    sql: `SELECT id, state_json FROM session WHERE id IN (${placeholders})`,
    args: ids
  });
  for (const r of sessRows.rows) {
    const s = sessions.get(String(r.id));
    if (s) s.state_json = r.state_json;
  }

  // 3. Pull request rows.
  const reqRows = await db.execute({
    sql: `SELECT id, session_id, service_id, status, created_at, last_event_at
            FROM request WHERE session_id IN (${placeholders})`,
    args: ids
  });
  const reqIds = [];
  for (const r of reqRows.rows) {
    const s = sessions.get(String(r.session_id));
    if (s) s.requests.push(r);
    reqIds.push(r.id);
  }

  // 4. Pull offers (joined back to sessions via request).
  if (reqIds.length) {
    const rp = reqIds.map(() => '?').join(',');
    const offerRows = await db.execute({
      sql: `SELECT request_id, office_id, status FROM request_offer WHERE request_id IN (${rp})`,
      args: reqIds
    });
    const reqToSession = new Map(reqRows.rows.map(r => [r.id, String(r.session_id)]));
    for (const o of offerRows.rows) {
      const sid = reqToSession.get(o.request_id);
      const s = sid && sessions.get(sid);
      if (s) s.offers.push(o);
    }
  }
  return sessions;
}

// Fetch a single session bundle (no time window — useful for dump_session.mjs).
export async function loadOneSession(session_id) {
  const sessRows = await db.execute({
    sql: `SELECT id, state_json, updated_at FROM session WHERE id = ?`,
    args: [session_id]
  });
  const reqRows = await db.execute({
    sql: `SELECT id, status, service_id, created_at, last_event_at, completed_at, claimed_at
            FROM request WHERE session_id = ? ORDER BY id ASC`,
    args: [session_id]
  });
  let offers = [];
  if (reqRows.rows.length) {
    const rp = reqRows.rows.map(() => '?').join(',');
    const offerRows = await db.execute({
      sql: `SELECT id, request_id, office_id, status, quoted_fee_omr, created_at
              FROM request_offer WHERE request_id IN (${rp})
             ORDER BY id ASC`,
      args: reqRows.rows.map(r => r.id)
    });
    offers = offerRows.rows;
  }
  return {
    session: sessRows.rows[0] || null,
    requests: reqRows.rows,
    offers
  };
}

// Resolve a user-supplied identifier to candidate session_ids.
// Accepts: a full session_id (e.g. "wa:+96812345678"), a phone number
// with or without "+"/"968" prefix, or a numeric phone-only fragment.
// Returns ordered candidate list (most-likely-first).
export async function resolveSessionId(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  if (raw.includes(':')) return [raw];

  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return [];

  // Build phone variants: +968…, 968…, bare last-8.
  const tail = digits.replace(/^968/, '');
  const variants = new Set([
    `+${digits}`,
    `+968${tail}`,
    `968${tail}`,
    tail
  ]);
  const candidates = [...variants].map(v => `wa:${v}`);

  // Also peek at the citizen table for any sessions we don't know about.
  try {
    const cit = await db.execute({
      sql: `SELECT phone FROM citizen WHERE phone IN (${[...variants].map(() => '?').join(',')})`,
      args: [...variants]
    });
    for (const r of cit.rows) candidates.push(`wa:${r.phone}`);
  } catch {}

  // Filter to ones that actually exist in message or session.
  const ph = candidates.map(() => '?').join(',');
  const hits = await db.execute({
    sql: `SELECT DISTINCT session_id
            FROM message WHERE session_id IN (${ph})
           UNION
          SELECT id AS session_id
            FROM session WHERE id IN (${ph})`,
    args: [...candidates, ...candidates]
  });
  return hits.rows.map(r => String(r.session_id));
}

export function maskPhone(s) {
  if (!s) return s;
  const m = String(s).match(/^(wa:)?(\+?\d{4,})(\d{4})$/);
  if (!m) return s;
  return `${m[1] || ''}${m[2].replace(/\d/g, '*')}${m[3]}`;
}
