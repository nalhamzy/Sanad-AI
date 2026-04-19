# Sanad-AI — Design Blueprint

A WhatsApp-first workflow and a web dashboard that lets Sanad offices in Oman handle citizen transactions (معاملات) end-to-end without the citizen ever having to walk into the office.

---

## 1. Context

Sanad Service Centers are SME-run offices (913 of them across the Sultanate, processing over 1.2M transactions a year) that act as the last-mile for 370+ government services — medical forms, business registration, work permits, ROP transactions, Nama utilities, Ministry of Labour, Ministry of Housing, etc. Today citizens physically visit a Sanad office, bring paper/photos of their documents, and the officer types the transaction into the relevant government portal.

The dataset in `oman_services_directory.csv` (3,417 services, 50 government entities) is the authoritative catalogue of services, each with structured metadata we can exploit:

- `ServiceNameAr/En`, `EntityAr/En`, `EntityDepartmentAr/En`
- `DescriptionAr/En`, `SpecialConditionsAr/En`
- `RequiredDocumentsAr/En`  ← the heart of the bot's collection flow
- `FeesAr/En`, `PaymentMethod`
- `ProcessStepsAr/En`, `NumSteps`, `AvgTimeTakenAr/En`
- `Beneficiary` (G2C / G2B / G2G / G2E)

The top entities by service count are: Ministry of Agriculture & Fisheries (361), MTCIT (245), ROP (233), Judiciary (184), Ministry of Information (163), MOCIIP (146), Civil Aviation Authority (146), Ministry of Social Development (121), Ministry of Health (103).

---

## 2. The Core Idea

**Split the transaction into two halves:**

1. **Collection half — WhatsApp.** A bilingual (Arabic-first) WhatsApp agent talks to the citizen, identifies the service they need from the catalogue, and collects every required document, fee confirmation, and consent. Because WhatsApp is where Omani citizens already are, there is zero onboarding friction.
2. **Execution half — Sanad dashboard.** When the package is complete, the request lands in a common web dashboard that any subscribed Sanad office can pick up. The officer handles only the government-portal part (PKI login, form filling, OTP submission) and communicates with the citizen through the same dashboard (which relays messages over WhatsApp).

This cleanly separates the slow, back-and-forth work (collecting documents from a distracted citizen) from the skilled work (navigating ROP, Invest Easy, Mala'a, Maktabi, etc.) and lets one officer run many requests in parallel.

---

## 3. Personas

| Persona | Where | Primary goal |
|---|---|---|
| **Citizen / Resident** | WhatsApp | Get a transaction done without driving to a Sanad office |
| **Sanad Officer** | Dashboard (Angular SPA) | Handle as many requests as possible, communicate only when needed |
| **Office Owner** | Dashboard, manager view | Track officer productivity, revenue, SLAs |
| **Admin (platform)** | Admin console | Onboard offices, pricing, catalogue updates, overall health |
| **Government portal** | External (ROP, Invest Easy, Maktabi, Tanfeeth, etc.) | Kept exactly the same — the officer still logs in with their PKI/credentials |

---

## 4. End-to-End Happy Path

```
Citizen → "مرحبا، أبي أجدد رخصة سياقة"
Bot     → detects intent → searches catalogue → confirms "تجديد رخصة القيادة — ROP"
Bot     → lists exactly the RequiredDocuments from the CSV + fee + avg time
Bot     → collects each item in order ("أرسل صورة البطاقة الشخصية", "أرسل الفحص الطبي", …)
Bot     → runs image-quality + OCR checks on each file via Qwen-VL
Bot     → quotes total fee (gov fee + Sanad service fee) and asks for consent
Bot     → drops the packaged request into the "New" column of the dashboard
Office  → officer claims it → opens request → starts ROP portal in a shortcut popup
Office  → when portal asks for OTP, officer clicks "Request OTP from citizen"
Bot     → "يرجى إرسال كود التحقق الذي وصلك من ROP"
Citizen → sends 6-digit code → bot parses it → autofills OTP field in officer's view
Office  → submits on the portal → uploads receipt PDF → marks request Completed
Bot     → pushes receipt + "✅ تم إنجاز معاملتك" to citizen
System  → invoices Sanad office per transaction (AmwalPay subscription) and collects CSAT
```

---

## 5. Feature Map

### 5.1 WhatsApp Agent (Citizen Side)

- **Intent & service matching** via Qwen (same pattern as the OmanJobs project). Uses `ServiceNameAr/En + Description + SpecialConditions` as the retrieval corpus. Disambiguates between similar services (e.g. "تجديد رخصة مركبة" vs "تجديد رخصة سياقة").
- **Document collection engine** that parses `RequiredDocumentsAr/En`, splits into atomic items, and walks the user through them one-by-one, with Arabic and English labels and a friendly example image.
- **Live validation**: blurry image detection, orientation check, file-type check, expiry-date OCR (passport, civil ID), face detection for personal photos, readability score for scanned letters.
- **Fee quoting** pulled from `FeesAr/En` + office service fee (set by each Sanad office) + AmwalPay processing fee. Shows total *before* starting.
- **Consent and e-signature** — a lightweight authorisation text the citizen approves before the officer acts on their behalf.
- **Status & tracking** — `حالة معاملتي` returns the live status; also proactive push notifications at every state change.
- **Cancel / pause** — citizen can cancel at any time before "In progress", and request pause after.
- **Forwarded OTP / PKI codes** — citizen can forward any OTP they receive from a gov portal; bot routes it to the officer handling the request.
- **CSAT survey** after completion, 5-star + one-tap reasons.

### 5.2 Sanad Officer Dashboard (Angular + Tailwind)

- **Inbox / Kanban** with five columns: **New · Claimed · Waiting on Citizen · In Progress · Done** (also a table mode for heavy days). Filters by service, entity, SLA, value, my-only.
- **One-click claim** (معاملة) and auto-release if idle > X minutes.
- **Request detail view** — the main workspace, a three-pane screen:
  - Left: request summary (citizen, service, entity, fee, process steps, timeline)
  - Middle: documents gallery with zoom/rotate/OCR-overlay; each doc has "Reject and request again", "Mark verified", "Replace"
  - Right: chat with the citizen over WhatsApp (live, with quick replies like "Please resend the ID in higher resolution", "Payment received", all prebuilt bilingual)
- **Shortcuts bar** — action buttons that save the officer taps:
  - **PKI Login Helper** — opens the target gov portal, pre-fills civil ID, waits for the officer's PKI card
  - **OTP Relay** — one click → "Request OTP from citizen" → when the code arrives from the bot, it auto-copies to clipboard and pastes into the focused field
  - **Fee Copy** — copies the quoted amount
  - **Process Steps Panel** — the CSV's `ProcessStepsEn` rendered as a checklist the officer ticks off
- **Status actions** — Hold (with reason), Cancel (with reason), Send to colleague, Escalate to manager, Complete (with receipt upload).
- **Cancellation & long-hold handling** — auto-notify citizen if status hasn't changed for N hours; auto-escalate to office manager on SLA breach; one-click "Cannot complete" with reason codes that get surfaced to admin.
- **My stats** — a personal widget on every page: today's handled count, avg handling time, CSAT, earnings.

### 5.3 Office Manager Sub-view

- Team roster, today's load per officer, SLA heatmap, revenue this month, refund list, appeals.
- Assign territory/services to officers (some officers only handle Ministry of Labour, etc.).

### 5.4 Platform Admin Console

- **KPIs**: active offices, officers online, requests/day, completion rate, P95 handling time, AmwalPay MRR, failed-payment rate.
- **Top services / top entities** pulled from the same request log.
- **Catalogue manager** — refresh from the CSV, edit per-service required docs, toggle services ON/OFF per subscription tier.
- **Office onboarding** — KYC, PKI registration, commercial registration upload, approval queue.
- **Subscription management** — plans, coupons, dunning.
- **Audit log** — every officer action on every request (immutable).

### 5.5 Subscription (AmwalPay)

Three tiers, all charged through AmwalPay (card + muscat-local wallets):

| Tier | Per month | Seats | Requests | Extras |
|---|---|---|---|---|
| **Starter** | 29 OMR | 2 officers | 250/month | Core services only |
| **Pro** | 79 OMR | 6 officers | 1,200/month | All 3,417 services, PKI relay, priority support |
| **Enterprise** | Custom | Unlimited | Unlimited | API access, SSO, dedicated success manager |

Overage billed at a per-transaction rate. Citizens' fees are collected up-front via AmwalPay; the platform takes a fixed cut and settles the remainder to the office nightly.

### 5.6 WhatsApp Webhook

Standard Meta WhatsApp Cloud API inbound → Node webhook → queue (BullMQ on Redis) → Qwen worker → state machine → WhatsApp outbound. Idempotency on `message.id`. Media files pulled via the media endpoint and stored in S3-compatible object storage (e.g. Oman-local). Signed URLs passed to the dashboard.

### 5.7 Qwen Integration

- **Intent & service match**: embedding index over the services corpus (Qwen-embed), top-5 semantic + BM25 hybrid, then a Qwen-chat re-ranker.
- **Document understanding**: Qwen-VL for OCR of Civil ID, passport, CR, medical reports; extract fields like ID number, expiry, name-in-Arabic, name-in-English.
- **Reply generation**: Arabic dialect and MSA toggles; style guide pinned in the system prompt.
- **Tool calls**: `get_service`, `record_document`, `quote_fee`, `handoff_to_officer`, `relay_otp`, `get_status`, `cancel`.
- **Guardrails**: the bot never "completes" a government transaction — it only collects. Execution always requires a human Sanad officer logged in with their own PKI.

---

## 6. Architecture

```
┌────────────┐           ┌──────────────────┐            ┌────────────────┐
│ WhatsApp   │  webhook  │   Node/Express   │  enqueue   │   Redis/Bull   │
│ Cloud API  │──────────▶│   webhook svc    │───────────▶│   job queue    │
└────────────┘           └──────────────────┘            └──────┬─────────┘
                                                                │
                                   ┌────────────────────────────┴────────────┐
                                   ▼                                         ▼
                          ┌─────────────────┐                      ┌──────────────────┐
                          │  Qwen workers   │                      │  Document worker │
                          │  (chat + VL)    │                      │  (OCR, quality)  │
                          └────────┬────────┘                      └────────┬─────────┘
                                   ▼                                         ▼
                                ┌──────────────────────────────────────────────┐
                                │               Postgres (primary)             │
                                │  users · services · requests · messages ·    │
                                │  documents · officers · offices · payments   │
                                └───────────────┬──────────────────────────────┘
                                                │
                  ┌─────────────────────────────┼──────────────────────────┐
                  ▼                             ▼                          ▼
         ┌────────────────┐         ┌────────────────────┐      ┌─────────────────┐
         │ Angular SPA    │         │  Admin console     │      │ AmwalPay webhook│
         │ (officer dash) │         │  (Angular)         │      │ (subscription)  │
         └────────────────┘         └────────────────────┘      └─────────────────┘
```

Stack: **Node 20 + Express + Prisma**, **Postgres**, **Redis + BullMQ**, **Angular 17 + Tailwind**, **Qwen via OmanJobs-style API client**, **S3-compatible object storage**, **AmwalPay REST/Webhook**, **Meta WhatsApp Cloud API**.

---

## 7. Data Model (core tables)

- `citizen` — phone, name, civil_id (optional), language_pref, consent flags
- `office` — name, governorate, plan, owner_id, service_fee_default, pki_ready
- `officer` — name, email, office_id, role, civil_id
- `service_catalog` — mirrors the CSV row + parsed `required_documents_list jsonb`
- `request` — citizen_id, service_id, office_id, officer_id, status, priority, sla_due_at, government_fee, service_fee, platform_fee, total
- `request_document` — request_id, label, url, ocr_json, quality_score, status (pending/verified/rejected)
- `request_event` — request_id, actor, type, payload (immutable timeline)
- `message` — request_id, direction (in/out), channel (whatsapp), body, media_url, wa_message_id
- `otp_relay` — request_id, code, received_at, consumed_at
- `subscription` — office_id, plan, status, amwalpay_customer_id, current_period_end
- `payment` — request_id, type (service/fee), amount, amwalpay_ref, status
- `audit_log` — actor, action, target, diff, ip, ts

---

## 8. State Machine for a Request

```
         ┌─ cancelled (by citizen)
         │
draft ──▶ awaiting_docs ──▶ ready ──▶ claimed ──▶ in_progress ──▶ completed
                    ▲                        │
                    └─── needs_more_info ◀───┘
                                             │
                                             ├──▶ on_hold ──▶ in_progress
                                             │
                                             └──▶ blocked ──▶ escalated
```

Each transition emits a `request_event`, an audit entry, and (where relevant) a WhatsApp message to the citizen.

---

## 9. Screens to Build

1. **Public landing + signup** (for Sanad offices) — marketing + AmwalPay checkout
2. **Officer inbox (Kanban + Table)** — main daily workspace
3. **Request detail** — three-pane: summary · docs · chat + shortcuts bar
4. **Manager view** — team, SLA, revenue
5. **Admin dashboard** — platform KPIs, top services, revenue, offices
6. **Service catalogue browser** — explore the 3,417 services (for onboarding)
7. **WhatsApp chat simulator** — shows the citizen's side (useful for sales demos)
8. **Settings** — office profile, officers, billing, WhatsApp number, PKI

The HTML mockup (`sanad-ai-mockup.html`) demonstrates screens 1, 2, 3, 5, and 7 with a sidebar to navigate between them, bilingual AR/EN toggle, and Tailwind styling that matches the Angular app you'll build next.

---

## 10. Build Plan (for when we move to code)

1. Scaffold Angular SPA + Node API + Postgres + Redis; copy Qwen client and subscription skeleton from the OmanJobs repo.
2. Import `oman_services_directory.csv` into `service_catalog`; write a parser that splits `RequiredDocumentsAr/En` into an ordered list.
3. WhatsApp webhook + inbound queue + outbound sender; echo test.
4. Document collection state machine + S3 storage + Qwen-VL validation.
5. Officer dashboard: inbox → request detail → chat → shortcuts. Ship this as "v1 internal" and have a Sanad office use it for one day.
6. AmwalPay integration (subscription + per-request fee collection) with webhooks.
7. Admin console + stats rollups.
8. PKI relay + OTP relay polish; officer productivity shortcuts.
9. CSAT + disputes + refunds.
10. Multi-office, multi-region rollout.

---
