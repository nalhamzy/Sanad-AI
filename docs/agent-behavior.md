# Sanad-AI · Agent Behavior Spec

Last updated: 2026-05-07 (commit `437b3e3`).
Source of truth for what the WhatsApp/web agent does in every interaction.
**If a behaviour here disagrees with `lib/agent.js`, the code is wrong.**

---

## 1. The product in one sentence

> Sanad-AI is a request-preparation layer between citizens and licensed Sanad offices.
> It collects the right documents, dispatches a complete file to a Sanad office for review, then forwards the office's payment link and completion notice back to the citizen. Pricing is **pre-set per service** (uniform across offices) — there is no marketplace, no offers, no office selection.

## 2. State machine

Every conversation is in exactly one state at a time:

```
idle ─search→ confirming ─yes→ collecting ─enough docs→ reviewing
                                       │                     │
                                       │ submit_request      │
                                       ▼                     ▼
                                queued → claimed → in_progress → completed
                                          │             │
                                          └──┬──────────┘
                                             ▼
                                    needs_more_info / awaiting_payment
                                             │
                                             ▼
                                   cancelled (citizen aborts)
```

State is persisted to `session.state_json` (see `lib/agent.js::loadSession / saveSession`).

## 3. Two pipelines: V1 heuristic vs V2 tool-loop

| Pipeline | Default | Used when |
|---|---|---|
| **V2** (tool-calling LLM, `runAgentV2`) | yes (`SANAD_AGENT_V2=true`) | Every turn except in-flight + attachment |
| **V1** (heuristic + LLM, `runLLMLoop`) | fallback | When V2 is disabled or in-flight pipeline takes over |

V1 stays as a safety net; all new work goes into V2.

## 4. Per-turn lifecycle (V2)

```
WhatsApp webhook
  │
  ├─ fetchMedia (1-3 s for media; bumps inflight counter via trackInflightMedia)
  │
  ▼
runTurn (per-session lock via withSessionLock)
  ├─ Bumps inflight (so drainBurst defers)
  ├─ Stores citizen message
  │
  ▼
_runTurnLocked
  └─ V2-eligible? → runAgentV2
                      ├─ /reset, /state slash commands
                      ├─ Button-intent dispatch (__btn__:* prefix)
                      ├─ Deterministic greeting (idle + bare hello)
                      ├─ Auto-record path (greedy positional)
                      ├─ Buffer-flush (parseUploadDescriptions)
                      ├─ Burst-continuation silent return
                      ├─ Deterministic buffered-file short-circuit
                      ├─ LLM tool loop (max 6 rounds)
                      ├─ Deterministic start_submission reply
                      ├─ Hallucination guard
                      ├─ Deterministic record-doc reply
                      └─ Context button attacher
  │
  ▼
runTurn returns; armBurst queues reply for drainBurst
  │
  ▼
drainBurst (after BURST_QUIET_MS=1.2s + BURST_COOLDOWN_MS=8s)
  ├─ Auto-flush pending_uploads positionally
  ├─ Render checklist + question
  ├─ storeMessage (single source of truth for attachment turns)
  └─ sendWhatsAppText/Buttons OR forward to web client
```

## 5. The deterministic handlers (`handleButtonIntent`)

Every button tap (`__btn__:<id>`) routes through `handleButtonIntent` BEFORE any LLM logic. This eliminates LLM drift on critical state transitions.

| Button id | Handler behaviour |
|---|---|
| `service:switch` | Reset state to idle, prompt for new service name |
| `status:check` | Read request row → render Arabic per-status label. **Bulletproof fallback**: if tool fails, derive label from `state.status` so citizen always gets a reply |
| `service:cancel` | State-aware: idle = "nothing to cancel"; collecting/reviewing = confirm + clear draft; queued/in-flight = confirm + `cancel_request` tool call; completed/cancelled = "can't cancel" |
| `confirm:yes` after `pending_cancel` | Branches on `request_id`: in-flight → `cancel_request` tool; draft → wipe local state |
| `confirm:no` after `pending_cancel` | Keep draft, "تابعنا" |
| `burst:more` | Reset to "send the rest" prompt with checklist (no per-doc steering) |
| `burst:done` | All collected → reviewing summary; partial → "what you've sent + ask is it complete?" |
| `doc:list` | Render full checklist, same question |
| `review:submit` | Bulletproof: 0 files = soft nudge; ≥1 file = `submit_request` tool, transition to queued, render summary + 3-step next-steps |
| `doc:yes` / `doc:wrong` / `doc:extra` | Pre-record classification (rare path; ambiguous-doc CASE 1) |

## 6. Button matrix (when each set appears)

| Moment | Buttons |
|---|---|
| Welcome (idle, no draft) | none, or `confirm:yes/no` if LLM emits a y/n question |
| start_submission first reply (zero files) | `🔍 خدمة أخرى` · `✕ إلغاء الطلب` |
| After ≥1 file received (collecting/reviewing) | `✅ انتهيت من الرفع` · `➕ سأرسل المزيد` · `✕ إلغاء الطلب` |
| Ambiguous-doc (vision uncertain + caption mismatch) | `✓ {slot label}` · `🔄 خانة أخرى` |
| Multi-file burst summary (n≥2) | same as "after ≥1 file" set |
| Cancel-confirm (draft) | `🗑️ نعم، احذف الطلب` · `↩️ تراجع` |
| Cancel-confirm (in-flight) | `✓ نعم، أرسل طلب الإلغاء` · `↩️ تراجع` |
| After submit (queued/claimed/in_progress/etc.) | `📊 حالة الطلب` · `❌ إلغاء الطلب` |
| Completed / cancelled | none (terminal) |
| Generic LLM yes/no question | `✓ نعم` · `✕ لا` |
| Reply ending in `؟` / `?` (fallback) | `✓ نعم` · `✕ لا` |
| Numbered candidate-list reply (`1️⃣ … 2️⃣ … 3️⃣ …`) | `1️⃣` · `2️⃣` · `3️⃣` (taps map to "1"/"2"/"3" so the LLM resolves the picked service from its previous reply) |

## 7. Multi-file (burst) handling

Citizens routinely drop 4–6 files in WhatsApp via "select all + send". Each one triggers a separate webhook. The agent must produce **ONE** consolidated reply, not N.

Pipeline:
1. Each webhook bumps `trackInflightMedia(+1)` BEFORE fetchMedia (so the gate is held during the slow CDN download).
2. `runTurn` per file enters the session lock serially.
3. First file: positional auto-record OR buffered (if `state.pending_uploads.length > 0` OR `inBurstWindow`).
4. Files 2..N within burst window: silent burst-continuation.
5. `drainBurst` schedules a flush 1.2s after the last `armBurst`. Inflight gate + 8s cooldown both defer.
6. On flush: auto-flush `pending_uploads` positionally → render checklist → store ONE row → send ONE message.

Tunables:
- `SANAD_BURST_QUIET_MS` (default 1200ms) — quiet window for first drain.
- `SANAD_BURST_COOLDOWN_MS` (default 8000ms) — refractory period after a drain.
- `BURST_WINDOW_MS` (8000ms, hardcoded in agent.js) — `inBurstWindow` check.

## 8. Hallucination guards

The LLM occasionally claims "✅ saved Civil ID" without calling `record_document`. The agent post-processes every reply with three regexes:

1. **`HALLUCINATED_SAVE_RE`** — `✅ + (حفظت|استلمت|تم الحفظ|saved|received|recorded|stored|got your)`.
2. **`HALLUCINATED_VERB_RE`** — verb-only patterns: `حُفِظت|سجّلت|سجلناه|أضفتها|ثبتناها|أرفقتها|وصلتني|تم استلام|received your|added your`.
3. **`HALLUCINATED_VERBLESS_RE`** — verb-less slot claims: `مضاف(ة)|مرفق(ة)|مسجَّل(ة)|محفوظ(ة)`. Only triggers Mode B (slot-name lie) since the verbless form is too generic on its own.

When triggered:
- **Mode A** (no record at all this turn) — force `record_extra_document` so the file is preserved, replace reply with honest "received your file, kept aside" + checklist.
- **Mode B** (record fired but reply names a slot NOT in `state.collected`) — flag as slot-naming lie, rewrite reply.
- **Text-turn variant** — even with no attachment, if the LLM claims it saved a slot that isn't actually filled, the guard fires.
- **Verb-less variant** (added 2026-05-08) — catches "الهوية مضافة" when the LLM elides the verb.

Real bug history: trace `+96892888715 #1184/#1208/#1280/#1288` showed the LLM repeatedly lying about saves on empty `state.collected`. The guards are layered so each new pattern gets caught.

## 9. Documents (label fallback)

Catalog data has empty `label_ar` for many services. `arabicLabelFor(doc)` resolution order:
1. `doc.label_ar` if non-empty
2. `ARABIC_DOC_LABELS[code]` lookup (with prefix-match for SQL-truncated codes)
3. **Generic Arabic placeholder `مستند`** (changed 2026-05-08 per gpt-5.2-codex review). The previous `«doc.label_en»‎` fallback was leaking on 60% of bot replies in prod, violating the "Arabic only" rule. The office still sees the canonical doc code in `request_document.doc_code`.

Coverage for the 8 services we've tested in production:
- Civil ID family (`civil_id`, `passport`, `photo`, `medical*`)
- Title-deed (سند ملكية) family (`police_report_*`, `original_deed_*`, `no_objection_*`)
- Commercial registration family (`recent_passport_sized_photograph`, `proof_of_address`, `commercial_*`)
- Driver-license-renewal family (`current_driver_s_license`, `recent_personal_photograph`)

Anything outside that coverage now renders as `مستند` instead of leaking English.

## 10. Submit + post-submit flow (the spec)

1. Citizen taps `✅ انتهيت من الرفع`
2. `review:submit` handler runs:
    - `submit_request` tool inserts a `request` row, transitions state → `queued`
    - Reply renders summary (count + checklist) + 3-step next-steps
    - Button set switches to `📊 حالة الطلب` · `❌ إلغاء الطلب`
3. Office reviews → sends payment link → office posts message via `routes/officer.js`
4. Citizen pays → state → `in_progress`
5. Office completes → state → `completed`, citizen notified, terminal

Per the user spec (2026-05-07): pricing is uniform per service. **No marketplace, no offers, no "pick an office".**

## 11a. Bench scenarios (9 in `scripts/scenario-bench.mjs`)

These run on every loop iteration with no LLM judge. Results land in
`docs/scenario-bench-report.json` for codex review.

| ID | Use case | Status |
|---|---|---|
| `doesnt_know_what_he_wants` | "I need help with a gov service" | ✅ pass |
| `service_accept_random_attachments` | Accept service, send 4 attachments out-of-order | ✅ pass |
| `follow_up_request` | Existing in-flight request, asks status | ✅ pass |
| `mid_flow_pivot` | Switch service mid-collection | ✅ pass |
| `cancel_in_flight_request` | Cancel a queued request | ✅ pass |
| `free_text_status_query` | Asks status by typing | ✅ pass |
| `no_files_yet_then_submit_attempt` | Tap submit before any file | ✅ pass |
| `payment_link_present` | Payment-link query when link IS in DB | ✅ pass |
| `otp_forward_refusal` | Citizen tries to share an OTP | ✅ pass (refused) |

## 11. Eval scenarios (12 in `scripts/eval_scenarios.mjs`)

| ID | Use case |
|---|---|
| `ar_typo_civil_id` | Arabic colloquial intent → service search → confirm → start |
| `en_question_then_start` | Q&A about fees first, then commit (no silent start) |
| `wrong_routing_trap` | "Will you send to police?" → must clarify Sanad office model |
| `mid_flow_topic_switch` | Driving licence draft → switch to passport (graceful pivot) |
| `ambiguous_request` | "I need a license" → must disambiguate (no silent pick) |
| `multi_file_batch_upload` | 3 files, weak captions → buffer, ask once, consolidated save |
| `multi_per_slot_burst` | 4 passport angles + 1 ID → save 1 + 3 extras + 1 ID, show counts |
| `unmatched_extras_in_description` | 4 files, 1 description doesn't match any slot → save as extra explicitly |
| `mid_flow_correction` | "wait, file 2 was actually X" → call `record_document` on new slot |
| `whatsapp_5_image_burst` | 5 photos no captions, then describe all → ≤4 bot messages total |
| `return_visit_status_query` | Existing in-flight request → answer status without re-asking |
| `short_fast_reply` | Simple fee Q → ≤30 words, no markdown |

Run: `node scripts/eval_scenarios.mjs` (Anthropic judge) or `node scripts/eval_scenarios.mjs --judge=qwen`.

## 12. Metrics tracked per iteration

`scripts/agent-metrics.mjs` walks all bot messages for the test phone over the past N hours and computes:

- **reply_count_by_scenario** — how many bot bubbles per session
- **avg_reply_length** — mean characters; aim < 200
- **button_attached_rate** — % of bot replies with `_buttons` set
- **deterministic_vs_llm_ratio** — % of replies from deterministic handlers vs LLM tool loop
- **state_progression** — idle → collecting → reviewing → queued reachability
- **hallucination_guard_fires** — count of `step: hallucination_guard_fired` trace rows
- **silent_failures** — citizen turns with no bot follow-up within 60s
- **multi_message_per_burst** — count of bursts that produced ≥2 bot messages (target: 0)
- **english_label_leaks** — bot replies containing `«…»‎` (Arabic-fallback marker)

## 13. Known production issues (history)

| Bug | Fix commit | Resolved |
|---|---|---|
| Hallucinated "saved Civil ID" with empty state.collected | `5b9dab8`, `e6d5714` | ✓ |
| Multi-file burst → 4 bubbles per 4 files (web channel) | `a92c34a` | ✓ |
| `service:cancel` on idle → English LLM reply | `a92c34a` | ✓ |
| Title-deed family rendered as `«English»‎` | `e6d5714` | ✓ |
| Commercial-reg + driver-licence labels leaking | `5de4e83`, `ba8903d` | ✓ |
| Burst summary said "saved 3 files" but they went to extras | `dc41e98` (auto-flush) | ✓ |
| `status:check` button → silent on tool failure | `437b3e3` | ✓ |
| Cooldown 4s too short for human burst rhythm | `5de4e83` (→ 8s) | ✓ |
| `«label_en»‎` fallback leaking on 60% of replies | `c413530` (→ مستند placeholder) | ✓ |
| LLM mis-interpreted "وصلني رابط الدفع؟" as confirmation of receipt | `ca30eb9` (deterministic payment-query handler) | ✓ |
| Long welcome message (333 chars) | `6556f98` (trimmed to ≤200 chars) | ✓ |
| Numbered service-picker lists had no buttons | `6556f98` (1️⃣/2️⃣/3️⃣ pick:N buttons) | ✓ |
| LLM accepted/forwarded OTPs in chat (security) | _iter-4_ (deterministic OTP refusal) | ✓ |

## 14. Engineering notes

- `lib/codex.js` — endpoint-aware OpenAI client (codex models → `/v1/responses`, others → `/v1/chat/completions`)
- `scripts/codex-review.mjs` — design-validation calls to `gpt-5.2-codex`
- `scripts/codex-uxreview.mjs` — hostile-QA review (predicts failure modes from code alone)
- `scripts/codex-doc-review.mjs` — review behavior doc + metrics via gpt-5.2-codex
- `scripts/codex-bench-review.mjs` — review scenario-bench transcripts via gpt-5.2-codex
- `scripts/agent-metrics.mjs` — UX/flow/hazard metrics from local DB or `/api/debug/trace`
- `scripts/scenario-bench.mjs` — runs the 7 named scenarios + extras against the live agent (no LLM judge), produces `docs/scenario-bench-report.json`
- `scripts/eval_scenarios.mjs` — full LLM-judge eval, 12 scenarios (more thorough but costs Anthropic tokens)

`render.yaml` ships `claude-opus-4-5` for the agent. Vision uses Sonnet 4.5. Embeddings on Qwen `text-embedding-v3`.

## 15. Loop-iteration playbook

Every `/loop` iteration runs:
1. `scripts/scenario-bench.mjs` — fresh transcripts via 7 scenarios
2. `scripts/codex-bench-review.mjs` — codex verdict per scenario + TOP-3 fixes
3. Apply real-bug fixes (skip false-positive flags)
4. Tests pass (`npm test`) → 163/163 currently
5. Commit + push → Render auto-deploy
6. Update §13 (history) and §15 of this doc with the iteration's changes

---

*This document is rebuilt each loop iteration. If something here is stale, the iteration's commit message will note the diff.*
