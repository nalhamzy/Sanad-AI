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
import { classifyDocImage, VISION_ENABLED, VISION_PROVIDER } from './vision.js';
import { sendWhatsAppText, isWhatsAppSession, WHATSAPP_ENABLED } from './whatsapp_send.js';
import { button, buttons as canonicalButtons, pickButtons } from './buttons.js';

// ── Test-mirror: when SANAD_TEST_PHONE is set, every OUTBOUND message
// (bot or officer) destined for a non-WhatsApp session is ALSO sent to that
// phone via WhatsApp. Lets the user drive web sessions from any browser
// while the conversation lands on their phone in real time. Inbound (citizen)
// messages are never mirrored — they're already in the chat thread.
const SANAD_TEST_PHONE = (process.env.SANAD_TEST_PHONE || '').trim();
const TEST_MIRROR_ENABLED = !!SANAD_TEST_PHONE;

// ── Burst-summary timer ────────────────────────────────────────
// When a citizen rapid-fires multiple files (WhatsApp sends one webhook
// per file), we don't ack each one. Instead we increment a per-session
// counter and (re)arm a 4.5s timer; the FIRST quiet moment after the
// burst ends, the timer fires a SINGLE summary message:
// ── UNIVERSAL BURST AGGREGATOR ─────────────────────────────
// Single source of truth for "5 files in → 1 reply out". Wraps the entire
// runTurn pipeline so every state (idle / collecting / reviewing / queued
// / claimed / in_progress / needs_more_info / awaiting_payment / etc.)
// gets the same treatment — no more per-handler burst hacks.
//
// Behaviour:
//   • Each attachment turn runs its handler normally (file is stored,
//     slot advanced, doc rows inserted) — only the OUTBOUND reply is
//     deferred / merged.
//   • A 1.8 s quiet window opens when the FIRST file lands. Every
//     subsequent file in the window: rearm timer, suppress reply.
//   • When the window closes:
//       count == 1  → emit the handler's actual reply (e.g. "أرسل التالي")
//       count >= 2  → emit one consolidated AR summary with تم/المزيد
//                     buttons on WhatsApp.
//   • A text-only turn while a burst is pending drains the burst FIRST
//     (so the summary lands before the bot's text response), then
//     processes the text normally.
//
// Why the previous burst logic missed cases: it lived inside
// handleInFlight only. Citizens uploading during the launch-flow
// `collecting` state, or in `idle` state with a recent service hint,
// never reached that code path. Lifting the aggregator one level above
// every handler eliminates that whole class of bugs.
// 1200 ms (down from 1800) — perceptibly snappier "got your file" ack on
// a single upload while still wide enough to absorb a 3-5 file burst.
// The in-flight gate in drainBurst() catches anything mid-batch regardless.
const BURST_QUIET_MS = Number(process.env.SANAD_BURST_QUIET_MS || 1200);
// When the timer fires but more files are still being processed for the same
// session, drainBurst reschedules itself to fire again after this short
// interval. Keeps total drain latency low without prematurely flushing.
const BURST_RECHECK_MS = Number(process.env.SANAD_BURST_RECHECK_MS || 400);
// Post-drain cooldown (gpt-5.2-codex pick "option B", 2026-05-06).
// After a drain fires, subsequent drains for the same session are deferred
// until cooldown elapses. Why: in the prod trace +96892888715 #1231/#1233
// two files arrived 3s apart. The 1.2s window expired between them, so
// each drained as its own n=1 burst → two separate per-file acks. The
// cooldown coalesces those late stragglers into the next consolidated
// summary. Solo upload ack stays snappy at +1.2s; the 2nd-arriving file
// either joins the just-fired burst's "tail" or waits to merge with a
// 3rd. Trade-off: a true single-file send takes 1.2s (unchanged); a
// 2-file send may delay the 2nd ack by up to ~4s — far better than two
// separate replies.
// Bumped from 4s to 8s after trace +96892888715 #1320/#1322 (2026-05-06)
// showed two separate "received N file" replies fire 5s apart — citizen
// sent 2 files in a burst, the cooldown expired between drains. 8s
// covers human burst-send rhythm reliably.
const BURST_COOLDOWN_MS = Number(process.env.SANAD_BURST_COOLDOWN_MS || 8000);
const SESSION_LAST_DRAIN_AT = new Map(); // session_id → ms timestamp
const SESSION_BURST = new Map();
// session_id → {
//   count,         // how many attachments seen in the window
//   timer,         // setTimeout handle for drain
//   lastReply,     // most-recent handler reply (used when count == 1)
//   request_id,    // tracked for storeMessage attribution
//   kind           // 'replacement' | 'extra' | 'collect' (informational)
// }

// Per-session count of attachment turns currently in flight (entered runTurn
// but not yet completed). drainBurst checks this before flushing — if files
// are still being processed for the session, the bot must NOT speak yet.
//
// Why this is needed: the burst-quiet timer is a wall-clock window that
// rearms after each file's handler returns. But under WhatsApp-typical
// latency (LLM + vision per file = 3-5 s) the gap between successive file
// completions can exceed BURST_QUIET_MS even though MORE files are queued
// behind the session lock. Without an inflight check, the timer would fire
// mid-batch and produce one bot message per N files instead of one summary
// message after the LAST file. (See the user-reported bug: "is that the doc
// for passport?" repeating once per uploaded image.)
const SESSION_INFLIGHT_FILES = new Map();

function bumpInflightFiles(session_id, delta) {
  const next = (SESSION_INFLIGHT_FILES.get(session_id) || 0) + delta;
  if (next <= 0) SESSION_INFLIGHT_FILES.delete(session_id);
  else SESSION_INFLIGHT_FILES.set(session_id, next);
  return next > 0 ? next : 0;
}

// Public re-export so the WhatsApp route can hold the inflight gate OPEN
// during the fetchMedia stage (Meta CDN download takes 1-3s for each media
// item, and is BEFORE runTurn — without route-side bumping the burst-quiet
// timer can fire on an earlier file while a sibling file's fetch is still
// in flight, producing a separate per-file ack instead of one summary).
// Real prod bug from trace +96892888715 #1231 + #1233 (2026-05-06).
export function trackInflightMedia(session_id, delta) {
  return bumpInflightFiles(session_id, delta);
}

function inflightFilesFor(session_id) {
  return SESSION_INFLIGHT_FILES.get(session_id) || 0;
}

function pendingBurst(session_id) {
  return SESSION_BURST.get(session_id) || null;
}

function armBurst(session_id, { reply, request_id, kind, buttons } = {}) {
  let cur = SESSION_BURST.get(session_id);
  if (!cur) cur = { count: 0, timer: null, lastReply: '', request_id: null, kind: 'extra', buttons: null };
  cur.count += 1;
  if (reply) cur.lastReply = reply;
  if (request_id != null) cur.request_id = request_id;
  // Quick-reply buttons piggyback the latest handler's reply. When a single
  // file produces an answerable question (e.g. "is this for the civil ID?"),
  // the handler attaches `_buttons` and drainBurst sends them via interactive
  // message instead of plain text — saves the citizen from typing yes/no.
  if (Array.isArray(buttons) && buttons.length) cur.buttons = buttons;
  // 'replacement' wins over 'extra' — more meaningful for the citizen.
  if (kind === 'replacement') cur.kind = 'replacement';
  else if (kind && cur.kind !== 'replacement') cur.kind = kind;
  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = setTimeout(() => drainBurst(session_id).catch(e => console.warn('[drainBurst]', e.message)), BURST_QUIET_MS);
  // Don't keep the event loop alive on SIGTERM solely to fire a drain.
  cur.timer.unref?.();
  SESSION_BURST.set(session_id, cur);
}

// Per-session record of the last reply we sent on the WhatsApp channel,
// used to de-duplicate identical consecutive bot messages within a short
// window (e.g. handler stored a reply, drainBurst then forwarded the same
// text). Keyed by session_id; value: { text, at }. Pruned opportunistically.
const SESSION_LAST_WA_REPLY = new Map();
const WA_DEDUP_WINDOW_MS = Number(process.env.SANAD_WA_DEDUP_MS || 4000);

function recordRecentWaReply(session_id, text) {
  if (!session_id || !text) return;
  SESSION_LAST_WA_REPLY.set(session_id, { text, at: Date.now() });
}
function isDuplicateWaReply(session_id, text) {
  if (!session_id || !text) return false;
  const last = SESSION_LAST_WA_REPLY.get(session_id);
  if (!last) return false;
  if (Date.now() - last.at > WA_DEDUP_WINDOW_MS) {
    SESSION_LAST_WA_REPLY.delete(session_id);
    return false;
  }
  return last.text.trim() === String(text || '').trim();
}

async function drainBurst(session_id) {
  const cur = SESSION_BURST.get(session_id);
  if (!cur) return;

  // Don't flush while more files for this session are still being processed.
  // Reschedule and wait. (See SESSION_INFLIGHT_FILES comment above.)
  if (inflightFilesFor(session_id) > 0) {
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(
      () => drainBurst(session_id).catch(e => console.warn('[drainBurst]', e.message)),
      BURST_RECHECK_MS
    );
    cur.timer.unref?.();
    return;
  }

  // Post-drain cooldown gate (codex 2026-05-06). If we drained recently for
  // this session, defer the new drain until cooldown elapses so the late-
  // arriving file's reply MERGES with whatever else lands in the cooldown
  // window rather than firing as its own separate ack message.
  const lastDrainAt = SESSION_LAST_DRAIN_AT.get(session_id) || 0;
  const sinceLast = Date.now() - lastDrainAt;
  if (lastDrainAt && sinceLast < BURST_COOLDOWN_MS) {
    const wait = Math.max(BURST_RECHECK_MS, BURST_COOLDOWN_MS - sinceLast);
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(
      () => drainBurst(session_id).catch(e => console.warn('[drainBurst]', e.message)),
      wait
    );
    cur.timer.unref?.();
    return;
  }

  SESSION_BURST.delete(session_id);
  if (cur.timer) clearTimeout(cur.timer);

  const n = cur.count;
  let text;
  if (n <= 1) {
    // Solo file — show the handler's natural reply (e.g. "ok send the next
    // doc" during collecting). Empty replies (handlers that were already
    // suppressed by special logic) → drain silently.
    text = (cur.lastReply || '').trim();
    if (!text) return;
  } else {
    // Multi-file burst → one templated AR summary. Plural-correct.
    // Wording differentiates "request exists already" (replacement of an
    // already-dispatched file via reclassify or post-pay needs_more_info)
    // vs "still in collection" (default — no request yet, just adding to the
    // draft). Old code said "أرسلتها إلى المكتب المتولّي طلبك" universally
    // even when request_id was null — that misled the citizen into thinking
    // an office was already handling things.
    const wordFile = n === 2 ? 'ملفين' : (n <= 10 ? 'ملفات' : 'ملفاً');
    const hasRequest = cur.request_id != null;

    // Read the up-to-date state so we can render the live checklist + see
    // how many files landed in extras vs required slots (per the spec's
    // "kept aside" pattern). This is the bot acknowledging WHAT THE USER
    // ACTUALLY SENT (file count) before mapping to the abstract checklist.
    let st = null;
    try { st = await loadSession(session_id); } catch {}

    // GREEDY POSITIONAL FLUSH (user spec, 2026-05-06): when burst drains,
    // any orphaned pending_uploads should be auto-recorded into the next
    // empty slots positionally. Trace +96892888715 #1340-#1348 showed 4
    // files arrived but only civil_id (file 1) got recorded — files 2-4
    // sat orphaned in pending_uploads. The user already said "we never
    // ask for individual files" → just slot them in declaration order.
    if (st && Array.isArray(st.pending_uploads) && st.pending_uploads.length) {
      const docsAll = (st.docs || []).filter(d => !isPlaceholderDoc(d));
      const collectedNow = st.collected || {};
      const flushed = [];
      for (const upload of st.pending_uploads) {
        const target = docsAll.find(d => !collectedNow[d.code]?.storage_url);
        if (!target) break; // no empty slots — leave remaining in buffer
        collectedNow[target.code] = {
          filename: upload.name || null,
          storage_url: upload.url,
          mime: upload.mime || null,
          size_bytes: null,
          caption: upload.caption || null,
          at: Date.now()
        };
        flushed.push(target.code);
      }
      if (flushed.length) {
        st.collected = collectedNow;
        // Anything past the slot count goes into state.extras instead of
        // being dropped. Real prod bug from +96892888715 (2026-05-09):
        // CR Renewal has 1 required doc, citizen sent 5 files, the
        // receipt then said "received 1 document" — citizens read that
        // as "the bot lost 4 of my files". The 4 surplus files DO get
        // dispatched to the office (extras flow through submit_request),
        // they just weren't being counted in user-visible totals because
        // the burst flush silently dropped them from pending_uploads.
        const surplus = st.pending_uploads.slice(flushed.length);
        if (surplus.length) {
          st.extras = Array.isArray(st.extras) ? st.extras : [];
          for (const upload of surplus) {
            st.extras.push({
              idx: upload.idx,
              url: upload.url,
              name: upload.name || null,
              mime: upload.mime || null,
              caption: upload.caption || upload.name || null,
              at: Date.now()
            });
          }
        }
        st.pending_uploads = []; // all uploads accounted for (slot or extra)
        // Advance pending_doc_index past now-filled slots.
        let idx = 0;
        while (idx < docsAll.length && collectedNow[docsAll[idx].code]?.storage_url) idx++;
        st.pending_doc_index = idx;
        try { await saveSession(session_id, st); } catch {}
      }
    }

    const docs = ((st && st.docs) || []).filter(d => !isPlaceholderDoc(d));
    const collected = (st && st.collected) || {};
    const pending = docs.filter(d => !collected[d.code]?.storage_url);
    const extrasN = ((st && st.extras) || []).length;
    const checklist = renderChecklist(st);

    let headline;
    if (cur.kind === 'replacement') {
      headline = `📥 استلمت ${n} ${wordFile} محدَّثة وأرسلتها إلى مكتب سند للمراجعة.`;
    } else if (hasRequest) {
      headline = `📥 استلمت ${n} ${wordFile} وأرفقتها بطلبك.`;
    } else {
      // Drop the duplicate-✨ from the headline (was: "...اكتمل ✨").
      // The closing question already includes the completion marker
      // when applicable. One emoji per role, not two for the same
      // signal. (Icon-density audit, 2026-05-07.)
      headline = `📥 استلمت ${n} ${wordFile}.`;
    }

    // Compose: headline → live checklist → close with the same question.
    // (User feedback 2026-05-07 #1497 on +96892888715: "just indicate 3
    // files, do u have more or اكتمل" — dropped the auto-match hint.)
    //
    // When extras > 0, ALWAYS surface the count in the closing line so the
    // citizen never reads the receipt and thinks "the bot only counted 1 of
    // my 5 files". Bug from +96892888715 trace 2026-05-09 (5 files sent,
    // headline said "5 files received", checklist showed 1 ✅, closing said
    // "اكتمل ملفك" — the missing line was "+ 4 إضافي مرفقة بالطلب").
    const sections = [headline];
    if (checklist) sections.push(checklist);
    const extrasCountNow = ((st && st.extras) || []).length;
    const extrasNote = extrasCountNow > 0
      ? `\n+ ${extrasCountNow} ملف إضافي مرفق بطلبك.`
      : '';
    if (docs.length && pending.length === 0) {
      sections.push(`✨ اكتمل ملفك.${extrasNote}\nاضغط *✅ انتهيت من الرفع*.`);
    } else {
      sections.push(`هل اكتمل ملفك؟${extrasNote}\nاضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`);
    }
    text = sections.join('\n\n');
  }

  try {
    // ALWAYS store the consolidated reply here (handler skips its own
    // storeMessage for attachment turns since 2026-05-07 — see runAgentV2).
    // This ensures the WEB channel sees ONE bubble per burst instead of
    // N+1 (one per file plus the synthetic summary). For WhatsApp the
    // sender below pushes the same text. Trace +96892888715 #1364-#1370
    // showed 4 bubbles for one 4-file burst — gone now.
    await storeMessage({
      session_id,
      request_id: cur.request_id || null,
      direction: 'out',
      actor_type: 'bot',
      body_text: text
    });
    // For WhatsApp-native sessions, push directly to the citizen's phone
    // (the webhook already returned reply='' for each file in the burst,
    // so without this push the citizen sees no ack at all).
    //
    // Button choices (max 3 per Meta spec, max 20-char title):
    //   • Multi-file burst (n >= 2)  → ✓ تم / + سأرسل المزيد
    //   • Solo file with `cur.buttons` set by the handler (e.g. ambiguous
    //     doc classification) → use those buttons → cuts citizen typing
    //   • Solo file otherwise → plain text
    if (typeof session_id === 'string' && session_id.startsWith('wa:')) {
      const phone = session_id.replace(/^wa:/, '');
      // Defensive de-dup: if we just sent the same text via the route layer
      // (handler reply path) within the last 4 s, drop this drain. Catches
      // races where a text-turn already pushed the consolidated reply and
      // the timer fires anyway.
      if (isDuplicateWaReply(session_id, text)) {
        try { console.warn('[drainBurst] dedup-suppress', session_id); } catch {}
        return;
      }
      const sendButtons = async (btns) => {
        try {
          const { sendWhatsAppButtons } = await import('./whatsapp_send.js');
          const r = await sendWhatsAppButtons(phone, text, btns);
          if (!r.ok) sendWhatsAppText(phone, text).catch(() => {});
        } catch (e) {
          sendWhatsAppText(phone, text).catch(() => {});
        }
      };
      if (n >= 2) {
        // Unified 3-button pattern (user spec, 2026-05-06): confirm-and-send
        // is ALWAYS available even with partial collection (citizen knows
        // best when they're done — the bot doesn't gatekeep). The same
        // three buttons appear after EVERY upload — no surprise menus.
        await sendButtons([
          button('review:submit'),
          button('burst:more'),
          button('service:cancel')
        ]);
      } else if (cur.buttons && cur.buttons.length) {
        // Trim to Meta's 3-button max and 20-char title cap defensively.
        const safeBtns = cur.buttons.slice(0, 3).map(b => ({
          id: String(b.id || '').slice(0, 256),
          title: String(b.title || '').slice(0, 20)
        }));
        await sendButtons(safeBtns);
      } else {
        sendWhatsAppText(phone, text).catch(() => {});
      }
      recordRecentWaReply(session_id, text);
    }
    // Mark this session as just-drained so the cooldown gate knows to
    // defer the next drain. Belt-and-suspenders for both wa: and web
    // sessions even though only wa: actually sends here — keeps the
    // cooldown semantics consistent.
    SESSION_LAST_DRAIN_AT.set(session_id, Date.now());
  } catch (e) {
    console.warn('[drainBurst]', e.message);
  }
}

// Agent v2 is the new unified tool-calling loop. Flip SANAD_AGENT_V2=true
// to route every turn through it (all states — no more scripted handlers).
// Default OFF so the existing pinned tests & heuristic flow are unaffected.
const AGENT_V2 = process.env.SANAD_AGENT_V2 === 'true';
const MAX_TOOL_ROUNDS_V2 = 6;

const SYSTEM_PROMPT = `You are **ساند** ("Saned, the smart assistant") — the AI front-desk for the Saned platform.

## What Saned is (read this carefully — it shapes every reply)

Saned (ساند) is a **request preparation and dispatch platform** for Oman government services:

  Citizen  ⇄  **You (ساند / Saned)**  ⇄  **Sanad office**  ⇄  Government entities

Your job is the LEFT half:
1. Talk to the citizen.
2. **Prepare a complete, ready-to-process request file**: identify the right service from the **453 services across 7 entities** (Muscat Municipality, Royal Oman Police, MOH, MOL, MOHUP, MOC, MTCIT) in our catalogue, gather every required document.
3. **Dispatch the prepared file** to a licensed Sanad office for review.
4. The office reviews → sends the citizen a payment link → processes the transaction with the gov entity → notifies completion. You relay payment links and updates between the office and the citizen. Pricing is pre-set per service (same across all offices) — no offers / marketplace selection.

That is the entire product. You are not a search engine and not a chatbot toy — you are a **request preparation specialist** whose output is a complete file that a Sanad office can pick up and execute.

## Who you are
- Name: **ساند** in Arabic, **Saned** in English. Always introduce yourself by this name. (Never say "Ahmed" — that was an old persona; the bot is now branded as Saned.)
- Tone: warm, respectful, concise — like a knowledgeable Omani friend who works the intake desk for every gov service.
- You don't *do* the transaction. You *build the file* and hand it over.

## The mission, every turn (in this exact order)
1. **Identify the service** — search the catalogue, ask one clarifying question if ambiguous, confirm.
2. **Build the file** — list required documents, accept uploads one at a time, recognise captions ("this is my id"), validate each slot.
3. **Dispatch** — when the file is complete, send it to a Sanad office for review. Tell the citizen the office will review the request and send a payment link, then process the transaction on their behalf.
4. **Relay** — after dispatch, you forward OTPs and status updates between the office and the citizen. The office, not you, executes the gov-portal steps.

## CRITICAL: who actually processes the request
**Sanad offices process every request. Period.** You NEVER:
- forward the request to a ministry, the Royal Oman Police (ROP), the Ministry of Health, the municipality, or any government body directly.
- say "I'll send this to ROP / the ministry / the police".
- promise the user a gov entity will contact them.

What you DO say:
- Arabic: "سأُجهّز ملف طلبك وأُرسله إلى مكتب سند للمراجعة. سيتولى المكتب إنجاز المعاملة نيابةً عنك."
- English: "I'll prepare your request file and dispatch it to the available Sanad offices. One will pick it up and an officer there will complete the paperwork on your behalf."

The gov entity in the catalogue (e.g. "Royal Oman Police") is the *issuer* of the service — useful context for the citizen. The **Sanad office** is who actually handles it.

## Hard rules
1. **One language per reply.** Mirror the user's script. Never mix mid-word. Never translate a service name — copy it verbatim from the tool output.
2. **Ground truth from tools only — ZERO invention.** Every fee, document, entity, processing time, fee-tier rule, age threshold, and step you mention MUST appear verbatim in a tool response in THIS conversation. If unsure, call get_service_details first.
   - If a tool returns fee_omr = null or no fee data: say "الرسوم غير محددة في القائمة — سيؤكدها مكتب سند المستلم" / "Fee not specified in the catalogue — the receiving Sanad office will confirm." NEVER substitute a number from your training data.
   - If a tool's required_documents is empty: say so honestly. NEVER pad with documents the tool didn't return.
   - Never invent age tiers, multi-tier pricing, time estimates, or eligibility rules that aren't in the tool output.
3. **Show options when ambiguous.** confidence ≥ 0.75 → one top pick. confidence < 0.75 → top 2–3 numbered, with a short reason for each.
4. **Brevity.** 3 short sentences + a ≤5-item bullet list when listing docs. No preambles.
5. **No double-prompting.** When the user signals intent ("I want to renew my X", "أبغى أجدد Y"), call start_submission directly — do NOT ask "do you want to start?" first. After start_submission succeeds, your reply summarizes the service and asks for the FIRST document in the same turn. The next document only — not the whole list again.
6. **Supported deterministic launch flows:** drivers_licence_renewal (ROP), mulkiya_renewal (ROP), cr_issuance (MOC). All other services in the 453-row catalogue can still be searched and submitted via start_submission with the catalogue id — they just lack the curated keyword shortcut.
7. **Catalogue gap honesty.** Civil ID renewal and Passport renewal are NOT in the current catalogue (only first-issuance variants exist for those). When asked, say so directly and surface the closest available option: "Issuing Civil Status Card Service" (id 140018) or "Omani Passport Issuance Service" (id 140020). Don't invent a renewal flow.
8. **Continuity across turns.** If you found a service in a previous turn, remember its id; never re-search and contradict yourself. If the user says "yes" / "go" / "ok let's do it" after you presented a service, call start_submission with that id immediately.
9. **Small talk** (greetings/thanks/jokes): 1–2 warm sentences, no tool calls. Sign off with "كيف أقدر أساعدك؟" / "How can I help?"
10. **Formatting:** **bold** for service names. Fees as "X.XXX OMR" (en) or "X.XXX ريال عماني" (ar) ONLY when the tool returned a numeric fee. End with one clear next-step question.
11. **Honesty on zero hits.** If hybrid search returns no results, say so plainly and ask a clarifying question. Never pad with tangential services.`;

const MAX_TOOL_ROUNDS = 4;

// ─── Session / message helpers ──────────────────────────────

// ── DETERMINISTIC BUTTON-INTENT DISPATCHER ──────────────────────
// Maps `__btn__:<id>` taps to concrete state mutations + canned replies
// without going through the LLM tool-loop OR the upload-description
// parser. This is what fixes the prod bug where "+ سأرسل المزيد" got
// parsed as a CAPTION for buffered files.
//
// Returns { reply, state, trace, _buttons } when handled, null when the
// button id is unknown / should fall through to the LLM.
async function handleButtonIntent({ session_id, state, btn_id, attachment, citizen_phone, trace }) {
  trace.push({ step: 'button_intent', btn_id, status: state.status });

  // Helper — list pending required slots in Arabic
  const renderRemaining = () => {
    const docs = state.docs || [];
    const collected = state.collected || {};
    const pending = docs.filter(d => !collected[d.code] && !isPlaceholderDoc(d));
    if (!pending.length) return null;
    const lines = pending.map((d, i) => `${i + 1}. ${arabicLabelFor(d)}`).join('\n');
    return { count: pending.length, lines, first: pending[0] };
  };

  // Helper — wrap a deterministic-handler return so we don't repeat the
  // last_offered_buttons stamping in every branch.
  const ret = ({ reply, state, _buttons }) => {
    if (_buttons && _buttons.length) {
      state.last_offered_buttons = _buttons.map(b => String(b.id));
    } else {
      delete state.last_offered_buttons;
    }
    return { reply, state, trace, _buttons };
  };

  // burst:more — citizen confirmed they have more files coming. List the
  // remaining required slots so they know what to send. Critically, do
  // NOT pass the text through parseUploadDescriptions (the old bug).
  if (btn_id === 'burst:more') {
    if (state.status !== 'collecting') {
      // No active collection → fall through to LLM (it'll say "ok, send them")
      return null;
    }
    const r = renderRemaining();
    const checklist = renderChecklist(state);
    if (!r) {
      // Nothing left — switch to reviewing summary
      state.status = 'reviewing';
      await saveSession(session_id, state);
      const reply = checklist
        ? `✨ كل المستندات المطلوبة عندي بالفعل:\n\n${checklist}\n\nاضغط *✅ انتهيت من الرفع*.`
        : '✨ كل المستندات المطلوبة عندي بالفعل. اضغط *✅ انتهيت من الرفع*.';
      const _buttons = [
        button('review:submit'),
        button('burst:more'),
        button('service:cancel')
      ];
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      return { reply, state, trace, _buttons };
    }
    const reply = checklist
      ? `تمام، أرسل البقية بأي ترتيب.\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
      : `تمام، أرسل البقية بأي ترتيب.\n\nهل اكتمل ملفك؟`;
    const _buttons = [
      button('review:submit'),
      button('burst:more'),
      button('service:cancel')
    ];
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'btn_more_listed', remaining: r.count });
    return { reply, state, trace, _buttons };
  }

  // burst:done — citizen says they're finished sending files. If at least
  // one required slot is filled, transition to reviewing. Otherwise nudge
  // them to send the first one.
  if (btn_id === 'burst:done') {
    const docs = state.docs || [];
    const collected = state.collected || {};
    const pending = docs.filter(d => !collected[d.code] && !isPlaceholderDoc(d));
    const haveAny = Object.keys(collected).length > 0;

    if (state.status === 'collecting' && pending.length === 0 && haveAny) {
      // All required collected — go to reviewing.
      state.status = 'reviewing';
      await saveSession(session_id, state);
      const checklist = renderChecklist(state);
      const extras = (state.extras || []).length;
      const reply =
        `📦 *جاهز للمراجعة*\n\n${checklist || ''}` +
        (extras ? `\n\n📎 ملفات مُرفقة: ${extras}` : '') +
        `\n\nاضغط *✅ انتهيت من الرفع* لإرسال الطلب إلى مكتب سند للمراجعة.`;
      const _buttons = [
        button('review:submit'),
        button('burst:more'),
        button('service:cancel')
      ];
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      trace.push({ step: 'btn_done_to_reviewing' });
      return { reply, state, trace, _buttons };
    }
    if (state.status === 'collecting' && pending.length > 0) {
      // Still missing required docs. Per the user's spec: never gatekeep —
      // citizen knows best. Show what we have, ASK if it's complete,
      // and offer the same 3 buttons (confirm / more / cancel). The
      // confirm button STILL works even when partial — it'll trigger
      // the office to follow up for the missing pieces.
      const checklist = renderChecklist(state);
      const haveCount = docs.filter(d =>
        collected[d.code]?.storage_url && !isPlaceholderDoc(d)
      ).length;
      const got = haveCount > 0
        ? `استلمت منك ${haveCount} ${haveCount === 1 ? 'مستند' : 'مستندات'} حتى الآن.`
        : '';
      const reply = checklist
        ? `${got}\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
        : `${got}\n\nهل اكتمل ملفك؟`;
      const _buttons = [
        button('review:submit'),
        button('burst:more'),
        button('service:cancel')
      ];
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      trace.push({ step: 'btn_done_blocked_missing', remaining: pending.length });
      return { reply, state, trace, _buttons };
    }
    // Not in collecting → fall through to LLM
    return null;
  }

  // doc:list — citizen wants to see what's left. Use the unified checklist
  // (✅/⏳ in declaration order) — clearer than two separate sections.
  if (btn_id === 'doc:list') {
    if (state.status !== 'collecting') return null;
    const r = renderRemaining();
    const checklist = renderChecklist(state);
    if (!r) {
      state.status = 'reviewing';
      await saveSession(session_id, state);
      const reply = checklist
        ? `✨ كل المستندات المطلوبة عندي:\n\n${checklist}\n\nاضغط *✅ انتهيت من الرفع*.`
        : '✨ كل المستندات المطلوبة عندي. اضغط *✅ انتهيت من الرفع*.';
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      return {
        reply, state, trace,
        _buttons: [
          button('review:submit'),
          button('burst:more'),
          button('service:cancel')
        ]
      };
    }
    const reply = checklist
      ? `${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
      : `📋 المتبقي: ${r.count} مستند${r.count === 1 ? '' : 'ات'}.\n\nهل اكتمل ملفك؟`;
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    return {
      reply, state, trace,
      _buttons: [
        button('review:submit'),
        button('burst:more'),
        button('service:cancel')
      ]
    };
  }

  // review:submit — DETERMINISTIC submit handler (user spec, 2026-05-06).
  // Trace +96892888715 #1315/#1316: citizen tapped "✅ تأكيد وأرسل" with
  // 0 files; the LLM lectured "send the first doc". Per spec: never ask
  // for individual files — citizen drives. Submission proceeds when at
  // least one file is collected; partial files are flagged for the
  // receiving office to follow up on.
  if (btn_id === 'review:submit') {
    if (!['collecting', 'reviewing'].includes(state.status)) return null;
    const docs = (state.docs || []).filter(d => !isPlaceholderDoc(d));
    const collected = state.collected || {};
    const haveCount = docs.filter(d => collected[d.code]?.storage_url).length;
    const extrasN = (state.extras || []).length;
    const totalUploaded = haveCount + extrasN;

    if (totalUploaded === 0) {
      // Truly nothing yet — soft nudge with the SAME 3 buttons (confirm
      // is still available, no new "send first one" lecture).
      const checklist = renderChecklist(state);
      const reply = checklist
        ? `لم يصلني أي ملف بعد.\n\n${checklist}\n\nأرسل ملفاتك الآن — كلها معاً أو واحداً تلو الآخر، بأي ترتيب.`
        : 'لم يصلني أي ملف بعد. أرسل ملفاتك الآن.';
      // codex iter-9: persist the reply (was missing — bench DB count
      // showed bots=2 instead of 3 because this branch never stored).
      await storeMessage({
        session_id, request_id: state.request_id || null,
        direction: 'out', actor_type: 'bot', body_text: reply
      });
      trace.push({ step: 'btn_review_submit_no_files' });
      return {
        reply, state, trace,
        _buttons: [
          button('review:submit'),
          button('burst:more'),
          button('service:cancel')
        ]
      };
    }

    // We have at least one file → submit it. The receiving office can
    // follow up on missing required docs (per spec: don't gatekeep).
    state.status = 'reviewing'; // submit_request requires this
    try {
      const result = await TOOL_IMPL_V2.submit_request({
        session_id, state, citizen_phone, trace, attachment: null
      });
      if (result?.ok) {
        state.status = 'queued';
        state.request_id = result.request_id;
        await saveSession(session_id, state);
        // ── Submit-time summary (user spec, 2026-05-07): lead with what
        // the citizen actually sent (count + checklist) so they SEE what
        // was packaged before the framing kicks in. Then a short
        // "we're starting" line + reference + expectation. Avoids the
        // earlier dry "📤 أرسلت طلبك" cold ack.
        const total = haveCount + extrasN;
        const fileWord = total === 1 ? 'مستند' : 'مستندات';
        // Render the FINAL ✅/⏳ checklist so the citizen can see what
        // shipped vs what's still missing.
        const checklist = renderChecklist(state);
        const partial = haveCount < docs.length
          ? `\n\nℹ️ بعض المستندات لم تصلني — لا قلق، سيتواصل معك المكتب المتولّي إن احتاج إليها.`
          : '';
        // CX iter-4 (2026-05-08, citizen comment #1815):
        // Old reply had a "*الخطوات التالية:* 1️⃣ مراجعة 2️⃣ إرسال رابط
        // الدفع 3️⃣ إشعارك" block that the user said felt unclear for
        // first-timers. Trimmed to what they actually need to know:
        //   • confirmation + reference number
        //   • single-line "we'll text you the payment link soon"
        //   • status:check button so they can poll any time without typing
        // Removed the explicit numbered ladder; the journey is implicit.
        const reply =
          `✅ تم الإرسال — استلمت ${total} ${fileWord}.\n` +
          `🆔 *#R-${result.request_id}*` +
          partial +
          `\n\nالمكتب يراجع الطلب الآن وسأرسل لك رابط الدفع فور جاهزيته.`;
        await storeMessage({
          session_id, request_id: result.request_id,
          direction: 'out', actor_type: 'bot', body_text: reply
        });
        trace.push({ step: 'btn_review_submit_ok', request_id: result.request_id, files: total });
        // Always-on actions in queued state (per iter-7 finalized-state
        // button matrix). Lets the citizen poll status or cancel any time.
        state.last_offered_buttons = ['status:check', 'service:cancel'];
        await saveSession(session_id, state);
        return {
          reply, state, trace,
          _buttons: [
            button('status:check'),
            button('service:cancel')
          ]
        };
      }
      trace.push({ step: 'btn_review_submit_failed', error: result?.error });
    } catch (e) {
      trace.push({ step: 'btn_review_submit_threw', error: e.message });
    }
    // Fall through to LLM if submit_request failed (rare — bad state).
    return null;
  }

  // service:switch — citizen wants a different service. Reset state to
  // idle and prompt for the new service name. The previous draft (if
  // any) is discarded. No confirm step because they're at the
  // "no-files-yet" gate (start_submission first reply).
  if (btn_id === 'service:switch') {
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await saveSession(session_id, state);
    const reply = '🔍 تمام، أخبرني باسم الخدمة التي تريدها — مثل: تجديد رخصة القيادة، إصدار سجل تجاري، بدل فاقد سند ملكية…';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'btn_service_switch' });
    return { reply, state, trace };
  }

  // CX iter-2 (2026-05-08): discover buttons now START THE SUBMISSION
  // directly via TOOL_IMPL_V2.start_submission, instead of telling the
  // citizen to "type the phrase" (which forced an extra round-trip and
  // wasted tokens on a re-match). Mapping is button-id → exact name_ar
  // of the catalog row, NOT a typed phrase. The launch entries in
  // catalogue.js LAUNCH_SERVICES still use match_keywords for typed
  // discovery; this is the tap-shortcut.
  const DISCOVERY_NAME_AR = {
    'discover:license': 'خدمة طلب تجديد رخصة سياقة',       // id 140017
    'discover:title':   'طلب إصدار سند ملكية بدل فاقد',    // id 150036
    'discover:cr':      'إنشاء سجل تجاري جديد'             // id 120008
  };
  if (DISCOVERY_NAME_AR[btn_id]) {
    const nameAr = DISCOVERY_NAME_AR[btn_id];
    try {
      const { rows } = await db.execute({
        sql: `SELECT id FROM service_catalog WHERE name_ar = ? LIMIT 1`,
        args: [nameAr]
      });
      if (rows[0]?.id) {
        const r = await TOOL_IMPL_V2.start_submission(
          { state, session_id, citizen_phone, trace },
          { service_id: rows[0].id }
        );
        if (r?.ok) {
          const svcName = r.name_ar || r.name_en;
          const docs = renderDocListOrPrompt(r.required_documents || [], svcName);
          const docsBlock = docs.kind === 'list'
            ? `الملفات المطلوبة:\n${docs.text}\n\n` +
              `أرسل الملفات بأي ترتيب — سأرتّبها لك.`
            : `${docs.text}`;
          const reply = `✅ بدأت طلب *${svcName}*.\n\n${docsBlock}`;
          await storeMessage({
            session_id, request_id: null,
            direction: 'out', actor_type: 'bot', body_text: reply
          });
          state.last_offered_buttons = ['service:switch', 'service:cancel'];
          await saveSession(session_id, state);
          trace.push({ step: 'btn_discovery_started', service_id: rows[0].id });
          return {
            reply, state, trace,
            _buttons: [
              button('service:switch'),
              button('service:cancel')
            ]
          };
        }
      }
    } catch (e) {
      trace.push({ step: 'btn_discovery_threw', error: e.message });
    }
    // Fallback if start_submission failed for any reason — graceful hint.
    const reply = `🔍 لم أستطع بدء الطلب الآن. حاول كتابة اسم الخدمة بدلاً من الزر، مثل *${nameAr.replace('خدمة ', '').replace('طلب ', '')}*.`;
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'btn_discovery_fallback', service_name_ar: nameAr });
    return { reply, state, trace };
  }

  // CX iter-6: pick:N tap consumes the cached search results from the
  // hybrid-search shortcut. state.last_search_results holds the 3 ids;
  // pick the Nth and call start_submission directly. Same behavior as
  // discover:* but for arbitrary catalog services (not just the curated
  // 3 launch services).
  const PICK_RE = /^pick:([123])$/;
  const pickMatch = btn_id && PICK_RE.exec(btn_id);
  if (pickMatch && Array.isArray(state.last_search_results)) {
    const idx = Number(pickMatch[1]) - 1;
    const sid = state.last_search_results[idx];
    if (sid) {
      try {
        const r = await TOOL_IMPL_V2.start_submission(
          { state, session_id, citizen_phone, trace },
          { service_id: sid }
        );
        if (r?.ok) {
          const svcName = r.name_ar || r.name_en;
          const docs = renderDocListOrPrompt(r.required_documents || [], svcName);
          const docsBlock = docs.kind === 'list'
            ? `الملفات المطلوبة:\n${docs.text}\n\n` +
              `أرسل الملفات بأي ترتيب — سأرتّبها لك.`
            : `${docs.text}`;
          const reply = `✅ بدأت طلب *${svcName}*.\n\n${docsBlock}`;
          await storeMessage({
            session_id, request_id: null,
            direction: 'out', actor_type: 'bot', body_text: reply
          });
          // Clear the cached search results — they were one-shot.
          delete state.last_search_results;
          state.last_offered_buttons = ['service:switch', 'service:cancel'];
          await saveSession(session_id, state);
          trace.push({ step: 'btn_pick_started', service_id: sid });
          return {
            reply, state, trace,
            _buttons: [
              button('service:switch'),
              button('service:cancel')
            ]
          };
        }
      } catch (e) {
        trace.push({ step: 'btn_pick_threw', error: e.message });
      }
    }
  }

  // status:check — citizen wants to know the state of their queued/in-flight
  // request. Read directly from the request row, render a deterministic
  // Arabic summary. Avoids the LLM hallucinating "still processing" when
  // the office has already moved the state forward.
  if (btn_id === 'status:check' && state.request_id) {
    // Real bug seen in trace +96892888715 #1507/#1508 (2026-05-07):
    // citizen tapped status:check, the handler returned null (tool failed
    // silently), the LLM fall-through also produced no reply, citizen sat
    // in silence for 5 minutes then typed "الو". Make this branch
    // bulletproof — ALWAYS produce a response, even on tool failure.
    // CX iter-6 (citizen comment #1870: "maybe better status is under review")
    // Collapsed queued+claimed into a single 'قيد المراجعة' label — from the
    // citizen's perspective both states mean "the office is handling it now"
    // and the visual difference (⏳ vs 👁️) was producing question marks like
    // "did they see it yet?". Keep the substantive states distinct so the
    // payment / needs-info / completed / cancelled cases still read clearly.
    const STATUS_LABELS = {
      queued:           '⏳ قيد المراجعة',
      claimed:          '⏳ قيد المراجعة',
      awaiting_payment: '💳 بانتظار الدفع',
      in_progress:      '⚙️ جارٍ تنفيذ المعاملة',
      needs_more_info:  '📋 المكتب يحتاج معلومة إضافية',
      completed:        '✅ تم إنجاز المعاملة',
      cancelled:        '❌ مُلغى'
    };
    const fallbackButtons = [
      button('status:check'),
      button('service:cancel')
    ];
    let reply = null;
    try {
      const result = await TOOL_IMPL_V2.get_request_status({
        session_id, state, citizen_phone, trace, attachment: null
      }, { request_id: state.request_id });
      if (result?.ok && result.request) {
        const r = result.request;
        const label = STATUS_LABELS[r.status] || `حالة: ${r.status}`;
        reply =
          `📊 *حالة طلبك*\n\n` +
          `🆔 رقم الطلب: *#R-${r.id}*\n` +
          (r.service_name_ar || r.service_name ? `📂 الخدمة: ${r.service_name_ar || r.service_name}\n` : '') +
          `${label}` +
          (r.cancel_requested ? '\n\n⚠️ تم تقديم طلب إلغاء — بانتظار رد المكتب.' : '');
        trace.push({ step: 'btn_status_check_ok', status: r.status });
      } else {
        trace.push({ step: 'btn_status_check_no_row', error: result?.error });
      }
    } catch (e) {
      trace.push({ step: 'btn_status_check_threw', error: e.message });
    }
    // Bulletproof fallback: even if the tool failed entirely, give the
    // citizen SOMETHING. Default to state.status if it's known.
    if (!reply) {
      const fallbackLabel = STATUS_LABELS[state.status] || '⏳ قيد المراجعة';
      reply =
        `📊 *حالة طلبك*\n\n` +
        `🆔 رقم الطلب: *#R-${state.request_id}*\n` +
        `${fallbackLabel}\n\n` +
        `سأخبرك فور أي تحديث من المكتب.`;
    }
    await storeMessage({
      session_id, request_id: state.request_id,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    return {
      reply, state, trace,
      _buttons: state.status === 'completed' || state.status === 'cancelled' ? null : fallbackButtons
    };
  }

  // service:cancel — confirm-first flow. Behaviour is state-aware:
  //   • idle                    → nothing to cancel
  //   • collecting / reviewing  → cancel the DRAFT (clears local state)
  //   • queued/claimed/in-flight → cancel the SUBMITTED request via
  //                                cancel_request tool (sets cancel_requested
  //                                flag on the request row for office review)
  //   • completed / cancelled    → can't cancel
  if (btn_id === 'service:cancel') {
    if (state.status === 'idle') {
      const reply = 'لا يوجد طلب نشط لإلغائه حالياً. أخبرني بأي خدمة تحتاجها لأبدأ معك.';
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      trace.push({ step: 'btn_cancel_no_draft' });
      return { reply, state, trace };
    }
    if (state.status === 'completed' || state.status === 'cancelled') {
      const reply = state.status === 'completed'
        ? '✅ هذا الطلب تم إنجازه بالفعل — لا يمكن إلغاؤه.'
        : '❌ هذا الطلب مُلغى مسبقاً.';
      await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
      trace.push({ step: 'btn_cancel_terminal_state', status: state.status });
      return { reply, state, trace };
    }
    state.pending_cancel = true;
    await saveSession(session_id, state);
    // In-flight cancellation has different consequences than draft cancel.
    const isInFlight = ['queued', 'claimed', 'in_progress', 'needs_more_info',
                        'awaiting_payment', 'awaiting_reclassify_ack'].includes(state.status);
    const reply = isInFlight
      ? `⚠️ هل تؤكد طلب إلغاء طلبك *#R-${state.request_id}*؟ سيُرسل طلب الإلغاء إلى المكتب المتولّي للمراجعة.`
      : '⚠️ هل تؤكد إلغاء الطلب الحالي؟ ستفقد المستندات المرفقة.';
    // codex iter-7: persist this confirmation prompt — was missing before,
    // so the bench transcript showed the bot row only via the wrapper but
    // the DB had no record between service:cancel tap and confirm:yes tap.
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'btn_cancel_confirm_prompt', in_flight: isInFlight });
    return {
      reply, state, trace,
      _buttons: [
        // Context-preserving labels via button() override. The previous
        // in-flight title "✓ نعم، أرسل طلب الإلغاء" was 23 chars which
        // exceeds the WhatsApp Cloud API 20-char button-title limit and
        // was silently dropping on prod (chatwoot issue #8288). The
        // shortened version below fits and reads identically.
        button('confirm:yes', isInFlight ? '✓ نعم، اطلب الإلغاء' : '🗑️ نعم، احذف الطلب'),
        button('confirm:no',  '↩️ تراجع')
      ]
    };
  }

  // confirm:yes after pending_cancel — execute the cancellation.
  // Two paths depending on what we're cancelling:
  //   • DRAFT (collecting/reviewing, no request_id) → just clear local state
  //   • SUBMITTED request → call cancel_request tool (sets cancel_requested
  //     flag on the request row; office sees the flag on next dashboard refresh)
  if (btn_id === 'confirm:yes' && state.pending_cancel) {
    delete state.pending_cancel;
    const wasInFlight = !!state.request_id;
    if (wasInFlight) {
      try {
        // codex iter-10: tool signature is (ctx, args). Original iter-7
        // call passed only the ctx, so destructuring `{request_id, reason}`
        // of undefined threw → the catch block swallowed it as "tool failed",
        // → deterministic apology fired → bench scenario #5 always failed.
        const result = await TOOL_IMPL_V2.cancel_request(
          { session_id, state, citizen_phone, trace, attachment: null },
          { request_id: state.request_id, reason: 'citizen_initiated' }
        );
        if (result?.ok) {
          await saveSession(session_id, state);
          const reply =
            `✅ أرسلت طلب إلغاء طلبك *#R-${state.request_id}* إلى المكتب المتولّي.\n\n` +
            `سأخبرك فور تأكيد الإلغاء من المكتب.`;
          await storeMessage({
            session_id, request_id: state.request_id,
            direction: 'out', actor_type: 'bot', body_text: reply
          });
          trace.push({ step: 'btn_cancel_inflight_ok', request_id: state.request_id });
          return { reply, state, trace };
        }
        trace.push({ step: 'btn_cancel_inflight_failed', error: result?.error });
      } catch (e) {
        trace.push({ step: 'btn_cancel_inflight_threw', error: e.message });
      }
      // codex iter-7: tool failed → DETERMINISTIC apology + retry buttons.
      // Previously fell through to LLM which leaked the bilingual fallback
      // ("Let me try again. / حسناً…") in the cancel_in_flight bench scenario.
      // The cancel intent is unambiguous; never let the LLM re-handle it.
      state.pending_cancel = true;            // restore so retry works
      await saveSession(session_id, state);
      const failReply =
        `⚠️ تعذّر إرسال طلب الإلغاء حالياً.\n\n` +
        `تواصل مع مكتب سند مباشرة عبر التطبيق، أو حاول مرة أخرى بعد لحظات.`;
      await storeMessage({
        session_id, request_id: state.request_id,
        direction: 'out', actor_type: 'bot', body_text: failReply
      });
      return {
        reply: failReply, state, trace,
        _buttons: [
          // "🔁 حاول الإلغاء مجدداً" was 22 chars — over Cloud API limit.
          // Shortened to fit while preserving meaning.
          button('confirm:yes', '🔁 إعادة المحاولة'),
          button('status:check')
        ]
      };
    }
    // Draft cancellation — wipe local state.
    state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await saveSession(session_id, state);
    const reply = '✓ ألغيت الطلب. اسألني عن أي خدمة أخرى تحتاجها.';
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'btn_cancel_draft_confirmed' });
    return { reply, state, trace };
  }
  // confirm:no after pending_cancel — keep the draft.
  if (btn_id === 'confirm:no' && state.pending_cancel) {
    delete state.pending_cancel;
    await saveSession(session_id, state);
    const reply = '👍 تمام، تابعنا — أرسل المستند التالي.';
    return { reply, state, trace };
  }

  // codex iter-11: post-deterministic-service-match confirm:yes. The
  // iter-8 service-match shortcut transitions straight to `collecting`,
  // so any `confirm:yes` that arrives next is the citizen re-confirming
  // a service we already started. Without this, the injection guard
  // strips the prefix → "yes" hits the LLM → bilingual fallback fires.
  // Real bug surfaced by bench scenarios #2 / #4 / #7.
  if (btn_id === 'confirm:yes' && state.service_id &&
      ['collecting', 'reviewing'].includes(state.status) &&
      !state.pending_cancel) {
    const checklist = renderChecklist(state);
    const reply = checklist
      ? `👍 ممتاز — الطلب جاهز. أرسل المستندات بأي ترتيب:\n\n${checklist}`
      : '👍 ممتاز — أرسل المستندات الآن.';
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_confirm_yes_post_match' });
    return {
      reply, state, trace,
      _buttons: [
        button('review:submit'),
        button('service:switch'),
        button('service:cancel')
      ]
    };
  }

  // doc:extra / review:submit / review:pause / service:show / next:doc /
  // doc:yes / doc:wrong / confirm:yes / confirm:no — let the LLM handle
  // these (it has the conversational context). Strip the prefix in the
  // caller so the LLM sees just "نعم" / "لا" / "إضافي" / etc.
  return null;
}

export async function loadSession(session_id) {
  const { rows } = await db.execute({ sql: `SELECT state_json FROM session WHERE id=?`, args: [session_id] });
  if (!rows.length) {
    const state = { status: 'idle', collected: {}, pending_doc_index: 0 };
    await db.execute({ sql: `INSERT INTO session(id,state_json) VALUES (?,?)`, args: [session_id, JSON.stringify(state)] });
    return state;
  }
  const state = JSON.parse(rows[0].state_json || '{}');
  // Real prod bug found 2026-05-08: when a request row gets deleted
  // (DB wipe / demo seed reset) while a session still references it,
  // every subsequent storeMessage call passes the stale request_id and
  // hits SQLITE_CONSTRAINT_FOREIGNKEY on `message.request_id REFERENCES
  // request(id)`. The error escapes runTurn, the WA webhook's
  // try/catch logs it, and the citizen sees nothing — the session is
  // permanently stuck without anyone noticing.
  // Discovered via wa:96892888715 — state had request_id=704 but only
  // requests 817+ existed in prod. Trace fix: validate the FK at load
  // and reset to idle if the row is gone.
  if (state.request_id) {
    try {
      const { rows: reqRows } = await db.execute({
        sql: `SELECT id FROM request WHERE id = ? LIMIT 1`,
        args: [state.request_id]
      });
      if (!reqRows.length) {
        const stale = state.request_id;
        delete state.request_id;
        delete state.last_offered_buttons;
        state.status = 'idle';
        state.collected = {};
        state.pending_doc_index = 0;
        delete state.docs;
        delete state.extras;
        delete state.pending_uploads;
        delete state.service_id;
        delete state.service_code;
        await db.execute({
          sql: `UPDATE session SET state_json=?, updated_at=datetime('now') WHERE id=?`,
          args: [JSON.stringify(state), session_id]
        });
        console.warn(`[loadSession] cleared stale request_id=${stale} for ${session_id} — request row missing`);
      }
    } catch (e) {
      console.warn('[loadSession] stale-request check failed:', e.message);
    }
  }
  return state;
}

export async function saveSession(session_id, state) {
  await db.execute({
    sql: `UPDATE session SET state_json=?, updated_at=datetime('now') WHERE id=?`,
    args: [JSON.stringify(state), session_id]
  });
}

// ── Per-turn trace registry ─────────────────────────────────
// _runTurnLocked() registers its `trace` array here under the session_id
// for the duration of one turn. Any outbound bot `storeMessage` call
// inside that turn that doesn't pass an explicit `meta` will pick up a
// snapshot of the trace and persist it as `meta_json.trace`. This is the
// single switch that makes scripts/dump_session.mjs and the bucket-dropoff
// JSONLs show what tools the LLM called for each reply — without having
// to thread `meta:` through 25+ scattered storeMessage call sites.
//
// Cleared in a finally inside _runTurnLocked / runTurn so a crashed turn
// can't leak a stale trace into the next one.
const CURRENT_TRACE = new Map();
export function _registerTurnTrace(session_id, trace) {
  if (session_id) CURRENT_TRACE.set(session_id, trace);
}
export function _clearTurnTrace(session_id) {
  if (session_id) CURRENT_TRACE.delete(session_id);
}

export async function storeMessage({ session_id, request_id = null, direction, actor_type, body_text, media_url = null, meta = null, channel = 'web' }) {
  // Opportunistic trace pickup — see CURRENT_TRACE doc above.
  if (meta == null && direction === 'out' && actor_type === 'bot') {
    const live = CURRENT_TRACE.get(session_id);
    if (live && live.length) {
      // Snapshot — the trace array continues to grow during the turn, but
      // we want this row to reflect *what produced this reply*, not what
      // happened after it.
      meta = { trace: live.slice() };
    }
  }

  // ── Markdown emphasis scrub for outbound bot text ─────────────
  // WhatsApp renders **bold** as literal asterisks; the web tester's
  // bubble() uses textContent (no markdown). Applied at the storeMessage
  // chokepoint so all 114+ author sites + future LLM output get cleaned.
  // See stripMarkdownEmphasis() docstring for full pattern coverage.
  if (direction === 'out' && actor_type === 'bot' && typeof body_text === 'string') {
    body_text = stripMarkdownEmphasis(body_text);
  }
  // CX iter-5 (2026-05-08): real prod bug from +96892888715 — citizen
  // tapped review:submit, submit_request created request 914, state was
  // saved with request_id=914, then within the same handler storeMessage
  // hit FK constraint failure (request 914 had been deleted by a
  // demo-seed cycle / deploy boot / clear-phone running concurrently).
  // The handler exited mid-flight: state already saved with stale
  // request_id, but bot reply NEVER persisted. Citizen sat in silence.
  // Same pattern broke status:check the next turn.
  // Fix: never let an FK failure on message.request_id drop the bot's
  // reply. If the INSERT fails because request_id no longer exists,
  // retry once with request_id=null. The reply text + session_id are
  // what the citizen actually needs to see; the request linkage is a
  // nice-to-have for the office inbox sort.
  try {
    await db.execute({
      sql: `INSERT INTO message(session_id,request_id,direction,actor_type,body_text,media_url,meta_json,channel)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [session_id, request_id, direction, actor_type, body_text, media_url, meta ? JSON.stringify(meta) : null, channel]
    });
  } catch (e) {
    const msg = String(e?.message || e || '').toLowerCase();
    const isFk = msg.includes('foreign key') || msg.includes('foreign_key') || msg.includes('sqlite_constraint_foreignkey');
    if (isFk && request_id != null) {
      console.warn(`[storeMessage] FK failure on request_id=${request_id}, retrying with null. body_head="${String(body_text||'').slice(0,80)}"`);
      try {
        await db.execute({
          sql: `INSERT INTO message(session_id,request_id,direction,actor_type,body_text,media_url,meta_json,channel)
                VALUES (?,?,?,?,?,?,?,?)`,
          args: [session_id, null, direction, actor_type, body_text, media_url, meta ? JSON.stringify(meta) : null, channel]
        });
      } catch (retryErr) {
        console.warn('[storeMessage] retry-with-null also failed:', retryErr.message);
        throw retryErr;
      }
    } else {
      throw e;
    }
  }
  // ── Bump request.last_event_at on every citizen-inbound message so the
  // office's inbox sort surfaces the request that just got a reply. Also
  // mark the request as having an unread citizen reply (the inbox query
  // diffs this against last_office_view_at to render a 💬 fresh-reply
  // badge on the card).
  if (direction === 'in' && actor_type === 'citizen' && request_id) {
    try {
      await db.execute({
        sql: `UPDATE request
                 SET last_event_at = datetime('now'),
                     last_citizen_reply_at = datetime('now')
               WHERE id = ?`,
        args: [request_id]
      });
    } catch (e) { /* column might be missing on a not-yet-migrated DB; non-fatal */ }
  }
  // ── Test-mirror ──────────────────────────────────────────────
  // Outbound bot/officer messages on web sessions also fire to the test
  // phone via WhatsApp. Skip when the session itself IS a WhatsApp session
  // (the channel adapter already sent the real message), when the test phone
  // owns this session (no self-echo), or when WhatsApp creds aren't loaded.
  if (TEST_MIRROR_ENABLED && WHATSAPP_ENABLED && direction === 'out' && body_text) {
    try {
      const isWa = isWhatsAppSession(session_id);
      const sessionPhone = isWa ? String(session_id || '').replace(/^wa:/, '') : '';
      const stripped = SANAD_TEST_PHONE.replace(/[\s+]/g, '');
      const sessionStripped = sessionPhone.replace(/[\s+]/g, '');
      const sameAsTester = sessionStripped && stripped && (sessionStripped === stripped);
      if (!isWa && !sameAsTester) {
        const tag = `🧪 [test-mirror · ${actor_type}` +
                    (request_id ? ` · R-${request_id}` : '') +
                    `]\n`;
        sendWhatsAppText(SANAD_TEST_PHONE, tag + body_text)
          .catch(e => console.warn('[test-mirror] failed:', e.message));
      }
    } catch (e) {
      console.warn('[test-mirror] skipped:', e.message);
    }
  }
}

export async function ensureCitizen({ phone, name }) {
  const { rows } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
  if (rows.length) return rows[0].id;
  const r = await db.execute({ sql: `INSERT INTO citizen(phone,name) VALUES (?,?)`, args: [phone, name || null] });
  return Number(r.lastInsertRowid);
}

async function recentMessages(session_id, limit = 20) {
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
  // Wrap the inner runTurn so we can scrub markdown emphasis from the
  // outbound `reply` AT THE EXIT BOUNDARY. The HTTP chat route (res.json)
  // and the WhatsApp sender both consume `out.reply` directly — without
  // this scrub, the citizen would see literal **asterisks** even though
  // storeMessage's persisted copy is already clean. One return point ⇒
  // one place to enforce the rule for every channel.
  const out = await _runTurnImpl(args);
  if (out && typeof out.reply === 'string') {
    out.reply = stripMarkdownEmphasis(out.reply);
  }
  return out;
}

async function _runTurnImpl(args) {
  // Bump the per-session in-flight counter BEFORE we wait on the lock — the
  // burst-drain timer must see the file as pending even while we're queued.
  // Decrement is in `finally` regardless of how the locked work resolves.
  const isAttachment = !!args.attachment;
  if (isAttachment) bumpInflightFiles(args.session_id, +1);
  try {
    return await withSessionLock(args.session_id, async () => {
    // ── Burst-aggregation layer ─────────────────────────────
    // Lives ABOVE every handler so suppression applies uniformly across
    // idle / collecting / reviewing / queued / claimed / in_progress /
    // needs_more_info / awaiting_payment / awaiting_reclassify_ack.
    //
    // 1) Text turn while a burst is pending → drain the burst FIRST, then
    //    process the text normally (so citizen sees the file summary
    //    before the bot's text response lands).
    // 2) Attachment turn → run handler (still inserts doc rows, advances
    //    slot, etc.), then queue or extend the burst window. Suppress
    //    the immediate reply; one consolidated reply fires on drain.
    if (!args.attachment) {
      const cur = pendingBurst(args.session_id);
      if (cur) {
        // Force-fire the pending summary before processing text. This
        // also clears the timer.
        await drainBurst(args.session_id);
      }
      return _runTurnLocked(args);
    }

    const out = await _runTurnLocked(args);

    // Determine the burst kind for messaging. handleInFlight tagged its
    // returns with a meta marker; everything else is generic. Handlers can
    // also attach `_buttons` (a small quick-reply array) when the reply
    // expects a yes/no/pick-one answer — the drain layer will then send
    // an interactive WhatsApp message instead of plain text.
    const kind = (out && out._burstKind) || 'extra';
    armBurst(args.session_id, {
      reply: out.reply || '',
      request_id: out.request_id ?? out.state?.request_id ?? null,
      kind,
      buttons: (out && Array.isArray(out._buttons) && out._buttons.length) ? out._buttons : null
    });
    // Suppress this turn's reply; the drain timer will emit one consolidated
    // reply 1.8 s after the LAST file in the burst.
    return { ...out, reply: '' };
    });
  } finally {
    if (isAttachment) bumpInflightFiles(args.session_id, -1);
  }
}

async function _runTurnLocked({ session_id, user_text, attachment, citizen_phone }) {
  const trace = [];
  // Register the trace so storeMessage() picks it up automatically for
  // every outbound bot reply during this turn. See CURRENT_TRACE above.
  _registerTurnTrace(session_id, trace);
  try {
    return await __runTurnLockedInner({ session_id, user_text, attachment, citizen_phone, trace });
  } finally {
    _clearTurnTrace(session_id);
  }
}

async function __runTurnLockedInner({ session_id, user_text, attachment, citizen_phone, trace }) {
  let state = await loadSession(session_id);
  const raw = (user_text || '').trim();
  trace.push({ step: 'load_state', status: state.status });

  // CX iter-5 (2026-05-08): real prod bug from +96892888715 traces
  // #1740/#1831 — runTurn was called with raw='' AND attachment=null
  // (caller couldn't extract text or recognized media from a webhook
  // payload). The default storeMessage path then wrote '(attachment)' as
  // the citizen body even though no file was actually attached, and the
  // V2 tool loop fired with no useful input → LLM credit-error fallback
  // → 'تعذّر الاتصال' as a phantom 'first reply' before the actual burst
  // summary landed. Intercept centrally so all entry points (WhatsApp
  // route + /api/chat web route) get the same deterministic recovery.
  if (!raw && !attachment) {
    const reply = '⚠️ لم أستلم محتوى أتعرف عليه. أرسل صورة (JPG/PNG/HEIC) أو ملف PDF أو رسالة نصية.';
    // Don't store the empty citizen turn — it would clutter the trace.
    // Just emit the bot reply so the caller can send it to the channel.
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_empty_payload_notice' });
    return { reply, state, trace };
  }

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
  // EXCEPTION: when the session is already in-flight (the citizen has a
  // request being processed by an office) AND a new attachment arrives, we
  // skip v2 and route through the deterministic handleInFlight path. v2's
  // LLM tends to treat each new file as a fresh intent and ask "is this for
  // service X?" — bypassing it here keeps multi-file uploads attached to
  // the existing request and triggers the burst-summary timer.
  const inFlightStatuses = ['queued','claimed','in_progress','needs_more_info','awaiting_payment','awaiting_reclassify_ack'];
  const inFlightWithAttachment = attachment && inFlightStatuses.includes(state.status);
  if (AGENT_V2 && LLM_ENABLED && !inFlightWithAttachment) {
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
  } else if (state.status === 'queued' || state.status === 'claimed' || state.status === 'in_progress' || state.status === 'needs_more_info' || state.status === 'awaiting_payment' || state.status === 'awaiting_reclassify_ack') {
    ({ reply, state } = await handleInFlight({ state, raw, trace, attachment, session_id }));
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
  // Wall-clock timeout: a slow/hung LLM should never tie up the citizen's
  // request indefinitely. 25 s leaves headroom under a typical 30 s edge
  // proxy timeout. On timeout we fall through to a graceful response.
  const LLM_BUDGET_MS = Number(process.env.SANAD_LLM_BUDGET_MS || 25000);
  const startedAt = Date.now();
  const overBudget = () => (Date.now() - startedAt) > LLM_BUDGET_MS;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (overBudget()) {
      trace.push({ step: 'llm_timeout', round });
      return { reply: 'استلمت رسالتك — أعطني لحظة وحاول مرة ثانية بسؤال محدد لو سمحت.', state };
    }
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
  if (overBudget()) {
    return { reply: 'استلمت رسالتك — أعطني لحظة وحاول مرة ثانية بسؤال محدد لو سمحت.', state };
  }
  const last = await chatWithTools({ messages, tools: [], trace });
  return { reply: sanitizeReply(last.content, raw) || 'جرب سؤالاً محدداً.', state };
}

function firstDocPrompt(service_code) {
  const s = launchService(service_code);
  if (!s) return 'بدأنا تجهيز ملفك ✅ سأطلب المستندات واحداً تلو الآخر.';
  const d = s.required_documents[0];
  const total = s.required_documents.length;
  // Plain text only — WhatsApp renders **asterisks** literally. Fee is
  // shown upfront when known so the citizen isn't surprised after uploading
  // every document; null fees are silently omitted (the office will quote
  // the standard price on review).
  const feeLine = (typeof s.fee_omr === 'number' && s.fee_omr > 0)
    ? `\n💰 الرسوم: ${s.fee_omr.toFixed(3)} ر.ع (تُحدّد عند مراجعة المكتب)`
    : '';
  return `✅ بدأنا تجهيز ملف ${s.name_ar}.${feeLine}
نحتاج ${total} مستندات. الأول:

📄 ${d.label_ar} / ${d.label_en}

أرسلها كصورة أو PDF.`;
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

// Greeting / help / thanks classifier. Mirrors the regex patterns the
// heuristic path uses (~line 1559+) so runAgentV2 can short-circuit the
// LLM for these intents — preventing the real prod bug where "مرحبا"
// triggered a search_services call and got back a "found 3 services"
// reply. Keep the regex anchored at the start so mid-sentence words
// ("مرحب بك في تجديد الرخصة") don't match.
//
// ⚠️ NEVER use \b in these patterns. \b is a no-op between two Arabic
// characters (both non-word in JS regex), so `^مرحب\b` would never match
// `مرحبا`. See README "Recent decisions log → 2026-04-19 · Greeting regex
// dropped \b". Use trailing whitespace/punctuation/end-of-string instead.
const _END = '(?=\\s|$|[!.,،؟?])';
const _GREETING_RE = new RegExp(
  `^\\s*(hi|hello|hey|hola|yo|salam|salaam|assalam[ou]?\\s*alaikum|good\\s+(morning|afternoon|evening)|مرحب[اًا]?|السلام|اهلا|أهلا|هاي|هلا|صباح(\\s+(الخير|النور))?|مساء(\\s+(الخير|النور))?)${_END}`, 'i');
const _HELP_RE = new RegExp(
  `^\\s*(help|menu|\\?|مساعده|مساعدة|قدراتك|ماذا\\s+تفعل|شو\\s+تسوي|what\\s+can\\s+you|how\\s+do\\s+you\\s+work)${_END}`, 'i');
const _THANKS_RE = new RegExp(
  `^\\s*(thanks|thank\\s+you|thx|ty|cheers|شكر[اًا]?|مشكور|يعطيك|تسلم|الله\\s+يعطيك)${_END}`, 'i');

export function isGreetingOrHelp(text) {
  if (!text || typeof text !== 'string') return false;
  return _GREETING_RE.test(text) || _HELP_RE.test(text) || _THANKS_RE.test(text);
}

export function greetingIntent(text) {
  if (!text || typeof text !== 'string') return null;
  if (_THANKS_RE.test(text))   return 'thanks';
  if (_HELP_RE.test(text))     return 'help';
  if (_GREETING_RE.test(text)) return 'greeting';
  return null;
}

// Strip markdown bold/italic markers from outbound bot text. WhatsApp does
// NOT render `**bold**` or `__bold__` — the asterisks/underscores show up
// as literal characters and ruin the message. The web tester's bubble()
// also uses textContent (no markdown rendering), so it has the same issue.
//
// Applied centrally inside storeMessage() so every outbound bot reply is
// scrubbed regardless of source — LLM output, deterministic templates,
// canned messages — without having to audit every author site (114+ in
// agent.js alone). Captures these patterns:
//   ***bold-italic*** → bold-italic
//   **bold**          → bold       (most common)
//   __bold__          → bold       (alt CommonMark)
//   *italic*          → italic     (only when adjoining word chars — bullet
//                                   "* item" lines are preserved)
// Empty/whitespace-only inner content is left alone.
export function stripMarkdownEmphasis(text) {
  if (text == null) return text;
  let t = String(text);
  // ***bold-italic*** → keep inner content
  t = t.replace(/\*\*\*([^*\n][^*\n]*?)\*\*\*/g, '$1');
  // __bold__
  t = t.replace(/__([^_\n][^_\n]*?)__/g, '$1');
  // **bold** — must contain at least one non-space, non-asterisk char
  t = t.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '$1');
  // *italic* — only when adjoining a word char on at least one side, so
  // bullet "* item" lines and standalone "* * *" dividers are preserved.
  t = t.replace(/(^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?=[^\w*]|$)/g, '$1$2');
  return t;
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
    // Launch services may have null fee_omr (v3 fixed-pricing model — total is
    // computed at /send-payment from catalog office_fee + gov_fee). Fall back
    // to a clear "office will confirm" line instead of crashing on toFixed.
    const feeLine = (s.fee_omr != null && Number.isFinite(Number(s.fee_omr)))
      ? `قيمة المعاملة: ${Number(s.fee_omr).toFixed(3)} ريال عماني (تُضاف إليها رسوم المكتب).`
      : `الرسوم: محسوبة من القائمة (رسوم الخدمة + رسوم المكتب) ويؤكدها مكتب سند المستلم قبل الدفع.`;
    return {
      reply: `هل تقصد: **${s.name_ar}** (${s.entity_ar})؟\n${feeLine}\nالمستندات المطلوبة:\n${docs}\n\n👉 اكتب **نعم** لنبدأ تجهيز ملفك ونرسله إلى مكاتب سند، أو اسأل أي سؤال عن الخدمة.`,
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
    ? (isAr ? '\n\n👉 اكتب **نعم** لنبدأ تجهيز ملفك ونرسله إلى مكتب سند للمراجعة.' : '\n\n👉 Type **yes** and I\'ll prepare your file and dispatch it to a Sanad office for review.')
    : (isAr ? '\n\n💡 هذه الخدمة للاستعلام فقط حالياً — يمكنك زيارة أي مكتب سند للتقديم.' : '\n\n💡 Info-only for now — visit any Sanad office to submit.');
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
      reply: `ممتاز — نبدأ تجهيز ملفك ✅\nأرسل أولاً: **${s.required_documents[0].label_ar}** / ${s.required_documents[0].label_en}.`,
      state
    };
  }

  // Free-form question about the SAME service — answer using the launch-service
  // data as context; do NOT re-search the catalogue (that loses state).
  const s = launchService(state.service_code);
  if (s) {
    const { answerAboutService } = await import('./llm.js');
    // Bug fix from prod trace 2026-05-09: `${s.fee_omr} OMR` was rendering
    // "null OMR 💰" when fee_omr was null (e.g. CR Renewal). Use the
    // SYSTEM_V2 spec wording for unknown fees instead.
    const feesText = (typeof s.fee_omr === 'number' && s.fee_omr > 0)
      ? `${s.fee_omr} OMR`
      : 'الرسوم غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم';
    const fakeRow = {
      name_en: s.name_en, name_ar: s.name_ar,
      entity_en: s.entity_en, entity_ar: s.entity_ar,
      fees_text: feesText, fee_omr: s.fee_omr,
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
    // Try to infer which required doc this upload maps to:
    //   1) caption / filename hints (cheap, deterministic, language-aware)
    //   2) vision classifier when (1) is uncertain and the file is an image
    //   3) fall back to the next pending slot in declaration order
    // Vision is best-effort — any failure (no key, API down, parse error) is
    // silently absorbed; we keep the legacy caption/order behaviour.
    const caption = (attachment.caption || '').toString();
    let inferred = matchDocByCaption(caption, s.required_documents, state.collected);
    let visionMeta = null;
    const isImage = (attachment.mime || '').toLowerCase().startsWith('image/');
    if (!inferred && isImage && VISION_ENABLED) {
      try {
        const slots = s.required_documents
          .filter(d => !state.collected[d.code] && !isPlaceholderDoc(d))
          .map(d => ({ code: d.code, label_en: d.label_en, label_ar: d.label_ar }));
        if (slots.length) {
          const v = await classifyDocImage({
            attachment,
            candidate_slots: slots,
            language: 'ar'
          });
          trace.push({ step: 'vision_classify', ok: v.ok, best: v.best?.code || null, conf: v.best?.confidence ?? null });
          if (v.ok && v.best && v.best.confidence >= 0.55) {
            const matched = s.required_documents.find(d => d.code === v.best.code);
            if (matched) {
              inferred = matched;
              visionMeta = { code: v.best.code, confidence: v.best.confidence, summary: v.best.summary };
            }
          }
        }
      } catch (e) {
        trace.push({ step: 'vision_error', error: e.message });
      }
    }
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
      caption: caption || null,
      matched_via: visionMeta ? 'vision' : (inferred ? 'caption' : 'order'),
      vision: visionMeta
    };

    // Advance pending index past any slots now filled
    while (state.pending_doc_index < s.required_documents.length
           && state.collected[s.required_documents[state.pending_doc_index].code]) {
      state.pending_doc_index += 1;
    }

    const next = s.required_documents[state.pending_doc_index];
    const recognisedSrc = visionMeta ? 'بتحليل الصورة' : (inferred ? 'من الوصف' : '');
    const ack = inferred && !wasExpected
      ? `✅ استلمنا **${targetDoc.label_ar}** (تعرّفنا عليها ${recognisedSrc}).`
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
//
// Catalogue codes are noisy ('the_expired_id_card', 'nothing', etc.), so we
// don't trust an exact code lookup. For each pending slot we figure out what
// CANONICAL doc-type it is by checking whether any DOC_CAPTION_HINTS phrase
// appears in the slot's code or label, then score the caption against that
// canonical type's keyword list.
function matchDocByCaption(caption, requiredDocs, collected) {
  if (!caption) return null;
  // Normalise separators so filename-style "civil_id_copy.pdf" and hint
  // "civil id" both reduce to "civil id copy pdf" / "civil id".
  const norm = s => String(s || '').toLowerCase().replace(/[_\-.\\\/]+/g, ' ');
  const cap = norm(caption);
  let best = null, bestScore = 0;
  for (const d of requiredDocs) {
    if (collected[d.code]) continue;
    if (isPlaceholderDoc(d)) continue;

    const codeStr = String(d.code || '').toLowerCase();
    const codeNorm = norm(d.code || '');
    const labelStr = `${d.label_en || ''} ${d.label_ar || ''}`.toLowerCase();

    // Build the hint list for THIS slot:
    //  • exact-code lookup, then
    //  • for every canonical doc-type, if any of its hint phrases appears
    //    in the slot's code or label (treating space ↔ underscore as the
    //    same), this slot IS that type — pull in all of its hints.
    let hints = DOC_CAPTION_HINTS[d.code] ? [...DOC_CAPTION_HINTS[d.code]] : [];
    for (const [hintKey, hintList] of Object.entries(DOC_CAPTION_HINTS)) {
      const slotIsThisType =
        codeStr.includes(hintKey) || codeNorm.includes(hintKey.replace(/_/g, ' ')) ||
        hintList.some(h => {
          const hLow = h.toLowerCase();
          return codeNorm.includes(hLow) || labelStr.includes(hLow);
        });
      if (slotIsThisType) hints = hints.concat(hintList);
    }

    const labelWords = labelStr.split(/\s+/).filter(w => w.length >= 3);
    const allHints = [...hints, ...labelWords];
    let score = 0;
    for (const h of allHints) {
      if (h && cap.includes(h.toLowerCase())) score += h.length >= 6 ? 2 : 1;
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return bestScore >= 2 ? best : null;
}

// Some catalogue rows mark "no documents required" with a placeholder slot
// (code='nothing', label empty, etc.). Treat these as "no real required docs"
// for the auto-record decision so an upload becomes an extra, not a forced
// fill of the placeholder.
function isPlaceholderDoc(d) {
  if (!d) return true;
  const code = String(d.code || '').toLowerCase().trim();
  if (!code || ['nothing', 'none', 'n/a', 'na'].includes(code)) return true;
  const label = `${d.label_en || ''} ${d.label_ar || ''}`.toLowerCase().trim();
  if (!label && code.length < 4) return true;
  return false;
}

// Catalog has many services where label_ar is empty (real-world bug:
// service 110102 "Issue New Resident and Work Card" has label_ar="" for
// every doc). When the bot is replying in Arabic, raw English labels look
// jarring inline. Use this map to translate common doc codes to native
// Arabic; fall back to the English label parenthesized if no match.
//
// NOT exhaustive — it covers the doc-codes the catalog has actually
// produced so far. Extend as new ones surface.
const ARABIC_DOC_LABELS = {
  civil_id:       'البطاقة المدنية',
  passport:       'جواز السفر',
  photo:          'صورة شخصية',
  personal_photo: 'صورة شخصية',
  medical:        'فحص طبي',
  medical_fitness:'شهادة لياقة طبية',
  valid_medical_fitness_certificate: 'شهادة لياقة طبية سارية',
  employment_contract:                'عقد العمل',
  employment_contract_approved_by_the_mini: 'عقد العمل المعتمد من وزارة الصحة',
  appointment_letter:                 'خطاب التعيين',
  appointment_letter_from_the_concerned_he: 'خطاب التعيين من الجهة الصحية',
  old_id_photo:   'البطاقة المدنية الحالية',
  old_passport:   'الجواز الحالي',
  mulkiya:        'الملكية',
  insurance:      'بوليصة التأمين',
  activity_list:  'قائمة الأنشطة',
  tenancy:        'عقد الإيجار',
  address_map:    'خريطة موقع العنوان',
  declaration:    'إقرار خطّي',
  lost_report:    'محضر فقد من الشرطة',
  bank_statement: 'كشف حساب بنكي',
  birth_certificate: 'شهادة ميلاد',
  marriage_cert:  'عقد الزواج',
  // Title-deed (سند ملكية) family — caught in trace +96892888715 #1278
  // where catalog rows for service 150036 had empty label_ar.
  police_report_of_loss_if_available:        'تقرير الشرطة عن الفقدان',
  police_report:                             'تقرير الشرطة',
  original_deed_number_or_known_property_d:  'رقم السند الأصلي أو تفاصيل العقار',
  no_objection_certificate_from_the_owner_:  'شهادة عدم ممانعة من المالك',
  no_objection_certificate_from_sponsoring:  'شهادة عدم ممانعة من الجهة الكفيلة',
  no_objection_certificate:                  'شهادة عدم ممانعة',
  title_deed:                                'سند الملكية',
  property_deed:                             'سند الملكية',
  // Commercial registration (إنشاء سجل تجاري) family — caught in trace
  // +96892888715 #1314 (service 120008) where these labels leaked English.
  recent_passport_sized_photograph:          'صورة شخصية حديثة',
  passport_sized_photograph:                 'صورة شخصية',
  proof_of_address:                          'إثبات عنوان',
  passport_for_non_omanis:                   'جواز السفر (لغير العُمانيين)',
  commercial_registration_form:              'استمارة السجل التجاري',
  commercial_name_certificate:               'شهادة الاسم التجاري',
  // Driver-license-renewal family — caught in trace +96892888715
  // #1488/#1490/#1494 (service 140017) on 2026-05-07.
  current_driver_s_license:                  'رخصة القيادة الحالية',
  current_drivers_licence:                   'رخصة القيادة الحالية',
  recent_personal_photograph:                'صورة شخصية حديثة'
  // (medical_fitness_certificate / valid_medical_fitness_certificate
  //  are already mapped above; don't redeclare.)
};

// Render a live checklist for state.docs vs state.collected.
//
// Per the WhatsApp UX spec (Khidmat v1, applied 2026-05-06): every
// collecting/reviewing reply MUST include this so the citizen never has
// to ask "what else do you need?" — the answer is always on screen.
//
// Markers (matching the spec):
//   ✅  collected (storage_url present → real file attached)
//   ⏳  pending (no upload yet)
//   ½  partial — placeholder for future per-page expected_pages tracking
//
// Returns '' when there are no real required docs (placeholder-only catalog
// rows like {code:'nothing'}). Callers should skip showing the checklist
// section entirely when this returns ''.
function renderChecklist(state) {
  const docs = ((state && state.docs) || []).filter(d => !isPlaceholderDoc(d));
  if (!docs.length) return '';
  const collected = (state && state.collected) || {};
  return docs.map(d => {
    const slot = collected[d.code];
    const got = !!(slot && slot.storage_url);
    const label = arabicLabelFor(d);
    const mark = got ? '✅' : '⏳';
    return `${mark} ${label}`;
  }).join('\n');
}

// Render the required-documents bullet list shown at the start of a
// submission. When most/all entries would resolve to the generic
// fallback "مستند" (because the catalogue row has no real labels),
// rendering "1) مستند 2) مستند 3) مستند" gives the citizen zero signal
// and looks broken — exactly the +96892888715 trace bug from
// 2026-05-09 on the CR Renewal service.
//
// Returns either:
//   { kind: 'list',   text: '1) X\n2) Y' }   when at least half have real labels
//   { kind: 'prompt', text: 'أرسل لي ...' }  when all/most resolve to "مستند"
//
// Caller renders accordingly: list goes after "الملفات المطلوبة:", prompt
// REPLACES that whole section.
export function renderDocListOrPrompt(docs, serviceName) {
  const real = (docs || []).filter(d => {
    const lbl = arabicLabelFor(d);
    // 'مستند' is the catch-all fallback inside arabicLabelFor — treat it
    // as "no real label" for the purpose of this decision.
    return lbl && lbl !== 'مستند';
  });
  const total = (docs || []).length;
  // If at least half the slots have meaningful labels, render the list
  // (using real labels for the meaningful ones, and the generic word for
  // the placeholders — at least the count is right).
  if (total > 0 && real.length >= Math.ceil(total / 2)) {
    const lines = (docs || [])
      .map((d, i) => `${i + 1}) ${arabicLabelFor(d) || 'مستند'}`)
      .join('\n');
    return { kind: 'list', text: lines };
  }
  // Otherwise: don't fake a doc-by-doc list. Ask one open question.
  // The receiving Sanad office will follow up if specific docs are
  // missing — that's the spec's "office is the safety net" pattern.
  const svc = serviceName ? ` لـ${serviceName}` : '';
  return {
    kind: 'prompt',
    text: `أرسل لي المستندات اللازمة${svc} (يمكنك إرسال أكثر من ملف).`
  };
}

// Pick the best Arabic label for a doc:
//   1. doc.label_ar if non-empty
//   2. ARABIC_DOC_LABELS[code]
//   3. doc.label_en wrapped in "(English: …)" so the citizen knows it's
//      not translated yet. Better than silently leaking English.
function arabicLabelFor(doc) {
  if (!doc) return '';
  const ar = (doc.label_ar || '').trim();
  if (ar) return ar;
  const code = String(doc.code || '').toLowerCase().trim();
  const mapped = ARABIC_DOC_LABELS[code];
  if (mapped) return mapped;
  // Try a normalized-prefix lookup so codes truncated by SQL VARCHAR (e.g.
  // employment_contract_approved_by_the_mini → 40 chars) still hit. Require
  // BOTH sides to be non-empty + at least 4 chars to avoid the ''.startsWith('')
  // degenerate case where every empty doc would resolve to "البطاقة المدنية".
  if (code.length >= 4) {
    for (const [k, v] of Object.entries(ARABIC_DOC_LABELS)) {
      if (k.length >= 4 && (code.startsWith(k) || k.startsWith(code))) return v;
    }
  }
  // No Arabic mapping. If the doc has truly nothing (no code AND no
  // labels), return empty — caller treats it as a placeholder and skips.
  // Otherwise render the generic Arabic placeholder per codex review
  // (gpt-5.2-codex 2026-05-08). The «label_en»‎ pattern was leaking on
  // 60% of bot replies, violating the "Arabic only" spec. The receiving
  // office sees the canonical doc code in request_document.
  const hasAnything = (doc.code && String(doc.code).trim()) ||
                      (doc.label_en && String(doc.label_en).trim()) ||
                      (doc.label_ar && String(doc.label_ar).trim());
  return hasAnything ? 'مستند' : '';
}

function hasRealRequiredDocs(state) {
  if (!Array.isArray(state.docs) || state.docs.length === 0) return false;
  return state.docs.some(d => !isPlaceholderDoc(d));
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
  const feeLine = (s.fee_omr != null && Number.isFinite(Number(s.fee_omr)))
    ? `قيمة المعاملة: **${Number(s.fee_omr).toFixed(3)} ريال** (تُضاف إليها رسوم المكتب).`
    : `الرسوم: تُحسب من القائمة الرسمية (رسوم الخدمة + رسوم المكتب) ويؤكدها المكتب المستلم قبل الدفع.`;
  return `ملف **${s.name_ar}** جاهز للإرسال ✅\n${summary}\n\n${feeLine}\n\nاكتب **نعم** أو **تأكيد** لإرسالك الطلب إلى مكتب سند للمراجعة (أو **إلغاء** للرجوع).`;
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
      // CX iter-4 (citizen comment #1815): trimmed numbered ladder.
      reply: `✅ تم الإرسال.\n🆔 *#R-${request_id}*\n\nالمكتب يراجع الطلب وسأرسل لك رابط الدفع فور جاهزيته.`,
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

async function handleInFlight({ state, raw, trace, attachment, session_id }) {
  const t = (raw || '').trim();
  const lowT = t.toLowerCase();

  // ── Reclassify accept / decline ─────────────────────────────
  // When the office proposes a service change the request sits in
  // 'awaiting_reclassify_ack'. The citizen's "موافق/نعم/yes" applies the
  // pending values; "رفض/لا/no" rolls them back. Anything else falls
  // through to the normal in-flight handlers — but we replay the proposal
  // so they remember what's pending.
  if (state.request_id) {
    try {
      const { rows: pr } = await db.execute({
        sql: `SELECT r.id, r.status, r.session_id, r.service_id, r.office_id,
                     r.pending_service_id, r.pending_office_fee_omr, r.pending_government_fee_omr,
                     r.pending_quoted_fee_omr, r.pending_reclassify_reason,
                     s.name_ar AS pending_name_ar, s.name_en AS pending_name_en
                FROM request r
                LEFT JOIN service_catalog s ON s.id = r.pending_service_id
               WHERE r.id=?`,
        args: [state.request_id]
      });
      const rrow = pr[0];
      if (rrow && rrow.status === 'awaiting_reclassify_ack' && rrow.pending_service_id) {
        const accept = /^(موافق|اوافق|أوافق|نعم|اي|أي|ايوا|أيوا|ايوه|yes|y|ok|okay|sure|approve|agree|accept)\b/i.test(lowT);
        const decline = /^(رفض|ارفض|أرفض|لا|no|n|nope|cancel|إلغاء|الغ|reject|decline)\b/i.test(lowT);
        if (accept) {
          // Apply the pending pricing + service. Status returns to 'claimed'
          // so the office's review timer resumes; they can now send the
          // payment link with the new total.
          await db.execute({
            sql: `UPDATE request
                     SET service_id=?, office_fee_omr=?, government_fee_omr=?, quoted_fee_omr=?,
                         status='claimed',
                         claim_review_started_at=datetime('now'),
                         pending_service_id=NULL, pending_office_fee_omr=NULL,
                         pending_government_fee_omr=NULL, pending_quoted_fee_omr=NULL,
                         pending_reclassify_reason=NULL,
                         last_event_at=datetime('now')
                   WHERE id=? AND status='awaiting_reclassify_ack'`,
            args: [rrow.pending_service_id, rrow.pending_office_fee_omr,
                   rrow.pending_government_fee_omr, rrow.pending_quoted_fee_omr,
                   state.request_id]
          });
          await db.execute({
            sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
                  VALUES ('citizen', NULL, 'request_reclassify_accepted', 'request', ?, ?)`,
            args: [state.request_id, JSON.stringify({
              from_service: rrow.service_id, to_service: rrow.pending_service_id,
              new_total: rrow.pending_quoted_fee_omr
            })]
          });
          return {
            reply: `✅ تم قبول الخدمة الجديدة "${rrow.pending_name_ar || rrow.pending_name_en}". المكتب سيُرسل رابط الدفع بالإجمالي المحدّث (${Number(rrow.pending_quoted_fee_omr).toFixed(3)} ر.ع).`,
            state
          };
        }
        if (decline) {
          await db.execute({
            sql: `UPDATE request
                     SET status='claimed',
                         pending_service_id=NULL, pending_office_fee_omr=NULL,
                         pending_government_fee_omr=NULL, pending_quoted_fee_omr=NULL,
                         pending_reclassify_reason=NULL,
                         last_event_at=datetime('now')
                   WHERE id=? AND status='awaiting_reclassify_ack'`,
            args: [state.request_id]
          });
          await db.execute({
            sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
                  VALUES ('citizen', NULL, 'request_reclassify_declined', 'request', ?, ?)`,
            args: [state.request_id, JSON.stringify({ rejected_to_service: rrow.pending_service_id })]
          });
          return {
            reply: '❌ تم رفض اقتراح تغيير الخدمة. سيتابع المكتب على الخدمة الأصلية أو يُعيد الطلب إلى السوق إن لم يستطع.',
            state
          };
        }
        // Unrecognised reply while a reclassify is pending — replay the
        // proposal so the citizen knows what's blocking them.
        return {
          reply:
            `🔄 طلب التحويل لا يزال معلّقاً.\n` +
            `الخدمة المقترحة: **${rrow.pending_name_ar || rrow.pending_name_en}**\n` +
            `الإجمالي الجديد: **${Number(rrow.pending_quoted_fee_omr).toFixed(3)} ر.ع**\n\n` +
            `للموافقة اكتب **موافق**. للرفض اكتب **رفض**.`,
          state
        };
      }
    } catch (e) {
      trace.push({ step: 'reclassify_ack_error', error: e.message });
    }
  }

  // Re-upload path: when an attachment arrives while the request is in flight,
  // route it as a replacement for the most-recently-rejected document on the
  // request. This is what backs the "officer rejected my id-back, I'll send
  // a new one in an hour, then I upload" UX. Without this, the file just
  // dangles and the office never sees the new copy.
  if (attachment && state.request_id) {
    try {
      const { rows: rejRows } = await db.execute({
        sql: `SELECT id, doc_code, label FROM request_document
                WHERE request_id=? AND status='rejected'
                ORDER BY verified_at DESC, id DESC LIMIT 1`,
        args: [state.request_id]
      });
      if (rejRows[0]) {
        const slot = rejRows[0];
        // Insert a fresh row for the new upload, mark the old one as 'replaced'
        // so the office's gallery shows BOTH (history) and the chip turns green.
        await db.execute({
          sql: `UPDATE request_document SET status='replaced'
                 WHERE id=? AND status='rejected'`,
          args: [slot.id]
        });
        await db.execute({
          sql: `INSERT INTO request_document
                  (request_id, doc_code, label, storage_url, mime, size_bytes,
                   status, original_name, caption, matched_via)
                VALUES (?,?,?,?,?,?, 'pending', ?, ?, 'replacement')`,
          args: [
            state.request_id, slot.doc_code, slot.label,
            attachment.url, attachment.mime || null, attachment.size || null,
            attachment.name || null, attachment.caption || null
          ]
        });
        // Move the request back to claimed so the office's SLA review timer
        // resumes — they have something fresh to look at.
        await db.execute({
          sql: `UPDATE request
                   SET status=CASE WHEN status='needs_more_info' THEN 'claimed' ELSE status END,
                       last_event_at=datetime('now')
                 WHERE id=?`,
          args: [state.request_id]
        });
        // Return the natural per-file reply with a kind hint. The
        // top-level burst aggregator in runTurn() decides whether to
        // emit it now (solo file) or merge into a multi-file summary.
        return {
          reply: `✅ استلمت النسخة المحدَّثة من "${slot.label || slot.doc_code}" وأرسلتها إلى مكتب سند للمراجعة.`,
          state,
          _burstKind: 'replacement'
        };
      }
    } catch (e) {
      // Don't crash the citizen flow if the replace path errors — fall
      // through to the generic in-flight reply below.
      trace.push({ step: 'inflight_replace_error', error: e.message });
    }

    // Attachment with no rejected slot — store it as supplementary so the
    // office sees it. Better than dropping it on the floor.
    try {
      await db.execute({
        sql: `INSERT INTO request_document
                (request_id, doc_code, label, storage_url, mime, size_bytes,
                 status, original_name, caption, matched_via, is_extra)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'extra', 1)`,
        args: [
          state.request_id,
          'extra_' + Date.now(),
          (attachment.caption || attachment.name || 'Additional document').slice(0, 200),
          attachment.url, attachment.mime || null, attachment.size || null,
          attachment.name || null, attachment.caption || null
        ]
      });
      await db.execute({
        sql: `UPDATE request SET last_event_at=datetime('now') WHERE id=?`,
        args: [state.request_id]
      });
      return {
        reply: '✅ استلمت ملفك وأرسلته إلى المكتب المتولّي طلبك.',
        state,
        _burstKind: 'extra'
      };
    } catch (e) {
      trace.push({ step: 'inflight_extra_error', error: e.message });
    }
  }

  // "I'm done sending files" closer — clean acknowledgment after a burst.
  // Doesn't change request status (the office still has to verify), just
  // tells the citizen the message was received.
  if (t && /^(تم|خلصت|خلاص|انتهيت|كل شي|كل شيء|that.?s all|done|finished|نعم انتهيت)\s*\.?$/i.test(t)) {
    return {
      reply: 'تمام 👍 الملفات في يد المكتب الآن. سأخبرك حال انتهاء المراجعة أو طلب أي تعديل.',
      state
    };
  }

  // OTP forwarding — relay between citizen and the Sanad office officer
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
      return { reply: '✅ مرّرت الرمز إلى موظف مكتب سند — يكمل المعاملة الآن.', state };
    }
  }
  if (/(حالة|status)/i.test(t)) {
    const { request } = await TOOL_IMPL.get_request_status({ request_id: state.request_id });
    if (!request) return { reply: 'ما لقيت طلبك — جرب مجدداً.', state };
    // ANONYMITY: never name the office to the citizen. Use platform-voice
    // status copy that's identical whether claimed or still in pool — silent
    // SLA transfers are invisible to the citizen.
    const stage = request.office_id
      ? '📋 طلبك قيد المراجعة الآن.'
      : '⏳ ملفك في قائمة المراجعة — سنُخطرك حال البدء.';
    return { reply: `📄 طلب **#R-${request.id}** — الحالة: **${request.status}**\nقيمة المعاملة: ${request.fee_omr} ر.ع\n${stage}`, state };
  }
  return { reply: 'تمام — موظف مكتب سند يعمل على معاملتك وسيتواصل معك قريباً. اكتب "حالة" أو "status" لآخر التحديثات.', state };
}

// ────────────────────────────────────────────────────────────
// Canned messages
// ────────────────────────────────────────────────────────────

// Exported (with `_` prefix to mark internal) so tests can assert that no
// markdown bold (**) leaks into outbound text — WhatsApp would render the
// asterisks literally. See tests/15-bot-helpers.test.js.
export { welcomeMessage as _welcomeMessage,
         helpMessage    as _helpMessage,
         firstDocPrompt as _firstDocPrompt };

function welcomeMessage() {
  // ⚠️ Plain text only — WhatsApp does not render markdown. Asterisks would
  // appear literally and ruin the first impression. The system prompt bans
  // the LLM from using **bold**; this deterministic template must follow
  // the same rule. Brevity ceiling per SYSTEM_V2: ≤40 words / first reply.
  // EN + AR must tell the same dispatch story (single office reviews → sends
  // payment link); the older "marketplace / available offices claim" wording
  // contradicts the current product spec.
  return `👋 أهلاً! أنا ساند — أُجهّز معك ملف طلبك (الخدمة + المستندات) ثم أُرسله إلى مكتب سند للمراجعة، ويصلك رابط الدفع.

جرّب:
• أبغى أجدد رخصة القيادة
• كم رسوم إصدار جواز السفر؟
• أحتاج سجل تجاري

شو تحتاج اليوم؟

───
👋 Hi! I'm Saned. I'll build your request file (service + documents) and dispatch it to a Sanad office for review — they'll send you the payment link and complete the paperwork.

What do you need today?`;
}

function helpMessage() {
  // Plain text only — WhatsApp renders **asterisks** literally.
  return `أنا ساند — الواجهة الذكية بينك وبين شبكة مكاتب سند.

كيف نعمل سوياً:
1️⃣ نختار الخدمة — أبحث في 600+ خدمة وأقترح الأنسب
2️⃣ نُجهّز الملف — نجمع المستندات المطلوبة
3️⃣ نُرسل لمكتب سند — يستلم المكتب الطلب ويُراجعه
4️⃣ رابط الدفع — يصلك رابط الدفع برسوم الخدمة (سعر موحّد)
5️⃣ الإنجاز — يتولى المكتب المعاملة، وأخبرك فور اكتمالها

📌 لست بحاجة لزيارة أي جهة حكومية بنفسك.

أسئلة سريعة: "كم الرسوم؟" · "شو المستندات؟" · "خدمات شرطة عمان السلطانية"
أوامر: \`/reset\` جلسة جديدة · \`/state\` حالة الجلسة

اسألني بحرية.`;
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

const SYSTEM_V2 = `You are **ساند** ("Saned, the smart assistant") — the AI front-desk for the Saned platform.

## What Saned is (this defines your entire purpose)

Saned (ساند) is a **request preparation and dispatch platform** for Oman government services. It connects two sides:

  Citizen  ⇄  **You (ساند / Saned)**  ⇄  **Sanad office**  ⇄  Government entities

You own the LEFT half. Your single product is a **complete, ready-to-process request file** — service identified, every required document collected — which you then dispatch to a licensed Sanad office. The office reviews the file, sends the citizen a payment link (the fee is the standard pre-set price for the service — same across all offices), the citizen pays, the office processes the transaction with the gov entity, then the office marks it complete and the citizen is notified.

You are NOT a generic search bot. You are NOT the office. You are the **intake + preparation + dispatch** layer. Every reply you write should serve that purpose.

## Channel UX (CRITICAL — saves citizen typing on phone keyboard)

Most citizens are on **WhatsApp**. The webhook layer auto-attaches **quick-reply buttons** to your reply for common decision points — citizens TAP, they don't type. Buttons appear automatically when:

- The reply asks a yes/no question → **✓ نعم / ✕ لا** buttons
- The reply asks about an ambiguous upload → **✓ [slot] / 🔄 خانة أخرى** buttons
- Any collecting/reviewing reply → unified **✅ انتهيت من الرفع / ➕ سأرسل المزيد / ✕ إلغاء الطلب** buttons

**Rules — these instructions look BROKEN to the citizen now that buttons appear:**
- ❌ **NEVER write** "اكتب نعم أو لا" / "اكتب نعم/لا" / "type yes/no" / "reply yes or no"
- ❌ **NEVER write** "اكتب تم" / "اكتب خلصت" / "اكتب 'تم' أو 'خلصت'" / "type 'done' to finish"
- ❌ **NEVER write** "اكتب موافق" / "اكتب رفض" / similar instructions to type a reserved word

**Do this instead:** end the question naturally — *"نتابع؟"*, *"هل تؤكد؟"*, *"نُرسل الملف؟"*, *"هل تبقّى ملف؟"* — and stop. The wrapper handles the buttons.

For free-form answers (describe a file, give a name, paste an OTP code) it IS fine to write "اكتب ..." since no buttons fit those answers.

## Your mission, every turn (in this exact order)

1. **Identify the service** — natural conversation, hybrid search, ONE clarifying question if ambiguous.
2. **Build the request file** — call start_submission, accept the documents in any order, recognise captions when given.
3. **Dispatch to a Sanad office** — call submit_request when the file is complete. The request goes to a Sanad office for review.
4. **Relay** — after dispatch, forward OTPs / payment links / status updates between the office and the citizen.

You don't *do* the transaction. You *build the file* and *dispatch it*. The office does the rest.

## CRITICAL: who actually processes the request

**Sanad offices process every single request. Period.** This is the foundation of the product. You NEVER:
- forward / send / transfer the request to a ministry, the Royal Oman Police (ROP), the Ministry of Health, the municipality, the Civil Status Department, or any government body directly.
- say "I'll send this to ROP / the ministry / the police / the embassy".
- imply the citizen will go to a government counter — they will be served by a **Sanad office**.

What you DO say (adapt the wording, keep the meaning):
- Arabic: "سأُجهّز ملف طلبك وأُرسله إلى مكتب سند للمراجعة. سيتولى المكتب إنجاز المعاملة نيابةً عنك."
- English: "I'll prepare your request file and dispatch it to a Sanad office for review. The office will complete the paperwork on your behalf."

You may *mention* the issuing entity (e.g. "this is a ROP service") for context — that is NOT the same as routing to them. The actual handler is always a Sanad office.

## After dispatch — the simple linear flow

Pricing is **pre-set per service** (same across all offices) — there are no competing offers, no marketplace selection. When submit_request returns ok:

1. The request goes to a Sanad office for review.
2. The office reviews the file → sends the citizen a payment link.
3. Citizen pays.
4. Office processes the transaction with the gov entity.
5. When done, the office marks completed and the citizen is notified.

Frame the post-dispatch waiting period as "your file is with the office for review; you'll receive a payment link shortly" — NEVER mention "offers", "marketplace", "competing", "first offer arrives", or "pick an office".

## Core rules (violating any of these breaks the product)

1. **One language per reply, consistent across the conversation.** Mirror the user's script — Arabic in → Arabic out, English in → English out. Never mix mid-sentence. Once the conversation is established in a language, **stay** in that language for unrelated turns (e.g. an attachment with no caption arriving in an English thread → reply in English, not Arabic).

2. **STRICT GROUNDING — ZERO INVENTION. Read this rule before every reply.**
   - The catalogue is 453 specific services. Many have null/empty fee data. That is FINE — say so. **Never substitute a "common" or "typical" fee from your training data. Never invent age tiers, multi-tier pricing, or processing-time bands that aren't in the tool output.**
   - **Service NAME**: copy verbatim from the tool result's \`name_en\` / \`name_ar\`. Do NOT paraphrase, anglicise, or reword. If the tool returned "Omani Passport Issuance Service", do not write "Renew Omani Passport" — those are different services with different IDs and the second one doesn't exist.
   - **Fees**: quote the tool's \`fee_omr\` (number) or \`fees_text\` (string) exactly. If \`fee_omr\` is null AND \`fees_text\` is empty/null, your reply MUST say "fee not listed in catalogue — the receiving Sanad office will confirm" / "الرسوم غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم". Do NOT write any number.
   - **Duration**: only from \`avg_time_en/ar\` or \`working_time_en/ar\`. Never write "3 working days", "5 days", or any time estimate not in the tool output.
   - **Required documents**: ONLY from \`required_documents_json\`. Use \`label_en\` / \`label_ar\` verbatim. If the list is empty or missing → say "no documents are listed in the catalogue for this service — please check with the office" / "لا توجد مستندات مدرجة — يرجى التأكد من المكتب". NEVER generalise from other services (don't add "recent photo / passport copy / birth certificate" unless THIS row has them).
   - **Entity**: use \`entity_en/ar\` verbatim from the tool result.
   - **Channels**: only from the tool's \`channels\` field.
   - If the user asks a detail you don't have in memory, call \`get_service_details(service_id)\` BEFORE answering. Never guess from training data, ever.

   **Self-check before sending each reply: every number, name, and document I'm about to mention — did a tool return it in this conversation? If not, delete it.**

3. **Use tools for state transitions.** The session state is controlled by tool returns ONLY. Don't write "I've started your application" unless start_submission just succeeded. Don't say "cancelled" unless cancel_request returned ok=true.

4. **Confirm irreversible actions before calling them.** cancel_request, accept_offer, submit_request — ask the user to confirm first in your reply, THEN call the tool on the next turn.

5. **Plain text only — NO markdown in output. THIS IS A HARD RULE.** Your replies render on WhatsApp (which does NOT render markdown) and in a basic web chat. Never emit \`**bold**\`, \`*italic*\`, \`# headers\`, \`|tables|\`, triple-backtick code blocks, or \`---\` horizontal rules — on WhatsApp these display as literal asterisks/pipes/dashes/hashes and ruin every message they appear in. Service names, fees, and emphasis all go in plain text:

   ❌ WRONG (markdown leaks):
   • "I found **Renew Omani Passport** for you"
   • "📝 **Issuance of Omani Card/Renewal**"
   • "**Fee:** 6.000 OMR"
   • "**What happens next:**"

   ✅ CORRECT (plain text):
   • "I found Renew Omani Passport for you"
   • "📝 Issuance of Omani Card/Renewal"
   • "Fee: 6.000 OMR"
   • "What happens next:"

   Use line breaks for structure; emoji are fine and encouraged for emphasis (📝 ✅ 💰 ⬜ 👉 🛂). Fees: "X.XXX OMR" / "X.XXX ريال".

6. **EXTREME BREVITY — citizens are on a phone screen.** Word counts are HARD ceilings:
   - **Single-fact question** (just "how much is X?", "what's the status of Y?", "when does it open?"): ≤ 25 words, ≤ 2 lines, plain prose, NO bullet lists. Answer the one fact + ONE optional next-step prompt. e.g. "Civil ID issuance is 2.000 OMR through a Sanad office. Want to start the request?" / "إصدار البطاقة المدنية 2.000 ريال عُماني عبر مكتب سند. نبدأ؟"
   - **Acknowledgments** (file received, action confirmed, simple "ok"): ≤ 25 words, ≤ 3 lines.
   - **Asking for the next document**: 1 line, e.g. "📎 Next: civil ID photo" / "📎 التالي: صورة البطاقة الشخصية".
   - **Multi-fact answer** (fees + docs + time bundled): ≤ 60 words. Format: 1 line for service+fee, 1 line per doc, 1 line for time. Then ONE follow-up: "Start now? / نبدأ؟". Only use this format when the user asks for ALL the details at once.
   - **Confirmations / disambiguation questions**: ≤ 15 words.
   - **Welcome / first reply**: ≤ 40 words. No essay about the dispatch flow on first contact — explain it ONCE, only when relevant (after submit_request, or when the user asks "where does my request go?").

7. **NEVER do these (they make the bot feel slow/clunky on WhatsApp):**
   - **Don't mention metadata about the user's input** — never say "no caption was provided", "since you didn't add a description", "I notice you sent a file without text", "you didn't tell me what this is". The system handles caption-less uploads silently. Just acknowledge what was saved and move on.
   - **Don't repeat what the user just saw**. If you summarised the service in the previous turn, don't summarise it again.
   - **Don't apologise** for things that aren't errors. No "Sorry, I should have asked first…" preambles.
   - **Don't say "let me…" / "دعني…"**. Just do it. ("✅ Got your civil ID. Submit now?" beats "Let me record your civil ID for you. Once that's done, I'll prepare a summary…")
   - **Don't list ALL the service's documents on every turn**. The user only needs to know what's NEXT.

## Flow rules — make it FEEL smooth, no double-prompts

- Unknown intent → call search_services. Use filters (entity, beneficiary, free, is_launch, max_fee_omr) whenever the user hints at them.
- Search is hybrid (BM25 + semantic embeddings + filters). Trust ONE good search call. Don't re-search unless the user gives new keywords.
- Ambiguous match (≥2 plausible options, similar scores) → list 2–3 numbered choices, ask the user to pick. Confidence high → state the pick + move forward.
- **Strong match + user signals intent to apply** → call start_submission(service_id) **immediately**. In the SAME reply that the tool result lands in, you announce the service AND ask for the FIRST document. **Never** ask "would you like to start?" as a separate turn — the user already told you what they want. start_submission goes straight to COLLECTING; do NOT call confirm_submission.
- **Commitment phrases** that mean "yes, start now" — call start_submission immediately, do NOT ask "Start now?" again:
  EN: "ok", "ok let's do it", "yes", "yep", "go ahead", "let's go", "start", "start now", "begin", "do it"
  AR: "نعم", "نعم تمام", "تمام", "أيوه", "ابدأ", "خلاص", "اوكي", "موافق"
  If the previous turn surfaced a service (its id is in the cached tool output at the top of this prompt), and the current user turn is one of the above, your reply should be the start_submission tool call, then the announcement + first-doc prompt — NOT another "Start now?" question.
- **Info-only questions** (price, time, what-do-I-need) before the user commits → answer concisely AND include the required documents list from \`required_documents_json\` so they can prepare. Don't start_submission yet — wait for them to say "let's do it" / "ابدأ".
- **New request vs. follow-up.** Read the session state injected at the top:
  - status=idle → user is fresh. Search and start as needed.
  - status=collecting/reviewing → there's a DRAFT in flight (no DB request yet). If the user is continuing (sends a doc, asks about the same service, says "yes") — keep going. If the user clearly **changes topic** ("forget that, I want a passport"):
    - **No documents AND no extras collected yet** → call discard_draft FIRST, then start_submission for the new service in the same turn.
    - **At least one required document OR one extra/supplementary file already attached** → DO NOT discard yet. Acknowledge the draft + count of files already on file (required docs and extras both count as user progress), and ask one confirmation: "You have [service] in progress with [N] document(s) saved — cancel that and start [new service]? (yes/no)" Wait for explicit yes before calling discard_draft.
  - status=queued/claimed/in_progress → there's a SUBMITTED request. New unrelated questions = follow-up about that request, OR a brand-new service request.
    - If the user explicitly asks to drop the active one ("forget that", "cancel that", "أُلغِ ذلك", "I want X **instead**") → BEFORE starting anything else, ask ONE confirmation: "Cancel #R-X (Driving Licence) and start a new request for X, or keep both?" Wait for their answer. Then call cancel_request if they confirm cancel, OR start_submission directly if they say "keep both".
    - If the new ask is genuinely unrelated and they didn't say cancel → "Do you want me to keep tracking #R-X, or start something new?"
    - Use cancel_request only after explicit confirmation in this turn or the previous one.
- **Document collection.** When a file/photo arrives, you'll see a system line about the attachment. The caption is what the user typed with the file. Use caption + filename + the "Document slots" list to pick the right doc_code for record_document. Examples:
  - Caption "this is my id" or "هذي بطاقتي" + slot needs civil_id_copy → record_document(doc_code='civil_id_copy', caption='this is my id').
  - Caption "passport" + slot wants passport_copy → match.
  - No caption, but only one slot pending → use that slot.
- **Caption present but doesn't match any pending required slot** → the system will tell you "Attachment uploaded but NOT auto-recorded". Default: drop the file into the next pending slot positionally — the citizen drives the order, never gatekeep. Only ask a clarification when there's a clear semantic mismatch (e.g., caption "passport" but only "civil_id" slot is pending).
- After every record_document, your reply asks "is your file complete?" — never name the next required slot (the citizen sends in any order). When all required docs done, ask the user to confirm before submit_request.
- **Summaries before submission.** List collected docs as ✅ checks. Don't separate "extras" — the citizen sees a single tidy checklist.
- When all required docs recorded the tool transitions to "reviewing" — ask the user to confirm the total (and offer them a chance to add another extra if they want). Call submit_request only after explicit yes.
- After submit_request returns ok, the request is queued for office review. For further mgmt (status, cancel) the user must reference the request_id OR you can use get_my_requests.
- **Mid-flow correction** — when the citizen says "wait, file 2 was actually X" / "no, the third one is the medical form" / "أُلغ الصورة، الملف الثاني كان جواز السفر": you MUST call record_document with the corrected slot, NOT just acknowledge in text. Example flow:
    Previous turn: bot saved file_2 into "photo" slot.
    Citizen: "wait, file 2 was actually my current licence not photo".
    Your action: call record_document(doc_code='current_drivers_licence', caption='reassigned from photo per citizen correction'). The new slot now holds file_2's reference. The "photo" slot is automatically empty again. Reply ≤25 words: "✅ Updated: file 2 is now Current driver's licence. Photo slot is empty — please send a photo."
    Never just say "noted" / "got it" without calling the tool — the state will be wrong on the next turn.

## Cancel semantics

- ready / queued → hard cancel (outcome: hard_cancelled).
- claimed / in_progress → soft cancel (outcome: cancel_requested). Tell the user: "I notified the office — they'll confirm shortly."

## Supported scope

Every service in the catalogue can be submitted (no 5-code allowlist). The is_launch=1 flag just hints at which ones have the slickest flow.

## Catalogue coverage gaps — be honest

The current catalogue (453 services across 7 entities) DOES NOT include:
- **Civil ID renewal** — only first-issuance: "Issuing Civil Status Card Service" (id 140018, ROP).
- **Passport renewal** — only first-issuance: "Omani Passport Issuance Service" (id 140020, ROP).

When a citizen asks for a renewal that isn't in the catalogue, do NOT pretend it exists. Say plainly: "I don't see a [civil ID / passport] renewal service in our catalogue. The closest match is [name] (id [N]) — would you like its details?" / "لا أرى خدمة تجديد [البطاقة الشخصية / جواز السفر] في القائمة الحالية. أقرب خدمة هي [name] — هل تريد تفاصيلها؟". Never invent a "Renew X" service name.

## Continuity

If a previous turn surfaced a specific service (you'll see its id in the cached tool output at the top), **remember it**. When the user replies "yes" / "ok" / "go ahead" / "نعم" / "تمام", act on that service — don't re-search and contradict yourself.

## Small talk

Greetings / thanks / "help" → 1–2 warm sentences, no tool calls, end with "How can I help?" / "كيف أقدر أساعدك؟"`;

// Quick-detect Arabic script in a string (for vision prompt language hint).
function looksArabic(s) {
  return /[؀-ۿ]/.test(String(s || ''));
}

// ─── Multi-file upload buffer ────────────────────────────────────
// When several files arrive in quick succession the old per-file vision +
// ambiguous-question loop produced messy back-to-back acks. The buffer
// keeps recently-arrived files until the citizen names them or the bot
// can confidently auto-classify, then flushes everything in one ack.
//
// state.pending_uploads is an array of { idx, url, name, mime, caption,
// vision_best, vision_summary, vision_confidence, ts }.

const VISION_AUTO_THRESHOLD = 0.85; // single-file fast-path confidence floor
const VISION_BUFFER_TTL_MS  = 5 * 60_000; // auto-flush via vision after 5 min

// Push an attachment onto the pending-uploads buffer. The buffer survives
// across turns via session state — saved by saveSession at the end of every
// runTurn — so multi-message batches accumulate naturally.
function pushPendingUpload(state, attachment, caption, vision) {
  state.pending_uploads = state.pending_uploads || [];
  // Skip duplicates if the same file URL is replayed (defensive).
  if (state.pending_uploads.some(p => p.url === attachment.url)) return;
  // Generate a stable monotonic idx so positional mapping ("first one is X")
  // works even after some items are flushed.
  const nextIdx = (state.pending_uploads.at(-1)?.idx ?? -1) + 1;
  state.pending_uploads.push({
    idx: nextIdx,
    url: attachment.url,
    name: attachment.name || null,
    mime: attachment.mime || null,
    caption: caption || null,
    vision_best: vision?.best?.code || null,
    vision_summary: vision?.summary || null,
    vision_confidence: vision?.best?.confidence ?? null,
    ts: Date.now()
  });
}

function pendingUploadsLines(state) {
  if (!state.pending_uploads?.length) return null;
  const lines = ['## Pending uploads (received but not yet committed to a slot)'];
  state.pending_uploads.forEach((p, i) => {
    const conf = p.vision_confidence != null ? `${(p.vision_confidence * 100).toFixed(0)}%` : '—';
    const guess = p.vision_best
      ? `looks like "${(state.docs?.find(d => d.code === p.vision_best)?.label_en || p.vision_best)}"`
      : (p.vision_summary ? `image: ${p.vision_summary.slice(0, 80)}` : 'unidentified');
    lines.push(`  [${i + 1}] file="${p.name || '?'}" caption="${(p.caption || '').slice(0, 50)}" — vision: ${guess} (${conf})`);
  });
  return lines.join('\n');
}

// Try to parse the user's text as a description of the buffered uploads.
// Returns { ok, mappings: [{idx, doc_code}], confidence: 'high'|'medium'|'low'|'none' }
// Only commits when ALL files can be confidently mapped — otherwise the bot asks.
function parseUploadDescriptions(text, pendingUploads, docs, collected) {
  if (!text || !pendingUploads?.length) return { ok: false, confidence: 'none' };
  const trimmed = text.trim().toLowerCase();
  const slotsLeft = (docs || []).filter(d => !collected[d.code]);

  // "save them" / "do it" / "ok" / "نعم" / "تمام" — accept whatever we have.
  // Two fallbacks for each upload, in order:
  //   1. vision_best (if vision ran and picked a confident slot)
  //   2. positional — next still-empty required slot from slotsLeft
  // The previous logic ONLY tried (1), and if vision_best was missing on
  // ANY file the entire branch failed. The function then fell through to
  // the comma-parse path, which treated "نعم" as an extra-file caption —
  // recording the user's yes-answer as a description. (Trace bug observed
  // in prod: a file uploaded with no caption + a user replying "نعم" got
  // stored as `record_extra_document(caption='نعم')` instead of going into
  // the next pending required slot.)
  // Trigger words: yes / done / save-them. "تم" and "خلصت" are the two
  // most common Arabic ways a citizen says "I'm done uploading" — without
  // them the parser fell to the comma-parse path and recorded the buffered
  // files as EXTRAS with caption "تم". (Trace bug observed 2026-05-06 on
  // +96892888715: 4 files all went to extras instead of slots.)
  // Trailing lookahead `(?=\s|$|[.،:؟?])` substitutes for `\b` which doesn't
  // fire on Arabic chars in JS regex. Works for both scripts.
  if (/^(save|ok|do it|yes|go|done|finish(?:ed)?|that'?s it|نعم|تمام|تم|خلصت|انتهيت|ما عندي(?:\s+(?:شي|أكثر))?|كفاية|اوكي|أكد|احفظ|سجل|كلها|كل[ ]?شيء|اعتمد|approve)(?=\s|$|[.،:؟?])/i.test(trimmed)) {
    const slotsQueue = [...slotsLeft]; // mutable: positional consumption
    const consumed = new Set();
    const mappings = pendingUploads.map(p => {
      if (p.vision_best && !collected[p.vision_best] && !consumed.has(p.vision_best)) {
        consumed.add(p.vision_best);
        return { idx: p.idx, doc_code: p.vision_best };
      }
      // Positional fallback: shift the next still-empty + unconsumed slot.
      while (slotsQueue.length) {
        const next = slotsQueue.shift();
        if (!consumed.has(next.code)) {
          consumed.add(next.code);
          return { idx: p.idx, doc_code: next.code };
        }
      }
      return { idx: p.idx, doc_code: null };
    }).filter(m => m.doc_code);
    if (mappings.length) {
      const allMapped = mappings.length === pendingUploads.length;
      return {
        ok: true,
        mappings,
        confidence: allMapped ? 'high' : 'medium',
        method: 'yes_positional'
      };
    }
  }

  // Comma- / "and"-separated description: "civil id, passport, photo"
  const parts = trimmed.split(/[,،;.]\s*|\s+(?:and|و)\s+|\s*\/\s*/u).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 1) {
    // Pair parts to uploads positionally. Each part is matched to a slot;
    // if the same slot appears multiple times (e.g. "civil id front, civil
    // id back" or "passport, passport, passport, passport, civil id"),
    // the FIRST file for that slot fills the required-doc slot and the
    // REST become extras tagged with the slot label so the dispatched
    // file still includes them. This handles the real "4 photos for
    // passport, 1 for civil ID" case without losing any files.
    const mappings = [];   // → record_document into a required slot
    const extras = [];     // → record_extra_document
    const slotsUsedThisRound = new Set();
    const allSlots = docs || [];
    for (let i = 0; i < pendingUploads.length; i++) {
      const upload = pendingUploads[i];
      const part = parts[i] != null ? parts[i] : null;  // user gave a description for this position?
      if (part) {
        // Slot-search across ALL docs (not just slotsLeft) so a description
        // for an already-filled slot can still classify a duplicate as that
        // slot's extra.
        const slot = matchSlotByText(part, allSlots);
        if (!slot) {
          // User described something we can't match — record as extra.
          extras.push({ idx: upload.idx, caption: part });
          continue;
        }
        // Slot found. Is the slot still empty AND not already claimed
        // by an earlier part this round? → fill it. Else → extra.
        const slotEmpty = !collected[slot.code];
        if (slotEmpty && !slotsUsedThisRound.has(slot.code)) {
          mappings.push({ idx: upload.idx, doc_code: slot.code });
          slotsUsedThisRound.add(slot.code);
        } else {
          extras.push({ idx: upload.idx, caption: `${slot.label_en || slot.code} (additional)` });
        }
      } else if (upload.vision_best && !collected[upload.vision_best] && !slotsUsedThisRound.has(upload.vision_best)) {
        // User ran out of parts — fall back to vision's best guess.
        mappings.push({ idx: upload.idx, doc_code: upload.vision_best });
        slotsUsedThisRound.add(upload.vision_best);
      } else {
        // Surplus file with no description and no vision — record as extra.
        extras.push({ idx: upload.idx, caption: upload.caption || upload.name || 'unlabeled' });
      }
    }
    if (mappings.length || extras.length) {
      return {
        ok: true,
        mappings, extras,
        confidence: mappings.length === pendingUploads.length ? 'high' : 'medium',
        method: extras.length ? 'positional_with_extras' : 'positional'
      };
    }
  }

  return { ok: false, confidence: 'low' };
}

// Match a user-typed phrase to a slot via keyword overlap. Matches against
// BOTH slot.code and slot.label_en/label_ar so synonyms work for slots
// generated from real catalogue rows (where codes look like
// "recent_personal_photograph" rather than "photo").
function matchSlotByText(text, slots) {
  const t = String(text || '').toLowerCase();
  // Synonym groups: any user-side hit on the LHS picks a slot whose
  // code/label/AR-label hits the RHS. Tested in priority order so more
  // specific terms ("driving licence") beat generic ones ("license").
  const SYN = [
    { user: /civil|id|identity|بطاق|هوي|شخص|مدني/i,                     slot: /civil[_\s]?id|identity|البطاق|هوي|مدن/i },
    { user: /passport|جواز|سفر/i,                                        slot: /passport|جواز|سفر/i },
    { user: /(photo|picture|portrait|photograph|image|صور|شخصي)/i,       slot: /(photo|photograph|portrait|picture|صور)/i },
    { user: /medical|fitness|طبي|فحص|صحي/i,                              slot: /(medical|fitness|health|طبي|فحص)/i },
    { user: /driv\w*|licence|license|رخص|سياق|قياد/i,                    slot: /(driv\w*|licen[sc]e|رخص|سياق|قياد)/i },
    { user: /vehicle|mulkiya|car|registration|ملكي|مرك?ب/i,              slot: /(mulkiya|vehicle|registration|ملكي|مرك?ب)/i },
    { user: /commercial|business|cr|سجل|تجاري|شرك/i,                     slot: /(commercial|business|cr|سجل|تجاري|شرك)/i },
    { user: /application|form|استمار|نموذج/i,                            slot: /(application|form|استمار|نموذج)/i },
    { user: /receipt|invoice|payment|إيصال|فاتور|دفع/i,                  slot: /(receipt|invoice|payment|إيصال|فاتور|دفع)/i },
    { user: /address|residence|عنوان|إقام/i,                             slot: /(address|residence|عنوان|إقام)/i },
    { user: /contract|عقد/i,                                             slot: /(contract|عقد)/i },
    { user: /birth|ميلاد/i,                                              slot: /(birth|ميلاد)/i }
  ];
  for (const s of slots || []) {
    const en = (s.label_en || '').toLowerCase();
    const ar = s.label_ar || '';
    const code = (s.code || '').toLowerCase();
    // 1. Exact-token overlap on label_en (longer tokens first → "passport"
    //    in user text matches a "passport copy" slot).
    const tokens = en.split(/\s+/).filter(w => w.length >= 3);
    if (tokens.some(w => t.includes(w))) return s;
    if (ar && t.includes(ar.toLowerCase())) return s;
    // 2. Synonym groups — user's text matches a known concept AND the
    //    slot's code or label name reflects the same concept.
    for (const g of SYN) {
      if (g.user.test(t) && (g.slot.test(code) || g.slot.test(en) || g.slot.test(ar))) return s;
    }
  }
  return null;
}

// ─── Render the citizen's requests as a system-message block ─────
// Injected at every v2 turn so the LLM never has to call get_my_requests
// just to know "this user has a request in progress." Joins by session_id
// AND by citizen_phone so cross-session return visits (especially WhatsApp)
// still surface the citizen's history.
async function renderUserRequestsBlock(session_id, citizen_phone, state) {
  const args = [];
  const wh = [];
  if (session_id) { wh.push(`r.session_id = ?`); args.push(session_id); }
  if (citizen_phone) {
    wh.push(`r.citizen_id IN (SELECT id FROM citizen WHERE phone = ?)`);
    args.push(citizen_phone);
  }
  if (!wh.length) return null;
  let rows = [];
  try {
    const r = await db.execute({
      sql: `SELECT r.id, r.status, r.fee_omr, r.created_at, r.claimed_at,
                   r.completed_at, r.cancel_requested,
                   s.name_en AS service_en, s.name_ar AS service_ar,
                   o.name_en AS office_en, o.name_ar AS office_ar, o.rating
              FROM request r
              LEFT JOIN service_catalog s ON s.id = r.service_id
              LEFT JOIN office o ON o.id = r.office_id
             WHERE ${wh.join(' OR ')}
             ORDER BY r.id DESC LIMIT 8`,
      args
    });
    rows = r.rows;
  } catch { return null; }
  if (!rows.length && !state?.service_id) return null;

  const lines = ['## Citizen request history (auto-injected; you do NOT need to call get_my_requests for this)'];
  // Active DRAFT (no DB request_id yet)
  if (state?.service_id && state?.status && ['confirming', 'collecting', 'reviewing'].includes(state.status)) {
    const docCount = state.docs?.length || 0;
    const collectedCount = Object.keys(state.collected || {}).length;
    lines.push(`Active draft: status=${state.status} · service="${state.service_code || state.service_id}" · ${collectedCount}/${docCount} docs collected${state.extras?.length ? ` · ${state.extras.length} extras` : ''}`);
  }
  const inFlight = rows.filter(r => ['queued', 'claimed', 'in_progress'].includes(r.status));
  const done     = rows.filter(r => r.status === 'completed').slice(0, 3);
  const cancelled = rows.filter(r => /cancel/.test(r.status || '')).slice(0, 2);
  if (inFlight.length) {
    lines.push('In-flight requests:');
    for (const r of inFlight) {
      const office = r.office_en ? ` · with ${r.office_en}${r.rating ? ` (${r.rating}★)` : ''}` : '';
      const cancel = r.cancel_requested ? ' · cancel requested' : '';
      lines.push(`  #R-${r.id} · ${r.service_en || r.service_ar || '?'} · status=${r.status}${office}${cancel}`);
    }
  }
  if (done.length) {
    lines.push('Recently completed:');
    for (const r of done) lines.push(`  #R-${r.id} · ${r.service_en || r.service_ar || '?'} · completed`);
  }
  if (cancelled.length) {
    lines.push('Cancelled:');
    for (const r of cancelled) lines.push(`  #R-${r.id} · ${r.service_en || r.service_ar || '?'} · ${r.status}`);
  }
  if (lines.length === 1) return null; // header only — citizen has no requests
  return lines.join('\n');
}

// Render a compact state summary injected before every LLM turn so the
// model never has to guess which state it's in. Includes the pending doc
// list verbatim — when an attachment arrives without a clear caption, the
// LLM matches against THIS list to pick the right doc_code.
function renderStateContext(state) {
  const bits = [`status=${state.status || 'idle'}`];
  if (state.service_id) bits.push(`service_id=${state.service_id}`);
  if (state.service_code) bits.push(`service="${state.service_code}"`);
  if (state.request_id) bits.push(`request_id=${state.request_id}`);

  let docList = '';
  if (state.docs?.length) {
    const collected = state.collected || {};
    const collectedCount = Object.keys(collected).length;
    bits.push(`docs_collected=${collectedCount}/${state.docs.length}`);
    if (['collecting', 'reviewing'].includes(state.status)) {
      const lines = state.docs.map((d, i) => {
        const have = collected[d.code] ? '✅' : '⬜';
        const isNext = i === (state.pending_doc_index ?? 0) && !collected[d.code];
        return `  ${have} ${d.code} — ${d.label_en || d.code}${d.label_ar ? ' / ' + d.label_ar : ''}${isNext ? '   ← NEXT' : ''}`;
      }).join('\n');
      docList = `\nDocument slots:\n${lines}`;
    }
  }

  // Supplementary / extra files the user attached beyond the required list.
  // Surfaced so the LLM can mention them in summaries and avoid asking the
  // user to re-upload, and so it knows to include them in the dispatched file.
  if (Array.isArray(state.extras) && state.extras.length) {
    bits.push(`extras=${state.extras.length}`);
    if (['collecting', 'reviewing'].includes(state.status)) {
      const lines = state.extras.map((e, i) => {
        const label = e.caption || e.original_name || `extra_${i + 1}`;
        return `  📎 extra_${i + 1} — "${String(label).slice(0, 80)}"`;
      }).join('\n');
      docList += `\nExtra / supplementary files attached (NOT required, will be dispatched alongside the required docs):\n${lines}`;
    }
  }

  // Routing hint — what the LLM should do given this state.
  let routing = '';
  if (state.status === 'idle') {
    routing = 'Routing: fresh — search/answer freely.';
  } else if (state.status === 'confirming' || state.status === 'collecting') {
    routing = 'Routing: a DRAFT is in progress (no DB request yet). If the user is continuing, keep collecting docs. If they clearly switch topics ("forget that, I want X"), call discard_draft then start_submission for the new service.';
  } else if (state.status === 'reviewing') {
    routing = 'Routing: all docs collected. Confirm the summary briefly and call submit_request when the user agrees. Do NOT ask them to upload docs again.';
  } else if (state.status === 'queued') {
    routing = `Routing: request #R-${state.request_id} was just submitted and is now queued for a Sanad office to review. Pricing is pre-set per service — there are NO offers / marketplace selection. The user is DONE with the submission flow. Your job now: (1) on the very next turn after submit_request, congratulate + give the request ID + tell them the office will review and send a payment link shortly; (2) on later turns, answer status / payment / cancel questions. **Never tell the user to "start over" or "re-upload" — the documents are already saved.** If they ask to start a NEW unrelated service, call start_submission for the new one (it'll be a separate request — the queued one is untouched).`;
  } else if (['claimed','in_progress'].includes(state.status)) {
    routing = `Routing: request #R-${state.request_id} is being worked on by a Sanad office. Answer questions about it. Do NOT propose new submissions unless the user explicitly asks. **Never tell them to re-upload — the office has the documents.**`;
  } else if (state.status === 'completed') {
    routing = `Routing: request #R-${state.request_id} is completed. Cheer them, answer follow-ups. New service requests start fresh (call start_submission).`;
  }

  return `\n\n## Current session\n${bits.join(' · ')}${docList}\n${routing}\n`;
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

  // ── GREETING / HELP / THANKS short-circuit (deterministic) ──────
  // Real prod bug from +96892888715 (2026-05-09): "مرحبا" → bot replied
  // "وجدت 3 خدمات تناسبك ..." Why: runAgentV2 went straight to the LLM
  // tool loop, Qwen called search_services("مرحبا") and wrapped the 3
  // top-BM25 hits in a "found 3 services" reply — even though SYSTEM_V2
  // explicitly says "greetings → no tool calls". The system prompt rule
  // alone isn't reliable enough; the heuristic path (runHeuristic) has
  // had a deterministic regex catch for this since day one (line ~1559).
  // Mirror it here so the LLM path behaves the same.
  //
  // ONLY fires when the session is idle — a "hi" mid-flow (e.g. while
  // collecting docs) is treated as the existing v2 logic decides.
  if (raw && typeof raw === 'string' && !attachment && !state.request_id &&
      (state.status === 'idle' || !state.status) &&
      isGreetingOrHelp(raw)) {
    const intent = greetingIntent(raw);
    let reply;
    if (intent === 'thanks') {
      reply = 'العفو 🤍 أي شيء ثاني أقدر أساعدك فيه؟\nYou\'re welcome — anything else?';
    } else if (intent === 'help') {
      reply = helpMessage();
    } else {
      reply = welcomeMessage();
    }
    await storeMessage({
      session_id, request_id: null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_greeting', intent });
    return { reply, state, trace };
  }

  // ── OTP / VERIFICATION-CODE REFUSAL (deterministic) ─────────────
  // Security: never accept or forward verification codes in chat.
  // Real codes belong on the government portal directly. Per
  // gpt-5.2-codex review (iter-4, 2026-05-08): the previous default
  // path let the LLM accept "الرمز: 123456" and reply "تم إرسال الرمز
  // للمكتب" — that's a credential-exfiltration shape we must refuse.
  // Pattern: 4-6 digit run, OR mention of رمز/OTP/verification + a
  // share/forward verb.
  const OTP_DIGITS_RE = /(?:^|[^\d])(\d{4,6})(?:[^\d]|$)/;
  const OTP_KEYWORD_RE = /(?:رمز\s*(?:تحقق|التحقق|التفعيل|دخول)?|OTP|verification\s*code|كود\s*تحقق)/i;
  if (raw && typeof raw === 'string' && !attachment && (
        OTP_DIGITS_RE.test(raw) || OTP_KEYWORD_RE.test(raw)
      )) {
    // codex iter-9: vary the message on a repeat so the citizen knows we
    // SAW their second attempt — same content, different framing. Avoids
    // the "duplicate refusal" hazard codex flagged on bench scenario #9.
    const repeated = state.last_otp_refusal_at && (Date.now() - state.last_otp_refusal_at) < 60_000;
    const reply = repeated
      ? `🔒 لاحظت أنك أرسلت رمزاً مرة أخرى — لا أحتاج هذه الرموز.\n\n` +
        `الرمز خاص بك وحدك؛ أكمل خطوة التحقق على بوابة الخدمة مباشرة.`
      : `🔒 *لا تشاركني رمز التحقق* — الرمز خاص بك وحدك.\n\n` +
        `أكمل خطوة التحقق على بوابة الخدمة الحكومية مباشرة.\n\n` +
        `إن احتجت مساعدة بشيء آخر، أخبرني.`;
    state.last_otp_refusal_at = Date.now();
    await saveSession(session_id, state);
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_otp_refusal', repeated });
    return {
      reply, state, trace,
      _buttons: state.request_id ? [
        button('status:check'),
        button('service:cancel')
      ] : null
    };
  }

  // CX iter-4 (2026-05-08): deterministic ack for the "comments:" feedback
  // prefix the operator uses on the test phone (+96892888715) to send
  // notes that the loop reviewer reads from the trace. Without this,
  // the LLM would fire on every comment and either lecture about being
  // a gov-services bot or hit the credit-error fallback. Both burn
  // tokens / look broken to the operator. This shortcut keeps the
  // chat clean: ack the comment, preserve state, attach state-aware
  // recovery buttons so the operator can keep testing.
  const COMMENTS_RE = /^\s*comments?\s*:/i;
  if (raw && typeof raw === 'string' && COMMENTS_RE.test(raw) && !attachment) {
    const reply = '🛠️ تم استلام تعليقك — شكراً، سيُراجعه فريق التحسين.';
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_comments_ack', preview: raw.slice(0, 80) });
    // State-aware buttons so the operator can resume testing whichever
    // flow they were in. Mirrors the in-flight / collecting matrices.
    const _btns = state.request_id && ['queued','claimed','in_progress','awaiting_payment','needs_more_info','awaiting_reclassify_ack'].includes(state.status)
      ? [
          button('status:check'),
          button('service:cancel')
        ]
      : (['collecting','reviewing'].includes(state.status)
          ? [
              button('review:submit'),
              button('service:switch'),
              button('service:cancel')
            ]
          : [
              // idle / unknown — surface discovery so the operator can
              // keep testing flows without typing.
              button('discover:license'),
              button('discover:title'),
              button('discover:cr')
            ]);
    if (_btns) {
      state.last_offered_buttons = _btns.map(b => b.id);
      await saveSession(session_id, state);
    }
    return { reply, state, trace, _buttons: _btns };
  }

  // CX iter-7: scope guard. Citizens occasionally ask off-topic things
  // (weather, news, jokes, sports, celebrities, etc.). Without a guard
  // these hit the LLM tool loop and either get a long evasive reply or
  // a credit-error fallback. Detect a small out-of-scope keyword set
  // and politely redirect — preserves CX without burning tokens.
  const OUT_OF_SCOPE_RE = /(?:طقس|الطقس|weather|أخبار|الاخبار|news|نكت(?:ة)?|joke|كرة\s*القدم|football|soccer|سعر\s*(?:الذهب|البتكوين|البتكوين|stocks?|usd|eur|دولار|عملة)|stocks?|crypto|bitcoin|ethereum|recipe|وصفة|طبخ|كيف\s*(?:أصلي|أصوم|أحج)|capital\s*of|عاصمة)/i;
  if (raw && typeof raw === 'string' && state.status === 'idle' && !attachment &&
      OUT_OF_SCOPE_RE.test(raw)) {
    const reply =
      `🤖 أنا *ساند* — متخصص في المعاملات الحكومية العُمانية فقط.\n\n` +
      `جرّب سؤالاً عن خدمة (مثل *كم رسوم تجديد رخصة القيادة؟*) أو اختر من الأزرار:`;
    state.last_offered_buttons = ['discover:license', 'discover:title', 'discover:cr'];
    await saveSession(session_id, state);
    await storeMessage({
      session_id, request_id: null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_out_of_scope', preview: raw.slice(0, 60) });
    return {
      reply, state, trace,
      _buttons: [
        button('discover:license'),
        button('discover:title'),
        button('discover:cr')
      ]
    };
  }

  // ── THANKS / GRATITUDE (deterministic) ──────────────────────────
  // Common short citizen turn that doesn't need the LLM. Catches
  // shukran / تشكر / شكراً / thanks / thank you. Brief ack + state-
  // appropriate next-step button.
  const THANKS_RE = /^(?:شكر(?:ا|اً|ك)?|تشكر|مشكور|يعطيك\s*العافية|thanks?|thank\s*you|thx|ty)\s*[!.،]*\s*$/i;
  if (raw && typeof raw === 'string' && THANKS_RE.test(raw.trim()) && !attachment) {
    const reply = state.request_id
      ? '🤍 العفو. سأخبرك فور أي تحديث من المكتب.'
      : '🤍 العفو. أخبرني إن احتجت أي خدمة أخرى.';
    await storeMessage({
      session_id, request_id: state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_thanks' });
    return {
      reply, state, trace,
      _buttons: state.request_id ? [
        button('status:check'),
        button('service:cancel')
      ] : null
    };
  }

  // ── FEE QUERY for current/known service (deterministic) ─────────
  // When citizen asks "كم الرسوم؟" / "what's the fee?" AND we know
  // the service (state.service_id is set), read the fee directly
  // from the catalog and reply without invoking the LLM. Saves a
  // round-trip + token cost on a very common turn.
  const FEE_QUERY_RE = /^(?:كم\s*(?:الرسوم|الرسم|التكلفة|السعر|الرسوم؟)|ايش\s*الرسوم|بكم|how\s*much|what.*(?:fee|cost|price))[?\s.،]*$/i;
  // codex iter-10: a wider regex catches phrasings like "كم رسوم تجديد رخصة القيادة"
  // that bundle the service name + fee question in one turn. When idle,
  // resolve the service from the text and answer the fee question.
  const FEE_QUERY_WITH_SVC_RE = /(?:كم|ايش|بكم|how\s*much).*?(رسوم|رسم|تكلفة|سعر|fee|cost|price)/i;
  if (raw && typeof raw === 'string' && state.status === 'idle' && !attachment &&
      FEE_QUERY_WITH_SVC_RE.test(raw.trim()) && !state.service_id) {
    try {
      const m = await matchService(raw, { trace, useHybrid: false });
      if (m && m.source === 'launch' && m.service?.name_ar) {
        const { rows } = await db.execute({
          sql: `SELECT id, name_ar, name_en, fee_omr FROM service_catalog WHERE name_ar = ? LIMIT 1`,
          args: [m.service.name_ar]
        });
        const svc = rows[0];
        if (svc) {
          const feeLine = svc.fee_omr != null
            ? `${Number(svc.fee_omr).toFixed(0)} ر.ع`
            : 'تختلف حسب نوع الترخيص — سيؤكدها مكتب سند المستلم';
          const name = svc.name_ar || svc.name_en;
          const reply =
            `💰 رسوم *${name}*: ${feeLine}\n\n` +
            `جاهز أبدأ الطلب؟ اكتب "${name}" وسأبدأ معك خطوة بخطوة.`;
          await storeMessage({
            session_id, request_id: null,
            direction: 'out', actor_type: 'bot', body_text: reply
          });
          trace.push({ step: 'deterministic_fee_query_idle', service_id: svc.id });
          state.last_offered_buttons = ['discover:license', 'discover:title', 'discover:cr'];
          await saveSession(session_id, state);
          return {
            reply, state, trace,
            _buttons: [
              button('discover:license'),
              button('discover:title'),
              button('discover:cr')
            ]
          };
        }
      }
    } catch (e) {
      trace.push({ step: 'fee_query_idle_threw', error: e.message });
    }
  }
  if (raw && typeof raw === 'string' && FEE_QUERY_RE.test(raw.trim()) &&
      state.service_id && !attachment) {
    try {
      const svc = await getServiceById(state.service_id);
      if (svc) {
        const feeLine = svc.fee_omr != null
          ? `${Number(svc.fee_omr).toFixed(0)} ر.ع`
          : 'غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم';
        const name = svc.name_ar || svc.name_en;
        const reply = `💰 رسوم *${name}*: ${feeLine}`;
        await storeMessage({
          session_id, request_id: state.request_id || null,
          direction: 'out', actor_type: 'bot', body_text: reply
        });
        trace.push({ step: 'deterministic_fee_query', service_id: state.service_id });
        // codex iter-9: fee reply was buttonless. Offer state-appropriate
        // continuation so the citizen knows what to do next.
        const isCollecting = ['collecting', 'reviewing'].includes(state.status);
        const isInFlight = ['queued', 'claimed', 'in_progress', 'awaiting_payment', 'needs_more_info', 'awaiting_reclassify_ack'].includes(state.status);
        const _buttons = isCollecting
          ? [
              button('review:submit'),
              button('burst:more'),
              button('service:cancel')
            ]
          : isInFlight
            ? [
                button('status:check'),
                button('service:cancel')
              ]
            : null;
        if (_buttons) {
          state.last_offered_buttons = _buttons.map(b => b.id);
          await saveSession(session_id, state);
        }
        return { reply, state, trace, _buttons };
      }
    } catch (e) {
      trace.push({ step: 'fee_query_threw', error: e.message });
    }
  }

  // ── PAYMENT-LINK QUERY (deterministic) ──────────────────────────
  // Real bug from gpt-5.2-codex bench review (2026-05-08, scenario #6):
  // citizen typed "وصلني رابط الدفع؟" while state=awaiting_payment.
  // The LLM mis-interpreted as confirmation-of-receipt and replied
  // "ممتاز! بعد ما تدفع... هل تم الدفع؟" — wrong intent.
  // Fix: when state is in-flight AND the citizen mentions
  // payment/link/دفع, read the request row directly and render a
  // deterministic reply with the actual payment_link (or "not yet").
  const PAYMENT_QUERY_RE = /(رابط\s*الدفع|الدفع|دفع|payment\s*link|payment|link)/i;
  const inFlightStates = new Set(['queued', 'claimed', 'in_progress',
                                  'awaiting_payment', 'needs_more_info',
                                  'awaiting_reclassify_ack']);
  if (raw && typeof raw === 'string' && PAYMENT_QUERY_RE.test(raw) &&
      state.request_id && inFlightStates.has(state.status) && !attachment) {
    try {
      const rs = await db.execute({
        sql: `SELECT payment_link, payment_status, payment_amount_omr, status
                FROM request WHERE id = ?`,
        args: [state.request_id]
      });
      const row = rs.rows[0];
      if (row) {
        let reply;
        if (row.payment_link && row.payment_status !== 'paid') {
          const amt = row.payment_amount_omr != null
            ? `\n💰 الإجمالي: ${Number(row.payment_amount_omr).toFixed(3)} ر.ع`
            : '';
          // codex iter-14: never expose a relative `/api/...` URL to the
          // citizen — they can't open it from WhatsApp. Promote relative
          // payment links to absolute using PUBLIC_BASE_URL (set in prod).
          // Bench scenario #8 plants `/api/payments/_stub/...` which codex
          // rightly flagged as unsafe to render bare.
          const link = String(row.payment_link).startsWith('http')
            ? row.payment_link
            : (process.env.PUBLIC_BASE_URL || 'https://saned.ai').replace(/\/$/, '') + row.payment_link;
          reply = `💳 *رابط الدفع*${amt}\n\n${link}\n\nاضغط الرابط للدفع — سأخبرك فور إتمام المعاملة.`;
        } else if (row.payment_status === 'paid') {
          reply = `✅ تم الدفع بنجاح. مكتب سند يعمل على إنجاز معاملتك الآن.`;
        } else {
          reply = `⏳ لم يصلني رابط الدفع بعد — المكتب يعدّ الطلب.\n\nسأرسله إليك فور جاهزيته.`;
        }
        await storeMessage({
          session_id, request_id: state.request_id,
          direction: 'out', actor_type: 'bot', body_text: reply
        });
        trace.push({ step: 'deterministic_payment_query', has_link: !!row.payment_link, paid: row.payment_status === 'paid' });
        return {
          reply, state, trace,
          _buttons: row.payment_status === 'paid' ? null : [
            button('status:check'),
            button('service:cancel')
          ]
        };
      }
    } catch (e) {
      trace.push({ step: 'payment_query_threw', error: e.message });
      // fall through to LLM
    }
  }

  // ── DETERMINISTIC SERVICE-MATCH SHORTCUT (codex iter-8) ─────────
  // When the citizen clearly names one of the curated launch services
  // ("تجديد رخصة القيادة", "بدل فاقد سند ملكية", "إصدار سجل تجاري", …)
  // AND state is idle (no in-flight request), start the submission
  // deterministically. Avoids two failure modes:
  //   • LLM credit exhaustion → bilingual fallback loop (codex iter-7)
  //   • LLM picking the wrong catalog entry → wrong doc list shown
  // The matchService call itself uses LAUNCH_SERVICES exact-keyword
  // hot path, so this is a pure in-memory check (no DB before lookup).
  if (raw && typeof raw === 'string' && state.status === 'idle' && !attachment) {
    // codex iter-10: don't start a submission when the citizen is asking
    // about fees/cost/duration — they're researching, not committing.
    // Bench scenario #13 ("كم رسوم تجديد رخصة القيادة؟") was incorrectly
    // matching "تجديد رخصة القيادة" → start_submission.
    const FEE_OR_INFO_QUERY_RE = /(كم|بكم|ايش|كيف|متى|مدة|how\s*much|how\s*long|cost|price|fee|when|duration)/i;
    if (FEE_OR_INFO_QUERY_RE.test(raw)) {
      // Skip the deterministic service-match; let the LLM (or fee handler)
      // answer the question without committing the citizen to a flow.
      trace.push({ step: 'deterministic_service_match_skipped', reason: 'fee_or_info_query' });
    } else try {
      const m = await matchService(raw, { trace, useHybrid: false });
      if (m && m.source === 'launch' && m.code && m.service) {
        // Resolve to a concrete service row (start_submission needs id).
        const { rows } = await db.execute({
          sql: `SELECT id FROM service_catalog WHERE name_ar = ? LIMIT 1`,
          args: [m.service.name_ar]
        });
        if (rows[0]?.id) {
          const r = await TOOL_IMPL_V2.start_submission(
            { state, session_id, citizen_phone, trace },
            { service_id: rows[0].id }
          );
          if (r?.ok) {
            await saveSession(session_id, state);
            // renderDocListOrPrompt() handles both cases:
            //   • most/all docs have real Arabic labels → render numbered list
            //   • most resolve to the generic "مستند" fallback → ask one open
            //     question instead of a useless "1) مستند 2) مستند" list.
            // Bug from +96892888715 trace 2026-05-09 (CR Renewal had only
            // generic labels and the bot rendered "1) مستند" — citizen had
            // no idea what to send).
            const svcName = r.name_ar || r.name_en;
            const docs = renderDocListOrPrompt(r.required_documents || [], svcName);
            const docsBlock = docs.kind === 'list'
              ? `الملفات المطلوبة:\n${docs.text}\n\n` +
                `أرسل الملفات بأي ترتيب — سأرتّبها لك.`
              : `${docs.text}`;
            const reply = `✅ بدأت طلب *${svcName}*.\n\n${docsBlock}`;
            await storeMessage({
              session_id, request_id: null,
              direction: 'out', actor_type: 'bot', body_text: reply
            });
            trace.push({ step: 'deterministic_service_match', code: m.code, service_id: rows[0].id });
            state.last_offered_buttons = ['service:switch', 'service:cancel'];
            await saveSession(session_id, state);
            return {
              reply, state, trace,
              _buttons: [
                button('service:switch'),
                button('service:cancel')
              ]
            };
          }
        }
      }
    } catch (e) {
      trace.push({ step: 'deterministic_service_match_threw', error: e.message });
      // fall through to LLM
    }
  }

  // CX iter-6 (citizen #1860 'ايش خدمات وزارة الصحه' + comment 'cant we
  // search or ask questions? this should be supported'): when free-text
  // in idle didn't hit the launch-service shortcut, run the HYBRID
  // SEARCH (FTS5 + Qwen embeddings via lib/hybrid_search.js) — this
  // doesn't need Anthropic credit, so it works even when the chat-LLM
  // is exhausted. Top 3 results come back as a numbered list with
  // pick:1/2/3 buttons cached on state.last_search_results so the
  // pick handler can start_submission deterministically on tap.
  if (raw && typeof raw === 'string' && state.status === 'idle' && !attachment &&
      raw.length >= 4 && !raw.startsWith('__btn__:')) {
    try {
      // CX iter-7: detect question intent from the citizen's text so the
      // search reply ANSWERS the question (per-result fee/duration/docs)
      // instead of just listing names. User feedback: "the agent should
      // be smart to use the tools and data available to answer".
      // Catalog fields available: fee_omr, fees_text, office_fee_omr,
      // avg_time_ar/en, working_time_ar/en, required_documents_json,
      // process_steps_json, num_steps, payment_method, channels,
      // description_ar/en, special_conditions_ar/en, entity_ar/en.
      const Q = {
        fee:      /(?:كم|بكم|ايش|أيش|how\s*much).*?(?:رسوم|رسم|تكلفة|سعر|كلفة|fee|cost|price)|(?:رسوم|تكلفة|سعر|fee|cost|price)\s*(?:كم|how\s*much|\?|؟)?/i,
        time:     /(?:كم|بكم|how\s*long|when|في\s*كم).*?(?:يستغرق|تستغرق|مدة|وقت|يوم|ساعة|duration|takes?|time)|(?:مدة|وقت|kam\s*kam)/i,
        docs:     /(?:ما|ايش|أيش|شو|what(?:\s+are)?).*?(?:مستندات|أوراق|اوراق|متطلبات|وثائق|documents?|docs?|paperwork|requirements?)/i,
        steps:    /(?:كيف|ازاي|طريقة|خطوات|how\s*do|how\s*to|process|steps?)/i,
        hours:    /(?:متى|أوقات|اوقات|الدوام|ساعات|hours?|when\s*open|working\s*time)/i,
        where:    /(?:أين|اين|فين|where|how\s*where).*?(?:دفع|أدفع|ادفع|pay|payment)|طريقة\s*الدفع/i,
        info:     /(?:ما|ايش|أيش|شو|tell\s*me|what(?:'s)?\s*is|describe|info)/i,
      };
      const qType =
        Q.fee.test(raw)   ? 'fee' :
        Q.time.test(raw)  ? 'time' :
        Q.docs.test(raw)  ? 'docs' :
        Q.steps.test(raw) ? 'steps' :
        Q.hours.test(raw) ? 'hours' :
        Q.where.test(raw) ? 'where' :
        Q.info.test(raw)  ? 'info' :
        null;

      const { searchServices } = await import('./hybrid_search.js');
      const { services } = await searchServices(raw, {}, { k: 5, trace });
      const top = (services || []).slice(0, 3);
      if (top.length >= 1) {
        // Render a per-Q-type fragment so each result line answers the
        // citizen's actual question. fragmentFor returns a short suffix
        // like " — 5 ر.ع" or " — 3 أيام" appended to the service name.
        const fragmentFor = (row, type) => {
          if (type === 'fee' || !type) {
            if (row.fee_omr != null) return ` — ${Number(row.fee_omr).toFixed(0)} ر.ع`;
            if (row.fees_text) return ` — ${String(row.fees_text).slice(0, 40)}`;
            return '';
          }
          if (type === 'time')  return row.avg_time_ar ? ` — ⏱️ ${row.avg_time_ar.slice(0, 35)}` : (row.avg_time_en ? ` — ⏱️ ${row.avg_time_en.slice(0, 35)}` : '');
          if (type === 'hours') return row.working_time_ar ? ` — 🕐 ${row.working_time_ar.slice(0, 35)}` : (row.working_time_en ? ` — 🕐 ${row.working_time_en.slice(0, 35)}` : '');
          if (type === 'docs') {
            try {
              const docs = JSON.parse(row.required_documents_json || '[]');
              return docs.length ? ` — 📋 ${docs.length} مستندات` : '';
            } catch { return ''; }
          }
          if (type === 'steps') return row.num_steps ? ` — ${row.num_steps} خطوات` : '';
          if (type === 'where') return row.payment_method ? ` — ${String(row.payment_method).slice(0, 40)}` : '';
          // 'info' falls back to fee summary
          if (row.fee_omr != null) return ` — ${Number(row.fee_omr).toFixed(0)} ر.ع`;
          return '';
        };

        const ids = [];
        const lines = [];
        const fullRows = [];
        for (let i = 0; i < top.length; i++) {
          const row = await getServiceById(top[i].id);
          if (!row) continue;
          ids.push(row.id);
          fullRows.push(row);
          const name = row.name_ar || row.name_en;
          const frag = fragmentFor(row, qType);
          lines.push(`${i + 1}️⃣ ${name}${frag}`);
        }

        // High-confidence single-target answer: when only one result lines up
        // AND the citizen asked a specific Q (fee/time/docs/steps), render a
        // direct answer card rather than a search list. Avoids forcing them
        // to tap a number for an info-only question.
        const singleRow = fullRows.length === 1 ? fullRows[0] : null;
        if (singleRow && qType && qType !== 'info') {
          const name = singleRow.name_ar || singleRow.name_en;
          let body = '';
          if (qType === 'fee') {
            const fee = singleRow.fee_omr != null
              ? `${Number(singleRow.fee_omr).toFixed(0)} ر.ع`
              : (singleRow.fees_text || 'غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم');
            body = `💰 رسوم *${name}*: ${fee}`;
          } else if (qType === 'time') {
            const t = singleRow.avg_time_ar || singleRow.avg_time_en || 'غير محدّدة';
            body = `⏱️ مدة إنجاز *${name}*: ${t}`;
          } else if (qType === 'hours') {
            const t = singleRow.working_time_ar || singleRow.working_time_en || 'غير محدّدة';
            body = `🕐 ساعات الدوام لـ *${name}*: ${t}`;
          } else if (qType === 'docs') {
            try {
              const docs = JSON.parse(singleRow.required_documents_json || '[]');
              const list = docs.map((d, i) => `${i + 1}) ${arabicLabelFor(d) || 'مستند'}`).join('\n');
              body = `📋 المستندات المطلوبة لـ *${name}*:\n${list || 'غير محدّدة'}`;
            } catch { body = `📋 المستندات المطلوبة لـ *${name}*: غير محدّدة`; }
          } else if (qType === 'steps') {
            body = `🔢 عدد الخطوات لـ *${name}*: ${singleRow.num_steps || 'غير محدّد'}`;
          } else if (qType === 'where') {
            body = `💳 طريقة الدفع لـ *${name}*: ${singleRow.payment_method || 'غير محدّدة'}`;
          }
          if (body) {
            const reply = `${body}\n\nهل تريد بدء الطلب الآن؟`;
            state.last_search_results = ids;
            state.last_offered_buttons = ['pick:1', 'service:cancel'];
            await saveSession(session_id, state);
            await storeMessage({
              session_id, request_id: null,
              direction: 'out', actor_type: 'bot', body_text: reply
            });
            trace.push({ step: 'deterministic_qa_single', q: qType, service_id: singleRow.id });
            return {
              reply, state, trace,
              _buttons: [
                // Single-answer Q&A → "yes start" + "not now". The
                // service:cancel context here is "skip starting", not
                // "abort an existing draft" — but the underlying intent
                // (clear the staged candidate) is the same as canonical
                // cancel, so we reuse the id with one canonical title.
                button('pick:1', '✅ ابدأ الطلب'),
                button('service:cancel')
              ]
            };
          }
        }

        if (ids.length) {
          state.last_search_results = ids;
          await saveSession(session_id, state);
          const header = qType
            ? `🔎 ${ids.length} خدمات قد تناسبك:`
            : `🔎 وجدت ${ids.length} خدمات قد تناسبك:`;
          const reply =
            `${header}\n\n${lines.join('\n')}\n\n` +
            `اضغط الرقم للبدء، أو اكتب اسم خدمة آخر.`;
          await storeMessage({
            session_id, request_id: null,
            direction: 'out', actor_type: 'bot', body_text: reply
          });
          // Use pickButtons() which truncates the actual service name into
          // the button label instead of just rendering "1️⃣"/"2️⃣"/"3️⃣".
          // The number-only labels were a research-flagged anti-pattern:
          // they force the citizen to read the body text + scroll back to
          // the keypad to map number → service. The truncated-name labels
          // make each button self-describing. (Infobip + Landbot UX research.)
          const btns = pickButtons(fullRows.slice(0, 3));
          state.last_offered_buttons = btns.map(b => b.id);
          await saveSession(session_id, state);
          trace.push({ step: 'deterministic_search_results', count: ids.length, ids, q: qType });
          return { reply, state, trace, _buttons: btns };
        }
      }
    } catch (e) {
      trace.push({ step: 'deterministic_search_threw', error: e.message });
      // fall through to LLM (or to fallback path if LLM is down)
    }
  }

  // ── BUTTON-INTENT DISPATCH (control-prefixed taps) ─────────────
  // routes/whatsapp.js maps every interactive button reply to
  // `__btn__:<id>` so it never gets confused with typed text.
  // Handle the deterministic ones HERE so the LLM never sees the raw
  // button text (which previously got eaten as captions/descriptions).
  // Real prod bug from trace +96892888715 #1214: tapping "+ سأرسل المزيد"
  // sent text "سأرسل المزيد", which parseUploadDescriptions interpreted
  // as a CAPTION for the still-buffered files and routed them to extras.
  //
  // INJECTION GUARD (gpt-5.2-codex Q1, 2026-05-06): a citizen could TYPE
  // the literal string "__btn__:burst:done" and trigger the deterministic
  // handler. Mitigation: only honor button intents whose id was actually
  // OFFERED in the previous bot turn (cached on state.last_offered_buttons).
  // Even if the malicious typed message bypasses, it can only invoke a
  // button id that was just shown — which is the same as them tapping it.
  if (typeof raw === 'string' && raw.startsWith('__btn__:')) {
    const btnId = raw.slice('__btn__:'.length);
    const offered = Array.isArray(state.last_offered_buttons) ? state.last_offered_buttons : null;
    // codex iter-9: state-appropriate buttons should ALWAYS be honored even
    // if not in last_offered_buttons. Real bug seen in iter-9 bench scenario
    // #7: deterministic-service-match offered service:switch/cancel only,
    // citizen tapped review:submit (a perfectly valid action while
    // collecting), injection guard rejected it → LLM fallback fired.
    // The injection guard exists to stop a malicious citizen from typing
    // "__btn__:review:submit" when status='idle' (no draft to submit).
    // When status MATCHES the button's preconditions, it's safe to allow.
    const ALWAYS_OK_FOR_COLLECTING = new Set(['review:submit', 'burst:more', 'burst:done', 'service:cancel', 'service:switch', 'confirm:yes', 'confirm:no']);
    const ALWAYS_OK_INFLIGHT = new Set(['status:check', 'service:cancel']);
    // CX iter-6: discover:* and pick:N are always-OK from idle/welcome —
    // they're tap-shortcuts for fresh-start, never spoofable to escalate.
    const ALWAYS_OK_IDLE = new Set(['discover:license', 'discover:title', 'discover:cr', 'pick:1', 'pick:2', 'pick:3']);
    const stateAllows = (
      (['collecting', 'reviewing'].includes(state.status) && ALWAYS_OK_FOR_COLLECTING.has(btnId)) ||
      (['queued', 'claimed', 'in_progress', 'awaiting_payment', 'needs_more_info', 'awaiting_reclassify_ack'].includes(state.status) && ALWAYS_OK_INFLIGHT.has(btnId)) ||
      ((state.status === 'idle' || !state.status) && ALWAYS_OK_IDLE.has(btnId))
    );
    if (offered && !offered.includes(btnId) && !stateAllows) {
      trace.push({
        step: 'button_intent_rejected_unoffered',
        btn_id: btnId,
        offered_count: offered.length
      });
      // Treat as plain text input (strip the prefix) so the LLM still
      // gets a chance to respond — no privileged dispatch.
      raw = btnId.replace(/^[a-z]+:/, '');
    } else {
      if (offered && !offered.includes(btnId) && stateAllows) {
        trace.push({ step: 'button_intent_state_allows', btn_id: btnId, status: state.status });
      }
    const btnRes = await handleButtonIntent({
      session_id, state, btn_id: btnId,
      attachment, citizen_phone, trace
    });
    if (btnRes) {
      // Re-stamp the cache from the buttons this handler is OFFERING (the
      // confirm:yes/no for cancel-flow, the doc:list for burst:more, etc.)
      // so the citizen's NEXT tap is validated against the right set.
      const nextBtns = Array.isArray(btnRes._buttons) ? btnRes._buttons : null;
      if (nextBtns && nextBtns.length) {
        btnRes.state.last_offered_buttons = nextBtns.map(b => String(b.id));
      } else {
        delete btnRes.state.last_offered_buttons;
      }
      await saveSession(session_id, btnRes.state);
      return btnRes;
    }
    // Fall through — map button id to a canonical Arabic intent that the
    // LLM understands without ambiguity. Critically, these tokens are
    // CHOSEN to never collide with caption parsing patterns
    // (parseUploadDescriptions's yes-fallback / comma-parse).
    const FALLTHROUGH_MAP = {
      'doc:yes':         'نعم',
      'doc:wrong':       'لا — هذا الملف لخانة أخرى',
      'doc:extra':       'احفظ هذا الملف كملف إضافي',
      'review:submit':   'أؤكد إرسال الطلب للمراجعة',
      'review:pause':    'أوقف الآن',
      'service:show':    'اعرض تفاصيل الخدمة الحالية',
      'service:switch':  'أريد خدمة أخرى',
      'next:doc':        'تابع للمستند التالي',
      'status:check':    'ما حالة طلبي؟',
      'pick:1':          '1',
      'pick:2':          '2',
      'pick:3':          '3',
      'confirm:yes':     'نعم',
      'confirm:no':      'لا',
      'reclassify:accept': 'موافق',
      'reclassify:reject': 'رفض'
    };
    raw = FALLTHROUGH_MAP[btnId] || btnId.replace(/^[a-z]+:/, '');
    trace.push({ step: 'button_intent_fallthrough', btn_id: btnId, mapped_to: raw.slice(0, 40) });
    } // close offered-validated branch
  }

  // ── Deterministic greeting on idle ─────────────────────────────
  // Bare hello / السلام عليكم / hi / مرحبا on a fresh session: skip the LLM
  // and reply with a concrete intro that names Saned, says what it does, and
  // shows three clickable example services. The LLM previously produced a
  // generic "كيف أقدر أساعدك" that didn't introduce the platform — citizens
  // had no idea what to ask for. This is faster (no LLM round-trip) and
  // gives a clear next step.
  const isGreeting =
    !attachment && raw && raw.length <= 25 &&
    /^(?:هلا|هلاو|هلو|مرحبا(?:ً)?|مرحب|اهلا|أهلا|أهلاً|السلام عليكم|سلام|hi|hello|hey|hola|salam|good (?:morning|evening|afternoon))[\s!.?؟،؛,]*$/i.test(raw.trim());
  const isFreshSession = (!state.status || state.status === 'idle')
    && !state.service_id
    && !state.request_id
    && !(state.docs?.length);
  if (isGreeting && isFreshSession) {
    // CX iter-2 (2026-05-08): attach 3 discover buttons so the citizen can
    // tap straight into a flow without typing — saves a round-trip and a
    // typo-correction cycle. Pairs with the upgraded discover:* handlers
    // below that deterministically start the submission on tap.
    const reply =
      'أهلاً 👋 أنا *ساند*. اختر خدمة من الأزرار أو اكتب اسم الخدمة (مثل *تجديد رخصة القيادة*).';
    state.last_offered_buttons = ['discover:license', 'discover:title', 'discover:cr'];
    await saveSession(session_id, state);
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'deterministic_welcome', greeting: raw.trim().slice(0, 30) });
    return {
      reply, state, trace,
      _buttons: [
        button('discover:license'),
        button('discover:title'),
        button('discover:cr')
      ]
    };
  }

  // CX iter-3 (2026-05-08): citizen greets while still parked in a
  // collecting/reviewing draft from a previous session. Real bug from
  // trace +96892888715 #1797: citizen typed "مرحبا" with state=collecting,
  // service_id=150036, 4 docs already saved → fell through to LLM tool
  // loop → "تعذّر الاتصال" fallback. They were ONE TAP from submitting.
  // Deterministic recap: tell them what's pending + offer submit / switch /
  // cancel — zero LLM tokens, one round-trip to clarity.
  if (isGreeting &&
      ['collecting', 'reviewing'].includes(state.status) &&
      !state.request_id) {
    const checklist = renderChecklist(state);
    const filesIn = Object.keys(state.collected || {}).length;
    const totalReq = (state.docs || []).filter(d => !isPlaceholderDoc(d)).length;
    const hasCheck = !!checklist;
    let svcName = null;
    if (state.service_id) {
      try {
        const svc = await getServiceById(state.service_id);
        svcName = svc?.name_ar || svc?.name_en || null;
      } catch {}
    }
    const header = svcName
      ? `أهلاً 👋 لديك طلب جارٍ: *${svcName}*.`
      : 'أهلاً 👋 لديك طلب قيد التحضير.';
    const progress = totalReq > 0 ? `\n\nالتقدّم: ${filesIn}/${totalReq} مستندات.` : '';
    const checklistBlock = hasCheck ? `\n\n${checklist}` : '';
    const cta = filesIn === 0
      ? '\n\nأرسل المستندات الآن، أو ابدأ من جديد بخدمة أخرى.'
      : (filesIn >= totalReq
          ? '\n\nاكتمل الملف — اضغط *✅ انتهيت من الرفع* لإرسال الطلب.'
          : '\n\nأكمل إرسال المتبقي أو اضغط *✅ انتهيت من الرفع* لإرسال ما لديك.');
    const reply = header + progress + checklistBlock + cta;
    const buttons = [
      button('review:submit'),
      button('service:switch'),
      button('service:cancel')
    ];
    state.last_offered_buttons = buttons.map(b => b.id);
    await saveSession(session_id, state);
    await storeMessage({ session_id, direction: 'out', actor_type: 'bot', body_text: reply });
    trace.push({ step: 'deterministic_greet_in_draft', files_in: filesIn, total_req: totalReq });
    return { reply, state, trace, _buttons: buttons };
  }

  // CX iter-3: greeting while in-flight (queued/claimed/in_progress/etc.)
  // — show status + actions instead of falling through to the LLM.
  const _inflight = ['queued', 'claimed', 'in_progress', 'needs_more_info',
                      'awaiting_payment', 'awaiting_reclassify_ack'];
  if (isGreeting && _inflight.includes(state.status) && state.request_id) {
    // CX iter-6 (citizen comment #1870): unified "قيد المراجعة" for both
    // queued/claimed — see note in the other STATUS_LABELS map above.
    const STATUS_LABEL = {
      queued: '⏳ قيد المراجعة',
      claimed: '⏳ قيد المراجعة',
      in_progress: '⚙️ جارٍ تنفيذ المعاملة',
      needs_more_info: '📋 المكتب يحتاج معلومة إضافية',
      awaiting_payment: '💳 بانتظار الدفع',
      awaiting_reclassify_ack: '🔄 بانتظار تأكيدك على إعادة التصنيف'
    };
    const label = STATUS_LABEL[state.status] || state.status;
    const reply = `أهلاً 👋 طلبك *#R-${state.request_id}*: ${label}.\n\nاضغط *📊 حالة الطلب* لمزيد من التفاصيل.`;
    const buttons = [
      button('status:check'),
      button('service:cancel')
    ];
    state.last_offered_buttons = buttons.map(b => b.id);
    await saveSession(session_id, state);
    await storeMessage({
      session_id, request_id: state.request_id,
      direction: 'out', actor_type: 'bot', body_text: reply
    });
    trace.push({ step: 'deterministic_greet_in_flight', request_id: state.request_id, status: state.status });
    return { reply, state, trace, _buttons: buttons };
  }

  // ctx.attachment lets record_document pull the real storage_url / mime / size
  // so the officer dashboard can preview + download the file. Cleared inside
  // the tool after it's consumed — prevents double-recording on loop retries.
  const ctx = { session_id, state, trace, citizen_phone, attachment: attachment || null };

  // ── Auto-record attachments BEFORE the LLM is consulted.
  //
  // Why: the LLM is supposed to call record_document when a file arrives,
  // but it sometimes acknowledges the upload in plain text without calling
  // the tool. The file then never lands in state.collected → next turn the
  // slots show ⬜ → Saned asks for the doc again. Doing it deterministically
  // here guarantees the file is always saved; the LLM's job becomes the
  // (much easier) "acknowledge + ask for next doc" step.
  //
  // Doc-code picking — only auto-record when we're confident:
  //   1. Caption keyword match → safe, record into the matched slot.
  //   2. No caption → safe, record into the next pending slot (the user
  //      just dropped a file at the right step).
  //   3. Caption present but no slot matched → DO NOT auto-record. The
  //      caption signals user intent (e.g. "civil id" during a passport
  //      flow → wrong doc, or "extra proof" → supplementary file). Surface
  //      to the LLM with a hint so it asks the user to clarify.
  let autoRecorded = null;
  let ambiguousAttachment = null;
  let autoExtra = null;
  // Track buffer size BEFORE this turn's attachment is pushed — used to
  // detect "burst-continuation" files (file 2+ in a rapid multi-upload
  // batch) so we can stay silent for them and avoid spamming the citizen
  // with one ack per file.
  const bufferSizeBefore = state.pending_uploads?.length || 0;

  // Service has 0 real required docs (catalogue may insert a placeholder
  // like {code:'nothing'} for services that need none) — but the citizen
  // is uploading something anyway. Don't ask "is this for the required
  // doc?" — there is no required doc. Auto-attach as extra so it rides
  // along with the dispatched file.
  if (attachment && ['collecting', 'reviewing'].includes(state.status)
      && !hasRealRequiredDocs(state)) {
    const cap = (attachment.caption || raw || '').toString().trim();
    const result = await TOOL_IMPL_V2.record_extra_document(ctx, {
      caption: cap || attachment.name || 'attached file',
      original_name: attachment.name || null
    });
    trace.push({
      step: 'auto_record_extra',
      reason: 'no_real_required_docs',
      ok: !!result?.ok,
      extra_index: result?.extra_index || null
    });
    if (result?.ok) autoExtra = result;
  } else if (attachment && ['collecting', 'reviewing'].includes(state.status)
      && hasRealRequiredDocs(state)) {
    const collected = state.collected || {};
    const cap = (attachment.caption || raw || '').toString().trim();
    // Burst detection: if the previous upload was within the last 6 seconds,
    // route THIS file to the buffer too — even if there's no caption and the
    // positional fast-path would otherwise record it. WhatsApp users dropping
    // 5 photos in a row tap "send" rapidly; without timing detection the
    // first file fast-paths before the buffer can engage. Updating
    // last_upload_at on every upload makes the burst window self-extending.
    // 8s, raised from 6s on 2026-05-07 so this window aligns with
    // BURST_COOLDOWN_MS (also 8s). Without alignment, files arriving 7s
    // apart wouldn't be tagged as same-burst by inBurstWindow but the
    // drain cooldown would still defer them — confusing trace patterns.
    const BURST_WINDOW_MS = 8_000;
    const lastUploadAt = state.last_upload_at || 0;
    const inBurstWindow = Date.now() - lastUploadAt < BURST_WINDOW_MS;
    state.last_upload_at = Date.now();
    // GREEDY POSITIONAL AUTO-RECORD (Khidmat spec applied 2026-05-06,
    // commit #17). The OLD behaviour buffered any uncaptioned file
    // when ≥2 slots were open — meaning a 6-file drop with no captions
    // would silently buffer all 6. The LLM then hallucinated "saved
    // Civil ID" without calling record_document because it saw a
    // pending upload. Trace proof: +96892888715 #1280/#1288 — bot said
    // "حفظت البطاقة المدنية" while state.collected stayed {} (empty).
    //
    // NEW behaviour, per spec principle "Greedy collection, lazy
    // clarification": ALWAYS slot positionally to the next pending
    // required slot. Vision is used as an OVERRIDE (≥0.8 confidence)
    // when it disagrees with positional. Buffer ONLY when an actual
    // burst is in progress (so drainBurst can render one summary)
    // OR within the rolling burst window of a sibling file. The
    // captionless-and-multi-slot case no longer triggers a buffer.
    if (state.pending_uploads?.length || inBurstWindow) {
      let v = null;
      if (VISION_ENABLED && attachment.url && /^image\//.test(attachment.mime || '')) {
        const slotsLeft = state.docs.filter(d => !collected[d.code]);
        if (slotsLeft.length) {
          const lang = looksArabic(cap) ? 'ar' : 'en';
          v = await classifyDocImage({ attachment, candidate_slots: slotsLeft, language: lang });
          trace.push({ step: 'vision_classify', provider: VISION_PROVIDER, ok: !!v?.ok,
            best: v?.best?.code || null, conf: v?.best?.confidence || 0, ms: v?.ms });
        }
      }
      pushPendingUpload(state, attachment, cap, v);
      trace.push({ step: 'pending_upload_buffered', reason: 'burst_continuation',
        buffer_size: state.pending_uploads.length });
    } else {
    const matched = matchDocByCaption(cap, state.docs, collected);
    if (matched && !collected[matched.code]) {
      const result = await TOOL_IMPL_V2.record_document(ctx, {
        doc_code: matched.code,
        filename: attachment.name || null,
        caption: cap || null
      });
      trace.push({
        step: 'auto_record_document',
        doc_code: matched.code,
        matched_via: 'caption',
        ok: !!result?.ok,
        next: result?.next_doc?.code || null,
        transition: result?.transition || null
      });
      if (result?.ok) autoRecorded = result;
    } else if (!cap) {
      // No caption and no match — drop into the next pending slot only when
      // there's exactly one obvious choice (the next pending). This is the
      // "user typed nothing, just sent the file" path.
      const target = state.docs[state.pending_doc_index ?? 0]
        || state.docs.find(d => !collected[d.code]);
      if (target && !collected[target.code]) {
        const result = await TOOL_IMPL_V2.record_document(ctx, {
          doc_code: target.code,
          filename: attachment.name || null,
          caption: null
        });
        trace.push({
          step: 'auto_record_document',
          doc_code: target.code,
          matched_via: 'order',
          ok: !!result?.ok,
          next: result?.next_doc?.code || null,
          transition: result?.transition || null
        });
        if (result?.ok) autoRecorded = result;
      }
    } else {
      // Caption present but no slot matched. BEFORE bailing to "ask the
      // user", try vision: look at the image content itself and decide.
      // The "caption keyword mismatch but image is obviously a civil ID"
      // case is the single most common upload-flow failure — vision fixes
      // it without bothering the citizen.
      let visionPicked = null;
      if (VISION_ENABLED && attachment.url && /^image\//.test(attachment.mime || '')) {
        const slotsLeft = state.docs.filter(d => !collected[d.code]);
        if (slotsLeft.length) {
          const lang = looksArabic(cap) ? 'ar' : 'en';
          const v = await classifyDocImage({
            attachment, candidate_slots: slotsLeft, language: lang
          });
          trace.push({ step: 'vision_classify', provider: VISION_PROVIDER, ok: !!v?.ok,
            best: v?.best?.code || null, conf: v?.best?.confidence || 0,
            is_extra: v?.is_extra, ms: v?.ms, error: v?.error });
          if (v?.ok && v.best && v.best.confidence >= 0.65) {
            const result = await TOOL_IMPL_V2.record_document(ctx, {
              doc_code: v.best.code,
              filename: attachment.name || null,
              caption: cap || null
            });
            if (result?.ok) {
              autoRecorded = result;
              visionPicked = { code: v.best.code, confidence: v.best.confidence, summary: v.summary };
              trace.push({ step: 'auto_record_document', doc_code: v.best.code,
                matched_via: 'vision', ok: true, conf: v.best.confidence,
                next: result?.next_doc?.code || null, transition: result?.transition || null });
            }
          } else if (v?.ok && v.is_extra && (v.best?.confidence ?? 0) < 0.4) {
            // Vision says "this is a relevant supporting doc, not one of
            // the required slots" — record as extra silently.
            const result = await TOOL_IMPL_V2.record_extra_document(ctx, {
              caption: cap || v.summary || attachment.name || 'attached file',
              original_name: attachment.name || null
            });
            if (result?.ok) {
              autoExtra = result;
              trace.push({ step: 'auto_record_extra', reason: 'vision_extra',
                summary: v.summary?.slice(0, 80) });
            }
          } else if (v?.ok) {
            // Low-confidence guess → buffer instead of asking. The bot will
            // either auto-flush on the user's next text message (if they
            // describe the files) or ask once for the whole batch.
            pushPendingUpload(state, attachment, cap, v);
            trace.push({ step: 'pending_upload_buffered', reason: 'vision_low_conf',
              vision_best: v.best?.code, vision_conf: v.best?.confidence,
              buffer_size: state.pending_uploads.length });
          }
        }
      }
      if (!autoRecorded && !autoExtra && !ambiguousAttachment && !state.pending_uploads?.find(p => p.url === attachment.url)) {
        // Vision unavailable / failed / no slots — push to buffer so the
        // bot can ask once for the whole batch instead of per-file.
        pushPendingUpload(state, attachment, cap, null);
        trace.push({ step: 'pending_upload_buffered', reason: 'no_vision_signal',
          buffer_size: state.pending_uploads.length });
      }
    }
    } // close burst-continuation else
  }

  // ── Try to flush pending uploads using the user's text ──────────
  // If the citizen sent text describing the buffered files, this records
  // each file into the right slot in one go (and any duplicates / unmatched
  // items as extras) and clears the buffer.
  let bufferFlushed = null;
  if (state.pending_uploads?.length && raw && raw.trim()) {
    const collected = state.collected || {};
    const desc = parseUploadDescriptions(raw, state.pending_uploads, state.docs, collected);
    if (desc.ok && desc.confidence !== 'low') {
      const recorded = [];   // [{ doc_code, name }]
      const extrasNoted = []; // [{ caption, name }]
      // Phase 1: required-slot mappings
      for (const m of (desc.mappings || [])) {
        const item = state.pending_uploads.find(p => p.idx === m.idx);
        if (!item) continue;
        const result = await TOOL_IMPL_V2.record_document(
          { ...ctx, attachment: { url: item.url, name: item.name, mime: item.mime, size: 0 } },
          { doc_code: m.doc_code, filename: item.name, caption: item.caption || null }
        );
        if (result?.ok) recorded.push({ doc_code: m.doc_code, name: item.name });
      }
      // Phase 2: extras (unmatched parts + duplicates of an already-mapped slot)
      for (const e of (desc.extras || [])) {
        const item = state.pending_uploads.find(p => p.idx === e.idx);
        if (!item) continue;
        const result = await TOOL_IMPL_V2.record_extra_document(
          { ...ctx, attachment: { url: item.url, name: item.name, mime: item.mime, size: 0 } },
          { caption: e.caption || item.caption || item.name || 'attached file', original_name: item.name }
        );
        if (result?.ok) extrasNoted.push({ caption: e.caption, name: item.name });
      }
      bufferFlushed = { recorded, extras: extrasNoted, method: desc.method };
      // Drop everything we just processed from the buffer
      const consumedIdxs = new Set([
        ...(desc.mappings || []).map(m => m.idx),
        ...(desc.extras || []).map(e => e.idx)
      ]);
      state.pending_uploads = state.pending_uploads.filter(p => !consumedIdxs.has(p.idx));
      trace.push({ step: 'pending_uploads_flushed', via: desc.method, recorded: recorded.length, extras: extrasNoted.length });
    }
  }

  // ── Silent burst-continuation short-circuit ──────────────────
  // If this turn just pushed an attachment to the buffer AND the buffer
  // already had items before this turn AND we didn't auto-record / flush,
  // this is file 2+ in a rapid multi-upload batch. Skip the LLM entirely
  // and return an empty reply — the WhatsApp send layer drops empty
  // bodies, so the citizen sees no message. The bot will speak when:
  //   • the FIRST file of the next batch arrives (buffer was 0 → 1)
  //   • the citizen sends text (flush attempt or describe-prompt)
  //   • a file completes a slot via vision auto-record (existing fast path)
  const isBurstContinuation =
    attachment &&
    bufferSizeBefore >= 1 &&
    state.pending_uploads?.length > bufferSizeBefore &&
    !autoRecorded &&
    !autoExtra &&
    !bufferFlushed;
  if (isBurstContinuation) {
    trace.push({
      step: 'burst_silent',
      buffer_size_before: bufferSizeBefore,
      buffer_size_now: state.pending_uploads.length
    });
    await saveSession(session_id, state);
    // Don't emit a bot message at all (storeMessage is skipped). The
    // citizen sees nothing for files 2..N of the burst; the buffer keeps
    // growing in state.
    return { reply: '', state, trace };
  }

  // DETERMINISTIC BUFFERED-FILE SHORT-CIRCUIT (user spec, 2026-05-06).
  // Trace +96892888715 #1345 showed the LLM producing "📥 استلمت ملف
  // إضافي" with no buttons — using the إضافي word the user explicitly
  // told us to remove. Skip the LLM for first-buffered-file turns and
  // emit the same standard reply (received + checklist + "هل اكتمل؟"
  // + unified 3-button set). The buffer will be auto-flushed
  // positionally when drainBurst fires (or on the next text turn).
  const justBufferedNow = !!(
    attachment &&
    state.pending_uploads?.some(p => p.url === attachment.url) &&
    !autoRecorded && !autoExtra && !bufferFlushed
  );
  if (justBufferedNow && ['collecting', 'reviewing'].includes(state.status)) {
    const checklist = renderChecklist(state);
    const reply = checklist
      ? `📥 استلمت الملف.\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
      : '📥 استلمت الملف. هل اكتمل ملفك؟';
    state.last_offered_buttons = ['review:submit', 'burst:more', 'service:cancel'];
    await saveSession(session_id, state);
    // No storeMessage here — runTurn will armBurst this reply and
    // drainBurst stores it centrally (one bubble per burst).
    trace.push({ step: 'deterministic_buffered_reply', buffer_size: state.pending_uploads.length });
    return {
      reply, state, trace,
      request_id: state.request_id || null,
      _buttons: [
        button('review:submit'),
        button('burst:more'),
        button('service:cancel')
      ]
    };
  }

  // Build the message stack.
  //
  // History window: 20 turns (down from 40). Renders state context already
  // captures the docs + status delta and renderUserRequestsBlock captures
  // cross-session context, so the extra 20 turns of raw history were dead
  // weight (~3 KB/round of unhittable cache prefix). Snappier turns.
  // Both DB reads are independent — fire in parallel to save ~50 ms.
  const [history, requestsBlock] = await Promise.all([
    recentMessages(session_id, 20),
    renderUserRequestsBlock(session_id, citizen_phone, state)
  ]);
  // Pending-uploads block: surface the buffer so the LLM sees what files
  // are awaiting description. When the citizen describes them on the next
  // turn, parseUploadDescriptions auto-flushes — the LLM only needs to
  // emit the consolidated ack.
  const pendingBlock = pendingUploadsLines(state);
  const messages = [
    { role: 'system', content: SYSTEM_V2 + renderStateContext(state) },
    ...(requestsBlock ? [{ role: 'system', content: requestsBlock }] : []),
    ...(pendingBlock ? [{ role: 'system', content: pendingBlock }] : []),
    ...history.map(m => ({
      role: m.actor_type === 'citizen' ? 'user' : m.actor_type === 'bot' ? 'assistant' : 'system',
      content: m.body_text || ''
    }))
  ];

  // If we just flushed the buffer, build a structured reply that:
  //   1. Groups SAVED files by slot with counts so multi-per-slot cases
  //      ("4 for passport, 1 for civil ID") are visible.
  //   2. Lists EXTRAS (described items that didn't match a required slot,
  //      or duplicates routed to extras).
  //   3. Shows what's STILL MISSING from the required-doc list.
  //   4. Ends with ONE next-step prompt — submit if complete, ask for the
  //      next missing doc if not.
  if (bufferFlushed && (bufferFlushed.recorded?.length || bufferFlushed.extras?.length)) {
    // Group saved files by slot label, count duplicates that became extras
    // for the same slot so the user sees "Passport: 1 + 3 extras".
    const bySlot = new Map();
    for (const r of (bufferFlushed.recorded || [])) {
      const slot = (state.docs || []).find(d => d.code === r.doc_code);
      const label = slot?.label_en || slot?.label_ar || r.doc_code;
      const labelAr = slot?.label_ar || '';
      if (!bySlot.has(r.doc_code)) bySlot.set(r.doc_code, { label, labelAr, n: 0, extras: 0 });
      bySlot.get(r.doc_code).n++;
    }
    // Count "X (additional)" extras → bucket them under the original slot if labels match
    for (const e of (bufferFlushed.extras || [])) {
      const cap = (e.caption || '').toLowerCase();
      let attached = false;
      for (const [code, info] of bySlot) {
        if (cap.includes((info.label || '').toLowerCase()) || cap.includes((info.labelAr || '').toLowerCase())) {
          info.extras++;
          attached = true;
          break;
        }
      }
      if (!attached) {
        // Not tied to a saved slot — surface as a standalone extra.
        if (!bySlot.has('__unmatched__')) bySlot.set('__unmatched__', { label: 'extras', n: 0, extras: 0, items: [] });
        bySlot.get('__unmatched__').items = bySlot.get('__unmatched__').items || [];
        bySlot.get('__unmatched__').items.push(e.caption);
      }
    }
    const savedSummary = [...bySlot.entries()]
      .filter(([code]) => code !== '__unmatched__')
      .map(([_code, info]) =>
        info.extras > 0
          ? `${info.label}: ${info.n} + ${info.extras} extra${info.extras > 1 ? 's' : ''}`
          : `${info.label}${info.n > 1 ? ` × ${info.n}` : ''}`
      ).join(', ');
    const unmatchedList = bySlot.get('__unmatched__')?.items?.slice(0, 5) || [];
    const remaining = (state.docs || []).filter(d => !state.collected?.[d.code]);
    const stillBuffered = state.pending_uploads?.length || 0;
    const remainingLabels = remaining.map(d => d.label_en || d.code).slice(0, 4).join(', ');
    messages.push({
      role: 'system',
      content:
        `[Buffer flushed via ${bufferFlushed.method}.\n` +
        `  Saved by slot: ${savedSummary || '(none)'}\n` +
        `  Unmatched extras: ${unmatchedList.length ? unmatchedList.join(', ') : 'none'}\n` +
        `  Required slots remaining: ${remaining.length}/${state.docs?.length || 0}${remaining.length ? ` (still need: ${remainingLabels})` : ''}\n` +
        `  Files still in buffer: ${stillBuffered}]\n\n` +
        `Reply rules (HARD CEILINGS):\n` +
        `  • ≤ 50 words total, ≤ 4 lines, plain text, no markdown.\n` +
        `  • Line 1 — ✅ + summary BY SLOT WITH COUNTS so multi-per-slot is visible. e.g. "✅ Saved: Civil ID, Passport × 4, Personal photo." / "✅ حفظت: البطاقة المدنية، جواز السفر × 4، صورة شخصية."\n` +
        (unmatchedList.length
          ? `  • Line 2 — note the supporting files. e.g. "📎 Plus: ${unmatchedList.slice(0, 2).join(', ')}." / "📎 وملفات مُرفقة: …"\n`
          : '') +
        (remaining.length
          ? `  • Final line — ask "is your file complete?". DO NOT name a "next" doc. e.g. "Is your file complete?" / "هل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد."\n`
          : `  • Final line — confirm complete + submit prompt. e.g. "All required docs saved. Submit your file?" / "اكتمل الملف. نُرسله الآن؟"\n`) +
        `  • DO NOT ask "is this correct?" — the per-slot summary IS the confirmation. The citizen can correct individual mappings on the next turn (e.g. "wait, file 3 was actually X" → you call record_document on the new slot).\n` +
        `  • DO NOT call any tool now. All records were already saved.`
    });
  }
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
    const cap = (attachment.caption || '').toString().trim();
    if (autoRecorded) {
      // File already saved. Tell the LLM as terse system metadata so the
      // reply is short and never leaks technical details about the upload.
      const next = autoRecorded.next_doc;
      const docMeta = (state.docs || []).find(d => d.code === autoRecorded.recorded);
      const docName = docMeta?.label_en || autoRecorded.recorded;
      const docNameAr = docMeta?.label_ar || '';
      const docNameDual = docNameAr ? `${docName} / ${docNameAr}` : docName;
      // Track whether this upload completed a multi-file burst. If yes,
      // the all-done reply should LIST every collected doc by name (the
      // "we got 5 files: X, Y, Z, ..." pattern from the user's spec) so
      // the citizen sees the full inventory of what's about to be dispatched.
      const allDoneList = !next
        ? (state.docs || [])
            .filter(d => (state.collected || {})[d.code])
            .map(d => `${d.label_en || d.code}${d.label_ar ? ' / ' + d.label_ar : ''}`)
            .join(', ')
        : null;
      const nextLine = next
        ? `next: ${next.code} — ${next.label_en || ''}${next.label_ar ? ' / ' + next.label_ar : ''}`
        : `ALL ${autoRecorded.total_docs} required docs collected — state="reviewing" — collected list: ${allDoneList}`;
      messages.push({
        role: 'system',
        content:
          `[File auto-saved silently — slot="${autoRecorded.recorded}" (${docNameDual}) — ${autoRecorded.collected_count}/${autoRecorded.total_docs} done — ${nextLine}]\n\n` +
          `Reply rules (HARD CEILINGS — do not exceed):\n` +
          `  • ≤ ${next ? 25 : 50} words total, ≤ ${next ? 3 : 4} lines.\n` +
          `  • Line 1 — tick + the doc's NAME in the user's language. e.g. "✅ Got your civil ID (3/5)." / "✅ استلمت بطاقتك الشخصية (3/5)."\n` +
          (next
            ? `  • Line 2 — the NEXT doc with 📎. e.g. "📎 Next: passport copy" / "📎 التالي: نسخة الجواز".\n`
            : `  • Line 2 — list ALL collected docs by name (the user just sent multiple files; show them what was saved). Format: "📦 Got all ${autoRecorded.total_docs} docs: ${allDoneList}" / "📦 وصلت جميع الوثائق (${autoRecorded.total_docs}): [الأسماء]".\n` +
              `  • Line 3 — submit prompt: "Submit your file?" / "نُرسل ملفك؟"\n`) +
          `  • DO NOT mention caption status, filename, mime, size, or "no caption was provided". The save was silent — keep it that way.\n` +
          `  • DO NOT call record_document (already saved). DO NOT ask to re-upload.`
      });
    } else if (autoExtra) {
      // The upload was auto-attached as an EXTRA (supplementary) file. Two
      // possible contexts: (a) service has zero required docs → nothing
      // pending; ask to submit; (b) service has required docs but vision
      // determined this file is supplementary → ack the extra AND ask for
      // the next required doc.
      const collected = state.collected || {};
      const stillPending = (state.docs || []).filter(d => !collected[d.code]);
      const nextReq = stillPending[0];
      const ackLines = nextReq
        ? [
            `[Extra file auto-saved silently — total extras now: ${autoExtra.extra_count}. Required docs still pending: ${stillPending.length}/${state.docs.length}. Next required slot: ${nextReq.code} — ${nextReq.label_en || ''}${nextReq.label_ar ? ' / ' + nextReq.label_ar : ''}]`,
            ``,
            `Reply rules (HARD CEILINGS):`,
            `  • ≤ 25 words total, ≤ 2 lines.`,
            `  • Line 1 — tick + simple ack. e.g. "✅ Saved." / "✅ استلمت."`,
            `  • Line 2 — ask "is your file complete?". DO NOT name a specific next doc (the citizen sends in any order). e.g. "Is your file complete?" / "هل اكتمل ملفك؟"`,
            `  • DO NOT prompt to submit — required docs are still pending.`,
            `  • DO NOT mention caption/filename/mime. DO NOT ask required-vs-extra — already decided.`,
            `  • DO NOT call any tool.`
          ]
        : [
            `[Extra file auto-saved silently — total extras now: ${autoExtra.extra_count} — no required docs are pending]`,
            ``,
            `Reply rules (HARD CEILINGS):`,
            `  • ≤ 25 words total, ≤ 2 lines.`,
            `  • Line 1 — tick + simple ack. e.g. "✅ Saved." / "✅ استلمت."`,
            `  • Line 2 — submit prompt. e.g. "Submit your file?" / "نُرسل ملفك؟"`,
            `  • DO NOT mention caption/filename/mime. DO NOT ask required-vs-extra.`,
            `  • DO NOT call any tool.`
          ];
      messages.push({ role: 'system', content: ackLines.join('\n') });
    } else if (ambiguousAttachment) {
      // Vision was unsure. Surface its best-guess HINT to the LLM so the
      // question becomes "looks like X — save as Y or extra?" rather than
      // a generic caption-mismatch dead end.
      const next = ambiguousAttachment.next_pending;
      const nextLabelEn = next?.label_en || next?.code || 'the next required doc';
      const nextLabelAr = next?.label_ar || '';
      const nextDual = nextLabelAr ? `${nextLabelEn} / ${nextLabelAr}` : nextLabelEn;
      const vSummary = ambiguousAttachment.vision_summary;
      const vBest = ambiguousAttachment.vision_best;
      const vBestSlot = vBest ? state.docs.find(d => d.code === vBest.code) : null;
      const vBestLabel = vBestSlot
        ? (vBestSlot.label_en || vBestSlot.code) + (vBestSlot.label_ar ? ' / ' + vBestSlot.label_ar : '')
        : null;
      const visionHint = vSummary
        ? `Vision read of the file: "${vSummary}". Vision's best guess: ${vBest ? `${vBestLabel} (confidence ${(vBest.confidence * 100).toFixed(0)}%)` : 'unsure'}.`
        : '';
      messages.push({
        role: 'system',
        content:
          `[Attachment uploaded — vision was not fully confident.${visionHint ? ' ' + visionHint : ''}]\n` +
          `Caption from user: "${ambiguousAttachment.caption.replace(/"/g, '\\"').slice(0, 80)}"\n` +
          `Next required slot: ${nextDual}\n\n` +
          `Reply rules (HARD CEILINGS):\n` +
          `  • ≤ 20 words, single line.\n` +
          `  • Ask ONE concise yes/no using vision's hint. e.g. "Looks like ${vBestLabel || nextLabelEn} — confirm?" / "يبدو أنه ${vBestLabel || nextLabelEn} — هل أحفظه في هذه الخانة؟"\n` +
          `  • DO NOT call any tool now. Wait for the user's reply.\n` +
          `  • On the user's NEXT turn: record_document(doc_code="${vBest?.code || next?.code || ''}", caption=<theirs>) when they confirm.`
      });
    } else if (state.pending_uploads?.some(p => p.url === attachment.url)) {
      // Attachment just landed in the multi-file buffer. The deterministic
      // record-doc reply path BELOW will render the standard "received +
      // checklist + هل اكتمل؟" reply. We don't push a system message that
      // could let the LLM drift — the trace #1345 showed the LLM
      // producing "📥 استلمت ملف إضافي" (using the إضافي word the user
      // explicitly said to remove). Skipping the LLM avoids that risk.
      // The buffer will be auto-flushed positionally on burst drain.
    } else {
      // Couldn't auto-record (no docs list, wrong state, or all slots filled).
      // Hand to the LLM the old way.
      const captionParts = [];
      if (cap) captionParts.push(`media_caption="${cap.replace(/"/g, '\\"')}"`);
      if (raw && raw !== cap) captionParts.push(`accompanying_text="${raw.replace(/"/g, '\\"')}"`);
      const capStr = captionParts.length ? ', ' + captionParts.join(', ') : '';
      messages.push({
        role: 'user',
        content: `[Attachment uploaded but NOT auto-recorded: name="${attachment.name || 'file'}", mime=${attachment.mime || 'unknown'}, size=${attachment.size || 0}B${capStr}]\n` +
          `→ Either start_submission first if no service is selected, or call record_document(doc_code, caption=<that caption>) once a service is chosen. ` +
          `If multiple slots could match and the caption is ambiguous, ask ONE short clarifying question instead of guessing.`
      });
    }
  } else if (state.pending_uploads?.length && !bufferFlushed) {
    // No attachment this turn AND user text didn't auto-flush (description
    // was unparseable). Ask the citizen to describe the buffered files.
    const n = state.pending_uploads.length;
    const remainingSlots = (state.docs || []).filter(d => !state.collected?.[d.code]);
    const slotHint = remainingSlots.slice(0, 4).map(d => d.label_en || d.code).join(', ');
    messages.push({
      role: 'system',
      content:
        `[Pending uploads buffer has ${n} file(s) the citizen hasn't described yet. Their last message wasn't a parseable description. Required slots remaining: ${slotHint || 'none'}.]\n\n` +
        `Reply rules (HARD CEILINGS):\n` +
        `  • ≤ 25 words, ≤ 2 lines.\n` +
        `  • Ask once for descriptions. e.g. "I have ${n} file${n > 1 ? 's' : ''}. Tell me what each is — comma-separated. e.g. \\"civil ID, passport, photo\\"." / "لدي ${n} ملف${n > 1 ? 'ات' : ''}. وضّح ما يحتوي كل واحد بفواصل — مثال: \\"البطاقة المدنية، الجواز، الصورة\\"."\n` +
        `  • DO NOT call any tool. Wait for the next text.`
    });
  }
  let finalReply = null;
  // Captured tool results we want to act on AFTER the loop. Lets us override
  // the LLM's drift with a deterministic, citizen-friendly reply.
  let startSubmissionResult = null;
  let recordedThisLoop = []; // [{ doc_code, label }] from successful record_document calls

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
      // Capture results we'll post-process after the loop.
      if (name === 'start_submission' && result?.ok) startSubmissionResult = result;
      if (name === 'record_document' && result?.ok) {
        const doc = (ctx.state.docs || []).find(d => d.code === result.recorded);
        recordedThisLoop.push({
          doc_code: result.recorded,
          label: doc?.label_ar || doc?.label_en || result.recorded
        });
      }
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
    // codex iter-13: drop the "/ Sorry, try again." English suffix
    // (consistent with iter-7 Arabic-only fallback policy).
    finalReply = sanitizeReply(last.content, raw) || 'عذراً، لم أكمل الإجابة — حاول مرة أخرى أو استخدم الأزرار للمتابعة.';
  }

  // ── Deterministic doc-list reply after start_submission ────────
  // User-requested: when a service is just started, show the FULL list of
  // required documents so the citizen can prepare them all at once instead
  // of being asked one-by-one with no idea what's coming. Sonnet was being
  // terse and only naming the first doc; override its reply with a clean
  // structured list (no LLM creativity here — the tool result is structured
  // data, perfect for templating).
  if (startSubmissionResult) {
    const r = startSubmissionResult;
    // start_submission returns name_ar / name_en (NOT service_name_*).
    // First-trace bug: the field-name mismatch left svcName falling back to
    // the literal string "الخدمة", and the citizen saw "بدأت طلبك: *الخدمة*".
    const svcName = (r.name_ar || r.name_en || ctx.state?.service_code || 'الخدمة').toString();
    const entity = (r.entity_ar || r.entity_en || '').toString();
    // Sanitize fees_text — many catalog rows have refund-policy or
    // T&C text crammed into this field. Only render when it LOOKS like
    // a fee figure (numeric digit + currency, OR short ≤60 chars).
    // Trace +96892888715 #1314: fee field was "The applicant is not
    // entitled to refund the fees…" — pure noise, looked like garbage.
    let feeLine = '';
    if (r.fee_omr != null) {
      feeLine = `\n💰 الرسوم: ${Number(r.fee_omr).toFixed(0)} ر.ع`;
    } else if (r.fees_text) {
      const ft = String(r.fees_text).trim();
      const looksLikeFee = ft.length <= 60 || /\d.*(ر\.ع|ريال|OMR|omr)/i.test(ft);
      if (looksLikeFee && !/refund|إلغاء|cancellation/i.test(ft)) {
        feeLine = `\n💰 الرسوم: ${ft}`;
      } else {
        feeLine = `\n💰 الرسوم: غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم`;
      }
    } else {
      feeLine = `\n💰 الرسوم: غير مُدرجة في القائمة — سيؤكدها مكتب سند المستلم`;
    }
    const fee = feeLine;
    const docs = r.required_documents || [];
    // BATCH-FIRST FLOW (user spec, 2026-05-06): no more "send doc 1, then
    // doc 2…" — show the full list once, ask for everything in one go.
    const docList = docs.length
      ? '\n\n📋 *المستندات المطلوبة* (' + docs.length + '):\n' +
        docs.map((d, i) => `${i + 1}. ${arabicLabelFor(d)}`).join('\n')
      : '\n\n📋 لا توجد مستندات مطلوبة لهذه الخدمة.';
    // Single-icon CTA — citizen can send everything at once or in any order.
    const cta = docs.length
      ? '\n\nأرسل المستندات الآن — كلها معاً أو بأي ترتيب.'
      : '\n\nيمكنك بدء التقديم الآن.';
    finalReply =
      `✅ بدأت طلبك:\n*${svcName}*` +
      (entity ? `\n🏛 ${entity}` : '') +
      fee +
      docList +
      cta;
    trace.push({ step: 'deterministic_start_reply', docs: docs.length, service: svcName });
  }

  // ── Hallucination guard ───────────────────────────────────────
  // The user-reported trace from prod (+96892888715) showed the bot
  // claiming "✅ حفظت Civil ID" while state.collected was empty AND no
  // record_* tool fired. The LLM was inventing the save because the
  // prompt example mentioned it. If we ship the lie, the citizen thinks
  // their file is in the system, the office never sees it, and the
  // request silently fails. Catch it here:
  //   1. If this turn had an attachment AND
  //   2. Nothing actually recorded the file (no auto-record paths fired,
  //      no record_* tool returned ok), AND
  //   3. The reply claims a save (✅ / حفظت / saved / recorded /...)
  // → force a deterministic record_extra_document so the file is at
  //   least preserved (officer can re-classify), and downgrade the reply
  //   to a non-misleading ack.
  // Save-claim regex. Extended 2026-05-06 after a trace showed the bot
  // hallucinating "✅ استلمت البطاقة المدنية" (received [slot-name]) when
  // no record_* tool fired and state.collected was empty. "استلمت [slot]"
  // is a save claim in this product context — the auto-record system
  // prompt template literally tells the LLM to start with "✅ استلمت ..."
  // when a record succeeds, so the LLM was reusing that template
  // unprompted.
  // Expanded 2026-05-08 per gpt-5.2-codex Q4. Real LLM emissions seen
  // in traces include verb-less slot claims ("الهوية مضافة"), and
  // alternative verbs (وصلتني / أرفقتها / سجلناه / أضفتها / ثبتناها).
  const HALLUCINATED_SAVE_RE =
    /✅\s*(?:حفظت|استلمت|تم\s*الحفظ|تم\s*التسجيل|تم\s*الاستلام|saved|received|recorded|stored|got\s+your)/i;
  const HALLUCINATED_VERB_RE =
    /(?:^|\s)(?:حُفِظ(?:ت|ا)?|سجّلت|سُجّل|سجلناه|سجلناها|أضفتها|أضفتُها|ثبتناه|ثبتناها|ثبّت|أرفقتها|أرفقتُها|وصلتني|تم\s+استلام|received\s+your|added\s+your)(?:\s|$|[:.،])/i;
  // Verb-less claim — "X مضاف(ة)" / "X مرفق(ة)" — needs slot context
  // to be confident; matched separately and only triggers Mode B.
  const HALLUCINATED_VERBLESS_RE =
    /\b(?:مضاف[ةا]?|مُضاف[ةا]?|مرفق[ةا]?|مُرفق[ةا]?|مسجَّل[ةا]?|مسجل[ةا]?|محفوظ[ةا]?)\b/i;
  const claimedSave = finalReply && (
    HALLUCINATED_SAVE_RE.test(finalReply) ||
    HALLUCINATED_VERB_RE.test(finalReply)
  );
  const verblessSlotClaim = finalReply && HALLUCINATED_VERBLESS_RE.test(finalReply);
  const recordedRequiredThisTurn = !!(
    autoRecorded ||
    (bufferFlushed && bufferFlushed.recorded?.length) ||
    recordedThisLoop.length
  );
  const recordedAnythingThisTurn = recordedRequiredThisTurn || !!(
    autoExtra ||
    (bufferFlushed && bufferFlushed.extras?.length)
  );
  // Two distinct hallucination modes:
  //   (A) reply claims a save but NOTHING was recorded → file lost
  //   (B) reply names a SPECIFIC slot label (e.g. "حفظت Civil ID") but that
  //       slot is NOT in state.collected → either the file went to extras
  //       (autoExtra fired) or to nothing — either way the citizen is being
  //       lied to about the slot mapping.
  let guardReason = null;
  if (claimedSave && attachment && !recordedAnythingThisTurn) {
    guardReason = 'reply_claims_save_but_no_record_at_all';
  } else if (claimedSave && !attachment && !recordedRequiredThisTurn) {
    // TEXT-TURN HALLUCINATION (caught 2026-05-06 in trace +96892888715 #1288):
    // citizen typed text → LLM replied "✅ حفظت البطاقة المدنية" → no
    // record_document tool call this turn → state.collected unchanged.
    // The previous guard skipped this because !attachment. Now we treat
    // it as a slot-naming lie if the reply mentions a slot label that
    // ISN'T actually in state.collected.
    const lyingAboutSlotInText = (state.docs || []).some(d => {
      if (state.collected?.[d.code]?.storage_url) return false;
      const labelAr = d.label_ar || arabicLabelFor(d) || '';
      const labelEn = d.label_en || '';
      const re = (labelAr || labelEn)
        ? new RegExp(`(?:${labelAr ? labelAr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') : ''}${labelAr && labelEn ? '|' : ''}${labelEn ? labelEn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') : ''})`, 'i')
        : null;
      return re && re.test(finalReply);
    });
    if (lyingAboutSlotInText) guardReason = 'text_reply_claims_save_no_record';
  } else if (claimedSave && attachment && !recordedRequiredThisTurn) {
    // Only an extra was recorded. Check if the reply names a required-slot
    // label that ISN'T actually in state.collected.
    const lyingAboutSlot = (state.docs || []).some(d => {
      if (state.collected?.[d.code]) return false; // genuinely collected — fine
      const labelAr = d.label_ar || '';
      const labelEn = d.label_en || '';
      const re = labelAr || labelEn
        ? new RegExp(`(?:${labelAr ? labelAr.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&') : ''}${labelAr && labelEn ? '|' : ''}${labelEn ? labelEn.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&') : ''})`, 'i')
        : null;
      return re && re.test(finalReply);
    });
    if (lyingAboutSlot) guardReason = 'reply_names_slot_that_is_not_collected';
  } else if (verblessSlotClaim && !recordedRequiredThisTurn) {
    // Verb-less claim like "الهوية مضافة" without a record this turn.
    // Check if any required-slot label appears in the reply AND isn't
    // in state.collected. Less aggressive than the verb-based guards
    // (matches all attachment + text turns).
    const lyingVerbless = (state.docs || []).some(d => {
      if (state.collected?.[d.code]?.storage_url) return false;
      const labelAr = d.label_ar || '';
      const labelEn = d.label_en || '';
      const re = labelAr || labelEn
        ? new RegExp(`(?:${labelAr ? labelAr.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&') : ''}${labelAr && labelEn ? '|' : ''}${labelEn ? labelEn.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&') : ''})`, 'i')
        : null;
      return re && re.test(finalReply);
    });
    if (lyingVerbless) guardReason = 'reply_makes_verbless_slot_claim';
  }
  if (guardReason) {
    trace.push({
      step: 'hallucination_guard_fired',
      reason: guardReason,
      original_reply_head: String(finalReply).slice(0, 120)
    });
    // Only force a fallback record if NOTHING was recorded; if an extra was
    // recorded the file is at least preserved — just need to fix the reply.
    if (!recordedAnythingThisTurn) {
      try {
        await TOOL_IMPL_V2.record_extra_document(ctx, {
          caption: attachment.caption || attachment.name || 'attached file',
          original_name: attachment.name || null
        });
      } catch (e) {
        console.warn('[hallucination_guard] forced record_extra failed:', e.message);
      }
    }
    // Honest reply pointing at the next pending slot so the citizen knows
    // what to do. List remaining required slots so they can describe it.
    const checklist = renderChecklist(ctx.state);
    // No more "📎 المطلوب التالي: X" — per user spec (2026-05-06): never
    // ask for individual files. Just ack + checklist + the same question.
    finalReply = checklist
      ? `📥 استلمت الملف.\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
      : '📥 استلمت الملف. هل اكتمل ملفك؟';
  }

  // ── Deterministic record-doc reply ──────────────────────────
  // After a SUCCESSFUL record_document (auto-record path OR LLM-driven
  // record_document tool call OR buffer-flush record), override the LLM's
  // free-form reply with a tight templated "✅ saved X. Next: Y" message.
  //
  // Why override even when the LLM was fine: the LLM occasionally
  //  • asks "is this for X?" AFTER record fired → friction (#3 in user report)
  //  • adds prose / multiple paragraphs that crowd out the next-step
  //  • forgets to name the next slot label
  // Templating from state is deterministic and pairs cleanly with the
  // collecting/reviewing buttons attached below.
  //
  // Skipped when:
  //  • bufferFlushed already produced a multi-slot summary (the LLM was
  //    instructed via system message to render the per-slot table; that's
  //    richer than a single "saved X" line).
  //  • the hallucination guard rewrote finalReply this turn.
  //  • the citizen's input was a text turn — they may have been asking a
  //    question; don't shadow a substantive answer with a one-liner.
  const didDeterministicReply = !!startSubmissionResult || !!guardReason;
  // Codex review (gpt-5.2-codex, 2026-05-06) flagged: the override silences
  // the LLM's clarifying question in mixed-confidence cases — e.g. vision
  // auto-recorded the file but the LLM noticed something off and asked
  // "هل هذا الملف للبطاقة المدنية؟". If we override, the citizen never
  // sees the question and the wrong slot ships. Preserve the LLM's reply
  // when it's a yes/no clarifier; the contextual button attacher below
  // will still pair confirm:yes/no with it.
  const llmAskedClarification = finalReply && looksLikeYesNoAsk(finalReply);
  if (
    attachment &&
    !didDeterministicReply &&
    !bufferFlushed?.recorded?.length &&
    recordedRequiredThisTurn &&
    !llmAskedClarification
  ) {
    const justSaved = [];
    if (autoRecorded) {
      const m = (state.docs || []).find(d => d.code === autoRecorded.recorded);
      if (m) justSaved.push(arabicLabelFor(m));
    }
    for (const r of recordedThisLoop) {
      // r.label is the raw-from-tool label; re-resolve via Arabic map.
      const m = (state.docs || []).find(d => d.code === r.doc_code);
      const label = arabicLabelFor(m) || r.label;
      if (!justSaved.includes(label)) justSaved.push(label);
    }
    const pending = (state.docs || []).filter(
      d => !ctx.state.collected?.[d.code] && !isPlaceholderDoc(d)
    );
    // Count of files received this turn (auto-record + LLM record + buffer
    // flush). Citizen-facing wording uses this count, not slot names —
    // per the user's batch-flow spec ("I received X files, are all complete?").
    const receivedThisTurn = (autoRecorded ? 1 : 0)
      + (recordedThisLoop?.length || 0)
      + ((bufferFlushed?.recorded?.length || 0) + (bufferFlushed?.extras?.length || 0));
    const totalCollected = Object.keys(ctx.state.collected || {}).length;
    const checklist = renderChecklist(ctx.state);
    const fileWord = receivedThisTurn === 1 ? 'ملف' : (receivedThisTurn === 2 ? 'ملفين' : 'ملفات');
    const savedLine = receivedThisTurn > 0
      ? `📥 استلمت ${receivedThisTurn} ${fileWord}.`
      : '📥 استلمت الملف.';
    let body;
    if (pending.length === 0) {
      // All required slots filled — push to review.
      body = checklist
        ? `${savedLine}\n\n${checklist}\n\n✨ ✨ اكتمل ملفك. اضغط *✅ انتهيت من الرفع*.`
        : `${savedLine}\n\n✨ ✨ اكتمل ملفك. اضغط *✅ انتهيت من الرفع*.`;
    } else {
      // The user's spec: don't request a specific next doc one-by-one.
      // Acknowledge what came in + show the live checklist + ask the SAME
      // question every time: "are all your files complete?".
      body = checklist
        ? `${savedLine}\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`
        : `${savedLine}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`;
    }
    trace.push({
      step: 'deterministic_record_reply',
      saved: justSaved.length,
      pending: pending.length,
      original_reply_head: String(finalReply || '').slice(0, 120)
    });
    finalReply = body;
  }

  // CX iter-1 (2026-05-08): when state is collecting/reviewing AND the
  // citizen sent an attachment AND the reply is the LLM-fallback (LLM
  // unreachable), override with a deterministic checklist ack instead of
  // letting drainBurst persist the outage message as the consolidated
  // summary. Real prod issue from trace +96892888715 #1741: single
  // attachment after start_submission got "⚠️ تعذّر الاتصال" persisted
  // by drainBurst, breaking continuity for the citizen.
  if (attachment && finalReply &&
      ['collecting', 'reviewing'].includes(ctx.state.status) &&
      /تعذّر الاتصال بالمساعد الذكي مؤقتاً/.test(String(finalReply))) {
    const checklist = renderChecklist(ctx.state);
    const filesIn = Object.keys(ctx.state.collected || {}).length
                  + (ctx.state.extras || []).length;
    if (filesIn > 0 && checklist) {
      finalReply = `📥 استلمت الملف.\n\n${checklist}\n\nهل اكتمل ملفك؟ اضغط *✅ انتهيت من الرفع* أو أرسل المزيد.`;
    } else if (checklist) {
      finalReply = `📎 وصل المرفق — لكن لم يُحفظ في خانة بعد.\n\n${checklist}\n\nأرسل تعليقاً قصيراً يصف الملف (مثال: "بطاقة مدنية") أو أعد إرساله.`;
    } else {
      finalReply = '📎 استلمت ملفاً — أكمل إرسال بقية الملفات أو اضغط *✅ انتهيت من الرفع*.';
    }
    trace.push({ step: 'cx_attachment_fallback_override', files_in: filesIn });
  }

  // codex iter-13: throttle the LLM-error fallback. When the same
  // "تعذّر الاتصال بالمساعد الذكي مؤقتاً" message would fire twice in a row
  // within 60 s, escalate the wording so the citizen knows we noticed the
  // repeat and gives them a clearer recovery path. Real bug from bench
  // scenario #1 — the citizen typed two follow-up messages and got the
  // same generic outage message twice.
  const _LLM_FALLBACK_HEAD = /تعذّر الاتصال بالمساعد الذكي مؤقتاً/;
  if (finalReply && _LLM_FALLBACK_HEAD.test(String(finalReply))) {
    const recent = ctx.state.last_llm_fallback_at
                && (Date.now() - ctx.state.last_llm_fallback_at) < 60_000;
    if (recent) {
      finalReply =
        `⚠️ المساعد الذكي ما زال غير متاح حالياً.\n\n` +
        `للمتابعة الآن، اختر إحدى الخدمات الشائعة من الأزرار، أو اكتب اسم الخدمة بالضبط — مثل: *تجديد رخصة القيادة*، *تجديد جواز السفر*، *إصدار سجل تجاري*.`;
      trace.push({ step: 'llm_fallback_escalated' });
    }
    ctx.state.last_llm_fallback_at = Date.now();
  } else if (ctx.state.last_llm_fallback_at) {
    // Successful turn — reset the throttle.
    delete ctx.state.last_llm_fallback_at;
  }

  // Persist + record bot turn. request_id may have been set by submit_request
  // or accept_offer mid-loop — pull it from state. Skip storing empty bot
  // turns (e.g. silent burst-continuation) so the chat history doesn't
  // accumulate blank rows.
  //
  // BURST-DEFERRED STORAGE (2026-05-07): for attachment turns in
  // collecting/reviewing, runTurn arms the burst aggregator with this
  // reply instead of sending immediately. drainBurst now handles the
  // storeMessage centrally — so we skip storage here. Without this,
  // the WEB channel rendered N+1 bubbles per N-file burst (one per
  // file's handler reply + one synthetic summary). After the change:
  // exactly ONE bubble per burst, on web AND WhatsApp.
  await saveSession(session_id, ctx.state);
  const willBeArmedToBurst = !!attachment &&
    ['collecting', 'reviewing'].includes(ctx.state.status);
  if (finalReply && String(finalReply).trim() && !willBeArmedToBurst) {
    await storeMessage({
      session_id, request_id: ctx.state.request_id || null,
      direction: 'out', actor_type: 'bot', body_text: finalReply
    });
  }
  trace.push({
    step: 'v2_saved',
    status: ctx.state.status,
    silent: !finalReply,
    deferred_to_burst: willBeArmedToBurst
  });

  // ── CONTEXT-DRIVEN BUTTON ATTACHER ───────────────────────────
  // Goal: every WhatsApp turn that asks the citizen for ANY action ships
  // with quick-reply buttons. Typing Arabic on a phone keyboard is the
  // single biggest friction in the prod traces — a tap is always faster.
  //
  // Priority (most specific first):
  //   1. File just buffered / ambiguous-classification → 3-btn doc:* set
  //      (the existing UX — pre-record clarification)
  //   2. collecting + just recorded → next-step nav (📋 المتبقي / ➕ إضافي / ✕ إلغاء)
  //      OR submit nav if pending == 0  (📤 أرسل / ➕ إضافي / ✕ إلغاء)
  //   3. collecting (no record this turn, but slots remain) → next-step nav
  //   4. reviewing → submit nav
  //   5. generic yes/no detected → confirm:yes/no
  //
  // Mapped button IDs (handled in routes/whatsapp.js → canonical text):
  //   doc:yes / doc:wrong / doc:extra   — pre-record classification
  //   doc:list                           — "show me remaining required docs"
  //   review:submit                      — "send for review / submit"
  //   service:cancel                     — "cancel this draft / start over"
  //   confirm:yes / confirm:no           — generic
  //   burst:done / burst:more            — multi-file burst summary (drainBurst)
  const justBufferedThisFile = !!(attachment && state.pending_uploads?.some(p => p.url === attachment.url));
  const _buttons = attachContextualButtons({
    state: ctx.state,
    finalReply,
    ambiguousAttachment,
    justBufferedThisFile,
    recordedRequiredThisTurn,
    trace
  });

  // Cache the offered button ids on state so the next turn can validate
  // any incoming __btn__: payload (injection guard, codex Q1).
  if (_buttons && _buttons.length) {
    ctx.state.last_offered_buttons = _buttons.map(b => String(b.id));
    await saveSession(session_id, ctx.state);
  } else if (ctx.state.last_offered_buttons) {
    delete ctx.state.last_offered_buttons;
    await saveSession(session_id, ctx.state);
  }

  return {
    reply: finalReply,
    state: ctx.state,
    trace,
    request_id: ctx.state.request_id || null,
    _buttons
  };
}

// True if the bot's reply asks the citizen for FREE-FORM TEXT (a name,
// address, description, or other typed answer) — buttons would block the
// expected input. Codex review (2026-05-06) flagged this as the #1
// confusing-button risk: nav buttons over a "describe these files" prompt
// would have the citizen tapping when they should be typing.
//
// Heuristic, not exhaustive — designed to over-trigger on description-style
// asks. False positives just mean "no buttons this turn"; the citizen can
// still type fine. False negatives mean a confusing button — worse.
function replyExpectsFreeText(reply) {
  const t = String(reply || '');
  if (!t) return false;
  return (
    // "describe / صف / وصف / اشرح / explain" with what-style follow-up.
    // Arabic note: \b doesn't fire on Arabic chars; use a lookahead for
    // (whitespace | end | punct) instead.
    /(?:^|\s)(?:صف|وصف|اشرح|اوصف)(?=\s|$|[:.،؟?])/i.test(t) ||
    /\b(?:describe|explain|tell me what|tell me which)\b/i.test(t) ||
    // "what is this / ما هذا / ما هو / ما اسم"
    /(?:^|\s)ما\s+(?:هذا|هو|هي|اسم|نوع)(?=\s|$|[:.،؟?])/i.test(t) ||
    /\bwhat (?:is|kind|type|name)\b/i.test(t) ||
    // Asking for a name / address / free typed identifier
    /(?:^|\s)(?:أرسل|ارسل|اكتب)\s+(?:اسم|عنوان|رقم|تفاصيل)/i.test(t) ||
    /\b(?:enter|type|provide|share)\s+(?:your\s+)?(?:name|address|details|description)\b/i.test(t) ||
    // "أخبرني ما هذا" / "tell me what this is"
    /أخبرني\s+ما/i.test(t) ||
    /\btell me what\b/i.test(t) ||
    // "اكتب وصف لكل ملف" / "describe each file"
    /اكتب\s+(?:وصف|تعليق|تعليقاً|تفاصيل)/i.test(t) ||
    /\bdescribe\s+each\b/i.test(t)
  );
}

// True if the bot's reply is a warning / error notice (⚠️ prefix or
// equivalent). Codex flagged: button sets attached to error states are
// confusing — the citizen needs to retry / fix the input, not navigate.
function isWarningReply(reply) {
  const t = String(reply || '').trim();
  return /^[⚠️❌🚫]/.test(t) || /^(error|warning|⚠)/i.test(t);
}

// Pure helper. Returns a button array (max 3) or null.
// Exported via __testBurst for unit testing.
function attachContextualButtons({ state, finalReply, ambiguousAttachment, justBufferedThisFile, recordedRequiredThisTurn, trace }) {
  if (!finalReply) return null;
  // codex iter-7: the LLM-error fallback ("⚠️ تعذّر الاتصال بالمساعد الذكي مؤقتاً…")
  // looks like a warning but is precisely the moment the citizen NEEDS
  // recovery buttons (status:check / service:cancel / discovery hints).
  // Bypass the warning-suppression guard for this exact reply.
  // codex iter-13: also match the escalated wording so recovery buttons
  // still attach when the throttle in runAgentV2 swaps the message.
  const LLM_FALLBACK_RE = /(?:تعذّر الاتصال بالمساعد الذكي مؤقتاً|المساعد الذكي ما زال غير متاح حالياً)/;
  const isLlmFallback = LLM_FALLBACK_RE.test(String(finalReply || ''));
  // Codex-suggested guards: don't attach buttons when the reply expects
  // a typed answer or is an error/warning.
  if (!isLlmFallback && isWarningReply(finalReply)) {
    trace?.push({ step: 'buttons_suppressed', reason: 'warning_reply' });
    return null;
  }
  if (!isLlmFallback && replyExpectsFreeText(finalReply)) {
    // codex iter-13: even when the LLM-fallback reply mentions "اكتب اسم
    // الخدمة" (typed-input hint), the citizen still benefits from the
    // discovery buttons as a faster alternative. Don't suppress on fallback.
    trace?.push({ step: 'buttons_suppressed', reason: 'free_text_expected' });
    return null;
  }
  // Codex review (gpt-5.2-codex, 2026-05-06) flagged: in finalized states
  // (queued / claimed / in_progress / etc.) we must NOT show submit/extra
  // buttons — the request is already in flight, those buttons would
  // trigger a double-submit or extras-after-final. Show only cancel /
  // status / contact-office actions.
  const FINALIZED = new Set(['queued', 'claimed', 'in_progress', 'needs_more_info',
                             'awaiting_payment', 'awaiting_reclassify_ack', 'completed']);
  if (state?.status && FINALIZED.has(state.status)) {
    // Generic yes/no still wins (handleInFlight may genuinely need a confirm).
    if (looksLikeYesNoAsk(finalReply)) {
      trace?.push({ step: 'attached_buttons', case: 'finalized_yes_no', count: 2 });
      return [
        button('confirm:yes'),
        button('confirm:no')
      ];
    }
    // Always-on actions for finalized states (user spec, 2026-05-07):
    // citizen should never have to type to check status or cancel.
    // 'completed' is excluded — nothing meaningful to do at that point.
    if (state.status !== 'completed') {
      trace?.push({ step: 'attached_buttons', case: 'finalized_status_cancel', count: 2 });
      return [
        button('status:check'),
        button('service:cancel')
      ];
    }
    trace?.push({ step: 'buttons_suppressed', reason: 'finalized_state', status: state.status });
    return null;
  }
  const docs = (state && state.docs) || [];
  const collected = (state && state.collected) || {};
  const pending = docs.filter(d => !collected[d.code] && !isPlaceholderDoc(d));

  // Defensive: clamp every button to Meta's 20-char title limit.
  const clamp = (b) => ({ id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) });
  const fire = (kase, btns) => {
    trace?.push({ step: 'attached_buttons', case: kase, count: btns.length });
    return btns.slice(0, 3).map(clamp);
  };

  // CASE 1 — pre-record classification (most specific)
  if (ambiguousAttachment || justBufferedThisFile) {
    const next = ambiguousAttachment?.next_pending || pending[0];
    const vBest = ambiguousAttachment?.vision_best;
    const guessSlot = vBest ? docs.find(d => d.code === vBest.code) : null;
    const slotForYes = guessSlot || next;
    const slotLabel = (arabicLabelFor(slotForYes) || 'هذا المستند').slice(0, 14);
    // 2-button confirm (per user 2026-05-06: remove the إضافي/داعم
    // concept from menus). Citizen confirms slot or asks for re-route.
    return fire(ambiguousAttachment ? 'ambiguous_doc' : 'buffered_no_caption', [
      { id: 'doc:yes',   title: `✓ ${slotLabel}` },
      button('doc:wrong')
    ]);
  }

  // UNIFIED COLLECTING/REVIEWING button set (user spec, 2026-05-06):
  // EVERY reply during collecting/reviewing gets the SAME three buttons —
  // BUT only once at least one file has actually been received. The
  // start_submission first message is "send your docs now" — there's
  // nothing to "finish uploading" or "send more of" yet, so showing
  // those buttons is nonsensical (user feedback 2026-05-07). Only
  // surface the cancel button at that point so the citizen can back
  // out cleanly.
  if (state?.status === 'collecting' || state?.status === 'reviewing') {
    const filesIn = Object.keys(state.collected || {}).length
                  + (state.extras || []).length
                  + (state.pending_uploads || []).length;
    if (filesIn === 0) {
      // Two affordances at start_submission first reply:
      //   • 🔍 خدمة أخرى — pivot if they picked the wrong service
      //   • ✕ إلغاء الطلب — back out cleanly
      return fire('collecting_no_files_yet', [
        button('service:switch'),
        button('service:cancel')
      ]);
    }
    return fire('unified_collecting', [
      button('review:submit'),
      button('burst:more'),
      button('service:cancel')
    ]);
  }

  // codex iter-13: LLM-fallback in idle state must take priority over
  // the generic yes/no detector. The escalated fallback ("اختر إحدى
  // الخدمات الشائعة من الأزرار…") was triggering yes/no buttons because
  // `اختر` matches looksLikeYesNoAsk's invite-selection pattern.
  if (isLlmFallback && (!state?.status || state.status === 'idle')) {
    return fire('llm_fallback_idle', [
      button('discover:license'),
      button('discover:title'),
      button('discover:cr')
    ]);
  }

  // CASE 5 — generic yes/no fallback (covers idle confirms, "هل تؤكد…", etc.)
  if (looksLikeYesNoAsk(finalReply)) {
    return fire('generic_yes_no', [
      button('confirm:yes'),
      button('confirm:no')
    ]);
  }

  // NUMBERED-LIST PICKER (codex iter-3 fix, 2026-05-08): when the LLM
  // presents a candidate list (1️⃣ X / 2️⃣ Y / 3️⃣ Z) — e.g. "i need a
  // license" → "here are the relevant services" — attach 1/2/3
  // tap-pickers so the citizen doesn't have to type the number on a
  // phone keyboard. The fallthrough map sends "1" / "2" / "3" to the
  // LLM, which sees the numbered list in its own previous reply and
  // resolves which service to start.
  const numberedListRe = /(?:^|\n)\s*1[️⃣.)\s]/m;
  const has2 = /(?:^|\n)\s*2[️⃣.)\s]/m.test(String(finalReply));
  const has3 = /(?:^|\n)\s*3[️⃣.)\s]/m.test(String(finalReply));
  if (numberedListRe.test(String(finalReply || '')) && has2) {
    const btns = [
      { id: 'pick:1', title: '1️⃣' },
      { id: 'pick:2', title: '2️⃣' }
    ];
    if (has3) btns.push({ id: 'pick:3', title: '3️⃣' });
    return fire('numbered_picker', btns);
  }

  // FALLBACK — per user spec ("never allow a message without buttons for
  // yes/no/go ahead"): if the LLM produced a reply ending with `؟` / `?`,
  // attach generic confirm buttons even if our heuristics didn't match.
  // Better to over-attach than miss.
  if (/[؟?]\s*$/.test(String(finalReply || '').trim())) {
    return fire('fallback_question', [
      button('confirm:yes'),
      button('confirm:no')
    ]);
  }

  // (iter-7 LLM-fallback case moved above CASE 5 in iter-13)

  return null;
}

// Heuristic: does the reply ask the citizen for a yes/no confirmation?
// Hits on Arabic and English variants. Designed to over-attach buttons
// rather than miss — false positives are harmless (citizen can still type).
//
// Arabic note: \b is an ASCII word boundary and does NOT fire on Arabic
// characters in JS regex (they aren't \w). Use lookbehind for "(start of
// line | whitespace)" instead, which works for any script.
function looksLikeYesNoAsk(reply) {
  const t = String(reply || '');
  if (!t) return false;
  return (
    // Explicit "type yes/no" / "اكتب نعم أو لا"
    /(?:^|\s)اكتب\s*(?:نعم|yes)\s*(?:أو|او|or|\/|،)\s*(?:لا|no)/i.test(t) ||
    /\b(?:type|reply|answer)\s+(?:yes|y)\s*(?:\/|or)?\s*(?:no|n)\b/i.test(t) ||
    // "نعم / لا?" / "نعم أو لا?" inline
    /(?:^|\s)نعم\s*(?:[\/،]|أو|او)\s*لا\s*[؟?]?\s*$/m.test(t) ||
    /\byes\s*\/\s*no\??$/im.test(t) ||
    // "هل ..." / "هل ترغب ..." / "هل تؤكد ..." style asks
    /(?:^|\s)هل\s+(?:تريد|ترغب|تؤكد|تأكد|توافق|تكمل|نكمل|نتابع|نُرسل|نرسل|نبدأ|أبدأ|أحفظ|نحفظ|تحب|تود|تكتفي|نكتفي|نُكمل|نُرسلها|نرسلها)/i.test(t) ||
    // "اكتب تم" / "اكتب نعم" / "اكتب موافق" — any "type X" reserved-word
    /(?:^|\s)اكتب\s+(?:تم|نعم|موافق|أرسل|ارسل|ابدأ|ابدا|أبدأ|تأكيد|تاكيد)/i.test(t) ||
    // English question patterns
    /\b(?:do you want|would you like|shall i|should i|are you sure|confirm|ready to|want me to)\b.*\?/i.test(t) ||
    // Trailing yes/no-style question prompts
    /(?:^|\s)(?:نتابع|نُرسل|نرسل|نبدأ|أبدأ|نُجهّز|نجهز|نُكمل|نكمل|نُؤكد|نؤكد|نتأكد|نلغي)\s*[؟?]\s*$/m.test(t) ||
    /(?:submit|continue|proceed|confirm|start|cancel|approve)\s*\?\s*$/im.test(t) ||
    // Inviting selection — "اختر X أو Y" / "pick X or Y". \b doesn't fire
    // on Arabic chars; lookahead for whitespace/end/punct instead.
    /(?:^|\s)اختر(?=\s|$|[:.،؟?])/i.test(t) ||
    /\b(?:pick|choose)\s+(?:one|either|from|between)\b/i.test(t)
  );
}

export { runAgentV2 };

// Test-only export — surfaces the burst-aggregation internals so the
// regression test in tests/12-burst-aggregator.test.js can verify that the
// in-flight gate prevents premature drainBurst flushes. Not part of the
// public API; do not import outside tests.
export const __testBurst = {
  armBurst,
  drainBurst,
  bumpInflightFiles,
  inflightFilesFor,
  pendingBurst,
  SESSION_BURST,
  SESSION_INFLIGHT_FILES,
  parseUploadDescriptions,
  looksLikeYesNoAsk,
  attachContextualButtons,
  replyExpectsFreeText,
  isWarningReply,
  arabicLabelFor,
  handleButtonIntent,
  SESSION_LAST_DRAIN_AT,
  renderChecklist
};
