// ────────────────────────────────────────────────────────────
// lib/codex.js — thin OpenAI client used to consult GPT (Codex / GPT-5)
// for design review and quick second-opinions on agent prompts.
//
// NOT used in citizen-facing requests. Only invoked by:
//   • dev scripts (scripts/codex-review.mjs)
//   • optional in-loop "self-critique" calls behind SANAD_CODEX_REVIEW=true
//
// Endpoint routing:
//   • Codex / o-series / reasoning models (gpt-5*-codex, gpt-5.x-codex,
//     o1*, o3*, o4*) → POST /v1/responses (the new Responses API).
//     These models 404 on /v1/chat/completions with the message
//     "This is not a chat model… Did you mean to use v1/completions?"
//   • Everything else (gpt-4.1, gpt-4o, gpt-5-chat-latest, gpt-5.x-chat) →
//     POST /v1/chat/completions.
// askCodex picks the right endpoint per model so callers don't care.
//
// Environment:
//   OPENAI_API_KEY        required for live calls
//   OPENAI_CODEX_MODEL    optional, default 'gpt-5.2-codex'
//   OPENAI_CODEX_FALLBACK optional, default 'gpt-5-codex'
//   OPENAI_CODEX_BASE     optional, default 'https://api.openai.com/v1'
//
// Public API:
//   askCodex({ prompt, system?, model?, max_tokens?, temperature? })
//     → { ok, text, model, ms, raw?, endpoint? } | { ok:false, error, detail? }
//
//   isCodexEnabled() → boolean (true when OPENAI_API_KEY is set)
// ────────────────────────────────────────────────────────────

// Resolve env at call-time, not module-load time. ES module imports are
// hoisted and run before any top-level dotenv.config() in the caller — so
// reading process.env at module scope would race the config load and read
// empty values. The getters keep us late-binding without changing the API.
const env = (k, dflt = '') => process.env[k] || dflt;
const KEY      = () => env('OPENAI_API_KEY');
const MODEL    = () => env('OPENAI_CODEX_MODEL', 'gpt-5.2-codex');
const BASE     = () => env('OPENAI_CODEX_BASE', 'https://api.openai.com/v1');
const FALLBACK = () => env('OPENAI_CODEX_FALLBACK', 'gpt-5-codex');

export function isCodexEnabled() { return !!KEY(); }

const DEFAULT_SYSTEM = `You are GPT-5 Codex acting as a senior code reviewer for Sanad-AI, ` +
  `an Arabic WhatsApp/Web agent for Omani government services. ` +
  `Be terse, opinionated, and technical. ` +
  `When asked to validate an approach: list the 3 biggest risks, then ` +
  `propose the smallest concrete change that mitigates each. ` +
  `No prose preambles. No "as an AI…". Output bullet lists.`;

// True for models that REQUIRE the /v1/responses endpoint (codex + o-series
// reasoning models). Chat-completions returns a 404 with
// "This is not a chat model" for these.
function isResponsesModel(model) {
  const m = String(model || '').toLowerCase();
  return /(?:^|[-/])codex(?:$|-)/i.test(m) ||
         /^o[134](?:-|$)/.test(m) ||
         /-reasoning(?:-|$)/.test(m);
}

async function callChat({ model, system, prompt, max_tokens, temperature, signal }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: String(prompt) }
    ],
    max_tokens,
    temperature
  };
  const r = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KEY()}` },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error(`openai chat ${r.status}: ${txt.slice(0, 240)}`);
    err.status = r.status; err.bodyText = txt; err.endpoint = 'chat';
    throw err;
  }
  const data = await r.json();
  return { text: data?.choices?.[0]?.message?.content || '', raw: data, endpoint: 'chat' };
}

async function callResponses({ model, system, prompt, max_tokens, temperature, signal }) {
  // Responses API shape:
  //   { model, instructions, input, max_output_tokens, temperature, ... }
  // The reasoning models reject `temperature` — only o-series; codex models
  // accept it but ignore. Send it anyway; OpenAI silently caps unsupported
  // params. The reply text lives in `output_text` (convenience field) or
  // collapsed from `output[].content[].text`.
  const body = {
    model,
    instructions: system,
    input: String(prompt),
    max_output_tokens: max_tokens
  };
  // Codex + reasoning models reject `temperature` ("Unsupported parameter").
  // Don't send it at all on the responses endpoint.
  const r = await fetch(`${BASE()}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KEY()}` },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error(`openai responses ${r.status}: ${txt.slice(0, 240)}`);
    err.status = r.status; err.bodyText = txt; err.endpoint = 'responses';
    throw err;
  }
  const data = await r.json();
  // Prefer the convenience `output_text`; otherwise stitch from output[].
  let text = data?.output_text || '';
  if (!text && Array.isArray(data?.output)) {
    text = data.output
      .flatMap(o => Array.isArray(o?.content) ? o.content : [])
      .filter(c => c?.type === 'output_text' || typeof c?.text === 'string')
      .map(c => c?.text || '')
      .join('');
  }
  return { text, raw: data, endpoint: 'responses' };
}

async function callOnce({ model, system, prompt, max_tokens, temperature, signal }) {
  return isResponsesModel(model)
    ? callResponses({ model, system, prompt, max_tokens, temperature, signal })
    : callChat({ model, system, prompt, max_tokens, temperature, signal });
}

export async function askCodex({
  prompt,
  system = DEFAULT_SYSTEM,
  model = MODEL(),
  max_tokens = 800,
  temperature = 0.2,
  timeout_ms = 120_000
} = {}) {
  if (!KEY()) return { ok: false, error: 'no_key' };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'empty_prompt' };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout_ms);
  const t0 = Date.now();
  try {
    try {
      const a = await callOnce({ model, system, prompt, max_tokens, temperature, signal: ac.signal });
      return { ok: true, text: a.text, model, endpoint: a.endpoint, ms: Date.now() - t0 };
    } catch (e) {
      // Fallback when the requested model isn't available on this account
      // or project (404 model_not_found, 403 access denied, 400 invalid_model).
      const code = e.status;
      const looksLikeMissingModel =
        code === 404 || code === 400 || code === 403 ||
        /model.*not.*found|does not exist|invalid.*model|access to model/i.test(e.bodyText || '');
      const fb = FALLBACK();
      if (looksLikeMissingModel && model !== fb) {
        try {
          const a = await callOnce({ model: fb, system, prompt, max_tokens, temperature, signal: ac.signal });
          return { ok: true, text: a.text, model: fb, endpoint: a.endpoint, ms: Date.now() - t0, fellback: true, original_error: e.message };
        } catch (e2) {
          return { ok: false, error: 'api_error', detail: e2.message, model: fb, ms: Date.now() - t0, original_error: e.message };
        }
      }
      return { ok: false, error: 'api_error', detail: e.message, model, ms: Date.now() - t0 };
    }
  } finally {
    clearTimeout(t);
  }
}
