# Sanad-AI — Multi-Office Production Plan (v2)

> Supersedes `SANAD_AI_DESIGN.md`. This is the build spec.

---

## 0. One-line vision

**One bilingual WhatsApp assistant for every citizen in Oman, wired into a shared dashboard that every Sanad office in the country can plug into and earn from — without the citizen ever having to pick an office first.**

---

## 1. Why a single shared bot (and not one bot per office)

| Option | Verdict |
|---|---|
| One WhatsApp number per office | ❌ Each office buys/verifies its own number, citizens need 913 contacts, no network effect. |
| One WhatsApp number per governorate | ❌ Still fragments the citizen experience, orphans border cases. |
| **One national WhatsApp number, many offices behind it** | ✅ Citizen has one number to remember; platform routes; offices compete on speed and rating. |

The platform **is** the phonebook. That's the product moat.

---

## 2. Personas

| Persona | Where they work | Primary interface | Primary goal |
|---|---|---|---|
| **Citizen / Resident** | On WhatsApp | `+968 …` one national number | Get a معاملة done without leaving the sofa |
| **Officer** | At their Sanad desk | Angular dashboard | Maximise completed معاملات per shift |
| **Office Manager** | Same office | Same dashboard, manager tabs | Staff load, SLAs, revenue |
| **Office Owner** | Back office | Owner tabs + billing | Wallet, invoices, office profile |
| **Platform Admin** | Sanad-AI HQ | Admin console | Onboard offices, catalogue, disputes |
| **Gov Portal** | External (ROP, Maktabi, Invest Easy, Tanfeeth…) | Officer's browser | Unchanged — officer still uses their own PKI |

---

## 3. The routing & claim model — the core innovation

### 3.1 How a request becomes an office's request

```
Citizen → bot collects → "ready" → routing engine → one or more offices see it
                                                        │
                                                  first click wins
                                                        │
                                                   claimed by office X
```

Two paths into the queue:

1. **Open marketplace (default).** Request lands in the governorate's public queue. Any active office in that governorate can claim it. First valid `UPDATE … WHERE status='ready' RETURNING *` wins. All others see "Already claimed" and the card disappears from their inbox in realtime.
2. **Citizen-pinned (optional).** Citizen says "send this to مكتب سند النهضة" or taps a saved office. Request is pinned — only that office sees it, for 20 minutes. If unclaimed, it falls back to the governorate marketplace.

**Fallback ladder** if the governorate queue ignores a request:
- 0–20 min: original governorate only
- 20–60 min: + adjacent governorates
- 60 min+: open to all Oman, and the citizen is pinged with an apology + option to cancel or extend.

### 3.2 Why this works
- Offices are incentivised to be fast and well-rated (citizen can re-pin later).
- Citizens never wait on one slow office unless they explicitly chose it.
- Platform can rebalance load by widening/narrowing the queue radius.
- No human dispatcher needed.

### 3.3 Claim correctness (no double-claims, ever)

Single atomic SQL statement:

```sql
UPDATE request
   SET status='claimed', officer_id=$1, office_id=$2, claimed_at=NOW()
 WHERE id=$3 AND status='ready'
RETURNING id;
```

If `RETURNING` returns no row, UI shows "Already claimed" and refreshes. No optimistic-then-sad UX.

### 3.4 Auto-release

A scheduled job releases stuck claims:
```sql
UPDATE request SET status='ready', officer_id=NULL
 WHERE status='claimed' AND last_event_at < NOW() - INTERVAL '15 minutes';
```
Emits `request.released` which broadcasts to the governorate's kanbans.

---

## 4. The privacy wall — what an office sees *before* vs *after* claiming

The user's constraint — *"sanad offices can see bot messages, maybe only after connecting with a user"* — is the right instinct. Here's the exact rule:

| Pre-claim (marketplace card) | Post-claim (full workspace) |
|---|---|
| Service name (EN + AR) | Everything on the left plus: |
| Entity (e.g. ROP) | Citizen full name, phone, civil ID |
| Governorate | Full WhatsApp transcript |
| Document count (e.g. "3/3 ready") | All media files (signed URLs) |
| Citizen first name + masked phone (`Aisha · 968 ***1234`) | OCR results |
| Citizen's one-sentence intent (bot-summarised) | Fee quote editable |
| Estimated total fee | Chat pane to send WhatsApp messages |
| Urgency flag | Process checklist |
| Citizen's rating history (stars only) | Shortcuts bar |

**Technical enforcement**: Postgres Row-Level Security. `message`, `request_document`, `citizen` (full PII) require `office_id = current_setting('app.office_id')` AND request is claimed by that office, or an admin override. The marketplace query hits a **view** (`request_marketplace_v`) that exposes only masked fields.

Unclaimed release = office loses read access to chat history from that moment forward. Existing rows are kept for audit but filtered out of the API.

---

## 5. Citizen journey — WhatsApp

```
1. Citizen messages +968 XX XX XXXX                        "مرحبا"
2. Bot greets, asks what service (free text or list menu)  "كيف أقدر أساعدك؟"
3. LLM matches to catalogue, confirms                      "هل تقصد تجديد رخصة القيادة؟"
4. Bot shows fee estimate + required docs                  "الرسوم حوالي 5 ريال، أحتاج 3 مستندات"
5. Bot collects each doc in order, with an example         "ابعثلي صورة البطاقة المدنية مثل هذه…"
6. Bot checks each file (type + size + optional OCR)       "شكلها واضحة ✅"
7. Bot quotes total + asks for consent                     "هل توافق أن يقوم موظف سند بتنفيذ المعاملة نيابة عنك؟"
8. Citizen sends "نعم" → bot drops request into queue      "طلبك في انتظار أحد مكاتب سند"
9. (optional) Citizen picks an office or governorate       interactive list of top-rated offices nearby
10. Office claims → citizen gets a welcome from office      "مرحبا، معك خالد من مكتب سند النهضة"
11. If officer needs OTP → bot asks, citizen forwards       60-second OTP window, latest 6-digit wins
12. Officer marks complete → bot sends receipt + CSAT       1–5 star emoji tap
```

### Key UX rules for the bot
- **Arabic first**, dialect-aware, English only if citizen writes in English.
- Interactive WhatsApp lists / buttons for anything with ≤10 options. Free text for clarifications only.
- Bot never invents fees — fees come from catalogue + office override.
- Bot never names a specific office unless one has claimed.
- Bot can do only 7 things via tools: `match_service`, `record_document`, `quote_fee`, `queue_request`, `status_lookup`, `cancel`, `relay_otp`. Anything else → LLM answers conversationally within the service context.
- `status` / `حالتي` always works regardless of state.
- `إلغاء` / `cancel` always works pre-claim; post-claim routes a cancel request to the officer.

---

## 6. Officer journey — dashboard

### 6.1 Day shape
1. Officer opens dashboard, sees **kanban** with their office's queue.
2. Top of left column = available marketplace cards for their governorate.
3. Officer presses **`C`** → claims the next available card → workspace opens.
4. In the workspace, 3 panes: summary (left), docs (middle), chat (right) + a shortcuts bar.
5. Officer does the gov-portal work in another window; relays OTP if needed; uploads receipt; presses **`✓ Complete`**.
6. Dashboard auto-advances to next claimed request or back to inbox.

### 6.2 Shortcuts bar (the productivity win)

The officer operates the gov portal **using the citizen's phone number** — the portal sends an OTP to that phone, the citizen forwards it to our bot, the officer pastes it into the portal. No PKI cards, no browser automation, no legal grey area.

- **Open portal** — deep-link to Maktabi / ROP / Invest Easy / Tanfeeth / Nama / Mala'a with the citizen's civil ID and phone copied to the clipboard.
- **Request OTP** — one click opens a 60-second OTP window; bot DMs the citizen *"أرسل رمز التحقق الذي وصلك من {entity}"*; first 4–6-digit code in the citizen's next message is auto-captured, copied to clipboard, and shown large in the officer's UI with a "copy again" button.
- **Copy fee** / **Copy civil ID** / **Copy phone** — one-tap copies.
- **Ask for doc again** — canned-reply picker (AR/EN) with `{{doc_name}}` placeholder.
- **Hold / Cancel / Escalate** — each requires a reason code (feeds admin analytics).

### 6.3 Keyboard-driven
| Key | Action |
|---|---|
| `C` | Claim next in marketplace |
| `J`/`K` | Next/previous request |
| `←`/`→` | Prev/next document in gallery |
| `V` | Mark current doc verified |
| `R` | Reject current doc + open reply |
| `O` | Open OTP window |
| `Enter` | Send chat reply |
| `Esc` | Close modal |
| `?` | Help overlay |

### 6.4 Easy-to-use touches
- **Inbox auto-refresh** via WebSocket — no manual reload.
- **Draft autosave** on chat replies per request.
- **Canned replies** bilingual, with variables, ordered by "most used by me".
- **Dark mode** (officers stare at screens 8h/day).
- **Arabic-first RTL**, EN toggle in header.
- **Mobile-responsive**: officer can triage on phone during lunch, full workspace on desktop.
- **"My day" strip** at top of every page: claimed-today, completed-today, avg-handling-time, today's earnings.

---

## 7. Office & owner management

### 7.1 Office profile (public)
- Name (AR + EN), logo, governorate, wilayat, map pin
- Working hours, languages spoken
- Service specialties (tags: ROP, MoL, MOCIIP, MoH, Nama, etc.) — used by routing engine to prefer relevant offices
- Average rating, completed-معاملات count, response-time p50
- Officer count (not names)

### 7.2 Owner tabs
- **Team**: add/remove officers, assign roles (owner / manager / officer), PKI status, seat count vs plan
- **Wallet**: running balance, nightly settlement log, withdraw to bank
- **Invoices**: AmwalPay subscription history, overage fees
- **KPIs**: requests claimed, completed, CSAT trend, revenue
- **Profile**: logo, hours, specialties, auto-accept rules

### 7.3 Manager tabs
- **Today's board**: live table of in-flight requests and who's handling each
- **Officer performance**: per-officer handling time, CSAT, completion rate
- **SLA heatmap**: requests at risk of breaching 2h / 4h / 24h markers
- **Reassign**: drag a request from officer A to officer B

### 7.4 Roles & permissions (RBAC)

| Role | Claim | Handle | View office stats | Manage officers | Wallet | Admin |
|---|---|---|---|---|---|---|
| Officer | ✓ | ✓ | own only | — | — | — |
| Manager | ✓ | ✓ | ✓ | ✓ | — | — |
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Admin (platform) | — | — | all offices | — | — | ✓ |

---

## 8. Platform admin

- **Office onboarding queue**: CR upload, PKI declarations, owner KYC → approve / reject
- **Catalogue**: read-only view of the 3,417 services, with per-service *override* for required-docs, fees, status (ON/OFF)
- **Disputes**: failed معاملات, refund requests, citizen complaints — workflow to resolve and log
- **Revenue**: MRR, transactions/day, per-office GMV, AmwalPay reconciliation
- **Audit log** (read-only, immutable)
- **Feature flags** (rollout new services, A/B bot prompts)
- **Impersonate office** (support mode, heavily audited)

---

## 9. Data model (core tables, production-grade)

```sql
-- Identity
citizen(id, phone_e164 UNIQUE, name_ar, name_en, civil_id, language_pref, created_at)
office(id, name_ar, name_en, governorate, wilayat, lat, lng, status, plan, wallet_balance_oman_baisa, …)
officer(id, office_id, full_name, email, role, pki_registered, status, auth_uid UNIQUE)

-- Catalogue
service_catalog(id, entity_en, entity_ar, service_name_en, service_name_ar,
                description_en, description_ar, fees_en, fees_ar,
                required_documents jsonb,      -- parsed array
                process_steps jsonb,
                avg_time_text, channels, source_url, is_active)
service_override(service_id, field, value_json)   -- sparse admin overrides

-- Request lifecycle
request(id, citizen_id, service_id, office_id NULL, officer_id NULL,
        status,                              -- see §10
        pinned_office_id NULL,
        governorate,
        priority,
        fee_government_baisa, fee_office_baisa, fee_platform_baisa, fee_total_baisa,
        claimed_at, completed_at, cancelled_at, last_event_at,
        sla_due_at, created_at)
request_document(id, request_id, doc_code, label_en, label_ar,
                 storage_url, mime, size_bytes, quality_score, ocr_json,
                 status,                     -- pending/verified/rejected
                 rejected_reason, uploaded_at)
request_event(id, request_id, actor_type, actor_id, type, payload jsonb, ts)

-- Messaging
message(id, request_id, citizen_id, office_id NULL, officer_id NULL,
        direction,                           -- in | out | bot
        wa_message_id UNIQUE, wa_timestamp,
        body_text, media_id, media_url,
        delivered_at, read_at, created_at)
canned_reply(id, office_id NULL, lang, title, body_template, used_count)

-- OTP relay
otp_window(id, request_id, opened_by_officer_id, opened_at, expires_at, code, consumed_at)

-- Rating
rating(id, request_id, stars, tags, comment, created_at)

-- Payments
subscription(id, office_id, plan, status, amwalpay_customer_id,
             current_period_end, seat_count)
payment(id, office_id NULL, citizen_id NULL, request_id NULL,
        type,                                -- subscription | service_fee | platform_fee
        amount_baisa, amwalpay_ref, status, created_at)
wallet_ledger(id, office_id, kind, amount_baisa, balance_after, ref, ts)

-- Ops
audit_log(id, actor_type, actor_id, action, target_type, target_id, diff_json, ip, ts)
```

All money stored as **integer baisa** (1 OMR = 1000 baisa). No floats ever.

**RLS policies** (illustrative):
```sql
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
CREATE POLICY office_can_read_own ON message FOR SELECT
  USING (office_id = current_setting('app.office_id')::uuid
      OR current_setting('app.role') = 'admin');
CREATE POLICY office_can_read_claimed ON message FOR SELECT
  USING (request_id IN (
     SELECT id FROM request
      WHERE office_id = current_setting('app.office_id')::uuid
        AND status <> 'ready'));
```

---

## 10. Request state machine

```
             ┌──────── cancelled_by_citizen
             │
draft ──▶ collecting ──▶ ready ──▶ claimed ──▶ in_progress ──▶ completed
                  ▲                     │             │
                  └── needs_more_info ──┘             ├─▶ on_hold ──▶ in_progress
                                                     │
                                                     ├─▶ blocked ──▶ escalated (admin)
                                                     │
                                                     └─▶ cancelled_by_office
```

Transitions:
- `ready → claimed`: atomic UPDATE (§3.3). Emits `claimed` event, notifies citizen.
- `claimed → ready` (release): auto-timeout or officer voluntarily releases.
- `claimed → in_progress`: first officer action (doc verified, chat sent, OTP opened, etc.). Happens automatically.
- `in_progress → needs_more_info`: officer asks for a re-upload. Citizen gets a prompt.
- `needs_more_info → in_progress`: citizen responds.
- `any → cancelled_*`: always emits refund entry if fees collected.

Each transition inserts a `request_event` and (optionally) a WhatsApp message.

---

## 11. Subsystem specs

### 11.1 WhatsApp agent

- **Single Meta Cloud API number**, verified business profile `Sanad-AI`.
- **Webhook** at `/api/whatsapp/webhook` — HMAC-verified (`X-Hub-Signature-256`).
- **Idempotency**: unique key on `wa_message_id`.
- **Media pipeline**: on inbound media, fetch once from Meta, stream to object storage (R2 or Supabase Storage), record `media_url`. Meta's 30-day retention is not relied on.
- **Templates**: pre-approved for all outbound messages that start outside the 24h window (status updates, OTP asks, completion receipt).
- **Rate limit** per phone: 10 msgs/min; bot batches its own replies.
- **LLM layer**: **Qwen 3.5** via the existing OmanJobs `qwen_client.py` pattern (same API client, swap model ID), temp 0.2, max 400 tokens.
  - Prompt = [system: persona + guardrails] + [catalogue snippet for matched service] + [state summary] + [last 6 messages].
  - Tool-call only surface: 7 tools listed in §5.
  - Fallback when confidence low: "دعني أتأكد — هل تقصد X أم Y؟" (always offers a way forward).

### 11.2 Service catalogue — the living knowledge base

**The CSV is the seed. The database is the source of truth.** The bot only ever reads from the DB; the CSV is re-imported only on version bumps.

- **Storage**: one-time import of `oman_services_directory.csv` into `service_catalog`. A Node parser splits `RequiredDocumentsAr/En` into an ordered list `[{code, label_ar, label_en, accept, example_url?, optional?}]`. `code` is a stable slug so overrides survive re-imports.
- **DB choice (open question)**: Turso (libSQL) keeps stack parity with OmanJobs and is cheap at our scale — but Turso doesn't support Postgres-style RLS, so multi-office tenancy must be enforced in the app layer (middleware + Prisma interceptors). Postgres+RLS is safer for a multi-tenant financial system. **Recommendation: Postgres for production, Turso for the catalogue-only read replica if we want edge-fast reads.** Final call after week-1 spike.
- **Read path**: the bot reads `service_catalog LEFT JOIN service_override` — approved overrides win without touching the seed.
- **Write path (the "smart FAQ")** — see §11.8. Offices submit corrections; admin approves; the approved override flows into the bot's next response.
- **Versioning**: every row has `version int`, bumped on each approved change. Bot includes the version in the request's `service_snapshot_json` so historical requests always reproduce what the bot actually said at that time.

### 11.3 Realtime dashboard

- Angular 17 + Tailwind. Same stack family as the OmanJobs `webapp/` so devs feel at home.
- Realtime via **Postgres `LISTEN/NOTIFY` → WebSocket gateway** (single Node process). Events: `request.created`, `request.claimed`, `request.released`, `request.completed`, `message.in`, `message.out`, `otp.received`.
- Every connected client joins rooms by: `office:{id}` and `governorate:{name}` (for marketplace).
- Optimistic UI only for local actions (send chat, verify doc); claim is always pessimistic (see §3.3).

### 11.4 Payments — AmwalPay

Two payment flows, fully separated:

1. **Office subscription** (SaaS): monthly/annual. Owner pays via AmwalPay hosted checkout. Webhook flips `subscription.status`. Dunning after 2 failed attempts, grace 7 days, then `office.status='suspended'` (can't claim new work, can complete in-flight).
2. **Citizen fee collection** (per-transaction): when bot quotes total, citizen pays via AmwalPay Pay-by-Token link inside WhatsApp. Webhook marks `payment.paid`, request advances to `ready`. Platform keeps its cut in `wallet_ledger`, remainder credited to `office.wallet_balance` on claim.

Nightly settlement job writes payouts to bank via AmwalPay payouts API (or manual for v1). Every ledger movement has a reconciled `amwalpay_ref`.

### 11.5 Identity & auth

- **Officers** sign in with office email + magic link (or Firebase Auth — reusing what OmanJobs already has). JWT holds `officer_id` and `office_id`; middleware calls `SET LOCAL app.office_id = …` on each request for RLS.
- **Citizens** are identified solely by WhatsApp phone — no app, no password.
- **Admins**: separate `admin_users` table, MFA required.

### 11.6 Audit

Every state change, every officer action, every admin override → one row in `audit_log`, append-only, with a diff JSON. Used for disputes and (eventually) ministry compliance.

### 11.7 Web test chatbot (staging + sales demo)

A `/chat` route on the Angular app that drives the **same backend agent** without going through Meta. Used for:
- **QA**: devs/admins test service flows without burning WhatsApp template quota.
- **Sales**: demoing to a prospective office in a meeting.
- **Officer training**: new hires run sandbox conversations before touching real requests.

Implementation: the WhatsApp webhook handler abstracts over a `ChannelAdapter` interface (`inbound_text`, `inbound_media`, `send_text`, `send_media`). `WhatsAppAdapter` talks to Meta; `WebChatAdapter` pumps messages over WebSocket to the Angular chat UI. The agent, LLM calls, catalogue lookups, and state machine are **identical** — only the transport changes.

The web tester renders the same WhatsApp-style bubbles as the mockup, supports image uploads, and has a `/reset`, `/state`, `/simulate gov_otp 12345` dev-only command palette.

### 11.8 Office-driven catalogue editor ("smart FAQ")

The daily reality: a ministry silently changes what a service requires ("now also need the medical form stamped by the wali"), offices learn the hard way, and our catalogue goes stale. The offices are our ground truth — we give them a structured way to feed corrections back.

**Who edits what**

| Action | Office officer | Office owner | Platform admin |
|---|---|---|---|
| Browse catalogue | ✓ | ✓ | ✓ |
| Flag a service as "outdated" | ✓ | ✓ | ✓ |
| Propose a change (docs, fee, step, condition) | ✓ | ✓ | ✓ |
| Upvote / confirm someone else's proposal | ✓ | ✓ | ✓ |
| Approve & publish | — | — | ✓ |
| Emergency override (instant) | — | — | ✓ (logged) |

**Data model addition**

```sql
service_edit_proposal(
  id, service_id, proposer_officer_id, proposer_office_id,
  field,                                  -- 'required_documents' | 'fees' | 'process_steps' | 'special_conditions'
  current_value_json,                     -- snapshot of what was there at proposal time
  proposed_value_json,
  rationale_text,                         -- why (free-text, required)
  evidence_url NULL,                      -- optional: screenshot/portal link
  status,                                 -- 'open' | 'approved' | 'rejected' | 'superseded'
  reviewed_by_admin_id, reviewed_at,
  created_at
)
service_edit_vote(proposal_id, office_id, direction, created_at)  -- 'confirm' | 'dispute'
```

**Workflow**
1. Officer hits "This doesn't match reality" on a service card → opens a structured edit form per-field.
2. Proposal enters `open`. Other offices see it in the catalogue browser with a "Confirm / Dispute" button.
3. After **3 confirms from 3 distinct offices** or **admin approval**, the proposal becomes `approved` → `service_override` row written → `service_catalog.version` bumped → bot uses the new value immediately.
4. Rejected proposals are kept for audit. Proposer is notified.
5. Admin can fast-track in a genuine emergency (e.g. ministry announcement) — marked `fast_tracked: true` for audit.

**Incentives**: offices with ≥10 approved edits get a "Trusted contributor" badge on their public profile. Small recognition, real network effect.

**Public read-only catalogue page**: `/services/:id` renders the current state + version history + recent proposals. Citizens can read it too (builds trust). SEO bonus — people Googling "متطلبات تجديد رخصة القيادة" land on our pages.

---

## 12. Security & compliance

- **TLS everywhere**, HSTS, CSP on dashboard.
- **PII minimisation**: civil IDs hashed at rest where possible (using last-4 for UI); images encrypted server-side.
- **Object storage** has signed URLs with 10-minute TTL.
- **Key rotation** for AmwalPay, Meta, Qwen — monthly.
- **OTP relay** is scoped: only active 60 seconds per `otp_window` row, only matches `\b\d{4,6}\b` in citizen messages, and only the officer who opened the window sees the code. Out-of-window codes are dropped silently.
- **Consent**: templated authorisation text per service, shown in Arabic & English, acknowledged by citizen in-chat; stored as an immutable `request_event` with the text version hash.
- **Immutable audit log** — append-only, daily hash-chain for tamper evidence (v2).
- **Data residency**: object storage in a region with Middle East presence; Postgres same. Declare in Terms of Service.
- **Rate limits**: per-phone (bot input), per-office (API), per-admin (console).
- **Secret management**: env vars in hosted platform, never in git. `.env.example` only.

---

## 13. Required screens for v1 (production)

| # | Screen | Who |
|---|---|---|
| 1 | Landing + pricing + signup | Public |
| 2 | Office onboarding wizard (KYC, CR upload, PKI declaration) | New owner |
| 3 | Officer inbox — marketplace + claimed kanban | Officer |
| 4 | Request detail (3-pane + shortcuts) | Officer |
| 5 | Manager board (today, SLA, team) | Manager |
| 6 | Owner: Team, Wallet, Invoices, Profile | Owner |
| 7 | Office public profile page | Public (linked in citizen UI) |
| 8 | Platform admin: offices, catalogue, disputes, KPIs, audit | Admin |
| 9 | Citizen-side: small web page for payment + status (deep-linked from WhatsApp) | Citizen |
| 10 | **Service catalogue browser + edit proposals** (smart FAQ, §11.8) | Officers, owners, admin |
| 11 | **Web test chatbot** (§11.7) | Devs, admins, sales demos |

Everything else (manager heatmaps, CSAT dashboards, API access) is v2.

---

## 14. Tech stack (final)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Angular 17 + Tailwind + RxJS | Matches OmanJobs `webapp/`; dev leverage. |
| Realtime | Native WebSocket gateway + Postgres LISTEN/NOTIFY | No extra infra (no Redis for pub/sub in v1). |
| Backend | Node 20 + Express + Prisma | Easy officer hiring, fits AmwalPay & Meta SDKs. |
| DB | **Postgres 15 + RLS** (primary). Turso (libSQL) considered for catalogue edge-reads only. | RLS is the multi-tenant firewall; Turso lacks it so it's not safe as the system-of-record. |
| Object storage | Cloudflare R2 (or Supabase Storage) | Signed URLs, cheap egress. |
| LLM | **Qwen 3.5** via existing OmanJobs `qwen_client.py` (same client, new model ID) | Already working in OmanJobs. |
| Payments | AmwalPay (hosted checkout + webhooks + payouts) | Oman-native, what the user spec'd. |
| Messaging | Meta WhatsApp Cloud API | Business verified, templates. |
| Hosting | Render (API + worker) + Vercel (Angular) | Matches OmanJobs. |
| Auth | Firebase Auth (officer, admin) | Reusing OmanJobs setup. |
| Monitoring | Sentry + Better Stack | Cheap, solid. |
| Queue (v2) | BullMQ on Redis | Only when request volume demands it. |

---

## 15. Subscription plans (launch-ready)

| Plan | OMR/mo | Seats | Requests incl. | Overage per tx | Notes |
|---|---|---|---|---|---|
| **Starter** | 29 | 3 | 200 | 0.5 OMR | Core entities only (ROP, MoL, Civil Status, Nama) |
| **Pro** | 79 | 8 | 1,200 | 0.3 OMR | All 3,417 services, PKI shortcuts, priority queue visibility |
| **Enterprise** | custom | ∞ | ∞ | negotiated | API, SSO, SLA, dedicated manager |

Citizens always pay the gov fee + a fixed platform fee (e.g. 0.5 OMR). Office service fee is set per office and visible in the quote.

---

## 16. Execution roadmap — 12 weeks to national pilot

| Wk | Milestone | Exit criterion |
|---|---|---|
| 1 | Repo scaffold: Angular, Node API, Postgres+RLS, Prisma, auth, CI. CSV → `service_catalog` importer. `ChannelAdapter` abstraction stubbed. | `GET /services/:id` returns parsed docs. |
| 2 | **Web test chatbot** (§11.7) + Qwen 3.5 agent skeleton + 1 service flow (civil ID renewal). ✅ **Done** — [AGENT.md](AGENT.md) documents the v2 unified tool-calling loop (17 tools) with hybrid FTS5 + semantic embeddings + RRF search across the full 3,417-service catalogue. | Can drive a full conversation in the browser. ✅ |
| 3 | Meta WhatsApp webhook + outbound sender + media pipeline + message storage. Same agent code now works on both channels. | Phone round-trip identical to web tester. |
| 4 | Collection flow for **5 launch services**: driver licence, civil ID, CR issuance, passport renewal, vehicle Mulkiya. ✅ **Done** — any slug in the catalogue can now be submitted; the 5 launch codes carry `is_launch=1` and a +0.05 search boost. | Full happy path from phone for all 5. ✅ |
| 5 | Request marketplace + claim/release + realtime WS kanban + 3-pane request detail + canned replies + shortcuts bar (portal link + OTP relay). | Officer handles a sandbox request end-to-end; two offices race-claim correctly. |
| 6 | Office onboarding + owner/manager views + wallet skeleton. | A new office self-signs up and goes live. |
| 7 | AmwalPay integration — subscription + citizen fee + webhooks + wallet ledger. | Real charge and real payout traced end-to-end. |
| 8 | **Catalogue browser + edit-proposal workflow** (§11.8) + admin approval queue. | An office can propose a required-docs fix and see it reflected in the bot within minutes of approval. |
| 9 | Admin console v1: offices, catalogue approvals, disputes, audit, KPIs. | Admin can onboard an office in <10 min. |
| 10 | **Pilot: 3 offices, 2 governorates, 30 officers** for 1 week. Instrumentation only. | 300 real معاملات completed. |
| 11 | Fix pilot findings; add CSAT, dispute intake, SLA warnings. | Pilot NPS ≥ 9, CSAT ≥ 4.5. |
| 12 | **Public launch** in Muscat & Al Batinah. Paid acquisition. | Onboarding self-serve, ≥ 10 paying offices. |

Post-launch (v2, months 4–6): catalogue override editor, manager heatmaps, WhatsApp simulator for demos, Qwen-VL document validation, API access for enterprise, Nama/utility bundles.

---

## 17. KPIs

**Product health**
- Citizen completion rate (started → completed) > 85%
- P50 end-to-end time per service < listed `AvgTimeTaken`
- Marketplace claim p50 < 5 min
- Rejected-document rate < 15%

**Business**
- Paying offices, MRR, ARPO
- Transactions/office/day
- Platform fee revenue/day
- CSAT (weighted avg, last 1,000 transactions)

**Ops**
- Webhook error rate < 0.1%
- API p95 latency < 300 ms
- WhatsApp delivery success > 99%

---

## 18. Known risks and mitigations

| Risk | Mitigation |
|---|---|
| **Meta suspends the WhatsApp number** | Two verified business numbers, DNS-style failover; templates pre-approved; strict opt-in logging. |
| **A bad office hurts the brand** | Rating visible publicly; auto-suspend after CSAT < 3.5 on 20 transactions; appeals process. |
| **Citizens forward OTPs to other offices** | Window-scoped (§12); only the opening officer's request accepts it. |
| **Gov portal changes (e.g. ROP UI update)** | We never automate portals — officer drives manually. Only impact is a deep-link that needs updating, which is a 1-line admin edit. |
| **Catalogue goes stale silently** | Office-driven edit proposals (§11.8) + 3-office confirmation rule surface ministry changes within days, not months. |
| **AmwalPay outage** | Queue unpaid requests; mark as `pending_payment`; retry daily; manual reconciliation tool in admin. |
| **LLM hallucinates a fee** | Fee is never generated by LLM — always read from `service_catalog JOIN service_override`. LLM's `quote_fee` tool just formats. |
| **Catalogue goes stale** | Quarterly diff job against the public services directory; admin review queue for changed services. |
| **Officer leaks citizen data** | Per-officer audit trail of every request view; watermark on doc thumbnails with officer email; owner can revoke access instantly. |

---

## 19. What we are explicitly *not* building

- Automating gov portals (legal + technical minefield).
- **Any PKI card integration.** Authentication on gov portals is the citizen's phone + OTP, relayed through the bot. That's the whole mechanism.
- A citizen mobile app (WhatsApp is the app).
- A marketplace for freelance "Sanad agents" (licensed offices only — ministry will require this).
- Per-office WhatsApp numbers.
- Custom LLM training. Qwen 3.5 as-a-service is enough.

---

## 20. What I need from you next

1. Confirm the **routing model** (open marketplace + citizen pin fallback, §3) is the right call.
2. Confirm the **privacy wall** cut (§4) — OK to expose masked card pre-claim?
3. Confirm **one national WhatsApp number** (we'll procure + verify).
4. Confirm **pricing** (29 / 79 / custom OMR) or adjust.
5. Pick the **5 launch services** (§16 wk-4): I suggest driver licence renewal, civil ID renewal, CR issuance, passport renewal, vehicle Mulkiya renewal.
6. Pick **2 pilot governorates** for week 10.
7. Confirm **Postgres as primary DB** (with Turso only as a catalogue read replica if we want it). Week-1 spike can prove either way.
8. Confirm the **3-office confirmation rule** for catalogue edits (§11.8) — or prefer admin-only approval.

Once these are locked, I scaffold the repo and we start wk-1.
