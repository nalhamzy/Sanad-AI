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
import { TOOL_SPEC, TOOL_IMPL } from './agent_tools.js';

const SYSTEM_PROMPT = `You are Sanad-AI — a warm, precise assistant for Oman government services.

HARD RULES (breaking any of these ruins the user experience):

1. LANGUAGE PURITY — Reply in ONE language per message. If the user wrote Arabic, reply fully in Arabic. If English, fully English. NEVER mix scripts mid-word. NEVER translate a service name — copy it verbatim from the tool output.

2. GROUND TRUTH — Every fee, document, entity or process step you mention MUST come from a tool response in THIS conversation. If it isn't in a tool result, you MUST NOT say it. If you're unsure, call search_services or get_service_details first.

3. SHOW MULTIPLE OPTIONS WHEN AMBIGUOUS — search_services returns a \`confidence\` number and each service has a \`matched_via\` hint.
   • confidence ≥ 0.75 → present ONE top recommendation, concise.
   • confidence < 0.75 → present top 2-3 as a numbered list. Briefly note what each matches (e.g. "if you meant work permit…" / "if you meant health card for workers…"). Ask the user to pick.
   Never hide alternatives when the system isn't sure. It's better to offer 3 relevant options than to commit to a wrong one.

4. BREVITY — Aim for 3 short sentences + a max-5-item bullet list if listing documents. No preambles, no restatements.

5. NO ROLE-PLAYING STATE — You do NOT manage the submission flow. When the user confirms ("yes", "نعم", "ابدأ"), you MUST call start_submission. Never write "I started the service" as free text. The tool — not your message — transitions the state.

6. SUPPORTED SERVICES — Only call start_submission for these five codes:
   drivers_licence_renewal, civil_id_renewal, passport_renewal, mulkiya_renewal, cr_issuance.
   For any other service, explain requirements from tool results and say: "To submit this, please visit a Sanad office."

7. SMALL TALK — Greetings/thanks/jokes get a 1-2 sentence warm reply. No tool call. End with "How can I help?" in the user's language.

8. FORMATTING — **bold** for service names. Fees as "X.XXX OMR" (English) or "X.XXX ريال عماني" (Arabic). End with a single clear next-step question.

9. ACKNOWLEDGE WHEN YOU DON'T KNOW — If search_services returns count=0 or no relevant matches, say so plainly and ask a clarifying question. Don't pad the reply with tangential services.`;

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

export async function runTurn({ session_id, user_text, attachment, citizen_phone }) {
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

  const doc = s.required_documents[state.pending_doc_index];
  if (attachment) {
    state.collected[doc.code] = { url: attachment.url, mime: attachment.mime, size: attachment.size };
    state.pending_doc_index += 1;
    const next = s.required_documents[state.pending_doc_index];
    if (next) {
      return { reply: `✅ استلمنا **${doc.label_ar}**.\nالآن ابعث: **${next.label_ar}** / ${next.label_en}.`, state };
    }
    state.status = 'reviewing';
    const summary = Object.keys(state.collected).map(code => {
      const d = s.required_documents.find(x => x.code === code);
      return `• ${d.label_ar} ✓`;
    }).join('\n');
    return {
      reply: `كل المستندات وصلت ✅\n${summary}\n\nالرسوم الإجمالية: **${s.fee_omr.toFixed(3)} ريال**.\nاكتب **تأكيد** لإرسال الطلب إلى مكاتب سند.`,
      state
    };
  }

  // Text reply while waiting for a file — nudge or answer a question
  return { reply: `محتاجين **${doc.label_ar}** (${doc.label_en}). ابعثها كصورة أو PDF.`, state };
}

async function handleReviewing({ session_id, state, raw, trace, citizen_phone }) {
  const t = (raw || '').toLowerCase();
  if (/(تأكيد|confirm|نعم|yes|submit)/i.test(t)) {
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
        sql: `INSERT INTO request_document(request_id,doc_code,label,storage_url,mime,size_bytes,status)
              VALUES (?,?,?,?,?,?, 'pending')`,
        args: [request_id, code, d?.label_en || code, f.url, f.mime || null, f.size || null]
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
  return `👋 مرحباً بك في مساعد سند — شات بوت ذكي لكل الخدمات الحكومية في سلطنة عُمان.

جرّب:
• "تجديد رخصة القيادة"
• "كم رسوم تجديد جواز السفر؟"
• "خدمات شرطة عمان السلطانية"
• "ماذا أحتاج لإصدار سجل تجاري؟"

عندي **3,422 خدمة حكومية** عبر 50 جهة. اسألني أي شيء.

───
👋 Welcome — I'm an AI assistant for every Oman gov service. Ask me anything.`;
}

function helpMessage() {
  return `أستطيع:

1️⃣ **البحث** — اكتب اسم الخدمة أو ما تحتاجه
2️⃣ **الإجابة** — "كم الرسوم؟"، "شو المستندات؟"
3️⃣ **تصفح حسب الجهة** — "ROP services"، "خدمات وزارة الصحة"
4️⃣ **تقديم طلب** — للخدمات الخمس المتاحة، أجمع المستندات وأحولها لمكتب سند معتمد

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
