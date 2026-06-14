# Sanad-AI — Publish Readiness Checklist

Last reviewed: code + security audit pass (full suite green).

This document captures (a) the hardening already applied in code and
(b) the **manual operator steps** that must be done before going live.
Items marked **[OPERATOR]** cannot be done in code — they're yours.

---

## 1. Security hardening — DONE in code

- **`lib/env.js`** centralises `DEBUG_ENABLED` = `DEBUG_MODE==='true' && NODE_ENV!=='production'`. Debug/stub surfaces can never open in production even if `DEBUG_MODE` is accidentally left `true`.
- **Payment stub routes** (`/api/payments/dummy/*`, `/_stub/*`, `confirm-stub`, `_dev/mark-paid`, `sub/_stub/activate`, `sub/_dev/autorenew`) now gated on `DEBUG_ENABLED` — previously some were live in production because they were gated on `!AMWAL_ENABLED` (true in prod). **This closed a hole where anyone could mark a request paid.**
- **Debug routes** (`/api/debug/state`, `/trace`, `/reset`, `/clear-phone`, `/simulate-otp`) now all behind `requireDebug` → 403 in production.
- **Annotator catalogue mutations** (create/edit/validate services, incl. `fee_omr`) now require a platform-admin in production. Previously a self-asserted `X-Annotator-Id` header let anyone rewrite pricing.
- **`requirePlatformAdmin`** no longer grants admin via the `DEBUG_MODE` fallback in production — a non-empty `ADMIN_EMAILS` allow-list is the only way in.
- **CSRF origin guard** can no longer be disabled by `DEBUG_MODE` in production.
- **Global error handler** added (terminal `app.use`) — logs server-side, returns generic JSON, only echoes `e.message` when `DEBUG_ENABLED`. No more stack-trace / internal-detail leakage; no worker crash on an unhandled route throw.
- **`app.set('trust proxy', 1)`** — correct client IP behind Render's proxy (rate-limiting + logging).
- **Boot guard `assertProductionConfig()`** — server refuses to start in production without `WHATSAPP_APP_SECRET` and `ADMIN_EMAILS` (and `JWT_SECRET`, enforced separately in `lib/auth.js`).
- **`render.yaml`** — Thawani keys are now `sync:false` (dashboard secrets), never committed. Added `ADMIN_EMAILS`, `SANAD_SUBS_V1`, `SANAD_SUBS_AUTORENEW`, `PLATFORM_FEE_BAISA`.

## 2. Chat quality — DONE in code

- Arabic document labels backfilled at the catalogue-read boundary (`lib/doc_labels.js`) — chat/apply/officer no longer show English doc codes in an Arabic UI.
- Burst-drain WhatsApp send now logs on total send failure (was silently swallowed).
- Webhook idempotency (Meta `msg.id` dedup) + fast 200 ACK confirmed correct.
- Reply de-dup (`isDuplicateWaReply`) + button→text fallback confirmed correct.

## 3. **[OPERATOR]** Secrets — ROTATE before launch

The following live keys were present in the working-copy `.env` during
development (the file is gitignored and was **never committed**, but treat
them as exposed and rotate):

- [ ] **Anthropic API key** — rotate at console.anthropic.com
- [ ] **Qwen API key** — rotate at dashscope
- [ ] **OpenAI key** (if still used) — rotate
- [ ] **WhatsApp permanent access token** — regenerate (Meta App → System User)
- [ ] **WhatsApp app secret** — rotate (Meta App → Settings → Basic)

Then set the new values as **Render dashboard secrets** (never in `render.yaml`).

## 4. **[OPERATOR]** Required production env vars (Render dashboard)

- [ ] `JWT_SECRET` — ≥16 random chars (boot fails without it)
- [ ] `ADMIN_EMAILS` — comma-separated platform-admin emails (boot fails without it)
- [ ] `WHATSAPP_APP_SECRET` — webhook signature (boot fails without it)
- [ ] `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`
- [ ] `ANTHROPIC_API_KEY`, `QWEN_API_KEY`
- [ ] `THAWANI_SECRET_KEY`, `THAWANI_PUBLISHABLE_KEY` + `THAWANI_ENV=production` (after Thawani onboarding)
- [ ] Confirm `DEBUG_MODE=false` and `NODE_ENV=production` (both set in render.yaml)
- [ ] Decide `SANAD_SUBS_V1` — enables office plan purchases (one-off, NOT recurring)

## 4b. **[OPERATOR]** Thawani gateway — single integration

Thawani is the ONE payment gateway for everything (citizen request payments
+ office plan purchases). There are no recurring subscriptions (Thawani
doesn't support them) — office plans are one-off charges.

- [ ] Complete Thawani **merchant onboarding** → real production keys issued
- [ ] Set the keys + `THAWANI_ENV=production` in the Render dashboard
- [ ] **Configure ONE webhook URL** on Thawani's merchant dashboard:
      `https://saned.ai/api/payments/webhook/thawani`
      (handles citizen payments AND office plans; the server routes by session)
- [ ] Confirm `PUBLIC_BASE_URL=https://saned.ai` (success/cancel redirects)
- [ ] Sandbox e2e: pay one citizen request + (if enabled) one office plan with
      test card `4242 4242 4242 4242`; confirm both flip to paid

## 5. **[OPERATOR]** Meta WhatsApp templates

Submit + get approved (see `docs/META_TEMPLATES.md`):
- [ ] `sanad_payment_link` (UTILITY, ar + en)
- [ ] `sanad_renewal_due` (UTILITY, ar) — only if office plans (`SANAD_SUBS_V1`) are enabled

Until approved, sends fall back to CTA-URL buttons then plain text (graceful).

## 6. **[OPERATOR]** Data + infra

- [ ] **SQLite → Turso/libSQL**: the SQLite file on Render's disk survives
      restarts but not a service recreation. For real production durability,
      provision a Turso DB and set `DB_URL=libsql://…` + `DB_AUTH_TOKEN`.
- [ ] Run `npm audit fix` for the moderate advisories (qs/body-parser/ws —
      `ws` is a `playwright-core` devDep, not runtime).
- [ ] Confirm `/api/health` returns `{ ok, thawani:true, whatsapp:true }` post-deploy.

## 7. Known follow-ups (non-blocking)

- Rate-limit `/api/chat/*` and `/api/payments/*` (LLM-cost + brute-force abuse).
- Consider `SameSite=Strict` on session cookies (currently `Lax`).
- Office plans are one-off purchases; when a plan expires the office buys
  again (7/3/1-day reminders are sent automatically). No recurring billing —
  Thawani doesn't support it and the recurring/auto-renew code was removed.
  The unused `office_subscription.auto_renew` / `renewal_*` /
  `thawani_customer_id` columns remain in the schema (harmless) in case
  recurring is ever revisited.
