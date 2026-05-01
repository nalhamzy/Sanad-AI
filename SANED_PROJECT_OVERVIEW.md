# SANED-AI — Full Application Overview

> Living description of the running app, generated 2026-05-01 from a fresh code + runtime read of the `confident-feynman-297b2c` worktree. Use this as the single map for the iterative review-and-enhance pass we're starting.

For deep dives, see:
- [SANAD_AI_PLAN_V2.md](SANAD_AI_PLAN_V2.md) — product spec
- [SANAD_AI_DESIGN.md](SANAD_AI_DESIGN.md) — design decisions log
- [AGENT.md](AGENT.md) — chat agent v2 architecture
- [README.md](README.md) — run/test/deploy
- [AUDIT_REPORT.md](AUDIT_REPORT.md) — last feature audit (87/100 Opus avg, 111/111 deterministic)
- [docs/FACEBOOK_SETUP.md](docs/FACEBOOK_SETUP.md) — WhatsApp Cloud API setup

---

## 1. What Saned actually is (one paragraph)

Saned (ساند) is a **request-preparation and dispatch platform** for Oman government services. A bilingual web/WhatsApp assistant talks to a citizen, identifies the right service from a catalogue of ~601 services across ~29 entities, collects every required document, and drops a complete "ready" file into a marketplace where licensed Sanad offices submit competing offers. The citizen accepts one, pays, and that office's officer processes the paperwork end-to-end on their behalf — Saned never touches a government portal. After dispatch, the bot relays OTPs and status updates between the office and the citizen.

The platform is the file-prep layer; the offices are the execution layer; the ministries are unchanged.

---

## 2. Stack at a glance

| Layer | Choice | Where |
|---|---|---|
| Runtime | Node 20+, ES modules | [server.js](server.js) |
| HTTP | Express 4 | [server.js:28-101](server.js:28) |
| DB | libSQL / SQLite (file or Turso) | [lib/db.js](lib/db.js) |
| Search | FTS5 BM25 + Qwen embeddings + RRF | [lib/hybrid_search.js](lib/hybrid_search.js), [lib/embeddings.js](lib/embeddings.js) |
| LLM (chat/tools) | Anthropic (default) or Qwen | [lib/llm.js](lib/llm.js) |
| LLM (embeddings) | Qwen `text-embedding-v3` (1024-dim) | Anthropic has no embed API |
| Auth | bcrypt + JWT in httpOnly cookie | [lib/auth.js](lib/auth.js) |
| WhatsApp | Meta Cloud API + HMAC-SHA256 sig | [routes/whatsapp.js](routes/whatsapp.js), [lib/whatsapp_send.js](lib/whatsapp_send.js) |
| Payments | Amwal (stub mode by default) | [lib/amwal.js](lib/amwal.js), [routes/payments.js](routes/payments.js) |
| Vision (doc OCR) | Anthropic vision (gated) | [lib/vision.js](lib/vision.js) |
| Frontend | Plain HTML + vanilla JS + `theme.css` (no framework) | [public/](public/) |
| Hosting | Render (single web service + persistent disk) | [render.yaml](render.yaml), [Dockerfile](Dockerfile) |

Boot sequence ([server.js:109-165](server.js:109)): migrate → optional force-reload catalogue → `autoImportCatalog()` → seed demo offices/officers/requests → start SLA watcher → background embed worker.

Local boot just verified: `npm install && npm start` → `http://localhost:3030`, 601 services in `service_catalog`, 8 demo requests, 3 demo offices/officers, `{"ok":true,"llm":false,"debug":true}` on `/api/health`.

---

## 3. Component map

```
┌────────────────────┐                ┌────────────────────────────────┐
│  Citizen channels  │                │  Office channels (web only)    │
│                    │                │                                │
│ /chat.html (web)   │                │ /office-signup.html  /-login   │
│ /apply.html (web)  │                │ /officer.html (workspace)      │
│ /account.html      │                │ /pay.html (subscription)       │
│ /request.html      │                │ /annotator.html (catalogue QA) │
│ WhatsApp Cloud API │                │ /admin.html (debug — dev only) │
└──────┬─────────────┘                └────────────────┬───────────────┘
       │                                               │
       ▼                                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Express app (server.js)                                            │
│  ──────────────────────────────────────────────────────────────────  │
│  /api/citizen-auth · /api/auth · /api/office · /api/officer ·       │
│  /api/chat · /api/whatsapp · /api/catalogue · /api/payments ·       │
│  /api/annotator · /api/platform-admin · /api/debug                  │
└─────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  lib/agent.js  ::  runTurn(session_id, user_text, attachment, …)    │
│  ──────────────────────────────────────────────────────────────────  │
│   AGENT_V2 + LLM key  →  unified Qwen tool-calling loop (17 tools)  │
│   else                 →  v1 heuristic state machine (5 launch flow)│
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────┐    ┌─────────────────────┐    ┌───────────────────┐
│  hybrid_search.js      │    │  catalogue / docs   │    │  agent_tools.js   │
│  FTS5 + cosine + RRF   │    │  parsing / fees     │    │  17 tool impls    │
└────────────────────────┘    └─────────────────────┘    └───────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  data/sanad.db (libSQL)  ·  uploads on persistent disk              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. The five components you called out

### 4.1 Web interface (citizen + office sides)

The HTML is served from [public/](public/) — vanilla, RTL-first Arabic, EN toggle. Pages:

**Public / marketing**
- [index.html](public/index.html) — landing (Saned brand, dual CTA: WhatsApp + Web).
- [pricing.html](public/pricing.html) — citizen + office pricing pages.
- [brochure.html](public/brochure.html) — ministry-pitch one-pager (AR + EN, self-contained).
- [privacy.html](public/privacy.html), [terms.html](public/terms.html).

**Citizen flow**
- [signup.html](public/signup.html), [login.html](public/login.html) — phone OTP + Google sign-in.
- [account.html](public/account.html) — "my requests", phone-attach banner, search.
- [chat.html](public/chat.html) — WhatsApp-style web chat with the bot (same agent as WA).
- [apply.html](public/apply.html) — non-chat path: pick a service, attach files, submit directly.
- [catalogue.html](public/catalogue.html) — browse all 601 services, hybrid-search UI.
- [request.html](public/request.html) — per-request timeline + thread + Pay-Now CTA.
- [pay.html](public/pay.html) — payment landing (citizen pays for a request).

**Office flow**
- [office-signup.html](public/office-signup.html) — KYC form (CR number, governorate, owner email/password).
- [office-login.html](public/office-login.html) — email + password login.
- [officer.html](public/officer.html) — main workspace: marketplace + my-board + request detail + chat relay + OTP window. Grid/list toggle, ⌘K command palette.
- [annotator.html](public/annotator.html) — internal catalogue QA tool (review/edit service rows).

**Admin / debug**
- [admin.html](public/admin.html) — counts, OTP simulator, latest requests (gated by DEBUG_MODE).

UI conventions live in [public/theme.css](public/theme.css) (surface system, ambient gradients, focus halos, skeleton loaders) and [public/i18n.js](public/i18n.js) (597 keys, every `data-i18n` validated by tests).

### 4.2 User logins

Two completely separate cookie + session systems — they never share state.

#### Citizen
File: [routes/citizen_auth.js](routes/citizen_auth.js). Cookie: `sanad_citizen_sess`. Two entry paths into the same `citizen` row:

1. **WhatsApp-first** — citizen messages the bot, [routes/whatsapp.js](routes/whatsapp.js) creates a `wa:<phone>` session, and the agent auto-promotes them to a `citizen` row on first contact (phone implicitly verified by Meta).
2. **Web-first** — phone OTP via WhatsApp template, *or* Google ID token (with mandatory phone-attach later, gated by `requireCitizen({ requirePhone: true })`).

OTP details ([routes/citizen_auth.js:152-300](routes/citizen_auth.js:152)):
- 6-digit code, bcrypt-hashed (cost 8), 5-min TTL, 30-second cooldown, 5 max-attempts.
- Magic OTP `000000` enabled when `DEBUG_MODE=true` for local testing.
- Send path: WhatsApp template first, free-text fallback within the 24h window.
- E.164 normaliser auto-prefixes `+968` for 8-digit Oman numbers.

Google sign-in ([routes/citizen_auth.js:307-358](routes/citizen_auth.js:307)) verifies the ID token via the `oauth2.googleapis.com/tokeninfo` endpoint (no extra dep), matches by `google_sub` then `email`, and flags `needs_phone:true` if the citizen still needs to attach one.

#### Office (officer)
File: [routes/auth.js](routes/auth.js). Cookie: `sanad_sess`. Email + bcrypt password, JWT-signed cookie.

- Signup ([routes/auth.js:64-131](routes/auth.js:64)): creates `office` (status='pending_review', plan='pro') and an admin `officer` (role='owner', status='active'). Office can't browse marketplace until a platform admin approves.
- Login ([routes/auth.js:134-158](routes/auth.js:134)): bcrypt verify, write `last_login_at`, set cookie. Rate-limited at 8 attempts / IP / minute.
- Password rules: min 10 chars, ≥1 letter, ≥1 digit, blocked common-password list.
- Allowed governorates: hardcoded set of 11 Oman governorates ([routes/auth.js:49-52](routes/auth.js:49)).
- `requireOfficer({ allowPending, roles })` middleware gates every other office endpoint.

#### Origin / CSRF guard
[lib/csrf.js](lib/csrf.js) checks `Origin` / `Referer` on state-changing routes. Bypass list: `/api/whatsapp/*` (HMAC-verified), `/api/payments/webhook`, `/api/payments/_stub/*`, `/api/chat/*` (no auth cookie to forge). See [server.js:78-85](server.js:78).

### 4.3 Sanad offices (the marketplace)

The whole offer / claim / payment lifecycle lives in [routes/officer.js](routes/officer.js) (1085 lines) and [routes/office.js](routes/office.js).

**Lifecycle stages of a request** (DB column `status`):
```
draft → collecting → reviewing → ready → claimed → awaiting_payment → in_progress → completed
                              │      │       │
                              │      │       └─→ released (auto, SLA breach) → ready
                              │      └─→ cancelled_by_office
                              └─→ cancelled_by_citizen / needs_more_info / on_hold
```

**Privacy wall** (the cut at [routes/officer.js:1-22](routes/officer.js:1) and enforced at [routes/officer.js:245-298](routes/officer.js:245)):
- **Pre-award (`status='ready'`)**: any active office can view an *anonymized* card — service, entity, governorate, doc count, # of offers. **No** citizen phone, name, civil ID, or doc URLs.
- **Post-award (`status='claimed'+`)**: only the winning office sees the documents (storage URLs) and chat. The citizen's phone is *never* exposed to the office — all messaging routes through the relay.
- **Chat gate**: even after claiming, the message thread stays locked until `paid_at` is set.

**Offers + credits** ([routes/officer.js:1-22](routes/officer.js:1) preamble):
- Each office submits one offer per request — `office_fee_omr` + `government_fee_omr` (split shown to citizen).
- Citizen accepts one offer → request transitions to `claimed` → 1 credit consumed regardless of outcome.
- Credits come from a 35-OMR pack (default 70 credits) sold via the office subscription endpoint ([routes/payments.js:1-16](routes/payments.js:1)).
- `subscription_status='active'` and `credits_remaining > 0` are required to submit/update offers.

**Office self-service** ([routes/office.js](routes/office.js)):
- `GET /profile`, `PATCH /settings` — owner sets `default_office_fee_omr` (one-click quote default).
- `GET /pricing` — full catalogue × per-office override table ([office_service_price](lib/db.js)).
- Team management endpoints (invite, role, status — owner/manager only).

**SLA watcher** ([lib/sla.js](lib/sla.js)): every 60s sweep, two windows.
- `REVIEW_SLA_MINUTES` (5 min default) — claim must move to `awaiting_payment` (offer accepted + payment link sent).
- `SLA_MINUTES` (45 min default) — work must complete after payment.
- Breach → `sla_auto_release` audit row, request bumped back to `ready`.

**Officer reports** ([routes/officer.js:40-103](routes/officer.js:40)) — 7-day status counts, 14-day daily pipeline, 30-day avg claim→complete time, in-flight queue with elapsed minutes.

### 4.4 WhatsApp web agent (the bot brain)

Same code runs on the web tester (`/chat.html`) and the WhatsApp webhook — only the channel adapter differs. Entry point: [lib/agent.js::runTurn](lib/agent.js).

**Two paths, one set of tools** ([lib/agent.js:24-28](lib/agent.js:24)):
- **v2** (`SANAD_AGENT_V2=true` + LLM key) — single Qwen/Anthropic tool-calling loop, every state, 17 tools.
- **v1** (no key or flag false) — scripted heuristic state machine for 5 launch flows. All pinned tests target v1 for determinism.

**State machine** (driven by tool calls in v2):
```
idle → confirming → collecting → reviewing → queued → claimed → in_progress → completed
```

**Tool catalogue** (from [lib/agent_tools.js:272+](lib/agent_tools.js:272)):

| Tool | Purpose |
|---|---|
| `search_services` | Hybrid FTS5 + semantic + RRF over the catalogue |
| `get_service_details` | Full row incl. process steps |
| `list_entities` / `list_categories` / `get_entity_services` | Browse |
| `compare_services` | Side-by-side 2–3 services |
| `start_submission` | Begin draft request → confirming |
| `confirm_submission` | Citizen says yes → collecting |
| `discard_draft` | Abandon draft |
| `record_document` / `record_extra_document` / `replace_document` | Doc collection |
| `submit_request` | Insert `request` + `request_document` rows → `ready` |
| `get_my_requests` / `get_request_status` | Citizen status lookup |
| `list_offers` / `accept_offer` | Pick a Sanad office |
| `cancel_request` | Hard or soft cancel by status |
| `add_note` | Free-text note visible to office |
| `get_session_state` | Debug introspection |

**System prompt** ([lib/agent.js:30-80](lib/agent.js:30)) — long, names the bot ساند / Saned, forbids "Ahmed" persona, enforces:
1. One language per reply (mirror citizen).
2. Ground truth from tools only — no fee/doc invention.
3. Show 2–3 options when match confidence < 0.75.
4. No double-prompting (don't ask "do you want to start?" after a clear intent).
5. Catalogue gap honesty (Civil ID renewal + Passport renewal aren't in the catalogue — surface the closest available variant).

**Hybrid search** ([lib/hybrid_search.js](lib/hybrid_search.js)): structured pre-filter → FTS5 BM25 (top 50) → cosine top-K against 1024-dim Qwen embeddings → RRF (k=60) with +0.05 launch boost + log-popularity. ~120 ms warm. First boot embeds the 601 rows in ~90 s in the background.

**Vision / OCR** ([lib/vision.js](lib/vision.js), 242 lines) — Anthropic-vision-gated doc classifier. Auto-tags an uploaded image as `civil_id`, `passport`, `medical`, etc. so the bot can match captioned uploads to the right slot.

### 4.5 WhatsApp webhook (Meta Cloud API)

File: [routes/whatsapp.js](routes/whatsapp.js) (113 lines).

**Verification + signature** ([routes/whatsapp.js:21-49](routes/whatsapp.js:21)):
- `GET /api/whatsapp/webhook` — Meta verification handshake (`hub.mode=subscribe` + `hub.verify_token`).
- `POST` — every body byte hashed against `WHATSAPP_APP_SECRET` via HMAC-SHA256, compared in constant time. When `WHATSAPP_APP_SECRET` is empty (dev mode), verification is bypassed and a one-time warning is logged.
- ACK 200 immediately, processing happens after the response is sent (Meta retries on timeout).

**Inbound message flow** ([routes/whatsapp.js:51-105](routes/whatsapp.js:51)):
1. Pull `entry[0].changes[0].value.messages[0]` from Meta payload.
2. Extract text or button text; for media, fetch the temporary URL via `fetchMedia(mediaId)` using the access token.
3. Treat captions on images/documents as effective `user_text` so search/intent works on caption-only uploads.
4. `runTurn({ session_id: 'wa:<phone>', user_text, attachment, citizen_phone })` — same agent code as web.
5. If `reply` is non-empty (burst-continuation gate suppresses acks during multi-file uploads), send via [lib/whatsapp_send.js](lib/whatsapp_send.js).

**Outbound** ([lib/whatsapp_send.js](lib/whatsapp_send.js)): wraps Meta's `/messages` endpoint, supports `sendWhatsAppText` and `sendWhatsAppTemplate(name, lang, components[])`. Stub mode (no creds) returns success and logs.

**OTP delivery** ([routes/citizen_auth.js:191-204](routes/citizen_auth.js:191)) goes through the same sender — template name configurable via `WHATSAPP_OTP_TEMPLATE`.

---

## 5. Data model (live shape)

Live counts on local boot: `service_catalog=601`, `request=8`, `request_document=29`, `message=8`, `citizen=8`, `office=3`, `officer=3`.

Core tables (defined in [lib/db.js](lib/db.js)):

| Table | Purpose |
|---|---|
| `service_catalog` | The 601 services (33 columns), `embedding_json` blob, `is_launch` flag, FTS5 mirror `service_catalog_fts` |
| `service_catalog_fts` | FTS5 virtual table, BM25 ranked |
| `office_service_price` | Per-office overrides for `office_fee_omr` + `government_fee_omr` |
| `citizen` | phone (E.164), email, google_sub, display_name, avatar, language_pref, signup_source, phone_verified_at |
| `citizen_otp` | code_hash, expires_at, attempts, purpose ('signup'/'attach_phone'), citizen_id |
| `office` | name (AR+EN), governorate, wilayat, status (pending/active/disabled), plan, wallet_baisa, rating, credits_remaining, subscription_status, default_office_fee_omr |
| `officer` | office_id, full_name, email, role (owner/manager/officer), password_hash, status |
| `request` | session_id, citizen_id, service_id, office_id, status, fees (office/government/quoted), payment_status, payment_link, paid_at, claimed_at, completed_at, last_event_at, claim_review_started_at, state_json |
| `request_document` | request_id, doc_code, label, storage_url, mime, status (pending/verified/rejected), caption, matched_via, is_extra |
| `request_offer` | request_id, office_id, office_fee_omr, government_fee_omr, quoted_fee_omr, estimated_hours, status |
| `message` | request_id, session_id, direction (in/out), actor_type (bot/officer/citizen/system), body_text, media_url |
| `credit_ledger` | office_id, request_id, delta, kind, ref (UNIQUE on office_id+request_id) |
| `audit_log` | actor_type/id, action, target_type/id, diff_json, ip — append-only |
| `session` | bot session state JSON keyed by session_id |
| `service_edit_proposal` | (table exists, no UI) — for the §11.8 smart-FAQ workflow |

All money fields keep `_omr` REAL plus selected `_baisa` integer columns ([SANAD_AI_PLAN_V2.md:286](SANAD_AI_PLAN_V2.md:286) recommends integer baisa everywhere; partial migration only).

---

## 6. The end-to-end flow

```
1.  Citizen lands on /chat.html OR DMs the WA business number
2.  Bot greets in Arabic, asks what service
3.  Tool: search_services("renew driving licence")  →  service id
4.  Tool: get_service_details                        →  fee, docs, steps
5.  Tool: start_submission                           →  state=confirming
6.  Citizen says "yes" → confirm_submission          →  state=collecting
7.  Bot asks for each required doc one at a time
8.  Citizen uploads → vision classifier tags it → record_document
9.  All slots filled → state=reviewing → submit_request
10. Request row inserted, status='ready', dispatched to marketplace
11. Sanad offices see anonymized card, submit offers (office_fee + gov_fee)
12. Citizen sees offers in /account.html → accept_offer
13. status='claimed', credit consumed, payment link generated (Amwal)
14. Citizen pays at /pay.html → status='in_progress', chat unlocks
15. Office processes the gov-portal work, asks for OTP via the bot
16. Bot relays OTP from citizen → officer pastes into portal
17. Office uploads receipt + Complete  →  status='completed'
18. Citizen gets receipt + CSAT prompt
```

SLA watcher silently reverts stuck claims to `ready` after the review/work windows.

---

## 7. Catalogue + scraping pipeline (where the 601 services come from)

8 scraper directories under [scripts/](scripts/). Each ministry scrapes the official source HTML and emits the canonical 32-column CSV that matches the legacy directory schema.

| Source | Rows | Path |
|---|---|---|
| Muscat Municipality | 103 | [scripts/mm_scrape](scripts/mm_scrape) |
| Min. of Commerce | 38 | [scripts/moc_scrape](scripts/moc_scrape) |
| Min. of Health | 69 | [scripts/moh_scrape](scripts/moh_scrape) |
| Housing/Urban Planning | 86 | [scripts/mohup_scrape](scripts/mohup_scrape) |
| Min. of Labour | 76 | [scripts/mol_scrape](scripts/mol_scrape) |
| Transport/Comms/IT | 50 | [scripts/mtcit_scrape](scripts/mtcit_scrape) |
| Royal Oman Police | 31 | [scripts/rop_scrape](scripts/rop_scrape) |
| **7-ministry total** | **453** | merged into [oman_services_directory_v2.csv](oman_services_directory_v2.csv) |
| sanad.om gap-fill | 210 | [scripts/sanad_om_scrape](scripts/sanad_om_scrape) |
| **v3 (live catalogue)** | **601** | [oman_services_directory_v3.csv](oman_services_directory_v3.csv) |

Pipeline:
```
scrape.mjs (per source) → {source}_services.csv
sanad.om scrape → reconcile_sanad_om.mjs → sanad_reconciliation.json → to_csv.mjs
normalize_scraped.mjs → enrich_scraped.mjs (Qwen fills name/desc/docs)
merge_catalog.mjs → v2 (453, ministries-only)
[manual] → v3 (601, includes sanad_om)
server boot → autoImportCatalog (lib/db.js:670) → service_catalog table
```

**Known gaps** (full review at the previous turn): `rebuild_catalogue.mjs` and `merge_catalog.mjs` don't include sanad_om — running them today shrinks the catalogue 601 → 453. `package.json` has aliases for only 3 of the 8 scrapers. ProcessSteps + Fees are 79% / 42% empty respectively because the enricher doesn't fill them. 62 "junk" rows flagged by the reconciliation are still live.

---

## 8. Auth & security inventory

| Area | Status | File |
|---|---|---|
| Officer pwd hashing | bcrypt cost 10, blocked common-password list | [lib/auth.js](lib/auth.js), [routes/auth.js:33](routes/auth.js:33) |
| Citizen OTP | bcrypt cost 8, 5-min TTL, 30s cooldown, 5 attempts | [routes/citizen_auth.js:104](routes/citizen_auth.js:104) |
| Cookies | httpOnly, separate cookies for citizen vs officer | [lib/auth.js](lib/auth.js) |
| CSRF | Origin/Referer guard on state-changing routes | [lib/csrf.js](lib/csrf.js), [server.js:78](server.js:78) |
| WhatsApp webhook | HMAC-SHA256, constant-time compare | [routes/whatsapp.js:21](routes/whatsapp.js:21) |
| Amwal webhook | Signature-verified | [lib/amwal.js](lib/amwal.js) |
| Rate limiting | Per-IP + per-phone | [lib/rate_limit.js](lib/rate_limit.js) |
| RLS | **Not implemented** — multi-tenancy enforced in app middleware (`req.office.id`) per [README.md:356](README.md:356) |
| Audit log | Append-only `audit_log` table on every state change | various |

Open items per [AUDIT_REPORT.md](AUDIT_REPORT.md): no logout endpoint test, no email validation on signup, no session-expiry test, DEBUG attach-phone shortcut still ships in `/account.html`, `idx_citizen_email` exists but no index on `citizen.google_sub`, no CHECK constraint on `payment_status`.

---

## 9. Deployment

- **Render** ([render.yaml](render.yaml)) — single web service + 1 GB persistent disk at `/data` for SQLite + uploads. Health check `/api/health`.
- **Docker** ([Dockerfile](Dockerfile)) — `docker build -t sanad-ai .` + run with env file.
- **Turso** option — change `DB_URL` to `libsql://...` + `DB_AUTH_TOKEN`, no code change.
- Per memory: live deploy URL exists with webhook path documented.

`SANAD_FORCE_RELOAD_CATALOGUE=true` ([server.js:120-137](server.js:120)) is the one-shot env flag for catalogue migrations on deployed instances — wipes service_catalog + dependent rows and re-imports from CSV. Must be unset on the next deploy or it re-runs.

---

## 10. Test surface

70 deterministic + 5 LLM-path tests, ~3 s wall ([README.md:96-128](README.md:96)):

| File | Covers |
|---|---|
| `01-unit.test.js` | `normalize()`, `expandQuery()` |
| `02-catalogue.test.js` | `matchService()` regression |
| `03-agent.test.js` | v1 `runTurn()` state machine + DB side-effects |
| `04-routes.test.js` | HTTP integration on a real Express on a random port |
| `05-agent-tricky.test.js` | 52 adversarial v1 conversations |
| `06-auth-offers.test.js` | Auth, sessions, credit ledger, anonymized offers |
| `07-agent-v2.test.js` | LLM-path coverage (requires `QWEN_API_KEY`, runs via `npm run test:llm`) |
| `08-hybrid-search.test.js` | FTS + filters + RRF deterministic fixture |
| `e2e-scenarios.mjs` | Larger end-to-end harness (not in `npm test`) |

**Gaps**: no scrape-pipeline tests, no SLA-watcher tests, no payment webhook tests, no multi-tenancy / RLS simulation.

---

## 11. What's deliberately NOT built (per [README.md:362-369](README.md:362))

- AmwalPay live integration (stub mode default).
- Office onboarding wizard backend (3 demo offices seeded).
- Firebase / SSO auth (cookies only).
- Postgres RLS.
- Catalogue edit-proposal voting UI (DB exists, no UI).
- Qwen-VL document validation (Anthropic vision used instead, gated).
- Realtime WebSockets (UIs poll every 2.5–3 s).

---

## 12. Iteration plan — what we do next

This doc is the map. The review-and-enhance loop runs **per component**, in this order, with the same shape each time:

> **read live behaviour → propose changes → discuss with you → implement on this branch → verify (npm test + browser) → ship**

Component queue (suggested order, tell me to re-rank):

1. **Catalogue / scraping pipeline** — already reviewed; quick-win fixes ready (rebuild includes sanad_om, npm aliases, junk pruning). Bring fees + steps coverage from 58%/21% up.
2. **Citizen web flow** (`/chat.html` → `/apply.html` → `/account.html` → `/request.html`) — drive it end-to-end in a browser (MCP), capture friction, fix.
3. **Office flow** (`/office-signup.html` → approval → `/officer.html` marketplace → claim → chat → complete) — same end-to-end pass.
4. **WhatsApp agent + webhook** — verify v2 tool loop with a real LLM key, audit the system prompt against the catalogue gap honesty rule, smoke-test signature verification.
5. **Payments + SLA** — exercise the stub mode through the full happy path, inspect `audit_log` rows, time the SLA sweeps.
6. **Auth + privacy wall** — adversarial: try to scrape the marketplace pre-claim, try to read another office's chats, verify the chat-gate before payment.

For each, I'll:
- Use the running app at `http://localhost:3030` and browser MCP (Claude in Chrome) where it exists; fall back to direct API calls for the rest.
- Keep changes scoped: one component, one PR-sized diff at a time.
- Run `npm test` before declaring done; flag any new test we need.
- Re-deploy to Render (per memory there's a live URL) only after you green-light each batch.

Tell me which component to start with and I'll begin.
