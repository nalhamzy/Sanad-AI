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
    const text = msg.text?.body || msg.button?.text || '';
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

    const send = await sendWhatsAppText(from, reply);
    if (!send.ok) console.warn('[whatsapp] bot reply send failed:', send.error);
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
