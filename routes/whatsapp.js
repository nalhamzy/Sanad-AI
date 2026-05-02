// Meta WhatsApp Cloud API webhook.
// In debug mode we only log + accept — no real send. When you plug credentials
// in, the same `runTurn` is used so the agent behaviour is identical to web.

import { Router } from 'express';
import crypto from 'node:crypto';
import { runTurn } from '../lib/agent.js';
import { sendWhatsAppText } from '../lib/whatsapp_send.js';

export const whatsappRouter = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'dev-verify-token';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

let warnedNoSecret = false;

// Validates Meta's X-Hub-Signature-256 (HMAC-SHA256 of raw body). Returns
// true when the signature is valid, OR when no APP_SECRET is configured
// (dev / web-only mode). Returns false on a present-but-bad signature.
function verifySignature(req) {
  if (!APP_SECRET) {
    if (!warnedNoSecret) {
      console.warn('[whatsapp] WHATSAPP_APP_SECRET is empty — signature verification DISABLED. Set it before going live.');
      warnedNoSecret = true;
    }
    return true;
  }
  const header = req.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

whatsappRouter.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

whatsappRouter.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[whatsapp] X-Hub-Signature-256 verification failed — rejecting request');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ACK immediately (Meta retries on timeout)
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return;

    const from = msg.from;                                 // E.164 phone
    // Three text-bearing message types: plain text, template-button reply
    // (msg.button), and interactive button/list reply (msg.interactive).
    // Each surfaces a different field. Map button payloads to canonical
    // tokens the agent's regex matchers recognise:
    //   reclassify:accept → 'موافق'
    //   reclassify:reject → 'رفض'
    //   burst:done        → 'تم'
    //   burst:more        → 'سأرسل المزيد'
    let interactiveText = '';
    if (msg.interactive?.type === 'button_reply') {
      const id = msg.interactive.button_reply.id || '';
      const title = msg.interactive.button_reply.title || '';
      if (id === 'reclassify:accept') interactiveText = 'موافق';
      else if (id === 'reclassify:reject') interactiveText = 'رفض';
      else if (id === 'burst:done')   interactiveText = 'تم';
      else if (id === 'burst:more')   interactiveText = 'سأرسل المزيد';
      else interactiveText = title; // generic — just forward what was tapped
    } else if (msg.interactive?.type === 'list_reply') {
      // List picks: forward the row id so list-driven flows can dispatch.
      interactiveText = msg.interactive.list_reply.id || msg.interactive.list_reply.title || '';
    }
    const text = msg.text?.body || msg.button?.text || interactiveText || '';
    const media = msg.image || msg.document || null;
    // Media captions live on the media object itself. Use filename as a
    // secondary hint for documents (WhatsApp preserves the original name).
    const caption = (media?.caption || msg.image?.caption || msg.document?.caption
                     || msg.document?.filename || '').toString();

    let attachment = null;
    const originalName = msg.document?.filename || null;
    if (media && ACCESS_TOKEN) {
      attachment = await fetchMedia(media.id);
      if (attachment) {
        attachment.caption = caption;
        attachment.name = originalName;
      }
    } else if (media) {
      // Debug / no-token path: still pass a stub so the agent can log it
      attachment = { url: '', mime: media.mime_type || '', size: 0, caption, name: originalName };
    }

    // If the user sent ONLY a media file with a caption (e.g. an image of
    // their civil ID with the caption "this is my id"), forward the caption
    // as the user_text too. The agent reads attachment.caption directly,
    // but seeding user_text means search/intent detection still works for
    // captions that describe a service rather than a doc.
    const effectiveText = text || (attachment?.caption || '');

    const session_id = `wa:${from}`;
    const { reply } = await runTurn({ session_id, user_text: effectiveText, attachment, citizen_phone: from });

    // Empty reply = agent intentionally stayed silent (e.g. burst-continuation
    // file 2+ of a multi-upload batch). Skip the WhatsApp send so the citizen
    // doesn't get a flood of identical "got N files" acks while they're still
    // in the middle of dropping photos.
    if (reply && String(reply).trim()) {
      const send = await sendWhatsAppText(from, reply);
      if (!send.ok) console.warn('[whatsapp] bot reply send failed:', send.error);
    }
  } catch (e) {
    console.error('[whatsapp] error', e);
  }
});

async function fetchMedia(mediaId) {
  const meta = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { 'authorization': `Bearer ${ACCESS_TOKEN}` }
  }).then(r => r.json());
  // Minimal: return the CDN URL (signed) — in production, fetch and re-host.
  return { url: meta.url, mime: meta.mime_type, size: meta.file_size };
}
