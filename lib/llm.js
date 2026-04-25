// LLM client — provider-aware. Chat / tool-calling can run on either
// Anthropic (Claude) or Qwen (DashScope OpenAI-compatible). Embeddings
// always go to Qwen because Anthropic doesn't expose an embeddings API.
//
// Public surface stays OpenAI-shaped — agent.js and the tools see
// `{role, content, tool_calls, tool_call_id}` messages and a tool spec
// shaped like `[{type:'function', function:{name, description, parameters}}]`.
// When the provider is Anthropic, this file translates in/out so callers
// don't need to know which backend is in use.

import 'dotenv/config';

// ─── Provider config ────────────────────────────────────────
// Explicit override: LLM_PROVIDER=anthropic|qwen
// Auto: Anthropic if its key is set, else Qwen.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_BASE = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-plus';

const PROVIDER = (process.env.LLM_PROVIDER || (ANTHROPIC_API_KEY ? 'anthropic' : 'qwen')).toLowerCase();

const EMBED_MODEL = process.env.QWEN_EMBED_MODEL || 'text-embedding-v3';
export const EMBED_DIM = Number(process.env.QWEN_EMBED_DIM || 1024);

// LLM_ENABLED gates LLM-only paths. Embeddings need QWEN specifically; the
// embed() function checks that on its own.
export const LLM_ENABLED = PROVIDER === 'anthropic' ? !!ANTHROPIC_API_KEY : !!QWEN_API_KEY;
export const LLM_PROVIDER = PROVIDER;
export const LLM_MODEL = PROVIDER === 'anthropic' ? ANTHROPIC_MODEL : QWEN_MODEL;

// ─── Embeddings (Qwen only) ─────────────────────────────────
// Returns number[][] aligned with `inputs`, or null if no Qwen key.
export async function embed(inputs, { trace } = {}) {
  if (!QWEN_API_KEY) return null;
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const batchSize = 10;
  const out = new Array(inputs.length);
  for (let i = 0; i < inputs.length; i += batchSize) {
    const slice = inputs.slice(i, i + batchSize).map(s => String(s || '').slice(0, 2000));
    let attempt = 0, vectors = null, lastErr = null;
    while (attempt < 3 && !vectors) {
      attempt++;
      try {
        const res = await fetch(`${QWEN_BASE}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${QWEN_API_KEY}` },
          body: JSON.stringify({
            model: EMBED_MODEL, input: slice, dimensions: EMBED_DIM, encoding_format: 'float'
          })
        });
        if (!res.ok) {
          const txt = await res.text();
          lastErr = `embed ${res.status}: ${txt.slice(0, 200)}`;
          if (res.status >= 500 || res.status === 429) {
            await new Promise(r => setTimeout(r, 400 * attempt));
            continue;
          }
          throw new Error(lastErr);
        }
        const data = await res.json();
        vectors = (data?.data || []).map(d => d.embedding);
      } catch (e) {
        lastErr = e.message;
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
    if (!vectors) {
      trace?.push({ step: 'embed_error', err: lastErr });
      return null;
    }
    for (let j = 0; j < vectors.length; j++) out[i + j] = vectors[j];
  }
  trace?.push({ step: 'embed_ok', n: out.length, dim: out[0]?.length });
  return out;
}

// ─── Tool-calling chat ──────────────────────────────────────
// Returns OpenAI-shaped { content, tool_calls } regardless of provider.
// tool_calls (when present) is an array of
//   { id, type:'function', function: { name, arguments: <json string> } }
export async function chatWithTools({ messages, tools, temperature = 0.2, max_tokens = 600, trace }) {
  if (!LLM_ENABLED) return { content: null, tool_calls: null, unavailable: true };
  if (PROVIDER === 'anthropic') {
    return await anthropicChatWithTools({ messages, tools, temperature, max_tokens, trace });
  }
  return await qwenChatWithTools({ messages, tools, temperature, max_tokens, trace });
}

// ─── Plain chat (no tools) ──────────────────────────────────
export async function chat({ system, user, temperature = 0.2, max_tokens = 400, trace }) {
  if (!LLM_ENABLED) {
    const reply = stubReply(user);
    trace?.push({ step: 'llm_stub', reply });
    return reply;
  }
  if (PROVIDER === 'anthropic') {
    return await anthropicChat({ system, user, temperature, max_tokens, trace });
  }
  return await qwenChat({ system, user, temperature, max_tokens, trace });
}

// ────────────────────────────────────────────────────────────
// QWEN backend (OpenAI-compatible)
// ────────────────────────────────────────────────────────────
async function qwenChatWithTools({ messages, tools, temperature, max_tokens, trace }) {
  const res = await fetch(`${QWEN_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${QWEN_API_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL, temperature, max_tokens, messages, tools,
      tool_choice: 'auto', parallel_tool_calls: false
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', provider: 'qwen', status: res.status, body: txt.slice(0, 400) });
    return { content: 'حسناً، دعني أحاول مجدداً. / Let me try again.', tool_calls: null };
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  trace?.push({
    step: 'llm_tool_turn', provider: 'qwen', model: QWEN_MODEL,
    tokens: data?.usage?.total_tokens,
    tool_calls: (msg.tool_calls || []).map(tc => tc.function?.name),
    reply_preview: (msg.content || '').slice(0, 120)
  });
  return { content: msg.content || null, tool_calls: msg.tool_calls || null };
}

async function qwenChat({ system, user, temperature, max_tokens, trace }) {
  const res = await fetch(`${QWEN_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${QWEN_API_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL, temperature, max_tokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', provider: 'qwen', status: res.status, body: txt.slice(0, 400) });
    return 'حسناً، أكمل من فضلك. / OK, please go on.';
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || '';
  trace?.push({ step: 'llm_reply', provider: 'qwen', model: QWEN_MODEL,
    tokens: data?.usage?.total_tokens, preview: reply.slice(0, 120) });
  return reply;
}

// ────────────────────────────────────────────────────────────
// ANTHROPIC backend (Claude Messages API)
// ────────────────────────────────────────────────────────────
//
// Translation surface:
//   OpenAI tool:    {type:'function', function:{name, description, parameters}}
//   Anthropic tool: {name, description, input_schema}
//
//   OpenAI msgs:
//     {role:'system', content:'...'}                           → top-level `system`
//     {role:'user', content:'...'}                             → as-is
//     {role:'assistant', content:'...', tool_calls:[{id, function:{name, arguments}}]}
//                                                              → assistant w/ content blocks
//                                                                [{type:'text'}, {type:'tool_use', id, name, input}]
//     {role:'tool', tool_call_id, content}                     → user w/ tool_result block
//                                                                [{type:'tool_result', tool_use_id, content}]
//
//   Response back:
//     content blocks → OpenAI-shaped { content: <joined text>, tool_calls: [...] }

async function anthropicChatWithTools({ messages, tools, temperature, max_tokens, trace }) {
  const { system, msgs } = translateMessagesToAnthropic(messages);
  const aTools = (tools || []).map(translateToolToAnthropic).filter(Boolean);

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens,
    temperature,
    messages: msgs,
    ...(system ? { system } : {}),
    ...(aTools.length ? { tools: aTools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {})
  };

  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', provider: 'anthropic', status: res.status, body: txt.slice(0, 400) });
    return { content: 'حسناً، دعني أحاول مجدداً. / Let me try again.', tool_calls: null };
  }
  const data = await res.json();
  const { content, tool_calls } = translateAnthropicResponse(data);
  trace?.push({
    step: 'llm_tool_turn', provider: 'anthropic', model: ANTHROPIC_MODEL,
    tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
    tool_calls: (tool_calls || []).map(tc => tc.function?.name),
    reply_preview: (content || '').slice(0, 120)
  });
  return { content, tool_calls };
}

async function anthropicChat({ system, user, temperature, max_tokens, trace }) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens, temperature,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', provider: 'anthropic', status: res.status, body: txt.slice(0, 400) });
    return 'حسناً، أكمل من فضلك. / OK, please go on.';
  }
  const data = await res.json();
  const reply = (data?.content || [])
    .filter(b => b?.type === 'text')
    .map(b => b.text || '')
    .join('')
    .trim();
  trace?.push({
    step: 'llm_reply', provider: 'anthropic', model: ANTHROPIC_MODEL,
    tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
    preview: reply.slice(0, 120)
  });
  return reply;
}

// ─── Translators ────────────────────────────────────────────

function translateToolToAnthropic(t) {
  // OpenAI: {type:'function', function:{name, description, parameters}}
  if (!t) return null;
  const fn = t.function || t;
  if (!fn?.name) return null;
  return {
    name: fn.name,
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object', properties: {} }
  };
}

function translateMessagesToAnthropic(messages) {
  // Pull system messages out; concatenate if multiple.
  const sysParts = [];
  const out = [];
  let pendingToolResults = null; // accumulate consecutive role:'tool' into one user msg

  const flushTools = () => {
    if (pendingToolResults && pendingToolResults.content.length) {
      out.push(pendingToolResults);
    }
    pendingToolResults = null;
  };

  for (const m of (messages || [])) {
    if (!m) continue;
    if (m.role === 'system') {
      flushTools();
      if (m.content) sysParts.push(String(m.content));
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic requires tool_result blocks inside a user-role message.
      // Merge consecutive tool messages into one user turn.
      if (!pendingToolResults) {
        pendingToolResults = { role: 'user', content: [] };
      }
      pendingToolResults.content.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
      });
      continue;
    }
    flushTools();

    if (m.role === 'assistant') {
      const blocks = [];
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt && txt.trim()) blocks.push({ type: 'text', text: txt });
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input
        });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user (and any other roles fall back to user)
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    out.push({ role: 'user', content });
  }
  flushTools();

  // Anthropic requires the conversation to start with role:'user'. If the
  // first message is assistant (rare — happens if history begins with a bot
  // turn), prepend a stub user message so the API doesn't 400.
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(continue)' });
  }
  // Anthropic also requires at least one message.
  if (out.length === 0) {
    out.push({ role: 'user', content: '(continue)' });
  }

  const system = sysParts.join('\n\n').trim() || undefined;
  return { system, msgs: out };
}

function translateAnthropicResponse(data) {
  const blocks = data?.content || [];
  let text = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (b?.type === 'text') {
      text += b.text || '';
    } else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {})
        }
      });
    }
  }
  return {
    content: text.trim() || null,
    tool_calls: toolCalls.length ? toolCalls : null
  };
}

// ────────────────────────────────────────────────────────────
// Service Q&A — natural-language answer about a service given its DB row.
// Uses whichever provider is enabled; structured fallback when none.
// ────────────────────────────────────────────────────────────
export async function answerAboutService({ user_question, service, lang = 'ar', trace }) {
  const docs = (() => { try { return JSON.parse(service.required_documents_json || '[]'); } catch { return []; } })();
  if (!LLM_ENABLED) {
    return formatServiceCard(service, docs, lang);
  }
  const context = `
SERVICE DATA (authoritative — do not invent anything not here):
- name (EN): ${service.name_en}
- name (AR): ${service.name_ar}
- entity (EN): ${service.entity_en}
- entity (AR): ${service.entity_ar}
- description (EN): ${service.description_en || '—'}
- description (AR): ${service.description_ar || '—'}
- fees: ${service.fees_text || '—'} (≈ ${service.fee_omr ?? '?'} OMR)
- required documents: ${docs.length ? docs.map(d => d.label_en || d.code).join('; ') : (service.required_documents_json || '—')}
- source URL: ${service.source_url || '—'}
`.trim();
  const reply = await chat({
    system: `You are the Sanad-AI assistant answering questions about ONE specific Oman government service. Reply in ${lang === 'ar' ? 'Arabic' : 'English'} unless the user's question was clearly in the other language. Be concise (3–5 lines). Use ONLY the service data below; if something isn't in the data, say so instead of inventing. End with a one-line offer: "Want Sanad to help submit this?" / "تحب أحد مكاتب سند يساعدك تقدّمه؟"`,
    user: `${context}\n\nUSER QUESTION: "${user_question}"\n\nAnswer using the service data above.`,
    max_tokens: 260,
    trace
  });
  return reply || formatServiceCard(service, docs, lang);
}

function formatServiceCard(s, docs, lang) {
  const isAr = lang === 'ar';
  const name = isAr ? (s.name_ar || s.name_en) : (s.name_en || s.name_ar);
  const entity = isAr ? (s.entity_ar || s.entity_en) : (s.entity_en || s.entity_ar);
  const desc = isAr ? s.description_ar : s.description_en;
  const docList = docs.length
    ? docs.map(d => `• ${isAr ? (d.label_ar || d.label_en) : (d.label_en || d.label_ar || d.code)}`).join('\n')
    : (s.required_documents_json && s.required_documents_json !== '[]' ? s.required_documents_json.slice(0, 200) : '—');
  return [
    `**${name}**`,
    `${entity || ''}`,
    desc ? `\n${desc.slice(0, 200)}` : '',
    `\n💰 ${s.fees_text || '—'}${s.fee_omr!=null ? ` (≈ ${s.fee_omr} OMR)` : ''}`,
    `\n📎 ${isAr ? 'المستندات المطلوبة' : 'Required documents'}:\n${docList}`,
    s.source_url ? `\n🔗 ${s.source_url}` : '',
    `\n${isAr ? 'تحب أحد مكاتب سند يساعدك تقدّمه؟' : 'Want a Sanad office to help you submit this?'}`
  ].filter(Boolean).join('\n');
}

// Rule-based fallback so the web tester works with zero config.
function stubReply(userMsg) {
  const t = (userMsg || '').toLowerCase();
  if (t.includes('hello') || t.includes('hi ') || t.includes('مرحبا')) {
    return 'مرحبا بك في سند. كيف أقدر أساعدك اليوم؟ / Welcome to Sanad-AI. How can I help?';
  }
  if (t.includes('help') || t.includes('/help')) {
    return 'You can ask for any Oman government service — e.g. "renew driving licence", "تجديد بطاقة مدنية".';
  }
  return 'تمام، فهمت. (stub LLM — set ANTHROPIC_API_KEY or QWEN_API_KEY for real replies)';
}
