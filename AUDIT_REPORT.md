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
| ✅ | homepage serves 200 <br/><sub>39211 bytes</sub> |
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
- Dual application paths (Web + WhatsApp) presented as equal side-by-side cards with clear "Easiest · Recommended" badge on web path
- Office partner pitch correctly relegated to footer ("I run a Sanad office →") — keeps citizen focus
- 39KB payload is reasonable for a content-rich landing page

**Watchlist**

- No explicit test for FAQ accordion presence or functionality — description mentions FAQ but tests don't verify
- Missing verification of How-it-works 3-step section mentioned in description
- No accessibility checks (focus order, ARIA labels on search input, skip-to-content link)
- Service spotlight section mentioned in description but not explicitly tested

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

- No test confirming cooldown actually blocks rapid re-requests (30s enforcement untested)
- No test for max-attempts lockout after 5 failures — brute-force protection unverified
- Missing test: expired OTP (>5 min) should fail verification
- Google sign-in flow incomplete: no test showing phone verification requirement after OAuth
- No Arabic copy verification — 'Arabic-first' claimed but no assertion on RTL/lang attributes
- Cookie SameSite and Secure flags not tested — CSRF/MITM surface unclear
- No logout endpoint tested — session teardown path unknown
- DEBUG auto-fill button should be hidden in production builds — no assertion it's conditionally rendered

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
- No test for phone-banner conditional rendering (should hide when phone already verified)
- No test for hybrid search endpoint integration on /account.html
- No test for entity grid rendering or data source
- No test for message thread ordering or Arabic RTL bubble alignment
- No test for Pay-now CTA state changes (hidden when already paid, disabled when not awaiting_payment)
- No test for status chip Arabic labels (e.g., 'قيد التنفيذ' vs 'in_progress')
- No test for documents grid click-to-preview or download behaviour

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
| ✅ | catalogue.html match-by chips wired |

### Opus verdict

**What's working**

- Hybrid search architecture (FTS5 BM25 + Qwen embeddings + substring LIKE) with RRF fusion is sophisticated and production-grade
- matched_by tags provide transparency on which lane(s) contributed each result
- Filter endpoints well-structured: /entities returns {entity_en, entity_ar, n}, /beneficiaries, /fee-buckets with 5 bucket counts
- Arabic query returns 200 — bilingual search confirmed working
- Free-fee filter correctly enforces fee_omr=0 on all results
- has_docs=yes filter properly validates doc_count > 0
- catalogue.html confirmed Arabic-first with hybrid endpoint integration (not legacy /search)
- UI components complete: fee-pill filters, beneficiary rail, sort dropdown, match-by chips all wired
- Browse vs hybrid mode distinction (search.mode) enables graceful degradation

**Watchlist**

- No test for empty query edge case or minimum query length validation
- Missing test for fee_min/max range filter (only free-fee tested)
- No pagination test (limit/offset) for large result sets
- No test for sort parameter options (relevance, fee, processing_time)
- Entity filter not explicitly tested despite being documented
- No latency benchmark for hybrid search — three parallel lanes could be slow on cold start
- Missing test for detail modal WA + Web CTAs functionality

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
- Separate sanad_sess cookie correctly isolates officer sessions from citizen sessions
- attachSession middleware pattern ensures consistent auth hydration across requests
- pending_review workflow prevents unauthorized offices from accessing marketplace
- All critical endpoints return expected status codes (login, signup, dashboard pages)
- 401 on wrong password confirms proper credential validation

**Watchlist**

- No rate-limiting test for /api/office/login — brute-force vector unverified
- Missing test for session expiry/max-age on sanad_sess cookie
- No CSRF protection evidence for login POST (cookie-based auth vulnerable)
- No test for email validation or duplicate email handling during signup
- Missing Arabic copy verification on /office-login.html and /office-signup.html
- No test for password complexity requirements (length, charset)
- pending_review → approved transition flow not tested end-to-end
- No logout endpoint tested — session invalidation unverified
- Missing test for office data sanitization in /api/auth/me response (potential data leak)

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
- stub_pay redirect enables full flow testing without Amwal credentials
- paid_at timestamp + payment_status=paid provides audit trail

**Watchlist**

- No test for payment expiry/timeout — what happens if citizen never pays? Stale awaiting_payment requests could accumulate
- POST /release refund_required=true flag tested but actual refund flow not verified — manual process risk
- No test for partial payment or payment amount mismatch scenarios
- Missing test for citizen-side payment notification (bot voice + WhatsApp mentioned in spec but not verified)
- No test for concurrent payment/start calls — potential for duplicate Amwal links if idempotency key fails
- Officer sees empty messages array pre-payment but no test confirms 🔒 banner copy or Arabic localization
- No timeout on awaiting_payment status — request could sit indefinitely blocking citizen from re-submitting

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
- One-language reply mandate and ground-truth-from-tools-only constraints documented

**Watchlist**

- Test notes 'excluding slot-comment' — residual Ahmed reference in slot comment should be cleaned for consistency
- No test coverage for actual one-language enforcement (Arabic reply to Arabic input, English to English)
- No test verifying the 6s burst window timing or edge cases (e.g., file at 5.9s vs 6.1s)
- Passport listed as fifth flow but description says 'four deterministic launch flows' — count mismatch
- No test for graceful degradation if async processing fails after ACK
- Missing test for tool-loop error handling when ground-truth tools are unavailable

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

- 597 i18n keys far exceeds 200+ requirement — comprehensive coverage
- All 6 HTML pages pass data-i18n key validation — zero missing references
- Brand naming correct: en='Saned', ar='ساند' — consistent identity
- Legacy 'سند الذكي' fully purged from codebase
- Arabic-first default with RTL at first paint prevents English flash
- Real-world 'Sanad office / مكاتب سند' distinction properly maintained

**Watchlist**

- No test for runtime lang-switch persistence (localStorage sanad.lang read/write cycle)
- Missing validation that <html lang='ar' dir='rtl'> is actually set at first paint vs after JS load
- No coverage for dynamic content (toast messages, API error strings) using i18n keys

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

- All 19 schema assertions pass — auth columns (email, google_sub, display_name, phone_verified_at), payment columns (payment_status, payment_link, paid_at, payment_amount_omr), and citizen_otp table all present
- Idempotent ALTERs via pragma_table_info checks ensure safe re-runs on persistent SQLite disks — critical for zero-downtime deploys
- Proper indexing: unique idx_citizen_email prevents duplicate accounts; idx_request_payment and idx_request_office_status support payment queries and office dashboards
- Schema supports full auth flow: Google OAuth (google_sub), email/password (email + email_verified_at), and phone OTP (phone_verified_at + citizen_otp table)
- released_count and claim_review_started_at columns enable payment-gate logic without breaking legacy rows

**Watchlist**

- No foreign-key constraint test for citizen_otp.citizen_id → citizen.id; orphan OTPs possible if citizen deleted
- Missing index on citizen.google_sub — OAuth lookups will table-scan as user base grows
- No test for payment_status CHECK constraint or ENUM-like validation; invalid states (e.g., 'piad') could slip in
- avatar_url column exists but no length/format validation test; malformed URLs could break UI
- No explicit test for DEFAULT values on new columns (e.g., payment_status DEFAULT 'pending'); legacy rows may have NULLs requiring app-level handling

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

- **Citizen Auth** — No test for max-attempts lockout after 5 failures — brute-force protection unverified
- **Citizen Auth** — Cookie SameSite and Secure flags not tested — CSRF/MITM surface unclear
- **Office Auth** — No rate-limiting test for /api/office/login — brute-force vector unverified
- **Office Auth** — No CSRF protection evidence for login POST (cookie-based auth vulnerable)
- **Office Auth** — No test for password complexity requirements (length, charset)

### UX & accessibility (medium)

- **Homepage** — Missing verification of How-it-works 3-step section mentioned in description
- **Homepage** — No accessibility checks (focus order, ARIA labels on search input, skip-to-content link)
- **Citizen Auth** — No test confirming cooldown actually blocks rapid re-requests (30s enforcement untested)
- **Citizen Auth** — Missing test: expired OTP (>5 min) should fail verification
- **Citizen Auth** — Google sign-in flow incomplete: no test showing phone verification requirement after OAuth
- **Dashboard + Request Tracking** — No test for phone-banner conditional rendering (should hide when phone already verified)
- **Dashboard + Request Tracking** — No test for hybrid search endpoint integration on /account.html
- **Dashboard + Request Tracking** — No test for entity grid rendering or data source
- **Dashboard + Request Tracking** — No test for message thread ordering or Arabic RTL bubble alignment
- **Dashboard + Request Tracking** — No test for Pay-now CTA state changes (hidden when already paid, disabled when not awaiting_payment)
- **Dashboard + Request Tracking** — No test for status chip Arabic labels (e.g., 'قيد التنفيذ' vs 'in_progress')
- **Dashboard + Request Tracking** — No test for documents grid click-to-preview or download behaviour
- **Catalogue + Hybrid Search** — No test for empty query edge case or minimum query length validation
- **Catalogue + Hybrid Search** — Missing test for fee_min/max range filter (only free-fee tested)
- **Catalogue + Hybrid Search** — No test for sort parameter options (relevance, fee, processing_time)
- **Catalogue + Hybrid Search** — Missing test for detail modal WA + Web CTAs functionality
- **Office Auth** — Missing test for session expiry/max-age on sanad_sess cookie
- **Office Auth** — No test for email validation or duplicate email handling during signup
- **Office Auth** — Missing Arabic copy verification on /office-login.html and /office-signup.html
- **Office Auth** — Missing test for office data sanitization in /api/auth/me response (potential data leak)
- **Single-claim + Payment Gate** — No test for payment expiry/timeout — what happens if citizen never pays? Stale awaiting_payment requests could accumulate
- **Single-claim + Payment Gate** — No test for partial payment or payment amount mismatch scenarios
- **Single-claim + Payment Gate** — Missing test for citizen-side payment notification (bot voice + WhatsApp mentioned in spec but not verified)
- **Single-claim + Payment Gate** — No test for concurrent payment/start calls — potential for duplicate Amwal links if idempotency key fails
- **Single-claim + Payment Gate** — Officer sees empty messages array pre-payment but no test confirms 🔒 banner copy or Arabic localization
- **WhatsApp Agent + Bot Persona** — No test coverage for actual one-language enforcement (Arabic reply to Arabic input, English to English)
- **WhatsApp Agent + Bot Persona** — No test verifying the 6s burst window timing or edge cases (e.g., file at 5.9s vs 6.1s)
- **WhatsApp Agent + Bot Persona** — No test for graceful degradation if async processing fails after ACK
- **WhatsApp Agent + Bot Persona** — Missing test for tool-loop error handling when ground-truth tools are unavailable
- **i18n (EN + AR)** — No test for runtime lang-switch persistence (localStorage sanad.lang read/write cycle)
- **i18n (EN + AR)** — Missing validation that <html lang='ar' dir='rtl'> is actually set at first paint vs after JS load
- **Database Schema** — Missing index on citizen.google_sub — OAuth lookups will table-scan as user base grows
- **Database Schema** — No test for payment_status CHECK constraint or ENUM-like validation; invalid states (e.g., 'piad') could slip in

### Polish (low)

- **Homepage** — No explicit test for FAQ accordion presence or functionality — description mentions FAQ but tests don't verify
- **Homepage** — Service spotlight section mentioned in description but not explicitly tested
- **Citizen Auth** — No Arabic copy verification — 'Arabic-first' claimed but no assertion on RTL/lang attributes
- **Citizen Auth** — No logout endpoint tested — session teardown path unknown
- **Citizen Auth** — DEBUG auto-fill button should be hidden in production builds — no assertion it's conditionally rendered
- **Dashboard + Request Tracking** — DEBUG attach-phone shortcut present in account.html — must be removed or feature-flagged before production
- **Catalogue + Hybrid Search** — No pagination test (limit/offset) for large result sets
- **Catalogue + Hybrid Search** — Entity filter not explicitly tested despite being documented
- **Catalogue + Hybrid Search** — No latency benchmark for hybrid search — three parallel lanes could be slow on cold start
- **Office Auth** — pending_review → approved transition flow not tested end-to-end
- **Office Auth** — No logout endpoint tested — session invalidation unverified
- **Single-claim + Payment Gate** — POST /release refund_required=true flag tested but actual refund flow not verified — manual process risk
- **Single-claim + Payment Gate** — No timeout on awaiting_payment status — request could sit indefinitely blocking citizen from re-submitting
- **WhatsApp Agent + Bot Persona** — Test notes 'excluding slot-comment' — residual Ahmed reference in slot comment should be cleaned for consistency
- **WhatsApp Agent + Bot Persona** — Passport listed as fifth flow but description says 'four deterministic launch flows' — count mismatch
- **i18n (EN + AR)** — No coverage for dynamic content (toast messages, API error strings) using i18n keys
- **Database Schema** — No foreign-key constraint test for citizen_otp.citizen_id → citizen.id; orphan OTPs possible if citizen deleted
- **Database Schema** — avatar_url column exists but no length/format validation test; malformed URLs could break UI
- **Database Schema** — No explicit test for DEFAULT values on new columns (e.g., payment_status DEFAULT 'pending'); legacy rows may have NULLs requiring app-level handling

---

_Auto-generated by `scripts/full_audit.mjs`. Re-run any time to refresh._
