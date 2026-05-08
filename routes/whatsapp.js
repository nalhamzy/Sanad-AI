// Meta WhatsApp Cloud API webhook.
// In debug mode we only log + accept — no real send. When you plug credentials
// in, the same `runTurn` is used so the agent behaviour is identical to web.

import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn, trackInflightMedia } from '../lib/agent.js';
import { sendWhatsAppText, sendWhatsAppButtons } from '../lib/whatsapp_send.js';

export const whatsappRouter = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'dev-verify-token';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

let warnedNoSecret = false;

// Pure HMAC verifier — extracted so it can be unit-tested without mocking
// Express. Returns true when the secret is empty (soft / dev mode), false on
// any malformed or wrong signature, true on a valid one. Length-equal guard
// before timingSafeEqual avoids the throw on mismatched buffer sizes.
export function verifyMetaSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true; // soft mode — set WHATSAPP_APP_SECRET before going live
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Express adapter — pulls header + raw body off the request and warns once
// when the secret is missing in production. Real verification logic lives
// in verifyMetaSignature() above.
function verifySignature(req) {
  if (!APP_SECRET && !warnedNoSecret) {
    console.warn('[whatsapp] WHATSAPP_APP_SECRET is empty — signature verification DISABLED. Set it before going live.');
    warnedNoSecret = true;
  }
  return verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256') || '', APP_SECRET);
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
    //   doc:yes           → 'نعم'   (confirm ambiguous-doc classification)
    //   doc:wrong         → 'لا'    (the file is for a different slot)
    //   doc:extra         → 'إضافي' (record as a supplementary file)
    let interactiveText = '';
    if (msg.interactive?.type === 'button_reply') {
      const id = msg.interactive.button_reply.id || '';
      const title = msg.interactive.button_reply.title || '';
      // Button payloads use control prefix `__btn__:<id>` so the agent can
      // distinguish tap-driven intent from typed text. Without this prefix
      // a tap on "+ سأرسل المزيد" would be passed to parseUploadDescriptions
      // as a CAPTION for the just-buffered files (real bug seen in prod
      // trace +96892888715 #1214: state.extras gained an entry with
      // caption="سأرسل المزيد"). The runAgentV2 entry strips the prefix
      // and dispatches to a deterministic handler.
      if (id === 'reclassify:accept') interactiveText = '__btn__:reclassify:accept';
      else if (id === 'reclassify:reject') interactiveText = '__btn__:reclassify:reject';
      else if (id === 'burst:done')   interactiveText = '__btn__:burst:done';   // "انتهيت"
      else if (id === 'burst:more')   interactiveText = '__btn__:burst:more';   // "سأرسل المزيد"
      else if (id === 'doc:yes')      interactiveText = '__btn__:doc:yes';
      else if (id === 'doc:wrong')    interactiveText = '__btn__:doc:wrong';
      else if (id === 'doc:extra')    interactiveText = '__btn__:doc:extra';
      else if (id === 'doc:list')     interactiveText = '__btn__:doc:list';
      else if (id === 'review:submit')  interactiveText = '__btn__:review:submit';
      else if (id === 'review:pause')   interactiveText = '__btn__:review:pause';
      else if (id === 'service:cancel') interactiveText = '__btn__:service:cancel';
      else if (id === 'service:switch') interactiveText = '__btn__:service:switch';
      else if (id === 'service:show')   interactiveText = '__btn__:service:show';
      else if (id === 'status:check')   interactiveText = '__btn__:status:check';
      else if (id === 'next:doc')       interactiveText = '__btn__:next:doc';
      else if (id === 'pick:1')         interactiveText = '__btn__:pick:1';
      else if (id === 'pick:2')         interactiveText = '__btn__:pick:2';
      else if (id === 'pick:3')         interactiveText = '__btn__:pick:3';
      // codex iter-7 — discovery hints surfaced when LLM is unreachable.
      else if (id === 'discover:license') interactiveText = '__btn__:discover:license';
      else if (id === 'discover:title')   interactiveText = '__btn__:discover:title';
      else if (id === 'discover:cr')      interactiveText = '__btn__:discover:cr';
      else if (id === 'confirm:yes')  interactiveText = '__btn__:confirm:yes';
      else if (id === 'confirm:no')   interactiveText = '__btn__:confirm:no';
      else interactiveText = title; // generic — just forward what was tapped
    } else if (msg.interactive?.type === 'list_reply') {
      // List picks: forward the row id so list-driven flows can dispatch.
      interactiveText = msg.interactive.list_reply.id || msg.interactive.list_reply.title || '';
    }
    const text = msg.text?.body || msg.button?.text || interactiveText || '';
    const media = msg.image || msg.document || null;
    // Media captions live on the media object itself. Use filename as a
    // secondary hint for documents (WhatsApp preserves the original name).
    // Caption priority: explicit user caption first; only fall back to the
    // filename if it looks INFORMATIVE. iPhone/Android default names like
    // "IMG_0001.HEIC" / "WhatsApp Image 2026-05-04 at 18.48.jpeg" /
    // "image.jpg" pollute the agent's intent matcher and the vision prompt
    // — they're worse than no caption. If only a noise filename is present,
    // pass empty string and let the buffer/button flow handle it.
    let caption = (media?.caption || msg.image?.caption || msg.document?.caption || '').toString();
    if (!caption && msg.document?.filename) {
      const fn = msg.document.filename;
      const NOISE_PATTERNS = [
        /^IMG[_-]?\d+/i,
        /^WhatsApp[ _]Image/i,
        /^WhatsApp[ _]Document/i,
        /^image\.[a-z]{3,4}$/i,
        /^document\.[a-z]{3,4}$/i,
        /^scan[ _]?\d+\.[a-z]{3,4}$/i,
        /^photo[ _]?\d*\.[a-z]{3,4}$/i,
        /^\d{4}[-_]\d{2}[-_]\d{2}/, // YYYY-MM-DD prefix from camera apps
      ];
      const isNoise = NOISE_PATTERNS.some(re => re.test(fn));
      if (!isNoise) caption = fn;
    }

    let attachment = null;
    const originalName = msg.document?.filename || null;
    const _sessionId = `wa:${from}`;

    // ── INFLIGHT-GATE OPEN ────────────────────────────────────────
    // Bump BEFORE fetchMedia so the burst-quiet timer in agent.js can SEE
    // this in-flight media even while we're still downloading from Meta's
    // CDN (1-3s). Without this, the timer can fire on file 1's reply
    // while file 2 is mid-fetch, producing a separate per-file ack
    // instead of one consolidated burst summary. Decremented in `finally`
    // below so any throw / early-return still releases the gate.
    // (Real prod bug from trace +96892888715 #1231/#1233 on 2026-05-06.)
    const mediaInflight = !!media;
    if (mediaInflight) trackInflightMedia(_sessionId, +1);
    let turn = null;
    try {
    if (media && ACCESS_TOKEN) {
      // fetchMedia downloads the binary from Meta and writes it to
      // /data/uploads/wa:<phone>/<ts_rand>.<ext>, returning a LOCAL URL
      // the officer dashboard can serve via express.static.
      attachment = await fetchMedia(media.id, _sessionId);
      if (attachment) {
        attachment.caption = caption;
        attachment.name = originalName;
      } else {
        // Download failed silently (unsupported mime, Meta 4xx/5xx, or
        // network error). Without this branch the citizen would see
        // nothing — and the LLM downstream sometimes hallucinates a save
        // anyway because it sees an "(attachment)" stub in chat history.
        // Tell the citizen explicitly so they can resend in a supported
        // format. Skip runTurn entirely for this turn.
        const reason = (media.mime_type || '').toLowerCase();
        const supported = 'JPG · PNG · WEBP · HEIC · PDF';
        const msg = reason
          ? `⚠️ لم أستطع استلام الملف (نوع ${reason} غير مدعوم). أرسل الملف بصيغة: ${supported}.`
          : `⚠️ لم أستطع استلام الملف. حاول إرسال الملف مرة أخرى بصيغة: ${supported}.`;
        try {
          const send = await sendWhatsAppText(from, msg);
          if (!send.ok) console.warn('[whatsapp] media-error notice send failed:', send.error);
        } catch (e) { console.warn('[whatsapp] media-error notice threw:', e.message); }
        return; // do NOT call runTurn — there's no attachment + no useful text
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
    turn = await runTurn({ session_id, user_text: effectiveText, attachment, citizen_phone: from });
    const reply = turn?.reply || '';
    const buttons = Array.isArray(turn?._buttons) ? turn._buttons : null;

    // Empty reply = agent intentionally stayed silent (e.g. burst-continuation
    // file 2+ of a multi-upload batch, or attachment turn whose reply is
    // queued for drainBurst). Skip the WhatsApp send so the citizen doesn't
    // get a flood of identical "got N files" acks while they're still in
    // the middle of dropping photos.
    if (reply && String(reply).trim()) {
      // Buttons take precedence — if the agent attached any, use the
      // interactive endpoint. Falls back to plain text if Meta rejects the
      // interactive message (rare; happens when title length is wrong or
      // recipient hasn't initiated the conversation in 24h).
      if (buttons && buttons.length) {
        const safe = buttons.slice(0, 3).map(b => ({
          id: String(b.id || '').slice(0, 256),
          title: String(b.title || '').slice(0, 20)
        }));
        const send = await sendWhatsAppButtons(from, reply, safe);
        if (!send.ok) {
          console.warn('[whatsapp] interactive send failed, falling back to text:', send.error);
          const fb = await sendWhatsAppText(from, reply);
          if (!fb.ok) console.warn('[whatsapp] bot reply send failed:', fb.error);
        }
      } else {
        const send = await sendWhatsAppText(from, reply);
        if (!send.ok) console.warn('[whatsapp] bot reply send failed:', send.error);
      }
    }
    } finally {
      // Release the inflight gate so drainBurst can flush. Outer try wraps
      // fetch + runTurn so a throw or early-return still hits this. Note:
      // runTurn ALSO bumps inflight inside its own try/finally — net count
      // stays >= 1 from webhook entry through the agent loop's completion,
      // closing the previously open race window during fetchMedia.
      if (mediaInflight) trackInflightMedia(_sessionId, -1);
    }
  } catch (e) {
    console.error('[whatsapp] error', e);
    // Defensive: if media inflight bump succeeded but the throw escaped
    // our inner try (e.g. before mediaInflight was set), the inner finally
    // already covered it. Nothing to do here.
  }
});

// ── WhatsApp media → local disk ───────────────────────────────────────
// Meta gives us a SHORT-LIVED signed URL on `lookaside.fbsbx.com` that:
//   • requires the bearer token to fetch
//   • expires in ~24h
// If we just stored that URL on the request_document row, the office would
// see a broken link the next day, and even within 24h the dashboard couldn't
// load it (no Meta token in the browser). So: fetch the binary right now,
// write it to /data/uploads/{wa-phone}/{ts_rand}.{ext}, and return the
// LOCAL path. Server already serves /uploads/* via express.static.
const UPLOAD_DIR = path.resolve('./data/uploads');
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf'
]);
function extForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return '.pdf';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/heic' || m === 'image/heif') return '.heic';
  return '.jpg';
}

async function fetchMedia(mediaId, sessionId) {
  // Step 1: ask Meta for the signed URL + metadata.
  const meta = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { 'authorization': `Bearer ${ACCESS_TOKEN}` }
  }).then(r => r.json());
  const cdnUrl = meta?.url;
  const mime = meta?.mime_type || '';
  const size = meta?.file_size || 0;
  if (!cdnUrl) {
    console.warn('[whatsapp] fetchMedia got no url from Meta:', JSON.stringify(meta).slice(0, 300));
    return null;
  }
  if (mime && !ALLOWED_MIMES.has(mime.toLowerCase())) {
    console.warn(`[whatsapp] rejecting unsupported mime ${mime} (mediaId=${mediaId})`);
    return null;
  }

  // Step 2: download the binary using the SAME bearer token. Lookaside URLs
  // 401 without it.
  let buf;
  try {
    const r = await fetch(cdnUrl, { headers: { 'authorization': `Bearer ${ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.warn(`[whatsapp] media fetch failed ${r.status} for ${mediaId}`);
      return null;
    }
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn('[whatsapp] media fetch threw:', e.message);
    return null;
  }

  // Step 3: write to /data/uploads/{sid}/{ts_rand}.{ext}. Mirrors the
  // multer destination shape used by web chat so officers' file-preview
  // path is the same on both channels.
  const safeSid = String(sessionId || 'wa-unknown').replace(/[^a-zA-Z0-9_+:.-]/g, '_');
  const dir = path.join(UPLOAD_DIR, safeSid);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${extForMime(mime)}`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buf);

  // Returned `url` is the path Express serves under express.static(/uploads).
  // Caller stores this on request_document.storage_url → dashboard renders it.
  return {
    url: `/uploads/${encodeURIComponent(safeSid)}/${encodeURIComponent(filename)}`,
    mime,
    size: buf.length
  };
}
