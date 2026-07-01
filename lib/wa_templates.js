// ────────────────────────────────────────────────────────────
// WhatsApp 24-hour customer-care window handling — "knock & flush".
//
// Meta only allows FREE-FORM messages (text / media / buttons) within 24h of
// the citizen's last inbound message. Outside that window we cannot push a
// document or an arbitrary update. Instead we:
//   1. QUEUE the real content in `pending_wa`,
//   2. send an approved TEMPLATE that asks the citizen to reply, and
//   3. FLUSH the queue the moment they reply (the webhook re-opens the window).
//
// The in-app thread / «طلباتي» dashboard is written regardless — this module
// only governs the WhatsApp channel.
// ────────────────────────────────────────────────────────────
import { db } from './db.js';
import { sendWhatsAppText, sendWhatsAppDocument, sendWhatsAppTemplate } from './whatsapp_send.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Approved template registry. Names are env-overridable so prod can point at
// the EXACT names approved in Meta WhatsApp Manager without a code change.
// Each template takes ONE body param: {{1}} = the request/service label.
export const WA_TEMPLATES = {
  update:    { name: process.env.WA_TPL_UPDATE    || 'sanad_update',            lang: process.env.WA_TPL_LANG || 'ar' },
  document:  { name: process.env.WA_TPL_DOCUMENT  || 'sanad_document_ready',    lang: process.env.WA_TPL_LANG || 'ar' },
  completed: { name: process.env.WA_TPL_COMPLETED || 'sanad_request_completed', lang: process.env.WA_TPL_LANG || 'ar' },
};

// Parse a SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) timestamp → epoch ms.
export function tsToMs(t) {
  if (!t) return 0;
  const s = String(t);
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  const ms = Date.parse(s.replace(' ', 'T') + (hasTz ? '' : 'Z'));
  return Number.isFinite(ms) ? ms : 0;
}

// The window is OPEN when the citizen sent an inbound message within 24h.
// `nowMs` is injectable for tests.
export async function isWindowOpen(session_id, nowMs = Date.now()) {
  if (!session_id) return false;
  const { rows } = await db.execute({
    sql: `SELECT MAX(created_at) AS t FROM message WHERE session_id=? AND direction='in'`,
    args: [session_id]
  });
  const last = tsToMs(rows[0]?.t);
  return last > 0 && (nowMs - last) < DAY_MS;
}

// Queue a real message (text and/or a media file) for later delivery.
export async function enqueuePendingWa(session_id, phone, { body = null, media = null } = {}) {
  if (!session_id || (!body && !media?.link)) return;
  await db.execute({
    sql: `INSERT INTO pending_wa(session_id, phone, body, media_link, media_filename, media_mime, caption)
          VALUES (?,?,?,?,?,?,?)`,
    args: [session_id, phone || null, body, media?.link || null,
           media?.filename || null, media?.mime || null, media?.caption || null]
  });
}

// Deliver every not-yet-sent queued message for a session, oldest first.
// Called when the citizen replies (window re-opened). Best-effort per row.
export async function flushPendingWa(session_id, phone = null) {
  if (!session_id) return 0;
  const { rows } = await db.execute({
    sql: `SELECT * FROM pending_wa WHERE session_id=? AND sent_at IS NULL ORDER BY id ASC`,
    args: [session_id]
  });
  let n = 0;
  for (const p of rows) {
    const to = p.phone || phone || session_id;
    try {
      if (p.body) await sendWhatsAppText(to, p.body);
      if (p.media_link) {
        await sendWhatsAppDocument(to, p.media_link, {
          filename: p.media_filename || 'document', mime: p.media_mime || '', caption: p.caption || ''
        });
      }
    } catch (e) { console.warn('[flushPendingWa] send failed:', e?.message || e); }
    await db.execute({ sql: `UPDATE pending_wa SET sent_at=datetime('now') WHERE id=?`, args: [p.id] });
    n++;
  }
  return n;
}

// Send the "knock" template for a kind (document | completed | update).
// `param` fills {{1}}.
export async function sendKnockTemplate(phone, kind, param) {
  const tpl = WA_TEMPLATES[kind] || WA_TEMPLATES.update;
  return sendWhatsAppTemplate(phone, tpl.name, tpl.lang, [String(param || 'طلبك')]);
}
