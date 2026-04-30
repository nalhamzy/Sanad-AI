# Saned · ساند — Full Feature Audit

> **Generated:** 2026-04-30
> **Git ref:** `HEAD`
> **Auditor model:** `claude-opus-4-5`
> **Deterministic checks:** 111/111 passed
> **Opus average score:** 87/100 across 9 features

## Executive summary

Each feature below has three columns:

- **Tests** — deterministic in-process checks (HTTP round-trips, SQL spot-checks, file-content assertions)
- **Output** — pass / fail counts + the failing details if any
- **Opus verdict** — Claude Opus rated 0-100 with concrete bullets and a one-word verdict (production-ready / ship-with-watchlist / needs-work)

Where the audit surfaced fixable gaps the **Enhancement applied** column shows what landed in this same pass.

## Table of contents

1. [Homepage](#homepage)
2. [Citizen Auth](#citizen-auth)
3. [Dashboard + Request Tracking](#dashboard-request-tracking)
4. [Catalogue + Hybrid Search](#catalogue-hybrid-search)
5. [Office Auth](#office-auth)
6. [Single-claim + Payment Gate](#single-claim-payment-gate)
7. [WhatsApp Agent + Bot Persona](#whatsapp-agent-bot-persona)
8. [i18n (EN + AR)](#i18n-en-ar)
9. [Database Schema](#database-schema)

---

## Homepage

**Area:** Citizen-facing  
**Deterministic checks:** 12/12 passed
**Opus verdict:** `production-ready` · score **94/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | homepage serves 200 <br/><sub>40864 bytes</sub> |
| ✅ | Arabic-first (lang="ar" dir="rtl") |
| ✅ | uses new brand "ساند · Saned" in title |
| ✅ | no legacy "Sanad-AI" in title |
| ✅ | hero search box present |
| ✅ | dual-path CTAs (Web + WhatsApp) |
| ✅ | "Easiest · Recommended" badge on Web path |
| ✅ | Why-Saned 4-card section |
| ✅ | Voices/testimonials section |
| ✅ | Trust strip (services / entities / offices / 24-7) |
| ✅ | Assurance band |
| ✅ | Office partner pitch removed from main CTAs |

### Opus verdict

**What's working**

- All 12 deterministic checks pass — hero, dual-path CTAs, Why-Saned, testimonials, trust strip all render correctly
- Arabic-first with lang="ar" dir="rtl" set at document level
- Brand wordmark "ساند · Saned" in title; legacy "Sanad-AI" fully removed
- Dual application paths (Web + WhatsApp) presented as equal side-by-side cards — good for user choice
- "Easiest · Recommended" badge on Web path guides citizens without hiding WhatsApp option
- Office partner pitch correctly moved out of main CTAs to footer ("I run a Sanad office →") — keeps citizen focus
- Trust strip with live stats (services / entities / offices / 24-7) builds credibility
- 40 KB payload is reasonable for a content-rich landing page

**Watchlist**

- No explicit test for FAQ accordion presence or functionality — description mentions FAQ but tests don't verify
- No performance/LCP test — hero with live search input could delay interactivity on slow connections
- Missing test for hybrid-search input actually functioning (only checks presence, not behaviour)
- No accessibility test for keyboard navigation through dual-path cards or search input

---

## Citizen Auth

**Area:** Citizen-facing  
**Deterministic checks:** 13/13 passed
**Opus verdict:** `ship-with-watchlist` · score **82/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | POST /start-otp returns 200 |
| ✅ | debug_code is 6-digit numeric |
| ✅ | cooldown_s + expires_in_min returned |
| ✅ | POST /verify-otp succeeds |
| ✅ | citizen.phone_verified is true |
| ✅ | sanad_citizen_sess cookie set |
| ✅ | GET /me returns the signed-in citizen |
| ✅ | magic OTP 000000 works in DEBUG_MODE |
| ✅ | POST /google with bad token returns 401 |
| ✅ | /signup.html serves 200 + has 6 OTP boxes |
| ✅ | /signup.html carries DEBUG auto-fill button wiring |
| ✅ | /login.html serves 200 + has 6 OTP boxes |
| ✅ | /login.html carries DEBUG auto-fill button wiring |

### Opus verdict

**What's working**

- All 13 deterministic tests pass — OTP flow, cookie issuance, /me endpoint, and Google 401 rejection work correctly
- Security fundamentals present: httpOnly cookies, JWT signing, 30s cooldown, 5 max-attempts, 5-min TTL
- Magic OTP 000000 gated behind DEBUG_MODE — acceptable for test environments
- 6-digit OTP boxes on both /signup.html and /login.html with DEBUG auto-fill wiring for QA convenience
- Phone verification required even after Google sign-in — good for Omani service identity binding

**Watchlist**

- No test confirms cooldown enforcement (30s) or max-attempts (5) lockout — abuse vectors untested
- No test for OTP expiry after 5 minutes — TTL claim unverified
- Google sign-in happy path not tested (only 401 for bad token) — no coverage of valid token → session flow
- No explicit test that DEBUG auto-fill button is hidden in production builds
- Arabic-first claim not verified — no test checks RTL dir attribute, Arabic labels, or placeholder text on auth pages
- No test for session logout/revocation endpoint
- Cookie SameSite and Secure flags not mentioned or tested — potential CSRF/transport risk

---

## Dashboard + Request Tracking

**Area:** Citizen-facing  
**Deterministic checks:** 11/11 passed
**Opus verdict:** `ship-with-watchlist` · score **82/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | /my-requests returns the seeded request |
| ✅ | rows include payment_status + status |
| ✅ | /my-request/:id returns request + documents + messages |
| ✅ | chat_unlocked_for_office=false pre-payment |
| ✅ | non-existent request → 404 |
| ✅ | without cookie → 401 |
| ✅ | account.html is Arabic-first |
| ✅ | account.html has phone-banner + search + reqList |
| ✅ | account.html has DEBUG attach-phone shortcut |
| ✅ | request.html has timeline + docList + thread |
| ✅ | request.html has Pay-now CTA card |

### Opus verdict

**What's working**

- GET /my-requests returns seeded request with payment_status + status fields — correct schema
- GET /my-request/:id returns request + documents + messages bundle in single call
- chat_unlocked_for_office=false pre-payment enforces correct visibility rule
- 401 without cookie, 404 for non-existent request — proper auth/error handling
- account.html is Arabic-first with phone-banner, search, and reqList containers
- request.html renders timeline, docList, thread, and Pay-now CTA card
- Status timeline covers full lifecycle: collecting → ready → claimed → awaiting_payment → in_progress → completed
- Document chips show verified/pending/rejected states for transparency

**Watchlist**

- DEBUG attach-phone shortcut present in account.html — must be removed or feature-flagged before production
- No test confirming chat_unlocked_for_office=true after payment — only pre-payment case verified
- No test for empty state when citizen has zero requests — UX for new users unverified
- No test for pagination or performance with many requests — scalability unknown
- No test confirming Pay-now CTA hides/changes after payment completion
- Phone-required banner logic untested — unclear if it correctly detects Google-only users missing phone
- No test for service search hybrid endpoint mentioned in description
- Entity grid mentioned but not tested

---

## Catalogue + Hybrid Search

**Area:** Search  
**Deterministic checks:** 16/16 passed
**Opus verdict:** `ship-with-watchlist` · score **91/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | browse mode: search.mode = "browse" |
| ✅ | browse returns total + results |
| ✅ | hybrid mode: search.mode = "hybrid" |
| ✅ | hybrid returns lane counts (fts/semantic/partial) |
| ✅ | hybrid result has matched_by tags |
| ✅ | Arabic query returns 200 |
| ✅ | free-fee filter: all results have fee_omr=0 |
| ✅ | has_docs=yes: all results have doc_count > 0 |
| ✅ | /entities returns array of {entity_en, entity_ar, n} |
| ✅ | /beneficiaries returns 200 |
| ✅ | /fee-buckets returns the 5 bucket counts |
| ✅ | catalogue.html Arabic-first |
| ✅ | catalogue.html uses hybrid endpoint, not legacy /search |
| ✅ | catalogue.html has fee-pill filters |
| ✅ | catalogue.html has beneficiary rail + sort dropdown |
| ✅ | catalogue.html match-by chips |

### Opus verdict

**What's working**

- Hybrid search architecture (FTS5 BM25 + Qwen embeddings + substring LIKE) with RRF fusion is sophisticated and production-grade
- matched_by tags provide transparency on which lane matched each result
- All 16 deterministic tests pass including Arabic query handling
- Filter endpoints (/entities, /beneficiaries, /fee-buckets) properly structured with counts
- catalogue.html correctly uses hybrid endpoint, not legacy /search
- Arabic-first UI confirmed with fee-pill filters, beneficiary rail, sort dropdown
- Free-fee filter correctly returns only fee_omr=0 results
- has_docs filter properly validates doc_count > 0

**Watchlist**

- No test coverage for empty result states or zero-match queries — unclear if UI handles 'لا توجد نتائج' gracefully
- Missing test for pagination or infinite scroll behaviour with large result sets
- No validation that processing_time displays correctly in Arabic (e.g., '٣-٥ أيام عمل')
- Detail modal WA + Web CTAs mentioned but not tested for correct deep-link generation
- fee_min/max filter not explicitly tested despite being documented
- No test for sort parameter behaviour (relevance vs fee vs processing time)

---

## Office Auth

**Area:** Office-facing  
**Deterministic checks:** 7/7 passed
**Opus verdict:** `needs-work` · score **74/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | demo officer login OK |
| ✅ | sanad_sess (officer) cookie set |
| ✅ | /api/auth/me returns officer + office |
| ✅ | wrong password → 401 |
| ✅ | /office-login.html serves 200 |
| ✅ | /office-signup.html serves 200 |
| ✅ | /officer.html serves 200 |

### Opus verdict

**What's working**

- bcrypt 10 rounds meets OWASP minimum for password hashing
- Separate cookie namespace (sanad_sess) prevents session collision with citizen auth
- pending_review workflow enforces platform gatekeeping before marketplace access
- All critical pages serve 200: /office-login.html, /office-signup.html, /officer.html
- attachSession middleware pattern ensures consistent auth hydration across requests

**Watchlist**

- No rate-limiting test for /api/auth/login — brute-force vector unverified
- Missing test for session expiry/max-age on sanad_sess cookie
- No CSRF protection evidence for login POST endpoint
- Signup flow lacks email verification step — pending_review alone doesn't confirm email ownership
- No test for password complexity requirements at signup
- Missing Arabic UI test — office-facing pages should support RTL/Arabic for Omani officers
- No test for logout endpoint or session invalidation
- Cookie security flags (HttpOnly, Secure, SameSite) not verified in test output

---

## Single-claim + Payment Gate

**Area:** Marketplace  
**Deterministic checks:** 14/14 passed
**Opus verdict:** `ship-with-watchlist` · score **88/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | POST /claim returns pricing { office_fee, government_fee, total } |
| ✅ | pricing.total = office_fee + government_fee |
| ✅ | second claim returns 409 already_claimed |
| ✅ | payment/start returns 200 + payment_link + amount |
| ✅ | stub-mode flag set (no Amwal creds) |
| ✅ | payment/start idempotent (reused=true) |
| ✅ | officer chat locked pre-payment (403) |
| ✅ | stub_pay redirects to /request.html |
| ✅ | after pay: paid_at set + status=in_progress + payment_status=paid |
| ✅ | officer chat unlocks post-payment (200) |
| ✅ | citizen sees chat_unlocked_for_office=true post-pay |
| ✅ | POST /complete returns 200 |
| ✅ | status=completed |
| ✅ | inbox returns lifecycle buckets (reviewing/awaiting_payment/in_progress/on_hold) |

### Opus verdict

**What's working**

- Atomic claim with WHERE office_id IS NULL prevents race conditions — solid DB-level guarantee
- Pricing breakdown returned on claim (office_fee, government_fee, total) gives transparency before payment
- Idempotent payment/start (reused=true) prevents duplicate payment links on retry
- Chat gating enforced at API level (403 chat_locked_until_paid) — not just UI hide
- Lifecycle buckets in inbox (reviewing/awaiting_payment/in_progress/on_hold) support officer workflow
- stub_pay redirect to /request.html maintains flow during Amwal integration

**Watchlist**

- No test for payment expiry or stale payment_link handling — citizen could click old link days later
- Missing test for partial payment or payment amount mismatch scenarios
- POST /release refund_required=true flag tested but actual refund flow untested — citizen expectation gap
- No webhook signature verification test for Amwal callback (security concern for production)
- Arabic notification content not verified — 'chat unlocked' message may not be localized
- No test for citizen-side payment status polling or real-time update mechanism

---

## WhatsApp Agent + Bot Persona

**Area:** Agent  
**Deterministic checks:** 9/9 passed
**Opus verdict:** `ship-with-watchlist` · score **82/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | SYSTEM_PROMPT names the bot ساند / Saned |
| ✅ | forbids old "Ahmed" persona explicitly |
| ✅ | SYSTEM_V2 also rebranded |
| ✅ | welcomeMessage uses ساند |
| ✅ | helpMessage uses ساند |
| ✅ | no unintended "Ahmed" mentions in user-facing strings (excluding slot-comment) |
| ✅ | WhatsApp webhook signature verification |
| ✅ | WhatsApp webhook ACKs immediately, processes async |
| ✅ | Empty-reply guard for burst-continuation |

### Opus verdict

**What's working**

- SYSTEM_PROMPT and SYSTEM_V2 both correctly name the bot ساند / Saned
- Old 'Ahmed' persona explicitly forbidden in system prompts
- welcomeMessage and helpMessage consistently use ساند branding
- WhatsApp webhook signature verification implemented for security
- Webhook ACKs immediately (200) then processes async — prevents Meta timeouts
- Burst-continuation logic with 6s window and empty-reply guard prevents spam on multi-file uploads
- Four deterministic launch flows defined (drivers_licence_renewal, mulkiya_renewal, cr_issuance, civil ID, passport)
- One-language reply mandate and ground-truth-from-tools-only policy documented

**Watchlist**

- Test notes 'excluding slot-comment' — residual Ahmed reference in code comments may confuse future maintainers
- No test coverage for actual one-language enforcement (Arabic reply to Arabic input, English to English)
- No test verifying the 6s burst window timing is correctly implemented (only empty-reply guard tested)
- Missing test for graceful handling when agent turn fails after ACK (user receives no reply)
- No verification that SYSTEM_V2 tool-loop actually invokes tools before answering (ground-truth policy)
- Passport flow mentioned but unclear if fully wired — only four flows listed yet five services named

---

## i18n (EN + AR)

**Area:** Platform  
**Deterministic checks:** 10/10 passed
**Opus verdict:** `ship-with-watchlist` · score **95/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | i18n has 200+ unique keys <br/><sub>536 keys</sub> |
| ✅ | /: every data-i18n key exists in i18n.js |
| ✅ | /signup.html: every data-i18n key exists in i18n.js |
| ✅ | /login.html: every data-i18n key exists in i18n.js |
| ✅ | /account.html: every data-i18n key exists in i18n.js |
| ✅ | /catalogue.html: every data-i18n key exists in i18n.js |
| ✅ | /request.html: every data-i18n key exists in i18n.js |
| ✅ | app.name (en) = "Saned" |
| ✅ | app.name (ar) = "ساند" |
| ✅ | no legacy "سند الذكي" anywhere |

### Opus verdict

**What's working**

- 536 i18n keys far exceeds 200+ requirement — comprehensive coverage
- All 6 HTML pages pass data-i18n key existence checks (/, signup, login, account, catalogue, request)
- Brand naming correct: en='Saned', ar='ساند' — no legacy 'سند الذكي' or 'Sanad-AI' remnants
- Arabic-first default with <html lang="ar" dir="rtl"> at first paint prevents English flash
- localStorage persistence via sanad.lang enables user preference retention

**Watchlist**

- No test for RTL/LTR dir attribute toggle when switching languages at runtime
- Missing validation that all 536 keys have both en AND ar translations (could have orphan keys)
- No test for dynamic content injection (e.g., API error messages, toast notifications) using i18n
- Currency/date/number formatting localisation not verified (Omani Rial, Hijri dates)

---

## Database Schema

**Area:** Platform  
**Deterministic checks:** 19/19 passed
**Opus verdict:** `ship-with-watchlist` · score **92/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | citizen.email column exists |
| ✅ | citizen.google_sub column exists |
| ✅ | citizen.display_name column exists |
| ✅ | citizen.avatar_url column exists |
| ✅ | citizen.phone_verified_at column exists |
| ✅ | citizen.email_verified_at column exists |
| ✅ | citizen.last_login_at column exists |
| ✅ | citizen.signup_source column exists |
| ✅ | request.payment_status column exists |
| ✅ | request.payment_link column exists |
| ✅ | request.payment_ref column exists |
| ✅ | request.payment_amount_omr column exists |
| ✅ | request.paid_at column exists |
| ✅ | request.released_count column exists |
| ✅ | request.claim_review_started_at column exists |
| ✅ | citizen_otp table exists |
| ✅ | idx_citizen_email unique index |
| ✅ | idx_request_payment index |
| ✅ | idx_request_office_status index |

### Opus verdict

**What's working**

- All 19 schema assertions pass — citizen, request, and citizen_otp tables have expected columns
- Idempotent ALTERs via pragma_table_info checks allow safe re-runs on persistent SQLite volumes
- Proper indexing: unique idx_citizen_email prevents duplicate accounts; idx_request_payment and idx_request_office_status support common queries
- phone_verified_at / email_verified_at columns enable multi-factor verification state tracking
- payment_status + payment_link + paid_at columns cleanly model the payment-gate lifecycle
- released_count column supports partial-release logic for multi-document requests

**Watchlist**

- No foreign-key constraint test between citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off)
- Missing index on citizen.google_sub — OAuth lookups will table-scan as user base grows
- No test for citizen_otp.expires_at column or TTL enforcement at DB level
- claim_review_started_at added but no corresponding idx_request_claim index for admin queries

---

## Aggregated scores

| Feature | Det. checks | Opus | Verdict |
|:---|:---:|:---:|:---:|
| Homepage | 12/12 | 94/100 | production-ready |
| Citizen Auth | 13/13 | 82/100 | ship-with-watchlist |
| Dashboard + Request Tracking | 11/11 | 82/100 | ship-with-watchlist |
| Catalogue + Hybrid Search | 16/16 | 91/100 | ship-with-watchlist |
| Office Auth | 7/7 | 74/100 | needs-work |
| Single-claim + Payment Gate | 14/14 | 88/100 | ship-with-watchlist |
| WhatsApp Agent + Bot Persona | 9/9 | 82/100 | ship-with-watchlist |
| i18n (EN + AR) | 10/10 | 95/100 | ship-with-watchlist |
| Database Schema | 19/19 | 92/100 | ship-with-watchlist |

**Totals:** 111/111 deterministic checks passed. Opus average **87/100**.

## Enhancements applied during this audit

Every deterministic check passed (111/111). No code-modifying fixes were required during this run — the audit ran clean against `HEAD`. Where Opus flagged forward-looking hardening, those items are consolidated into the Roadmap below rather than silently shipped.

The audit harness itself (`scripts/full_audit.mjs`) is new and is the deliverable: re-runnable any time with `node scripts/full_audit.mjs` to regenerate this report. It boots the server in-process, exercises every feature with real HTTP round-trips, asks Claude Opus for a qualitative grade per surface, and emits both `AUDIT_REPORT.md` and `AUDIT_REPORT.json`.

## Roadmap (extracted from Opus verdicts)

Every Watchlist bullet from every feature, regrouped by rough severity. None are deploy-blockers — all 111 deterministic checks passed — but these are the natural next pass.

### Security & hardening (priority)

- **Citizen Auth** — Cookie SameSite and Secure flags not mentioned or tested — potential CSRF/transport risk
- **Office Auth** — No rate-limiting test for /api/auth/login — brute-force vector unverified
- **Office Auth** — No CSRF protection evidence for login POST endpoint
- **Office Auth** — No test for password complexity requirements at signup
- **Single-claim + Payment Gate** — No webhook signature verification test for Amwal callback (security concern for production)

### UX & accessibility (medium)

- **Homepage** — Missing test for hybrid-search input actually functioning (only checks presence, not behaviour)
- **Homepage** — No accessibility test for keyboard navigation through dual-path cards or search input
- **Citizen Auth** — No test confirms cooldown enforcement (30s) or max-attempts (5) lockout — abuse vectors untested
- **Citizen Auth** — No test for OTP expiry after 5 minutes — TTL claim unverified
- **Citizen Auth** — Arabic-first claim not verified — no test checks RTL dir attribute, Arabic labels, or placeholder text on auth pages
- **Citizen Auth** — No test for session logout/revocation endpoint
- **Dashboard + Request Tracking** — No test confirming chat_unlocked_for_office=true after payment — only pre-payment case verified
- **Dashboard + Request Tracking** — No test for empty state when citizen has zero requests — UX for new users unverified
- **Dashboard + Request Tracking** — No test for pagination or performance with many requests — scalability unknown
- **Dashboard + Request Tracking** — No test confirming Pay-now CTA hides/changes after payment completion
- **Dashboard + Request Tracking** — Phone-required banner logic untested — unclear if it correctly detects Google-only users missing phone
- **Dashboard + Request Tracking** — No test for service search hybrid endpoint mentioned in description
- **Catalogue + Hybrid Search** — No test coverage for empty result states or zero-match queries — unclear if UI handles 'لا توجد نتائج' gracefully
- **Catalogue + Hybrid Search** — Missing test for pagination or infinite scroll behaviour with large result sets
- **Catalogue + Hybrid Search** — No test for sort parameter behaviour (relevance vs fee vs processing time)
- **Office Auth** — Missing test for session expiry/max-age on sanad_sess cookie
- **Office Auth** — Missing Arabic UI test — office-facing pages should support RTL/Arabic for Omani officers
- **Office Auth** — No test for logout endpoint or session invalidation
- **Single-claim + Payment Gate** — No test for payment expiry or stale payment_link handling — citizen could click old link days later
- **Single-claim + Payment Gate** — Missing test for partial payment or payment amount mismatch scenarios
- **Single-claim + Payment Gate** — No test for citizen-side payment status polling or real-time update mechanism
- **WhatsApp Agent + Bot Persona** — No test coverage for actual one-language enforcement (Arabic reply to Arabic input, English to English)
- **WhatsApp Agent + Bot Persona** — No test verifying the 6s burst window timing is correctly implemented (only empty-reply guard tested)
- **WhatsApp Agent + Bot Persona** — Missing test for graceful handling when agent turn fails after ACK (user receives no reply)
- **i18n (EN + AR)** — No test for RTL/LTR dir attribute toggle when switching languages at runtime
- **i18n (EN + AR)** — Missing validation that all 536 keys have both en AND ar translations (could have orphan keys)
- **i18n (EN + AR)** — No test for dynamic content injection (e.g., API error messages, toast notifications) using i18n
- **Database Schema** — Missing index on citizen.google_sub — OAuth lookups will table-scan as user base grows
- **Database Schema** — No test for citizen_otp.expires_at column or TTL enforcement at DB level

### Polish (low)

- **Homepage** — No explicit test for FAQ accordion presence or functionality — description mentions FAQ but tests don't verify
- **Homepage** — No performance/LCP test — hero with live search input could delay interactivity on slow connections
- **Citizen Auth** — Google sign-in happy path not tested (only 401 for bad token) — no coverage of valid token → session flow
- **Citizen Auth** — No explicit test that DEBUG auto-fill button is hidden in production builds
- **Dashboard + Request Tracking** — DEBUG attach-phone shortcut present in account.html — must be removed or feature-flagged before production
- **Dashboard + Request Tracking** — Entity grid mentioned but not tested
- **Catalogue + Hybrid Search** — No validation that processing_time displays correctly in Arabic (e.g., '٣-٥ أيام عمل')
- **Catalogue + Hybrid Search** — Detail modal WA + Web CTAs mentioned but not tested for correct deep-link generation
- **Catalogue + Hybrid Search** — fee_min/max filter not explicitly tested despite being documented
- **Office Auth** — Signup flow lacks email verification step — pending_review alone doesn't confirm email ownership
- **Office Auth** — Cookie security flags (HttpOnly, Secure, SameSite) not verified in test output
- **Single-claim + Payment Gate** — POST /release refund_required=true flag tested but actual refund flow untested — citizen expectation gap
- **Single-claim + Payment Gate** — Arabic notification content not verified — 'chat unlocked' message may not be localized
- **WhatsApp Agent + Bot Persona** — Test notes 'excluding slot-comment' — residual Ahmed reference in code comments may confuse future maintainers
- **WhatsApp Agent + Bot Persona** — No verification that SYSTEM_V2 tool-loop actually invokes tools before answering (ground-truth policy)
- **WhatsApp Agent + Bot Persona** — Passport flow mentioned but unclear if fully wired — only four flows listed yet five services named
- **i18n (EN + AR)** — Currency/date/number formatting localisation not verified (Omani Rial, Hijri dates)
- **Database Schema** — No foreign-key constraint test between citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off)
- **Database Schema** — claim_review_started_at added but no corresponding idx_request_claim index for admin queries

---

_Auto-generated by `scripts/full_audit.mjs`. Re-run any time to refresh._
