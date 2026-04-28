// ────────────────────────────────────────────────────────────
// WhatsApp Cloud API outbound — single source of truth for sending
// messages from Sanad to a citizen's phone.
//
// Used by:
//   • routes/whatsapp.js — bot replies (citizen→bot turn round-trip)
//   • routes/officer.js — Sanad office officer typing in the dashboard
//
// Behaviour:
//   • If WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set, POST to
//     graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages and return
//     { ok, message_id, channel: 'whatsapp' }.
//   • If either is missing (dev / web-only mode), no network call — log
//     and return { ok: true, channel: 'stub' } so callers can keep flowing.
//   • On API error, return { ok: false, error } and DO NOT throw — callers
//     decide whether to surface the error.
// ────────────────────────────────────────────────────────────

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

export const WHATSAPP_ENABLED = !!(ACCESS_TOKEN && PHONE_NUMBER_ID);

// Strip any leading '+' or whitespace; Meta's API accepts E.164 without '+'.
// Also tolerate session ids like "wa:+96890xxxx" by stripping the prefix.
function normalisePhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (s.startsWith('wa:')) s = s.slice(3);
  return s.replace(/[\s+]/g, '');
}

/**
 * Send a plain-text WhatsApp message to a citizen.
 * @param {string} toPhone — E.164 phone (with or without leading '+'), or
 *                           a "wa:+968…" session id.
 * @param {string} text — message body (Meta's free-form text limit is ~4096
 *                        chars; we truncate at 4000 for safety).
 * @returns {Promise<{ok:boolean, channel:'whatsapp'|'stub', message_id?:string, error?:string}>}
 */
export async function sendWhatsAppText(toPhone, text) {
  const to = normalisePhone(toPhone);
  if (!to) return { ok: false, error: 'no_phone', channel: 'whatsapp' };
  const body = String(text || '').slice(0, 4000);
  if (!body) return { ok: false, error: 'empty_text', channel: 'whatsapp' };

  if (!WHATSAPP_ENABLED) {
    console.log(`[wa:stub] would send to ${to}: ${body.slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
    return { ok: true, channel: 'stub' };
  }

  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body, preview_url: false }
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = `wa-send ${r.status}: ${txt.slice(0, 200)}`;
      console.warn('[wa:send]', err);
      return { ok: false, error: err, channel: 'whatsapp' };
    }
    const data = await r.json();
    const message_id = data?.messages?.[0]?.id;
    return { ok: true, channel: 'whatsapp', message_id };
  } catch (e) {
    console.warn('[wa:send] threw:', e.message);
    return { ok: false, error: e.message, channel: 'whatsapp' };
  }
}

// ────────────────────────────────────────────────────────────
// Test helper: detect whether a given session id was opened from WhatsApp.
// All WhatsApp sessions use "wa:<phone>" as their session_id (see
// routes/whatsapp.js); web sessions use a random uuid-ish string.
export function isWhatsAppSession(session_id) {
  return typeof session_id === 'string' && session_id.startsWith('wa:');
}
