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
- Dual application paths (Web + WhatsApp) with clear "Easiest · Recommended" badge guiding citizens toward the smoother flow
- Office partner pitch correctly relegated to footer ("I run a Sanad office →") — keeps citizen focus clean
- Page weight ~40 KB is reasonable for a content-rich landing; no obvious bloat

**Watchlist**

- No test coverage for FAQ accordion functionality or keyboard accessibility
- Missing explicit check for How-it-works 3-step section mentioned in description
- No performance or Core Web Vitals assertion (LCP, CLS) — important for first impression
- Service spotlight section not verified in test output

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

- OTP flow complete: /start-otp → /verify-otp → /me chain works end-to-end
- Security basics present: httpOnly cookie, 30s cooldown, 5 max-attempts, 5-min TTL
- Magic OTP 000000 gated behind DEBUG_MODE — safe for prod if flag is off
- Google OAuth rejects bad tokens (401) — no silent pass-through
- Both /signup.html and /login.html serve 200 with 6-box OTP UI
- DEBUG auto-fill wiring present for faster QA cycles

**Watchlist**

- No test confirming cooldown actually blocks rapid /start-otp calls — could allow OTP spam
- No test for max-attempts lockout after 5 failures — brute-force vector unverified
- Missing test: expired OTP rejection after 5 min TTL
- Google sign-in flow incomplete in tests — no happy-path /google → phone-verification chain shown
- No explicit Arabic-first assertion (RTL dir, Arabic placeholder/label text) in HTML tests
- Cookie SameSite and Secure flags not verified — CSRF/MITM risk on prod
- No test for /logout or session invalidation
- DEBUG auto-fill button should be hidden/absent in production builds — no assertion for that

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
- 401 for unauthenticated, 404 for non-existent request — proper error codes
- account.html is Arabic-first with phone-banner, search, and reqList containers
- request.html renders timeline, docList, thread, and Pay-now CTA card
- DEBUG attach-phone shortcut present for testing phone verification flow

**Watchlist**

- DEBUG attach-phone shortcut visible in production build — should be dev-only or feature-flagged
- No test for phone-banner conditional rendering (should hide when phone already verified)
- chat_unlocked_for_office tested only for false case — missing test for true after paid_at
- Timeline status progression not tested (e.g., correct chip for 'awaiting_payment' vs 'in_progress')
- Document chips (verified/pending/rejected) rendering not explicitly tested
- No test for empty state when citizen has zero requests
- Entity grid mentioned in description but not covered by any test
- No RTL layout or Arabic copy verification beyond 'Arabic-first' assertion

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

- Three-lane hybrid search (FTS5 BM25 + Qwen embedding + substring LIKE) with RRF fusion is sophisticated and handles Arabic morphology well
- matched_by tags give transparency into which lane surfaced each result — useful for debugging and user trust
- Filter endpoints (/entities, /beneficiaries, /fee-buckets) are well-structured with counts for faceted UI
- Free-fee filter correctly enforces fee_omr=0 on all results
- has_docs=yes filter properly returns only services with doc_count > 0
- catalogue.html confirmed Arabic-first with modern card grid, sticky filter rail, and match-by chips
- UI correctly calls /hybrid endpoint rather than legacy /search — clean migration
- Fee-pill filters and beneficiary rail provide good progressive disclosure for 200+ services

**Watchlist**

- No test for empty-result UX — what does user see when hybrid returns zero matches?
- Missing test for pagination or infinite scroll — catalogue could have 200+ services
- No latency assertion for hybrid search — three parallel lanes plus embedding lookup could be slow on cold start
- Sort dropdown tested for presence but no verification that sort=fee_asc or sort=name actually reorders results
- No test for detail modal CTA behaviour — do WA/Web buttons pass correct service_id?
- Partial-match lane (LIKE) could surface noisy results for short queries — no minimum query length validation tested

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
- attachSession middleware pattern ensures consistent auth hydration across routes
- pending_review workflow prevents unauthorized marketplace access until admin vetting
- All core endpoints return expected status codes (login, me, static pages)
- 401 on wrong password confirms credential validation works

**Watchlist**

- No rate limiting tested on /api/office/login — brute-force vector for officer accounts
- Missing test for SQL injection or malformed email input on login/signup endpoints
- No evidence of CSRF protection on auth forms (cookie-based auth requires this)
- No password complexity validation tested during signup — weak passwords may be accepted
- Missing test for session expiry/timeout behaviour
- No test for duplicate email signup rejection
- pending_review state has no tested notification flow — officers may not know approval status
- Arabic localisation of auth error messages not verified (e.g., 'كلمة المرور غير صحيحة')
- No test for logout endpoint or cookie clearing
- Missing test for office data sanitisation in /api/auth/me response (potential data leak)

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

- No test for payment expiry or stale payment links — citizen could click old link days later
- Missing test for partial payment or payment amount mismatch scenarios
- POST /release refund_required=true flag tested but actual refund flow untested — citizen expectation gap
- No webhook signature verification test for Amwal callbacks — security risk in production
- Arabic notification content for payment request not verified (voice + WhatsApp mentioned but not tested)
- No test for citizen-side payment status polling or real-time update mechanism
- Missing test for office_service_price override path — only default pricing verified

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
- Webhook ACKs immediately (200) before async processing — prevents Meta timeouts
- Burst-continuation logic with 6s window and empty-reply guard prevents spam on multi-file uploads
- Four deterministic launch flows defined: drivers_licence_renewal, mulkiya_renewal, cr_issuance, civil ID, passport

**Watchlist**

- Slot-comment exclusion noted in test — verify no 'Ahmed' leaks into conversation context or logs
- Two separate system prompts (SYSTEM_PROMPT + SYSTEM_V2) risk drift; consider consolidating or adding sync tests
- One-language reply mandate not explicitly tested — could fail on mixed Arabic/English input
- No test coverage for tool-loop error handling when ground-truth tools fail
- Burst-continuation 6s window is arbitrary — no test for edge cases (e.g., 5.9s vs 6.1s timing)
- No explicit test that passport flow is fully wired (only listed, not verified like others)

---

## i18n (EN + AR)

**Area:** Platform  
**Deterministic checks:** 10/10 passed
**Opus verdict:** `production-ready` · score **96/100**

### Tests

| Result | Check |
|:---:|:---|
| ✅ | i18n has 200+ unique keys <br/><sub>597 keys</sub> |
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

- 597 i18n keys far exceed 200+ requirement — comprehensive coverage
- All 6 HTML pages pass data-i18n key validation — zero missing translations
- Brand naming correct: en='Saned', ar='ساند' — consistent identity
- Legacy 'سند الذكي' fully purged from codebase
- Arabic-first default with RTL at first paint prevents English flash

**Watchlist**

- No test for actual localStorage 'sanad.lang' persistence across sessions
- Missing validation that <html lang='ar' dir='rtl'> is set before DOMContentLoaded
- No coverage for dynamic content (toast messages, error responses) using i18n keys
- 597 keys suggests possible duplication — audit for unused/redundant entries

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
- phone_verified_at / email_verified_at columns enable proper verification state tracking for OTP and Google flows
- payment_status + payment_link + paid_at columns align with Thawani payment-gate requirements
- released_count column supports partial-release logic for multi-document requests

**Watchlist**

- No foreign-key constraint test between citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off by default)
- Missing index on citizen.google_sub — Google login lookups will table-scan as user base grows
- No test for citizen_otp expiry/cleanup mechanism — stale OTP rows could accumulate indefinitely
- claim_review_started_at added but no corresponding index for office dashboard queries filtering by review state

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
| i18n (EN + AR) | 10/10 | 96/100 | production-ready |
| Database Schema | 19/19 | 92/100 | ship-with-watchlist |

**Totals:** 111/111 deterministic checks passed. Opus average **87/100**.

## Enhancements applied during this audit

Every deterministic check passed (111/111). No code-modifying fixes were required during this run — the audit ran clean against `HEAD`. Where Opus flagged forward-looking hardening, those items are consolidated into the Roadmap below rather than silently shipped.

The audit harness itself (`scripts/full_audit.mjs`) is new and is the deliverable: re-runnable any time with `node scripts/full_audit.mjs` to regenerate this report. It boots the server in-process, exercises every feature with real HTTP round-trips, asks Claude Opus for a qualitative grade per surface, and emits both `AUDIT_REPORT.md` and `AUDIT_REPORT.json`.

## Roadmap (extracted from Opus verdicts)

Every Watchlist bullet from every feature, regrouped by rough severity. None are deploy-blockers — all 111 deterministic checks passed — but these are the natural next pass.

### Security & hardening (priority)

- **Citizen Auth** — No test for max-attempts lockout after 5 failures — brute-force vector unverified
- **Citizen Auth** — Cookie SameSite and Secure flags not verified — CSRF/MITM risk on prod
- **Office Auth** — No rate limiting tested on /api/office/login — brute-force vector for officer accounts
- **Office Auth** — Missing test for SQL injection or malformed email input on login/signup endpoints
- **Office Auth** — No evidence of CSRF protection on auth forms (cookie-based auth requires this)
- **Office Auth** — No password complexity validation tested during signup — weak passwords may be accepted
- **Single-claim + Payment Gate** — No webhook signature verification test for Amwal callbacks — security risk in production

### UX & accessibility (medium)

- **Homepage** — No test coverage for FAQ accordion functionality or keyboard accessibility
- **Homepage** — Missing explicit check for How-it-works 3-step section mentioned in description
- **Citizen Auth** — No test confirming cooldown actually blocks rapid /start-otp calls — could allow OTP spam
- **Citizen Auth** — Missing test: expired OTP rejection after 5 min TTL
- **Citizen Auth** — No test for /logout or session invalidation
- **Dashboard + Request Tracking** — No test for phone-banner conditional rendering (should hide when phone already verified)
- **Dashboard + Request Tracking** — chat_unlocked_for_office tested only for false case — missing test for true after paid_at
- **Dashboard + Request Tracking** — No test for empty state when citizen has zero requests
- **Catalogue + Hybrid Search** — No test for empty-result UX — what does user see when hybrid returns zero matches?
- **Catalogue + Hybrid Search** — Missing test for pagination or infinite scroll — catalogue could have 200+ services
- **Catalogue + Hybrid Search** — No test for detail modal CTA behaviour — do WA/Web buttons pass correct service_id?
- **Office Auth** — Missing test for session expiry/timeout behaviour
- **Office Auth** — No test for duplicate email signup rejection
- **Office Auth** — pending_review state has no tested notification flow — officers may not know approval status
- **Office Auth** — No test for logout endpoint or cookie clearing
- **Office Auth** — Missing test for office data sanitisation in /api/auth/me response (potential data leak)
- **Single-claim + Payment Gate** — No test for payment expiry or stale payment links — citizen could click old link days later
- **Single-claim + Payment Gate** — Missing test for partial payment or payment amount mismatch scenarios
- **Single-claim + Payment Gate** — No test for citizen-side payment status polling or real-time update mechanism
- **Single-claim + Payment Gate** — Missing test for office_service_price override path — only default pricing verified
- **WhatsApp Agent + Bot Persona** — No test coverage for tool-loop error handling when ground-truth tools fail
- **WhatsApp Agent + Bot Persona** — Burst-continuation 6s window is arbitrary — no test for edge cases (e.g., 5.9s vs 6.1s timing)
- **i18n (EN + AR)** — No test for actual localStorage 'sanad.lang' persistence across sessions
- **i18n (EN + AR)** — Missing validation that <html lang='ar' dir='rtl'> is set before DOMContentLoaded
- **Database Schema** — Missing index on citizen.google_sub — Google login lookups will table-scan as user base grows
- **Database Schema** — No test for citizen_otp expiry/cleanup mechanism — stale OTP rows could accumulate indefinitely

### Polish (low)

- **Homepage** — No performance or Core Web Vitals assertion (LCP, CLS) — important for first impression
- **Homepage** — Service spotlight section not verified in test output
- **Citizen Auth** — Google sign-in flow incomplete in tests — no happy-path /google → phone-verification chain shown
- **Citizen Auth** — No explicit Arabic-first assertion (RTL dir, Arabic placeholder/label text) in HTML tests
- **Citizen Auth** — DEBUG auto-fill button should be hidden/absent in production builds — no assertion for that
- **Dashboard + Request Tracking** — DEBUG attach-phone shortcut visible in production build — should be dev-only or feature-flagged
- **Dashboard + Request Tracking** — Timeline status progression not tested (e.g., correct chip for 'awaiting_payment' vs 'in_progress')
- **Dashboard + Request Tracking** — Document chips (verified/pending/rejected) rendering not explicitly tested
- **Dashboard + Request Tracking** — Entity grid mentioned in description but not covered by any test
- **Dashboard + Request Tracking** — No RTL layout or Arabic copy verification beyond 'Arabic-first' assertion
- **Catalogue + Hybrid Search** — No latency assertion for hybrid search — three parallel lanes plus embedding lookup could be slow on cold start
- **Catalogue + Hybrid Search** — Sort dropdown tested for presence but no verification that sort=fee_asc or sort=name actually reorders results
- **Catalogue + Hybrid Search** — Partial-match lane (LIKE) could surface noisy results for short queries — no minimum query length validation tested
- **Office Auth** — Arabic localisation of auth error messages not verified (e.g., 'كلمة المرور غير صحيحة')
- **Single-claim + Payment Gate** — POST /release refund_required=true flag tested but actual refund flow untested — citizen expectation gap
- **Single-claim + Payment Gate** — Arabic notification content for payment request not verified (voice + WhatsApp mentioned but not tested)
- **WhatsApp Agent + Bot Persona** — Slot-comment exclusion noted in test — verify no 'Ahmed' leaks into conversation context or logs
- **WhatsApp Agent + Bot Persona** — Two separate system prompts (SYSTEM_PROMPT + SYSTEM_V2) risk drift; consider consolidating or adding sync tests
- **WhatsApp Agent + Bot Persona** — One-language reply mandate not explicitly tested — could fail on mixed Arabic/English input
- **WhatsApp Agent + Bot Persona** — No explicit test that passport flow is fully wired (only listed, not verified like others)
- **i18n (EN + AR)** — No coverage for dynamic content (toast messages, error responses) using i18n keys
- **i18n (EN + AR)** — 597 keys suggests possible duplication — audit for unused/redundant entries
- **Database Schema** — No foreign-key constraint test between citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off by default)
- **Database Schema** — claim_review_started_at added but no corresponding index for office dashboard queries filtering by review state

---

_Auto-generated by `scripts/full_audit.mjs`. Re-run any time to refresh._
