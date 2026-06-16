// Shared helpers for officer-facing routes (routes/officer.js + features/payment-checkout/routes.js).
//
// Three patterns were copy-pasted 30+ times across the request lifecycle:
//
//   1. Load-and-check-ownership: SELECT request → 403 if office_id mismatch.
//      One missed copy = cross-tenant data leak. Centralised here.
//   2. Audit log insert: same 6-column shape, 36+ sites. Centralised so we
//      can later add structured logging / queue dispatch in one place.
//   3. Notify citizen: storeMessage + (isWhatsAppSession ? sendWhatsAppText)
//      with the WA send historically wrapped in `.catch(() => {})` — failures
//      were invisible. Centralised so silent swallows become a warning log.
//
// Side-effect ordering inside notifyCitizen() preserves the previous
// behaviour: in-app message thread is the source of truth, WA is best-effort.

import { db } from './db.js';
import { sendWhatsAppText, sendWhatsAppDocument, isWhatsAppSession } from './whatsapp_send.js';
import { storeMessage } from './agent.js';
import { canonicalPhone } from './phone.js';

/**
 * Load a request by id and assert it belongs to the given office. Returns
 * `{ ok, row, status, error }` so callers can early-return uniformly:
 *
 *   const { ok, row, status, error } = await loadOwnedRequest(req.office.id, id);
 *   if (!ok) return res.status(status).json({ error });
 *   // proceed with row
 *
 * Pass `extra` to extend the SELECT (and auto-join `citizen`) — useful when
 * the handler needs the citizen's phone/language_pref for a follow-up notify:
 *
 *   loadOwnedRequest(req.office.id, id, {
 *     extra: ', c.phone AS citizen_phone, c.language_pref'
 *   });
 */
export async function loadOwnedRequest(officeId, requestId, { extra = '' } = {}) {
  const baseCols = `r.id, r.session_id, r.office_id, r.officer_id, r.status,
                    r.paid_at, r.payment_status, r.fee_omr`;
  const join = extra ? 'LEFT JOIN citizen c ON c.id = r.citizen_id' : '';
  const { rows } = await db.execute({
    sql: `SELECT ${baseCols}${extra} FROM request r ${join} WHERE r.id = ?`,
    args: [requestId]
  });
  const row = rows[0];
  if (!row) return { ok: false, row: null, status: 404, error: 'not_found' };
  if (row.office_id !== officeId) {
    return { ok: false, row: null, status: 403, error: 'not_your_request' };
  }
  return { ok: true, row, status: 200, error: null };
}

/**
 * Single audit log insert. Replaces hand-rolled
 *   INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, diff_json)
 *   VALUES (?, ?, ?, ?, ?, ?)
 * sites scattered across routes/officer.js, features/payment-checkout/routes.js, lib/sla.js.
 *
 * `actor` is `{ type, id }` — e.g. `{ type: 'officer', id: 7 }` or `{ type: 'system', id: null }`.
 * `diff` is JSON-serialised here; pass the object directly.
 */
export async function audit({ actor, action, target, targetId, diff = null }) {
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type, actor_id, action, target_type, target_id, diff_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [actor.type, actor.id ?? null, action, target, targetId,
           diff ? JSON.stringify(diff) : null]
  });
}

/**
 * Notify the citizen: persist the outbound message, then push to WhatsApp
 * when the session lives there. WA delivery is best-effort — failures are
 * logged (was: silent `.catch(() => {})`) so we can spot outages.
 *
 *   await notifyCitizen({
 *     session_id: row.session_id,
 *     request_id: id,
 *     body: 'Your application has been claimed.',
 *     actor_type: 'office',  // or 'bot' / 'officer'
 *     citizen_phone: row.citizen_phone,
 *     meta: { officer_id: req.officer.officer_id }
 *   });
 */
// `media` (optional) pushes an actual file into the WhatsApp thread AFTER the
// text — used for office-issued documents. Shape: { link, filename, mime }
// where `link` is a public https URL Meta can fetch (our /uploads mount).
export async function notifyCitizen({
  session_id, request_id = null, body, actor_type = 'office',
  meta = null, citizen_phone = null, media = null
}) {
  await storeMessage({
    session_id,
    request_id,
    direction: 'out',
    actor_type,
    body_text: body,
    media_url: media?.link || null,
    meta
  });

  // Resolve a deliverable WhatsApp number. Two cases:
  //   • WhatsApp session  → the phone IS the session id (wa:<phone>).
  //   • Web session       → only deliverable once the citizen has verified a
  //     phone via OTP (citizen_phone). This is what lets a request *applied
  //     from the web app* still reach the citizen on WhatsApp (issue #1).
  // Either way delivery is best-effort: Meta's 24h customer-care window means
  // a free-form text only lands if the citizen messaged us recently; the
  // in-app thread above is always the source of truth.
  let phone = isWhatsAppSession(session_id)
    ? (citizen_phone || session_id.replace(/^wa:/, ''))
    : (citizen_phone || null);
  if (phone) {
    phone = canonicalPhone(phone) || phone;
    try {
      if (body) await sendWhatsAppText(phone, body);
      if (media?.link) {
        await sendWhatsAppDocument(phone, media.link, {
          filename: media.filename, mime: media.mime, caption: media.caption || ''
        });
      }
    } catch (e) {
      // Citizen is still notified via the in-app thread; log so the WA
      // outage is visible instead of silently swallowed.
      console.warn(`[notifyCitizen] WA send failed for ${session_id}:`, e?.message || e);
    }
  }
}
