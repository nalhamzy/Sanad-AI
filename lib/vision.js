// ────────────────────────────────────────────────────────────
// Vision classifier for citizen-uploaded service documents.
//
// Goal: when a citizen uploads a file in `collecting` state, look at the
// IMAGE CONTENT itself to decide which required-doc slot it fills — instead
// of asking the citizen to caption every file. Removes the messy
// "caption not detected, is this for X or extra?" loop.
//
// Provider strategy:
//   - Anthropic Claude (vision via the Messages API) when ANTHROPIC_API_KEY
//     is set — best instruction-following.
//   - Qwen-VL (qwen-vl-plus / qwen-vl-max via the OpenAI-compatible endpoint)
//     as the fallback, since QWEN_API_KEY is what we actually have set up.
//   - Returns { ok:false, error:'no_key' } if neither is configured — the
//     caller falls back to the legacy "ambiguous, ask the user" path.
//
// Usage:
//   const r = await classifyDocImage({
//     attachment,                    // { url, mime, name, ... }
//     candidate_slots,               // [{ code, label_en, label_ar }]
//     language                       // 'ar' | 'en'
//   });
//   r => { ok, best: { code, confidence, summary }, is_extra, alternatives, raw }
// ────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL_VL = process.env.ANTHROPIC_VISION_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

const QWEN_KEY = process.env.QWEN_API_KEY || '';
const QWEN_BASE = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_VL_MODEL = process.env.QWEN_VL_MODEL || 'qwen-vl-plus';

const PROVIDER = process.env.VISION_PROVIDER
  || (ANTHROPIC_KEY ? 'anthropic' : (QWEN_KEY ? 'qwen' : 'none'));

export const VISION_ENABLED = PROVIDER !== 'none';
export const VISION_PROVIDER = PROVIDER;

const UPLOAD_DIR = path.resolve('./data/uploads');

// ─── Image loader ──────────────────────────────────────────
// Resolves an attachment to { mime, base64, sourceKind } regardless of
// whether the file is local (web upload) or a CDN URL (WhatsApp).
async function loadImageBytes(attachment) {
  if (!attachment) return null;
  const url = attachment.url || '';
  const mime = attachment.mime || guessMimeFromName(attachment.name) || 'image/jpeg';
  if (!isImageMime(mime)) return null;
  if (url.startsWith('/uploads/')) {
    // /uploads/<sid>/<filename> → ./data/uploads/<sid>/<filename>
    const rel = decodeURI(url.replace(/^\/uploads\//, ''));
    const abs = path.join(UPLOAD_DIR, rel);
    const buf = await fs.readFile(abs);
    return { mime, base64: buf.toString('base64'), sourceKind: 'local' };
  }
  if (/^https?:\/\//.test(url)) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`vision-fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { mime, base64: buf.toString('base64'), sourceKind: 'remote' };
  }
  return null;
}

function guessMimeFromName(name) {
  if (!name) return null;
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'pdf') return 'application/pdf';
  return null;
}

function isImageMime(mime) {
  return /^image\/(jpeg|jpg|png|webp|gif)/.test(mime);
}

// ─── Prompt builder ────────────────────────────────────────
// Tells the vision model what it's looking at + what to choose between.
function buildPrompt(candidate_slots, attachment, language) {
  const slotLines = candidate_slots.map((d, i) =>
    `${i + 1}. code="${d.code}" — ${d.label_en || d.code}${d.label_ar ? ' / ' + d.label_ar : ''}`
  ).join('\n');
  const filename = attachment?.name ? `Filename: "${attachment.name}".` : '';
  const captionPart = attachment?.caption
    ? `User caption (may be misleading): "${String(attachment.caption).slice(0, 200)}".`
    : '';
  const langInstr = language === 'ar'
    ? 'Reply in Arabic for the summary field; everything else stays in JSON.'
    : 'Reply in English.';
  return `You are classifying a document image uploaded by an Omani citizen as part of a Sanad-AI government-service request. Inspect the image and choose which required-document slot it best fills.

Required document slots for this service:
${slotLines}

${filename}
${captionPart}
${langInstr}

Decision rules:
- If the image clearly is one of the listed slots, pick that slot's code with high confidence (0.8-0.99).
- If it's plausibly one of them but you can't be sure, pick your best guess with mid confidence (0.4-0.7) and explain.
- If it's not any of them but looks like a relevant supplementary document (extra ID, payment receipt, support letter), set best_code=null, is_extra=true, confidence=0.6.
- If you can't tell what it is at all, set best_code=null, is_extra=false, confidence=0.

Output STRICT JSON only, no prose, no markdown fences. Schema:
{
  "best_code": "<slot code or null>",
  "confidence": <0..1>,
  "summary": "<one sentence describing what you see in the image>",
  "is_extra": <true|false>,
  "alternatives": [{"code": "<slot code>", "confidence": <0..1>}, ...]
}`;
}

// ─── Anthropic backend ─────────────────────────────────────
async function classifyAnthropic({ image, prompt }) {
  const body = {
    model: ANTHROPIC_MODEL_VL,
    max_tokens: 400,
    temperature: 0.1,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } },
          { type: 'text', text: prompt }
        ]
      }
    ]
  };
  const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`anthropic-vision ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('');
  return text;
}

// ─── Qwen-VL backend ───────────────────────────────────────
async function classifyQwen({ image, prompt }) {
  const dataUri = `data:${image.mime};base64,${image.base64}`;
  const body = {
    model: QWEN_VL_MODEL,
    temperature: 0.1,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUri } },
        { type: 'text', text: prompt }
      ]
    }]
  };
  const r = await fetch(`${QWEN_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${QWEN_KEY}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`qwen-vision ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ─── Public API ────────────────────────────────────────────
export async function classifyDocImage({ attachment, candidate_slots = [], language = 'en' }) {
  if (!VISION_ENABLED) return { ok: false, error: 'no_key' };
  if (!attachment) return { ok: false, error: 'no_attachment' };
  if (!candidate_slots.length) return { ok: false, error: 'no_slots' };

  let image;
  try { image = await loadImageBytes(attachment); }
  catch (e) { return { ok: false, error: 'load_failed', detail: e.message }; }
  if (!image) return { ok: false, error: 'unsupported_mime', mime: attachment.mime };

  const prompt = buildPrompt(candidate_slots, attachment, language);
  const t0 = Date.now();
  let raw;
  try {
    raw = (PROVIDER === 'anthropic')
      ? await classifyAnthropic({ image, prompt })
      : await classifyQwen({ image, prompt });
  } catch (e) {
    return { ok: false, error: 'api_error', detail: e.message };
  }
  const ms = Date.now() - t0;

  // Tolerate ```json fences
  let txt = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'unparseable', raw, ms };
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch (e) { return { ok: false, error: 'json_parse', detail: e.message, raw, ms }; }

  const validCodes = new Set(candidate_slots.map(s => s.code));
  let best = null;
  if (parsed.best_code && validCodes.has(parsed.best_code) && Number(parsed.confidence) >= 0) {
    best = {
      code: parsed.best_code,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      summary: String(parsed.summary || '').slice(0, 200)
    };
  }
  const alternatives = Array.isArray(parsed.alternatives)
    ? parsed.alternatives
        .filter(a => a && validCodes.has(a.code))
        .map(a => ({ code: a.code, confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)) }))
        .filter(a => !best || a.code !== best.code)
        .slice(0, 3)
    : [];
  return {
    ok: true,
    provider: PROVIDER,
    ms,
    best,
    is_extra: !!parsed.is_extra,
    summary: String(parsed.summary || best?.summary || '').slice(0, 200),
    alternatives,
    raw
  };
}
