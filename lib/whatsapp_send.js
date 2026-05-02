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
// Send a pre-approved WhatsApp template message. Used for messages outside
// the 24h customer-care window (e.g. FIRST contact for OTP / payment prompt).
//
// Meta requires templates to be pre-approved on the Business Manager and
// referenced by name + language code. Body parameters substitute {{1}}, {{2}}…
// in declaration order.
//
// Common templates in this project (must be approved on Meta side):
//   • sanad_otp        — body: "Your Sanad code is {{1}}. Expires in {{2}} min."
//   • sanad_payment    — body: "{{1}}, your request is ready. Pay {{2}} OMR: {{3}}"
//
// In dev (no creds) we log the rendered template + params and return stub:true
// so callers proceed. The OTP flow surfaces a debug-mode hint with the code.
//
// @param {string} toPhone — E.164 (with or without '+').
// @param {string} name — template name as registered on Meta.
// @param {string} langCode — e.g. 'en', 'ar', 'en_US'. Defaults to 'en'.
// @param {Array<string>} bodyParams — positional substitutions for {{1}}…{{N}}.
// @returns {Promise<{ok:boolean, channel:string, message_id?:string, error?:string, stub?:boolean, rendered?:string}>}
export async function sendWhatsAppTemplate(toPhone, name, langCode = 'en', bodyParams = []) {
  const to = normalisePhone(toPhone);
  if (!to)   return { ok: false, error: 'no_phone',     channel: 'whatsapp' };
  if (!name) return { ok: false, error: 'no_template',  channel: 'whatsapp' };

  const components = bodyParams.length ? [{
    type: 'body',
    parameters: bodyParams.map(p => ({ type: 'text', text: String(p) }))
  }] : [];

  if (!WHATSAPP_ENABLED) {
    const rendered = `[wa:stub:template] ${name} (${langCode}) → ${to}` +
                     (bodyParams.length ? ` :: ${bodyParams.join(' | ')}` : '');
    console.log(rendered);
    return { ok: true, channel: 'stub', stub: true, rendered, params: bodyParams };
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
        type: 'template',
        template: {
          name,
          language: { code: langCode },
          components
        }
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = `wa-template ${r.status}: ${txt.slice(0, 240)}`;
      console.warn('[wa:template]', err);
      return { ok: false, error: err, channel: 'whatsapp' };
    }
    const data = await r.json();
    return { ok: true, channel: 'whatsapp', message_id: data?.messages?.[0]?.id };
  } catch (e) {
    console.warn('[wa:template] threw:', e.message);
    return { ok: false, error: e.message, channel: 'whatsapp' };
  }
}

// ────────────────────────────────────────────────────────────
// Send an interactive QUICK-REPLY button message. Up to 3 buttons.
// Each button has { id, title } — the id comes back in the next webhook
// as interactive.button_reply.id, the title is what the citizen sees.
//
// In dev (no creds) we log the structure and return stub:true so the
// caller's flow keeps moving. The caller may also send a plain-text
// fallback so the message is still readable in stub mode.
//
// @param {string} toPhone — E.164 phone (with or without '+').
// @param {string} body — message body (≤ 1024 chars per Meta spec; we
//                        trim at 1000 for safety).
// @param {Array<{id:string,title:string}>} buttons — up to 3.
// @returns {Promise<{ok, channel, message_id?, error?, stub?:boolean}>}
export async function sendWhatsAppButtons(toPhone, body, buttons = []) {
  const to = normalisePhone(toPhone);
  if (!to) return { ok: false, error: 'no_phone', channel: 'whatsapp' };
  const msg = String(body || '').slice(0, 1000);
  if (!msg) return { ok: false, error: 'empty_body', channel: 'whatsapp' };
  // Meta caps button title at 20 chars + max 3 buttons.
  const btns = (buttons || []).slice(0, 3).map(b => ({
    type: 'reply',
    reply: { id: String(b.id || '').slice(0, 256), title: String(b.title || '').slice(0, 20) }
  })).filter(b => b.reply.id && b.reply.title);
  if (!btns.length) return { ok: false, error: 'no_buttons', channel: 'whatsapp' };

  if (!WHATSAPP_ENABLED) {
    console.log(`[wa:stub:btns] to=${to} body="${msg.slice(0,60).replace(/\n/g,' ⏎ ')}" btns=${btns.map(b => b.reply.title).join(' | ')}`);
    return { ok: true, channel: 'stub', stub: true };
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg },
          action: { buttons: btns }
        }
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      console.warn('[wa:btns]', `${r.status}: ${txt.slice(0, 200)}`);
      return { ok: false, error: `wa-btns ${r.status}: ${txt.slice(0, 200)}`, channel: 'whatsapp' };
    }
    const data = await r.json();
    return { ok: true, channel: 'whatsapp', message_id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message, channel: 'whatsapp' };
  }
}

// ────────────────────────────────────────────────────────────
// Send a CTA URL button — single button that opens a URL when tapped.
// Used for payment links so the citizen taps a button labelled "ادفع
// الآن" instead of long-pressing a raw URL. Same auth + stub semantics
// as sendWhatsAppButtons.
//
// @param {string} toPhone — E.164.
// @param {string} body — message body.
// @param {string} buttonTitle — ≤ 20 chars (e.g. "💳 ادفع الآن").
// @param {string} url — must be https.
export async function sendWhatsAppCTAUrl(toPhone, body, buttonTitle, url) {
  const to = normalisePhone(toPhone);
  if (!to) return { ok: false, error: 'no_phone', channel: 'whatsapp' };
  const msg = String(body || '').slice(0, 1000);
  const title = String(buttonTitle || '').slice(0, 20);
  if (!msg || !title || !/^https:\/\//.test(url || '')) {
    return { ok: false, error: 'bad_args', channel: 'whatsapp' };
  }
  if (!WHATSAPP_ENABLED) {
    console.log(`[wa:stub:cta] to=${to} body="${msg.slice(0,60).replace(/\n/g,' ⏎ ')}" cta="${title}" url=${url}`);
    return { ok: true, channel: 'stub', stub: true };
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: msg },
          action: {
            name: 'cta_url',
            parameters: { display_text: title, url }
          }
        }
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      console.warn('[wa:cta]', `${r.status}: ${txt.slice(0, 200)}`);
      // Soft-fall back to a plain-text message with the URL inline so the
      // citizen still sees the link even if the button payload was rejected
      // (template-window edge cases, account not verified for cta_url, etc.).
      const fallback = await sendWhatsAppText(to, `${msg}\n\n${title}: ${url}`);
      return { ok: fallback.ok, channel: 'whatsapp', fallback_used: true, error: `wa-cta ${r.status}: ${txt.slice(0,160)}` };
    }
    const data = await r.json();
    return { ok: true, channel: 'whatsapp', message_id: data?.messages?.[0]?.id };
  } catch (e) {
    // Same plain-text fallback on network errors.
    const fallback = await sendWhatsAppText(to, `${msg}\n\n${title}: ${url}`);
    return { ok: fallback.ok, channel: 'whatsapp', fallback_used: true, error: e.message };
  }
}

// ────────────────────────────────────────────────────────────
// Test helper: detect whether a given session id was opened from WhatsApp.
// All WhatsApp sessions use "wa:<phone>" as their session_id (see
// routes/whatsapp.js); web sessions use a random uuid-ish string.
export function isWhatsAppSession(session_id) {
  return typeof session_id === 'string' && session_id.startsWith('wa:');
}
