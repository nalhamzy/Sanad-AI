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
**Opus verdict:** `ship-with-watchlist` · score **92/100**

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
- 40 KB payload is reasonable for a content-rich landing page

**Watchlist**

- No test coverage for How-it-works 3-step section mentioned in spec — verify it renders and is accessible
- FAQ section not explicitly validated; confirm accordion/expand behaviour and that answers are bilingual
- Service spotlight block not tested — ensure dynamic content or placeholder gracefully degrades
- Missing performance baseline (LCP, CLS) — hero image or search box could regress Core Web Vitals
- No explicit check that WhatsApp CTA deep-links correctly (wa.me with pre-filled text)

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
- 6-digit OTP UI on both /signup.html and /login.html with auto-fill wiring
- phone_verified flag correctly set after successful verification

**Watchlist**

- No test for cooldown enforcement — 30s claim unverified; second /start-otp within window should return 429
- No test for max-attempts lockout — 5 failed /verify-otp calls should block further attempts
- No test for TTL expiry — OTP used after 5 min should fail
- Google sign-in flow incomplete: no test that phone verification is required post-Google auth
- No test for Arabic error messages on /start-otp or /verify-otp failures
- DEBUG auto-fill button should be hidden/absent in production builds — no assertion for PROD mode
- No logout endpoint tested (/logout or cookie clearing)
- No rate-limit test on /google endpoint — potential brute-force vector

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

- GET /my-requests returns correct payload with payment_status + status fields
- GET /my-request/:id returns request + documents + messages bundle
- chat_unlocked_for_office=false enforced pre-payment — correct gating logic
- 401 for unauthenticated, 404 for non-existent request — proper error handling
- account.html is Arabic-first with phone-banner, search, and reqList elements
- request.html has timeline, docList, thread, and Pay-now CTA card
- Status timeline covers full lifecycle: collecting → ready → claimed → awaiting_payment → in_progress → completed
- Document chips show verified/pending/rejected states — good transparency

**Watchlist**

- DEBUG attach-phone shortcut present in account.html — must be removed or feature-flagged before production
- Phone-required banner for Google-only users needs clear CTA copy explaining why phone verification matters for Sanad office communication
- No test coverage for pagination on /my-requests — could break with many requests
- No test for message thread ordering (chronological vs reverse)
- No test for document upload/re-upload flow from request.html
- Entity grid mentioned in description but not validated in tests
- No test for Pay-now CTA behaviour (link target, disabled state when already paid)
- No Arabic validation for request.html — only account.html confirmed Arabic-first

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
- matched_by tags provide transparency on which lane(s) matched — excellent for debugging and user trust
- All 16 deterministic tests pass including Arabic query handling
- Filter endpoints well-structured: /entities returns {entity_en, entity_ar, n}, /fee-buckets returns 5 bucket counts
- Free-fee filter correctly enforces fee_omr=0 on all results
- has_docs=yes filter properly validates doc_count > 0
- catalogue.html confirmed Arabic-first with modern UI: fee-pill filters, beneficiary rail, sort dropdown, match-by chips
- Hybrid endpoint correctly wired (not legacy /search)
- Browse vs hybrid mode distinction (search.mode) is clean API design

**Watchlist**

- No test coverage for empty query edge case or whitespace-only input
- Missing test for fee_min/max range filter (only free-fee tested)
- No test for sort parameter behaviour (e.g., sort=fee_asc, sort=relevance)
- entity filter not explicitly tested despite being documented
- No test for pagination (limit/offset) on large result sets
- Lane counts (fts/semantic/partial) returned but no test verifying counts sum correctly or handle zero-match lanes
- Detail modal WA + Web CTAs mentioned but not tested for correct deep-link generation

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
- All critical endpoints return expected status codes (login, me, wrong password 401)
- Static pages for login/signup/dashboard all serve correctly

**Watchlist**

- No rate limiting tested on /api/office/login — brute-force vector for officer credentials
- Missing test for session expiry/max-age on sanad_sess cookie
- No CSRF protection evidence for cookie-based auth on state-changing endpoints
- Signup flow lacks email verification step — pending_review alone doesn't confirm email ownership
- No test for password complexity requirements at signup
- Missing Arabic UI/copy verification on /office-login.html and /office-signup.html
- No logout endpoint tested — unclear if session invalidation works
- Cookie security flags (HttpOnly, Secure, SameSite) not verified in test output
- No test for concurrent session handling or session fixation protection

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

- Atomic claim with WHERE office_id IS NULL prevents race conditions — deterministic test confirms 409 already_claimed on second attempt
- Pricing transparency: POST /claim returns structured { office_fee, government_fee, total } breakdown before payment commitment
- Payment idempotency handled correctly (reused=true on duplicate payment/start calls)
- Chat gating enforced server-side: 403 chat_locked_until_paid prevents officer access to citizen messages pre-payment
- Clean state transitions: paid_at timestamp + status=in_progress + payment_status=paid all set atomically on payment confirmation
- Lifecycle buckets in inbox (reviewing/awaiting_payment/in_progress/on_hold) enable proper dashboard filtering
- stub_pay redirect to /request.html provides graceful fallback when Amwal credentials unavailable

**Watchlist**

- No test coverage for POST /release refund flow — description mentions refund_required=true but no deterministic validation of refund state or citizen notification
- Missing Arabic copy verification: payment notifications via 'bot voice + WhatsApp' described but no test confirms رسالة الدفع or تم فتح المحادثة messaging
- No timeout/expiry test for payment links — what happens if citizen abandons payment? No TTL or cleanup validation
- Officer sees empty messages array pre-payment but no test confirms citizen-side UX shows equivalent lock state or explanation
- No test for edge case: what if payment webhook arrives before payment/start completes? Race condition unvalidated
- Missing test for partial payment or payment failure states — only happy path (stub_pay → paid) covered

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
- Webhook ACKs immediately (200) then processes async — correct pattern for WhatsApp API timeouts
- Burst-continuation logic with 6s window and empty-reply guard prevents spam on multi-file uploads
- One-language reply mandate supports Arabic-first UX
- Four deterministic launch flows defined (drivers_licence_renewal, mulkiya_renewal, cr_issuance, civil_id, passport — note: five listed, not four)

**Watchlist**

- Description says 'four deterministic launch flows' but lists five services — inconsistency in documentation
- Slot-comment exclusion noted for Ahmed check — unclear if this is a code comment or user-visible; needs verification
- Two separate system prompts (SYSTEM_PROMPT + SYSTEM_V2) creates maintenance burden and potential drift risk
- No test coverage for one-language reply enforcement — could reply in mixed Arabic/English
- No test for ground-truth-from-tools-only behaviour — LLM could hallucinate service details
- Burst-continuation 6s window is arbitrary — no test for edge cases (exactly 6s, rapid sequential uploads)
- No explicit test for Arabic-first greeting or language detection on first message

---

## i18n (EN + AR)

**Area:** Platform  
**Deterministic checks:** 10/10 passed
**Opus verdict:** `production-ready` · score **96/100**

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

- 536 i18n keys far exceeds 200-key threshold — comprehensive coverage
- All 6 HTML pages pass data-i18n key existence checks (/, /signup, /login, /account, /catalogue, /request)
- Brand naming correct: en="Saned", ar="ساند" — no legacy "Sanad-AI" or "سند الذكي" remnants
- Arabic-first default with <html lang="ar" dir="rtl"> at first paint prevents English flash
- Clear separation of product brand (Saned · ساند) vs real-world Sanad offices (مكاتب سند)

**Watchlist**

- No test coverage for dynamic JS-injected strings (e.g., toast messages, error modals) — only static data-i18n attributes verified
- Missing validation that localStorage sanad.lang toggle actually switches all visible copy at runtime
- No RTL/LTR layout regression test — dir="rtl" is set but visual alignment not verified

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

- No foreign-key constraint test for citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off by default)
- Missing index on citizen.google_sub — Google login lookups will table-scan as user base grows
- No test for citizen_otp expiry/cleanup mechanism (stale OTPs could accumulate)
- claim_review_started_at added but no corresponding index for office dashboard queries filtering by review state

---

## Aggregated scores

| Feature | Det. checks | Opus | Verdict |
|:---|:---:|:---:|:---:|
| Homepage | 12/12 | 92/100 | ship-with-watchlist |
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

- **Citizen Auth** — No rate-limit test on /google endpoint — potential brute-force vector
- **Office Auth** — No rate limiting tested on /api/office/login — brute-force vector for officer credentials
- **Office Auth** — No CSRF protection evidence for cookie-based auth on state-changing endpoints
- **Office Auth** — No test for password complexity requirements at signup

### UX & accessibility (medium)

- **Homepage** — No test coverage for How-it-works 3-step section mentioned in spec — verify it renders and is accessible
- **Homepage** — Missing performance baseline (LCP, CLS) — hero image or search box could regress Core Web Vitals
- **Citizen Auth** — No test for cooldown enforcement — 30s claim unverified; second /start-otp within window should return 429
- **Citizen Auth** — No test for max-attempts lockout — 5 failed /verify-otp calls should block further attempts
- **Citizen Auth** — No test for TTL expiry — OTP used after 5 min should fail
- **Citizen Auth** — Google sign-in flow incomplete: no test that phone verification is required post-Google auth
- **Citizen Auth** — No test for Arabic error messages on /start-otp or /verify-otp failures
- **Dashboard + Request Tracking** — No test coverage for pagination on /my-requests — could break with many requests
- **Dashboard + Request Tracking** — No test for message thread ordering (chronological vs reverse)
- **Dashboard + Request Tracking** — No test for document upload/re-upload flow from request.html
- **Dashboard + Request Tracking** — No test for Pay-now CTA behaviour (link target, disabled state when already paid)
- **Catalogue + Hybrid Search** — No test coverage for empty query edge case or whitespace-only input
- **Catalogue + Hybrid Search** — Missing test for fee_min/max range filter (only free-fee tested)
- **Catalogue + Hybrid Search** — No test for sort parameter behaviour (e.g., sort=fee_asc, sort=relevance)
- **Catalogue + Hybrid Search** — No test for pagination (limit/offset) on large result sets
- **Catalogue + Hybrid Search** — Lane counts (fts/semantic/partial) returned but no test verifying counts sum correctly or handle zero-match lanes
- **Office Auth** — Missing test for session expiry/max-age on sanad_sess cookie
- **Office Auth** — Missing Arabic UI/copy verification on /office-login.html and /office-signup.html
- **Office Auth** — No test for concurrent session handling or session fixation protection
- **Single-claim + Payment Gate** — No test coverage for POST /release refund flow — description mentions refund_required=true but no deterministic validation of refund state or citizen notification
- **Single-claim + Payment Gate** — Missing Arabic copy verification: payment notifications via 'bot voice + WhatsApp' described but no test confirms رسالة الدفع or تم فتح المحادثة messaging
- **Single-claim + Payment Gate** — Officer sees empty messages array pre-payment but no test confirms citizen-side UX shows equivalent lock state or explanation
- **Single-claim + Payment Gate** — No test for edge case: what if payment webhook arrives before payment/start completes? Race condition unvalidated
- **Single-claim + Payment Gate** — Missing test for partial payment or payment failure states — only happy path (stub_pay → paid) covered
- **WhatsApp Agent + Bot Persona** — No test coverage for one-language reply enforcement — could reply in mixed Arabic/English
- **WhatsApp Agent + Bot Persona** — No test for ground-truth-from-tools-only behaviour — LLM could hallucinate service details
- **WhatsApp Agent + Bot Persona** — Burst-continuation 6s window is arbitrary — no test for edge cases (exactly 6s, rapid sequential uploads)
- **i18n (EN + AR)** — No test coverage for dynamic JS-injected strings (e.g., toast messages, error modals) — only static data-i18n attributes verified
- **i18n (EN + AR)** — Missing validation that localStorage sanad.lang toggle actually switches all visible copy at runtime
- **Database Schema** — Missing index on citizen.google_sub — Google login lookups will table-scan as user base grows
- **Database Schema** — No test for citizen_otp expiry/cleanup mechanism (stale OTPs could accumulate)

### Polish (low)

- **Homepage** — FAQ section not explicitly validated; confirm accordion/expand behaviour and that answers are bilingual
- **Homepage** — Service spotlight block not tested — ensure dynamic content or placeholder gracefully degrades
- **Homepage** — No explicit check that WhatsApp CTA deep-links correctly (wa.me with pre-filled text)
- **Citizen Auth** — DEBUG auto-fill button should be hidden/absent in production builds — no assertion for PROD mode
- **Citizen Auth** — No logout endpoint tested (/logout or cookie clearing)
- **Dashboard + Request Tracking** — DEBUG attach-phone shortcut present in account.html — must be removed or feature-flagged before production
- **Dashboard + Request Tracking** — Phone-required banner for Google-only users needs clear CTA copy explaining why phone verification matters for Sanad office communication
- **Dashboard + Request Tracking** — Entity grid mentioned in description but not validated in tests
- **Dashboard + Request Tracking** — No Arabic validation for request.html — only account.html confirmed Arabic-first
- **Catalogue + Hybrid Search** — entity filter not explicitly tested despite being documented
- **Catalogue + Hybrid Search** — Detail modal WA + Web CTAs mentioned but not tested for correct deep-link generation
- **Office Auth** — Signup flow lacks email verification step — pending_review alone doesn't confirm email ownership
- **Office Auth** — No logout endpoint tested — unclear if session invalidation works
- **Office Auth** — Cookie security flags (HttpOnly, Secure, SameSite) not verified in test output
- **Single-claim + Payment Gate** — No timeout/expiry test for payment links — what happens if citizen abandons payment? No TTL or cleanup validation
- **WhatsApp Agent + Bot Persona** — Description says 'four deterministic launch flows' but lists five services — inconsistency in documentation
- **WhatsApp Agent + Bot Persona** — Slot-comment exclusion noted for Ahmed check — unclear if this is a code comment or user-visible; needs verification
- **WhatsApp Agent + Bot Persona** — Two separate system prompts (SYSTEM_PROMPT + SYSTEM_V2) creates maintenance burden and potential drift risk
- **WhatsApp Agent + Bot Persona** — No explicit test for Arabic-first greeting or language detection on first message
- **i18n (EN + AR)** — No RTL/LTR layout regression test — dir="rtl" is set but visual alignment not verified
- **Database Schema** — No foreign-key constraint test for citizen_otp.citizen_id → citizen.id (SQLite FK enforcement may be off by default)
- **Database Schema** — claim_review_started_at added but no corresponding index for office dashboard queries filtering by review state

---

_Auto-generated by `scripts/full_audit.mjs`. Re-run any time to refresh._
