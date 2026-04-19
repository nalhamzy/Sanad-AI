// Qwen (OpenAI-compatible) client with a deterministic fallback for debugging
// without a key. Mirrors the OmanJobs `qwen_client.py` shape.

import 'dotenv/config';

const API_KEY = process.env.QWEN_API_KEY || '';
const BASE_URL = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen-plus';

export const LLM_ENABLED = !!API_KEY;

// Tool-calling chat — OpenAI-compatible function calling.
// Returns { content, tool_calls } — caller is expected to run tools and loop.
export async function chatWithTools({ messages, tools, temperature = 0.2, max_tokens = 600, trace }) {
  if (!LLM_ENABLED) return { content: null, tool_calls: null, unavailable: true };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature, max_tokens, messages, tools,
      tool_choice: 'auto', parallel_tool_calls: false
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', status: res.status, body: txt.slice(0, 400) });
    return { content: 'حسناً، دعني أحاول مجدداً. / Let me try again.', tool_calls: null };
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  trace?.push({
    step: 'llm_tool_turn',
    tokens: data?.usage?.total_tokens,
    tool_calls: (msg.tool_calls || []).map(tc => tc.function?.name),
    reply_preview: (msg.content || '').slice(0, 120)
  });
  return { content: msg.content || null, tool_calls: msg.tool_calls || null };
}

export async function chat({ system, user, temperature = 0.2, max_tokens = 400, trace }) {
  if (!LLM_ENABLED) {
    const reply = stubReply(user);
    trace?.push({ step: 'llm_stub', reply });
    return reply;
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    trace?.push({ step: 'llm_error', status: res.status, body: txt.slice(0, 400) });
    // fail open with a generic reply so the demo never dead-ends
    return 'حسناً، أكمل من فضلك. / OK, please go on.';
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || '';
  trace?.push({ step: 'llm_reply', tokens: data?.usage?.total_tokens, preview: reply.slice(0, 120) });
  return reply;
}

// Natural-language answer about a service given its DB row as context.
// Uses Qwen when keyed, a structured template otherwise.
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
  const t = userMsg.toLowerCase();
  if (t.includes('hello') || t.includes('hi ') || t.includes('مرحبا')) {
    return 'مرحبا بك في سند. كيف أقدر أساعدك اليوم؟ / Welcome to Sanad-AI. How can I help?';
  }
  if (t.includes('help') || t.includes('/help')) {
    return 'You can ask for any Oman government service — e.g. "renew driving licence", "تجديد بطاقة مدنية".';
  }
  return 'تمام، فهمت. (stub LLM — set QWEN_API_KEY for real replies)';
}
