// ────────────────────────────────────────────────────────────
// Sanad-AI agent — LLM-first tool-calling design with a smart
// heuristic fallback. Same tools are used by both paths.
// ────────────────────────────────────────────────────────────
//
// States:
//   idle        — conversational; LLM (or heuristic) decides per turn
//   collecting  — deterministic doc collection flow for a launch service
//   reviewing   — all docs in; awaiting final confirmation
//   queued      — request inserted, citizen can ask status
//   claimed / in_progress — officer is handling; relay OTPs, etc.
//   completed   — done
//
// Only `idle` is LLM-driven. Submission is deterministic on purpose — it's
// a financial/document workflow that must be reliable, not creative.
// ────────────────────────────────────────────────────────────

import { db } from './db.js';
import { chat, chatWithTools, LLM_ENABLED } from './llm.js';
import { matchService, launchService, getServiceById, LAUNCH_SERVICES } from './catalogue.js';
import { TOOL_SPEC, TOOL_IMPL, TOOL_SPEC_V2, TOOL_IMPL_V2 } from './agent_tools.js';

// Agent v2 is the new unified tool-calling loop. Flip SANAD_AGENT_V2=true
// to route every turn through it (all states — no more scripted handlers).
// Default OFF so the existing pinned tests & heuristic flow are unaffected.
const AGENT_V2 = process.env.SANAD_AGENT_V2 === 'true';
const MAX_TOOL_ROUNDS_V2 = 6;

const SYSTEM_PROMPT = `You are **أحمد المساعد الذكي** ("Ahmed, the smart assistant") for Sanad-AI — the friendly assistant that helps citizens in Oman get their government paperwork done through the Sanad office network.

## Who you are
- Name: **أحمد المساعد الذكي** in Arabic, **Ahmed** in English. Always introduce yourself by this name.
- Tone: warm, respectful, concise — like a knowledgeable Omani friend who happens to know every gov service.
- Scope: every government service in Oman (3,400+ services across 50+ entities).

## Your mission (in this exact order)
1. **Identify the service** the user needs — search the catalogue, ask one clarifying question if ambiguous, confirm.
2. **Collect the required documents** — list what's needed, accept uploads one at a time, validate each one.
3. **Hand off to a Sanad office** — once docs are ready, queue the request so a licensed Sanad office can claim it and complete the paperwork on the citizen's behalf.

## CRITICAL: who actually processes the request
**Sanad offices process every request. Period.** You NEVER:
- forward the request to a ministry, the Royal Oman Police (ROP), the Ministry of Health, the municipality, or any government body directly.
- say "I'll send this to ROP / the ministry / the police".
- promise the user the gov entity will contact them.

What you DO say:
- Arabic: "سيتم إرسال طلبك إلى أحد مكاتب سند المعتمدة، وسيقوم موظف المكتب بإنهاء المعاملة نيابة عنك."
- English: "Your request will be sent to a licensed Sanad office, and an officer there will complete the paperwork on your behalf."

The gov entity in the catalogue (e.g. "Royal Oman Police") is the *issuer* of the service — useful context for the citizen, but Sanad offices are who they interact with.

## Hard rules
1. **One language per reply.** Mirror the user's script. Never mix mid-word. Never translate a service name — copy it verbatim from the tool output.
2. **Ground truth from tools only.** Every fee, document, entity, step you mention MUST come from a tool response in this conversation. If unsure, call search_services or get_service_details first.
3. **Show options when ambiguous.** confidence ≥ 0.75 → one top pick. confidence < 0.75 → top 2–3 numbered, with a short reason for each.
4. **Brevity.** 3 short sentences + a ≤5-item bullet list when listing docs. No preambles.
5. **No role-playing state.** You don't manage submission. When the user confirms ("yes", "نعم", "ابدأ"), call start_submission — the tool transitions state, not your prose.
6. **Supported deterministic flows:** drivers_licence_renewal, civil_id_renewal, passport_renewal, mulkiya_renewal, cr_issuance. For any other service, explain requirements from the tool result and tell the user a Sanad office can submit it for them.
7. **Small talk** (greetings/thanks/jokes): 1–2 warm sentences, no tool calls. Sign off with "كيف أقدر أساعدك؟" / "How can I help?"
8. **Formatting:** **bold** for service names. Fees as "X.XXX OMR" (en) or "X.XXX ريال عماني" (ar). End with one clear next-step question.
9. **Honesty:** if search returns zero results, say so plainly and ask a clarifying question. Never pad with tangential services.`;

const MAX_TOOL_ROUNDS = 4;

// ─── Session / message helpers ──────────────────────────────

export async function loadSession(session_id) {
  const { rows } = await db.execute({ sql: `SELECT state_json FROM session WHERE id=?`, args: [session_id] });
  if (!rows.length) {
    const state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await db.execute({ sql: `INSERT INTO session(id,state_json) VALUES (?,?)`, args: [session_id, JSON.stringify(state)] });
    return state;
  }
  return JSON.parse(rows[0].state_json || '{}');
}

export async function saveSession(session_id, state) {
  await db.execute({
    sql: `UPDATE session SET state_json=?, updated_at=datetime('now') WHERE id=?`,
    args: [JSON.stringify(state), session_id]
  });
}

export async function storeMessage({ session_id, request_id = null, direction, actor_type, body_text, media_url = null, meta = null, channel = 'web' }) {
  await db.execute({
    sql: `INSERT INTO message(session_id,request_id,direction,actor_type,body_text,media_url,meta_json,channel)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [session_id, request_id, direction, actor_type, body_text, media_url, meta ? JSON.stringify(meta) : null, channel]
  });
}

export async function ensureCitizen({ phone, name }) {
  const { rows } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
  if (rows.length) return rows[0].id;
  const r = await db.execute({ sql: `INSERT INTO citizen(phone,name) VALUES (?,?)`, args: [phone, name || null] });
  return Number(r.lastInsertRowid);
}

async function recentMessages(session_id, limit = 12) {
  const { rows } = await db.execute({
    sql: `SELECT direction, actor_type, body_text, created_at
            FROM message WHERE session_id=? ORDER BY id DESC LIMIT ?`,
    args: [session_id, limit]
  });
  return rows.reverse();
}

// ────────────────────────────────────────────────────────────
// MAIN ENTRY
// ────────────────────────────────────────────────────────────

// Per-session mutex: chain concurrent runTurn calls on the same session so
// that state reads + writes happen serially. Without this, two fast messages
// from the same citizen race on session.state_json — last-write-wins clobbers
// one turn's mutations, and start_submission / submit_request can fire twice.
// Messages still record in arrival order (storeMessage is sequential inside
// the lock), so the transcript never interleaves in, in, out, out.
const SESSION_LOCKS = new Map();

async function withSessionLock(session_id, fn) {
  const prev = SESSION_LOCKS.get(session_id) || Promise.resolve();
  // Swallow any rejection from the prior turn so one failure doesn't poison
  // the chain — each turn's own errors still surface via its own awaiter.
  const next = prev.catch(() => {}).then(() => fn());
  SESSION_LOCKS.set(session_id, next);
  try {
    return await next;
  } finally {
    // Drop the map entry if we're still the tail (no one queued behind us).
    if (SESSION_LOCKS.get(session_id) === next) SESSION_LOCKS.delete(session_id);
  }
}

export async function runTurn(args) {
  return withSessionLock(args.session_id, () => _runTurnLocked(args));
}

async function _runTurnLocked({ session_id, user_text, attachment, citizen_phone }) {
  const trace = [];
  let state = await loadSession(session_id);
  const raw = (user_text || '').trim();
  trace.push({ step: 'load_state', status: state.status });

  await storeMessage({
    session_id,
    direction: 'in',
    actor_type: 'citizen',
    body_text: raw || '(attachment)',
    media_url: attachment?.url || null
  });

  // ─── Agent v2 unified loop (opt-in) ────────────────────────
  // One tool-calling loop handles every state — discovery, confirm, collect,
  // cancel, etc. See lib/agent_tools.js::TOOL_SPEC_V2 for the tool surface.
  if (AGENT_V2 && LLM_ENABLED) {
    return await runAgentV2({ session_id, state, raw, attachment, citizen_phone, trace });
  }

  // If a file arrives while NOT in collecting state, infer intent from the
  // most recent bot turn: if it mentioned a launch service name, auto-start.
  // Otherwise give a helpful "I need a service first" reply instead of
  // dumping another search-result card.
  if (attachment && state.status !== 'collecting' && state.status !== 'reviewing') {
    const inferred = await inferLaunchFromRecent(session_id);
    if (inferred) {
      state.status = 'collecting';
      state.service_code = inferred;
      state.collected = {};
      state.pending_doc_index = 0;
      // Treat the attachment as the first document
      return await finishAttachmentTurn({ session_id, state, attachment, trace });
    }
    const reply = 'استلمت المرفق 📎 — لكن لم نبدأ بعد أي معاملة. أخبرني الخدمة التي تريدها أولاً (مثل: "تجديد رخصة القيادة")، ثم أستلم المستندات.';
    await saveSession(session_id, state);
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return { reply, state, trace };
  }

  // Global commands
  if (raw === '/reset') {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await saveSession(session_id, state);
    const reply = '🔁 Session reset. Ask me anything — I can help with 3,422 Oman gov services.';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return { reply, state, trace };
  }
  if (raw === '/state') {
    const reply = '```\n' + JSON.stringify(state, null, 2) + '\n```';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return { reply, state, trace };
  }

  // ─── State router ────────────────────────────────────────
  let reply, request_id = state.request_id || null;

  if (state.status === 'collecting') {
    ({ reply, state } = await handleCollecting({ session_id, state, raw, attachment, trace }));
  } else if (state.status === 'reviewing') {
    ({ reply, state, request_id } = await handleReviewing({ session_id, state, raw, trace, citizen_phone }));
  } else if (state.status === 'confirming') {
    ({ reply, state } = await handleConfirming(state, raw, trace));
  } else if (state.status === 'queued' || state.status === 'claimed' || state.status === 'in_progress') {
    ({ reply, state } = await handleInFlight({ state, raw, trace }));
  } else if (state.status === 'completed') {
    reply = 'معاملتك السابقة مكتملة ✅ لطلب جديد اكتب "خدمة أخرى".\nYour previous request is done. Say "new service" to start another.';
    if (/new service|خدمة أخرى|reset/i.test(raw)) { state = { status: 'idle', collected: {}, pending_doc_index: 0 }; reply = 'جاهز — ماذا تحتاج؟'; }
  } else {
    // idle
    ({ reply, state } = await handleIdle({ session_id, state, raw, trace }));
  }

  await saveSession(session_id, state);
  await storeMessage({ session_id, request_id, direction: 'out', actor_type: 'bot', body_text: reply });
  trace.push({ step: 'saved', status: state.status });

  return { reply, state, trace, request_id };
}

// ────────────────────────────────────────────────────────────
// IDLE — LLM tool-calling loop (preferred) or heuristic fallback
// ────────────────────────────────────────────────────────────

async function handleIdle({ session_id, state, raw, trace }) {
  if (!raw) return { reply: welcomeMessage(), state };

  if (LLM_ENABLED) {
    return await runLLMLoop({ session_id, state, raw, trace });
  }
  return await runHeuristic({ state, raw, trace });
}

async function runLLMLoop({ session_id, state, raw, trace }) {
  const history = await recentMessages(session_id, 12);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({
      role: m.actor_type === 'citizen' ? 'user' : m.actor_type === 'bot' ? 'assistant' : 'system',
      content: m.body_text || ''
    })),
    { role: 'user', content: raw }
  ];

  let submissionStarted = null; // if set: { code }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await chatWithTools({ messages, tools: TOOL_SPEC, trace });
    if (!tool_calls || tool_calls.length === 0) {
      // If the LLM started a submission this turn, override its reply with
      // the deterministic first-doc prompt so we never leak into fake flows.
      if (submissionStarted) {
        return { reply: firstDocPrompt(submissionStarted.code), state };
      }
      return { reply: sanitizeReply(content, raw) || '…', state };
    }
    // Run each tool and append back to the LLM
    messages.push({ role: 'assistant', content: content || null, tool_calls });
    for (const tc of tool_calls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const impl = TOOL_IMPL[name];
      const result = impl ? await impl(args) : { ok: false, error: 'no_such_tool' };
      trace.push({ step: 'tool', name, args, ok: result?.ok, count: result?.count });

      // SIDE EFFECT: start_submission transitions directly to collecting.
      // We remember it so we can override the LLM's final reply below.
      if (name === 'start_submission' && result?.ok) {
        state.status = 'collecting';
        state.service_code = result.service_code;
        state.collected = {};
        state.pending_doc_index = 0;
        submissionStarted = { code: result.service_code };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 4000)
      });
    }
    // If submission was started, short-circuit the loop — skip extra LLM rounds.
    if (submissionStarted) {
      return { reply: firstDocPrompt(submissionStarted.code), state };
    }
  }
  const last = await chatWithTools({ messages, tools: [], trace });
  return { reply: sanitizeReply(last.content, raw) || 'جرب سؤالاً محدداً.', state };
}

function firstDocPrompt(service_code) {
  const s = launchService(service_code);
  if (!s) return 'بدأنا الخدمة ✅ سأطلب المستندات الواحد تلو الآخر.';
  const d = s.required_documents[0];
  const total = s.required_documents.length;
  return `ممتاز، بدأنا تقديم **${s.name_ar}** ✅
أحتاج منك ${total} مستندات. أولها:

📄 **${d.label_ar}** / ${d.label_en}

ارسلها كصورة أو PDF.`;
}

// Post-process LLM reply: strip mid-word language switches like "إ issuance",
// drop excessive length, enforce one-language output.
function sanitizeReply(text, userText) {
  if (!text) return text;
  let t = String(text);
  // Collapse single Arabic letters glued to English words: "إ issuance" → "issuance"
  t = t.replace(/(^|\s)([\u0600-\u06FF])\s+([A-Za-z]{3,})/g, '$1$3');
  // Same for the reverse rare case
  t = t.replace(/([A-Za-z]{3,})\s+([\u0600-\u06FF])(\s|$)/g, '$1$3');
  // Trim extremely long replies (> 900 chars) to the first 3 paragraphs
  if (t.length > 900) {
    const paras = t.split(/\n\s*\n/).slice(0, 3);
    t = paras.join('\n\n');
  }
  return t.trim();
}

// ─── Heuristic fallback (no LLM) ────────────────────────────
// Still uses the same tools. Just does rule-based routing + nice templates.

async function runHeuristic({ state, raw, trace }) {
  const low = raw.toLowerCase();

  if (/^(hi|hello|hey|salam|hola|yo|مرحب|السلام|اهلا|أهلا|هاي|هلا)/i.test(low))
    return { reply: welcomeMessage(), state };
  if (/^(help|\?|مساعده|مساعدة|قدراتك|ماذا تفعل|what can)/i.test(low))
    return { reply: helpMessage(), state };
  if (/^(thanks|thank you|thx|شكر|مشكور|يعطيك|تسلم)/i.test(low))
    return { reply: 'العفو 🤍 أي شيء ثاني أقدر أساعدك فيه؟\nYou\'re welcome — anything else?', state };
  if (/^(list|menu|قائمة|قائمه|الجهات|ministries|entities|show)$/i.test(low)) {
    const { entities } = await TOOL_IMPL.list_entities();
    const top = entities.slice(0, 8)
      .map((e, i) => `${i + 1}. ${e.entity_en} · ${e.n} services`).join('\n');
    return { reply: `📋 Top ministries by service count:\n\n${top}\n\nSay "ROP services" or "خدمات وزارة الصحة" to see services.`, state };
  }

  // Entity browse
  const entMatch = raw.match(/^(?:show|list)\s+(.+?)\s+services?\s*$/i)
                || raw.match(/^(.+?)\s+services?\s*$/i)
                || raw.match(/^خدمات\s+(.+?)\s*$/);
  if (entMatch) {
    const { entity, services } = await TOOL_IMPL.get_entity_services({ entity: entMatch[1], limit: 10 });
    if (services.length) {
      state.last_candidates = services.map(s => s.id);
      const lines = services.map((s, i) =>
        `${i + 1}. ${s.name_en || s.name_ar}${s.fee_omr ? ` · ${s.fee_omr} OMR` : ''}`
      ).join('\n');
      return { reply: `🏛 **${entity}** — ${services.length} services:\n\n${lines}\n\nType a number for details.`, state };
    }
  }

  // Numbered pick from last candidates
  const picked = parseInt(raw, 10);
  if (!isNaN(picked) && state.last_candidates?.[picked - 1]) {
    const { service } = await TOOL_IMPL.get_service_details({ service_id: state.last_candidates[picked - 1] });
    if (service) return presentServiceReply(service, state, raw);
  }

  // Search
  const result = await TOOL_IMPL.search_services({ query: raw, limit: 5 });
  trace.push({ step: 'heuristic_search', count: result.count });

  if (result.count === 0) {
    return {
      reply: `لم أتعرف على "${raw}" تماماً. جرب:\n\n• "تجديد رخصة القيادة"\n• "passport renewal"\n• "خدمات شرطة عمان السلطانية"\n• "help" — for all my capabilities`,
      state
    };
  }
  if (result.launch_code) {
    const s = LAUNCH_SERVICES[result.launch_code];
    state.status = 'confirming';
    state.service_code = result.launch_code;
    const docs = s.required_documents.map(d => `• ${d.label_ar} / ${d.label_en}`).join('\n');
    return {
      reply: `هل تقصد: **${s.name_ar}** (${s.entity_ar})؟\nالرسوم: ${s.fee_omr.toFixed(3)} ريال عماني.\nالمستندات المطلوبة:\n${docs}\n\n👉 اكتب **نعم** لبدء التقديم، أو اسأل سؤالاً عن الخدمة.`,
      state
    };
  }
  if (result.confidence >= 0.6 && result.services[0]) {
    const { service } = await TOOL_IMPL.get_service_details({ service_id: result.services[0].id });
    return presentServiceReply(service, state, raw);
  }
  // multiple ambiguous
  state.last_candidates = result.services.map(s => s.id);
  const lines = result.services.map((s, i) =>
    `${i + 1}. **${s.name_en}**${s.entity_en ? ` — ${s.entity_en}` : ''}${s.fee_omr ? ` · ${s.fee_omr} OMR` : ''}`
  ).join('\n');
  return {
    reply: `Found ${result.count} candidates — pick a number for details:\n\n${lines}`,
    state
  };
}

function presentServiceReply(service, state, raw) {
  const isAr = /[\u0600-\u06FF]/.test(raw);
  state.active_service_id = service.id;
  // Launch services → confirming so "yes" starts collection; others stay idle
  // so the next user turn re-matches freely against the catalogue.
  state.status = service.can_submit ? 'confirming' : 'idle';
  if (service.can_submit) {
    const code = Object.entries(LAUNCH_SERVICES).find(([, s]) => s.name_en === service.name_en)?.[0];
    if (code) state.service_code = code;
  }
  const name = isAr ? (service.name_ar || service.name_en) : (service.name_en || service.name_ar);
  const entity = isAr ? (service.entity_ar || service.entity_en) : (service.entity_en || service.entity_ar);
  const desc = isAr ? service.description_ar : service.description_en;
  const docs = (service.required_documents || []).slice(0, 6).map(d => `• ${d}`).join('\n') || '—';
  const fee = service.fee_omr != null ? `${service.fee_omr} OMR` : (service.fees_text || '—');
  const footer = service.can_submit
    ? (isAr ? '\n\n👉 اكتب **نعم** لبدء التقديم عبر مكاتب سند.' : '\n\n👉 Type **yes** and I\'ll start the submission via a Sanad office.')
    : (isAr ? '\n\n💡 هذه الخدمة للاستعلام فقط حالياً — زُر مكتب سند للتقديم.' : '\n\n💡 This is info-only for now — visit a Sanad office to submit.');
  return {
    reply: `**${name}**\n${entity || ''}\n${desc ? '\n' + desc.slice(0, 200) + '\n' : ''}\n💰 ${fee}\n📎 ${isAr ? 'المستندات' : 'Required docs'}:\n${docs}${footer}`,
    state
  };
}

// ────────────────────────────────────────────────────────────
// Deterministic submission flow
// ────────────────────────────────────────────────────────────

async function handleConfirming(state, raw, trace) {
  const t = (raw || '').trim();
  const low = t.toLowerCase();

  // Global exits first
  if (/^(\/?reset|new service|خدمة أخرى|menu|start over)$/i.test(t)) {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: 'جاهز — أخبرني بأي خدمة أخرى تحتاجها.', state };
  }

  // Greetings / help / thanks ALWAYS pop back to idle — don't let a stale
  // confirming state intercept a fresh "hello".
  if (/^(hi|hello|hey|salam|hola|مرحب|السلام|اهلا|أهلا|هاي|هلا)/i.test(low)) {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: welcomeMessage(), state };
  }
  if (/^(help|\?|مساعده|مساعدة|قدراتك|what can)\b/i.test(low)) {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: helpMessage(), state };
  }
  if (/^(thanks|thank you|thx|ty|شكر|مشكور|يعطيك|تسلم)\b/i.test(low)) {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: 'العفو 🤍 أي شيء ثاني أقدر أساعدك فيه؟\nYou\'re welcome — anything else?', state };
  }
  if (/^(لا|no|cancel|إلغاء|stop|nope)\b/i.test(t)) {
    state.status = 'idle'; delete state.service_code;
    return { reply: 'تمام، ألغيت. اسألني عن أي خدمة أخرى.', state };
  }
  // "yes" at the start of the message is enough — accept trailing words
  if (/^(نعم|ايوه|yes|yeah|yep|y|ok|okay|sure|go|ابدأ|ابدا|start|proceed|submit|confirm|تأكيد|تاكيد)\b/i.test(t)) {
    state.status = 'collecting';
    state.pending_doc_index = 0;
    state.collected = {};
    const s = launchService(state.service_code);
    return {
      reply: `ممتاز، بنبدأ ✅\nابعث أولاً: **${s.required_documents[0].label_ar}** / ${s.required_documents[0].label_en}.`,
      state
    };
  }

  // Free-form question about the SAME service — answer using the launch-service
  // data as context; do NOT re-search the catalogue (that loses state).
  const s = launchService(state.service_code);
  if (s) {
    const { answerAboutService } = await import('./llm.js');
    const fakeRow = {
      name_en: s.name_en, name_ar: s.name_ar,
      entity_en: s.entity_en, entity_ar: s.entity_ar,
      fees_text: `${s.fee_omr} OMR`, fee_omr: s.fee_omr,
      required_documents_json: JSON.stringify(s.required_documents),
      description_en: '', description_ar: '', source_url: ''
    };
    const lang = /[\u0600-\u06FF]/.test(t) ? 'ar' : 'en';
    const reply = await answerAboutService({ user_question: t, service: fakeRow, lang, trace });
    return { reply: reply + '\n\n↩ اكتب **نعم** للبدء في التقديم أو اسأل أي سؤال آخر.', state };
  }
  return { reply: 'اكتب **نعم** للبدء أو **لا** للإلغاء.', state };
}

async function handleCollecting({ session_id, state, raw, attachment, trace }) {
  const s = launchService(state.service_code);
  if (!s) { state.status = 'idle'; return { reply: 'حدث خطأ — ابدأ من جديد.', state }; }

  // Global exits
  const low = (raw || '').trim().toLowerCase();
  if (/^(\/?reset|cancel|إلغاء|خدمة أخرى|new service|stop)$/i.test(raw || '')) {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: 'تمام، توقفنا. اسألني عن خدمة أخرى.', state };
  }
  // Greetings / help pop back to idle (but warn the user they had a flow in progress)
  if (!attachment && /^(hi|hello|hey|salam|مرحب|السلام|اهلا|أهلا|help|مساعده|مساعدة)/i.test(low)) {
    const keep = state.pending_doc_index;
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    return { reply: `أهلاً بك 👋 أوقفت عملية جمع المستندات (كنت عند الخطوة ${keep + 1}). أخبرني ماذا تحتاج.`, state };
  }

  if (attachment) {
    // Try to infer which required doc this upload maps to, using caption/filename
    // hints. If we can't infer confidently, fall back to the next pending slot.
    const caption = (attachment.caption || '').toString();
    const inferred = matchDocByCaption(caption, s.required_documents, state.collected);
    const targetDoc = inferred || s.required_documents[state.pending_doc_index];
    if (!targetDoc) {
      // All slots filled already — shouldn't normally happen
      state.status = 'reviewing';
      return { reply: buildReviewSummary(s, state), state };
    }

    const wasExpected = (targetDoc.code === s.required_documents[state.pending_doc_index]?.code);
    state.collected[targetDoc.code] = {
      url: attachment.url, mime: attachment.mime, size: attachment.size,
      name: attachment.name || null,
      caption: caption || null, matched_via: inferred ? 'caption' : 'order'
    };

    // Advance pending index past any slots now filled
    while (state.pending_doc_index < s.required_documents.length
           && state.collected[s.required_documents[state.pending_doc_index].code]) {
      state.pending_doc_index += 1;
    }

    const next = s.required_documents[state.pending_doc_index];
    const ack = inferred && !wasExpected
      ? `✅ استلمنا **${targetDoc.label_ar}** (تعرفنا عليها من الوصف).`
      : `✅ استلمنا **${targetDoc.label_ar}**.`;

    if (next) {
      return { reply: `${ack}\nالآن ابعث: **${next.label_ar}** / ${next.label_en}.`, state };
    }
    // All docs collected
    state.status = 'reviewing';
    return { reply: `${ack}\n\n${buildReviewSummary(s, state)}`, state };
  }

  // Text reply while waiting for a file — accept a skip/done signal before nudging
  if (/^(تم|خلص|done|finished|finish|that.?s all)$/i.test(low)) {
    if (Object.keys(state.collected).length >= 1) {
      state.status = 'reviewing';
      return { reply: buildReviewSummary(s, state), state };
    }
  }
  const doc = s.required_documents[state.pending_doc_index];
  return { reply: `محتاجين **${doc.label_ar}** (${doc.label_en}). ابعثها كصورة أو PDF.`, state };
}

// Score each required doc against caption/filename keywords; return the
// highest-scoring doc that hasn't been collected yet, or null.
function matchDocByCaption(caption, requiredDocs, collected) {
  if (!caption) return null;
  const cap = caption.toLowerCase();
  let best = null, bestScore = 0;
  for (const d of requiredDocs) {
    if (collected[d.code]) continue; // already filled
    const hints = DOC_CAPTION_HINTS[d.code] || [];
    // Also use the doc's own label words as additional hints
    const labelWords = `${d.label_en || ''} ${d.label_ar || ''}`
      .toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    const allHints = [...hints, ...labelWords];
    let score = 0;
    for (const h of allHints) {
      if (h && cap.includes(h.toLowerCase())) score += h.length >= 6 ? 2 : 1;
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  // Require at least 2 matching chars of signal to avoid false positives on
  // single-letter overlaps.
  return bestScore >= 2 ? best : null;
}

// Doc-code → caption keywords (EN + AR) used to auto-map uploads to slots.
const DOC_CAPTION_HINTS = {
  civil_id:       ['civil id','civil-id','id card','national id','بطاقة','مدنية','الهوية','البطاقة الشخصية'],
  medical:        ['medical','fitness','health form','فحص طبي','طبي','الصحة'],
  photo:          ['photo','picture','selfie','portrait','صورة شخصية','صورة'],
  old_id_photo:   ['old id','existing id','current id','البطاقة الحالية','بطاقتي القديمة'],
  old_passport:   ['passport','current passport','جواز','الجواز','باسبور'],
  mulkiya:        ['mulkiya','vehicle','registration','car reg','ملكية','المركبة','رخصة السيارة'],
  insurance:      ['insurance','policy','تأمين','بوليصة'],
  activity_list:  ['activity','activities','business list','أنشطة','النشاط','قائمة الأنشطة'],
  tenancy:        ['tenancy','lease','rental','rent contract','إيجار','عقد الإيجار'],
  address_map:    ['map','location','address','خريطة','موقع','العنوان']
};

function buildReviewSummary(s, state) {
  const summary = s.required_documents
    .filter(d => state.collected[d.code])
    .map(d => `• ${d.label_ar} ✓`).join('\n');
  return `كل المستندات وصلت ✅\n${summary}\n\nالرسوم الإجمالية: **${s.fee_omr.toFixed(3)} ريال**.\nاكتب **نعم** أو **تأكيد** لإرسال الطلب إلى مكاتب سند (أو **إلغاء** للرجوع).`;
}

async function handleReviewing({ session_id, state, raw, trace, citizen_phone }) {
  const t = (raw || '').toLowerCase().trim();
  // Accept any reasonable affirmation — no strict "تأكيد" needed.
  // Note: \b doesn't work at end of Arabic words (both sides are \W in JS regex),
  // so we match anywhere inside the text — same as the original permissive behaviour.
  const confirmRe = /(تأكيد|تاكيد|confirm|نعم|ايوه|ايوا|أيوا|yes|yeah|yep|yup|ok|okay|sure|submit|proceed|ابعث|أرسل|ارسل|خلاص|تمام|tamam)/i;
  if (confirmRe.test(t)) {
    const s = launchService(state.service_code);
    const serviceRow = await ensureCatalogueRow(state.service_code, s);
    const citizen_id = citizen_phone ? await ensureCitizen({ phone: citizen_phone }) : null;
    const ins = await db.execute({
      sql: `INSERT INTO request(session_id,citizen_id,service_id,status,fee_omr,governorate,state_json)
            VALUES (?,?,?, 'ready', ?, ?, ?)`,
      args: [session_id, citizen_id, serviceRow, s.fee_omr, 'Muscat', JSON.stringify(state)]
    });
    const request_id = Number(ins.lastInsertRowid);
    for (const [code, f] of Object.entries(state.collected)) {
      const d = s.required_documents.find(x => x.code === code);
      await db.execute({
        sql: `INSERT INTO request_document
                (request_id,doc_code,label,storage_url,mime,size_bytes,status,
                 caption,matched_via,original_name)
              VALUES (?,?,?,?,?,?, 'pending', ?,?,?)`,
        args: [
          request_id, code, d?.label_en || code, f.url, f.mime || null, f.size || null,
          f.caption || null, f.matched_via || 'order', f.name || null
        ]
      });
    }
    state.status = 'queued';
    state.request_id = request_id;
    return {
      reply: `تم ✅ طلبك **#R-${request_id}** في انتظار أحد مكاتب سند. سأخبرك بمجرد أن يستلمه موظف.`,
      state,
      request_id
    };
  }
  if (/(إلغاء|cancel|back)/i.test(t)) {
    state.status = 'idle'; state.collected = {}; state.pending_doc_index = 0;
    return { reply: 'ألغيت الطلب. اسأل عن خدمة أخرى وقت ما تريد.', state };
  }
  return { reply: 'اكتب **تأكيد** لإرسال الطلب أو **إلغاء** للرجوع.', state };
}

async function handleInFlight({ state, raw, trace }) {
  const t = (raw || '').trim();
  // OTP forwarding
  const otpMatch = t.match(/\b(\d{4,6})\b/);
  if (otpMatch) {
    const { rows } = await db.execute({
      sql: `SELECT id FROM otp_window WHERE request_id=? AND consumed_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
      args: [state.request_id]
    });
    if (rows.length) {
      await db.execute({
        sql: `UPDATE otp_window SET code=?, consumed_at=datetime('now') WHERE id=?`,
        args: [otpMatch[1], rows[0].id]
      });
      return { reply: '✅ استلمنا الرمز — الموظف يكمل الآن.', state };
    }
  }
  if (/(حالة|status)/i.test(t)) {
    const { request } = await TOOL_IMPL.get_request_status({ request_id: state.request_id });
    if (!request) return { reply: 'ما لقيت طلبك — جرب مجدداً.', state };
    return { reply: `📄 طلب **#R-${request.id}** — الحالة: **${request.status}**\nالرسوم: ${request.fee_omr} OMR\n${request.office_name ? 'المكتب: ' + request.office_name : 'بانتظار مكتب يستلم…'}`, state };
  }
  return { reply: 'شكراً — الموظف سيتابع معك قريباً. اكتب "status" لمعرفة آخر التحديثات.', state };
}

// ────────────────────────────────────────────────────────────
// Canned messages
// ────────────────────────────────────────────────────────────

function welcomeMessage() {
  return `👋 أهلاً بك! أنا **أحمد المساعد الذكي** — شات بوت سند-AI لجميع الخدمات الحكومية في سلطنة عُمان.

مهمتي:
1. أساعدك تحدّد الخدمة اللي تحتاجها
2. أجمع معك المستندات المطلوبة
3. أرسل ملفك إلى أحد **مكاتب سند المعتمدة** ليكمل الموظف المعاملة نيابةً عنك

جرّب:
• "تجديد رخصة القيادة"
• "كم رسوم تجديد جواز السفر؟"
• "ماذا أحتاج لإصدار سجل تجاري؟"

عندي **3,400+ خدمة** عبر 50 جهة. تفضّل، كيف أقدر أساعدك؟

───
👋 Hi! I'm **Ahmed**, your Sanad-AI smart assistant. I help you pick the right service, gather the required documents, and route everything to a licensed **Sanad office** — an officer there finishes the paperwork on your behalf. Ask me anything.`;
}

function helpMessage() {
  return `أنا **أحمد** — مساعدك الذكي في سند-AI. أستطيع:

1️⃣ **البحث** — اكتب اسم الخدمة أو ما تحتاجه
2️⃣ **الإجابة** — "كم الرسوم؟"، "شو المستندات؟"
3️⃣ **تصفح حسب الجهة** — "خدمات شرطة عمان السلطانية"، "خدمات وزارة الصحة"
4️⃣ **تجهيز الطلب** — أساعدك تجمع المستندات وأرسل ملفك إلى **مكتب سند معتمد** يتولى التنفيذ

📌 ملاحظة: كل المعاملات تُنجَز عبر مكاتب سند المعتمدة — لست بحاجة للذهاب لأي جهة حكومية بنفسك.

أوامر: \`/reset\` — جلسة جديدة · \`/state\` — حالة الجلسة

💡 اسألني بحرية.`;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

// Look at the last bot message and see if it clearly referred to one of the
// launch services by name. If so, return the code; else null.
async function inferLaunchFromRecent(session_id) {
  const { rows } = await db.execute({
    sql: `SELECT body_text FROM message WHERE session_id=? AND actor_type='bot' ORDER BY id DESC LIMIT 3`,
    args: [session_id]
  });
  const hay = rows.map(r => r.body_text || '').join(' ').toLowerCase();
  for (const [code, s] of Object.entries(LAUNCH_SERVICES)) {
    if (hay.includes(s.name_en.toLowerCase()) || hay.includes(s.name_ar)) return code;
    // Also match individual keywords (rare, but covers the "I said start" hallucination case)
    for (const k of s.match_keywords) {
      if (hay.includes(k.toLowerCase())) return code;
    }
  }
  return null;
}

async function finishAttachmentTurn({ session_id, state, attachment, trace }) {
  const { reply, state: newState } = await handleCollecting({ session_id, state, raw: '', attachment, trace });
  await saveSession(session_id, newState);
  await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
  return { reply, state: newState, trace };
}

async function ensureCatalogueRow(code, s) {
  const { rows } = await db.execute({
    sql: `SELECT id FROM service_catalog WHERE name_en=? LIMIT 1`, args: [s.name_en]
  });
  if (rows.length) return rows[0].id;
  const r = await db.execute({
    sql: `INSERT INTO service_catalog(entity_en,entity_ar,name_en,name_ar,fee_omr,required_documents_json,is_active)
          VALUES (?,?,?,?,?,?,1)`,
    args: [s.entity_en, s.entity_ar, s.name_en, s.name_ar, s.fee_omr, JSON.stringify(s.required_documents)]
  });
  return Number(r.lastInsertRowid);
}

// re-export old name so state handler works with LLM tool-call transitions
export { handleConfirming };

// ────────────────────────────────────────────────────────────
// AGENT V2 — unified tool-calling loop for EVERY state
// ────────────────────────────────────────────────────────────

const SYSTEM_V2 = `You are **أحمد المساعد الذكي** ("Ahmed, the smart assistant") — a warm, precise assistant for ALL 3,400+ Oman government services, powered by Sanad-AI.

## Your mission (in this exact order)

1. **Identify the service** the user needs — through natural conversation, search, and clarifying questions.
2. **Collect the required documents** for that service so the file is complete before submission.
3. **Hand off to a licensed Sanad office** that will complete the paperwork on the citizen's behalf.

That's it. You don't *do* the transaction — you prepare the file and route it to a Sanad office.

## CRITICAL: who actually processes the request

**Sanad offices process every single request. Period.** This is the foundation of the product. You NEVER:
- forward / send / transfer the request to a ministry, the Royal Oman Police (ROP), the Ministry of Health, the municipality, the Civil Status Department, or any government body directly.
- say "I'll send this to ROP / the ministry / the police / the embassy".
- imply the citizen will go to a government counter — they go to a **Sanad office**.

What you DO say:
- Arabic: "سيتم إرسال طلبك إلى أحد مكاتب سند المعتمدة، وسيقوم موظف المكتب بإنهاء المعاملة نيابة عنك."
- English: "Your request will be sent to a licensed Sanad office, and an officer there will complete the paperwork on your behalf."

You may *mention* the issuing entity (e.g. "this is a ROP service") for context — that is NOT the same as routing to them. Always clarify the actual handler is a Sanad office.

## Core rules (violating any of these breaks the product)

1. **One language per reply.** Mirror the user's script — Arabic in → Arabic out, English in → English out. Never mix mid-sentence.

2. **STRICT GROUNDING — facts come ONLY from tool results in this conversation.**
   - Fees: quote \`fee_omr\` or \`fees_text\` exactly. If both are null/empty → say "the fee is not listed" / "الرسوم غير مدرجة".
   - Duration: only from \`avg_time_en/ar\` or \`working_time_en/ar\`. Never invent "3 working days".
   - Required documents: ONLY from \`required_documents_json\`. If the list is empty or missing → say "no documents are listed in the catalogue for this service — please check with the office" / "لا توجد مستندات مدرجة — يرجى التأكد من المكتب". NEVER generalise from other services (don't add "recent photo / passport copy / birth certificate" unless THIS row has them).
   - Entity: use \`entity_en/ar\` verbatim.
   - Channels: only from \`channels\`. Don't claim "available on Sanad" unless the row says so.
   - If the user asks a detail you don't have in memory, call \`get_service_details\` before answering. Never guess.

3. **Use tools for state transitions.** The session state is controlled by tool returns ONLY. Don't write "I've started your application" unless start_submission just succeeded. Don't say "cancelled" unless cancel_request returned ok=true.

4. **Confirm irreversible actions before calling them.** cancel_request, accept_offer, submit_request — ask the user to confirm first in your reply, THEN call the tool on the next turn.

5. **Brevity.** 3 short sentences + a <=5-item bullet list. Use **bold** for service names. Fees: "X.XXX OMR" / "X.XXX ريال".

## Flow rules

- Unknown intent → call search_services. Use filters (entity, beneficiary, free, is_launch, max_fee_omr) whenever the user hints at them.
- Ambiguous match (≥2 plausible options) → list 2–3 choices, ask the user to pick.
- Strong match + user signals intent to apply → describe briefly then call start_submission(service_id).
- After start_submission: summarize fee + required docs, then wait for a clear "yes" before confirm_submission.
- After confirm_submission: walk through docs one at a time. When the user sends a file or names a doc, call record_document(doc_code, caption).
- When all docs recorded the tool transitions to "reviewing" — ask user to confirm the total, then call submit_request.
- After submit_request returns ok, the request is queued. For further mgmt (status, cancel, accept offer) the user must reference the request_id OR you can use get_my_requests.

## Cancel semantics

- ready / queued → hard cancel (outcome: hard_cancelled).
- claimed / in_progress → soft cancel (outcome: cancel_requested). Tell the user: "I notified the office — they'll confirm shortly."

## Supported scope

Every service in the catalogue can be submitted (no 5-code allowlist). The is_launch=1 flag just hints at which ones have the slickest flow.

## Small talk

Greetings / thanks / "help" → 1–2 warm sentences, no tool calls, end with "How can I help?" / "كيف أقدر أساعدك؟"`;

// Render a compact state summary injected before every LLM turn so the
// model never has to guess which state it's in.
function renderStateContext(state) {
  const bits = [`status=${state.status}`];
  if (state.service_id) bits.push(`service_id=${state.service_id}`);
  if (state.request_id) bits.push(`request_id=${state.request_id}`);
  if (state.docs?.length) {
    const collected = Object.keys(state.collected || {});
    bits.push(`docs_collected=${collected.length}/${state.docs.length}`);
    if (state.status === 'collecting') {
      const next = state.docs[state.pending_doc_index ?? 0];
      if (next) bits.push(`next_doc=${next.code}:${next.label_en}`);
    }
  }
  return `\n\n## Current session\n${bits.join(' · ')}\n`;
}

async function runAgentV2({ session_id, state, raw, attachment, citizen_phone, trace }) {
  // Global slash commands stay deterministic (same as v1).
  if (raw === '/reset') {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await saveSession(session_id, state);
    const reply = '🔁 Session reset. كيف أقدر أساعدك؟ / How can I help?';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return { reply, state, trace };
  }
  if (raw === '/state') {
    const reply = '```\n' + JSON.stringify(state, null, 2) + '\n```';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return { reply, state, trace };
  }

  // Build the message stack.
  //
  // History window: 30 turns. Qwen-plus has a 128k context window — 30 short
  // messages is ~3 KB, nowhere near the ceiling. Lets the LLM remember
  // multi-service exploration ("compare X and Y, then Z; which was cheapest?").
  const history = await recentMessages(session_id, 30);
  const messages = [
    { role: 'system', content: SYSTEM_V2 + renderStateContext(state) },
    ...history.map(m => ({
      role: m.actor_type === 'citizen' ? 'user' : m.actor_type === 'bot' ? 'assistant' : 'system',
      content: m.body_text || ''
    }))
  ];
  // Replay the most recent tool snapshot (cached in state.last_tool) so the LLM
  // can cite specific IDs / fees / docs without re-calling. Only one hop back
  // — further history is already summarized via assistant messages. Keeps the
  // grounding rule enforceable: the LLM sees the exact JSON it last received.
  if (state.last_tool?.name && state.last_tool?.result) {
    messages.push({
      role: 'system',
      content: `## Recent tool output (previous turn)\ntool=${state.last_tool.name}\nresult=${JSON.stringify(state.last_tool.result).slice(0, 2000)}`
    });
  }
  if (raw) messages.push({ role: 'user', content: raw });
  if (attachment) {
    // Surface enough for the LLM to pick the right doc_code — but the URL and
    // mime stay out of the prompt; record_document reads them straight off ctx.
    messages.push({
      role: 'user',
      content: `[Attachment uploaded: name="${attachment.name || 'file'}", mime=${attachment.mime || 'unknown'}, size=${attachment.size || 0}B${raw ? `, caption="${raw}"` : ''}] — call record_document(doc_code, caption) with the matching doc slot.`
    });
  }

  // ctx.attachment lets record_document pull the real storage_url / mime / size
  // so the officer dashboard can preview + download the file. Cleared inside
  // the tool after it's consumed — prevents double-recording on loop retries.
  const ctx = { session_id, state, trace, citizen_phone, attachment: attachment || null };
  let finalReply = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS_V2; round++) {
    const { content, tool_calls } = await chatWithTools({
      messages, tools: TOOL_SPEC_V2, trace, max_tokens: 700
    });
    if (!tool_calls || tool_calls.length === 0) {
      finalReply = sanitizeReply(content, raw) || '…';
      break;
    }
    messages.push({ role: 'assistant', content: content || null, tool_calls });
    for (const tc of tool_calls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const impl = TOOL_IMPL_V2[name];
      const result = impl
        ? await impl(ctx, args)
        : { ok: false, error: 'no_such_tool', tool: name };
      trace.push({ step: 'tool_v2', name, args, ok: result?.ok, transition: result?.transition });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 4000)
      });
      // Cache informational tool results on state.last_tool so the NEXT turn
      // can replay them. Only cache retrieval tools — skip state-mutation ones
      // whose result reflects a now-stale state (start_submission etc.).
      const CACHEABLE = new Set(['search_services', 'get_service_details',
        'list_entities', 'list_categories', 'get_entity_services',
        'compare_services', 'get_request_status', 'get_my_requests',
        'list_offers', 'get_session_state']);
      if (CACHEABLE.has(name) && result?.ok !== false) {
        ctx.state.last_tool = { name, args, result, at: Date.now() };
      }
    }
  }

  if (!finalReply) {
    // Loop exhausted — make one last no-tools call to turn tool output into prose.
    const last = await chatWithTools({ messages, tools: [], trace, max_tokens: 500 });
    finalReply = sanitizeReply(last.content, raw) || 'عذراً، لم أكمل — حاول مجدداً. / Sorry, try again.';
  }

  // Persist + record bot turn. request_id may have been set by submit_request
  // or accept_offer mid-loop — pull it from state.
  await saveSession(session_id, ctx.state);
  await storeMessage({
    session_id, request_id: ctx.state.request_id || null,
    direction: 'out', actor_type: 'bot', body_text: finalReply
  });
  trace.push({ step: 'v2_saved', status: ctx.state.status });

  return { reply: finalReply, state: ctx.state, trace, request_id: ctx.state.request_id || null };
}

export { runAgentV2 };
