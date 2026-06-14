# Thawani Subscriptions & Payments — Implementation Plan

> Status: planning approved 2026-05-18. Execution started same day. PR 1 = schema + plans config.
>
> **⚠ UPDATE (post-build):** Thawani confirmed they do **not** support recurring
> subscriptions. The product now uses **a single Thawani integration** for
> everything, with **one webhook** (`/api/payments/webhook/thawani`) that routes
> both citizen request payments and office plan purchases. Office "plans"
> (3/6/12-month access) are sold as **one-off charges** — when a plan expires the
> office simply buys again (7/3/1-day reminders are sent). The auto-renew /
> saved-card / payment-intent machinery described as "Phase 4/6" below was
> **removed**; sections referencing recurring billing are historical. The
> `office_subscription.auto_renew` / `renewal_*` / `thawani_customer_id` columns
> remain in the schema (unused, harmless) in case recurring is revisited.

## 1. Goals

1. **Office subscriptions** — paid 1/3/6/12-month plans gating dashboard access + claim quota.
2. **Citizen payment links** — request-fee payment over WhatsApp via Thawani hosted checkout (already mostly built; polish only).
3. **Admin dashboard** — one well-divided page covering active subscriptions, expiring soon, MRR, citizen payments, and per-office payment history.
4. **Auto-renew via saved cards** — Phase 4 (after manual flow is validated in sandbox).

## 2. Plan pricing & quota

| Plan          | Months | Discount | Total OMR | Per-month | Claim quota |
| ------------- | ------ | -------- | --------- | --------- | ----------- |
| `monthly`     | 1      | —        | 30        | 30.00     | 100/mo      |
| `quarterly`   | 3      | 8%       | 82.80     | 27.60     | 100/mo      |
| `semi-annual` | 6      | 15%      | 153       | 25.50     | 100/mo      |
| `annual`      | 12     | 20%      | 288       | 24.00     | 100/mo      |

Quota = 100 claims per calendar month, rolling reset on the 1st. Computed live from `request` table — no extra meter table.

Plans live in `lib/plans.js`.

## 3. Data model changes

### 3.1 `office_subscription` — extend

```sql
ALTER TABLE office_subscription ADD COLUMN months INTEGER;
ALTER TABLE office_subscription ADD COLUMN starts_at INTEGER;
ALTER TABLE office_subscription ADD COLUMN expires_at INTEGER;
ALTER TABLE office_subscription ADD COLUMN renewed_from_id INTEGER;
ALTER TABLE office_subscription ADD COLUMN thawani_session_id TEXT;
ALTER TABLE office_subscription ADD COLUMN thawani_invoice TEXT;
ALTER TABLE office_subscription ADD COLUMN thawani_payment_id TEXT;
ALTER TABLE office_subscription ADD COLUMN auto_renew INTEGER DEFAULT 0;
ALTER TABLE office_subscription ADD COLUMN cancelled_at INTEGER;
```

New `plan_code` values: `monthly | quarterly | semi-annual | annual`. Legacy `starter-70` continues to work.

### 3.2 `office` — extend

```sql
ALTER TABLE office ADD COLUMN current_plan TEXT;
ALTER TABLE office ADD COLUMN subscription_expires_at INTEGER;
ALTER TABLE office ADD COLUMN thawani_customer_id TEXT;
```

### 3.3 New table: `payment_event`

```sql
CREATE TABLE payment_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,            -- 'office_subscription' | 'request'
  subject_id INTEGER NOT NULL,
  thawani_session_id TEXT,
  event_type TEXT NOT NULL,              -- session_created | webhook_received | fetch_verified | paid | failed | expired | refunded
  raw_json TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_payment_event_subject ON payment_event(subject_type, subject_id);
CREATE INDEX idx_payment_event_session ON payment_event(thawani_session_id);
```

Drives idempotency (Thawani webhooks aren't signed — dedupe on `(session_id, event_type)`) AND the admin payment-history view.

### 3.4 Claim quota — no new table

In the claim handler:

```js
const monthStart = startOfCurrentMonthUnix();
const used = await countClaimsSince(officeId, monthStart);
if (used >= plan.claim_quota) return res.status(402).json({ ok:false, reason:'quota_exceeded' });
```

Plus active-subscription check (block claims if `subscription_expires_at < now`).

## 4. Subscription lifecycle

1. Office hits paywall → picks plan → `POST /api/payments/sub/start`.
2. Server: create `office_subscription` row (`payment_status='pending'`) + `POST` Thawani `/api/v1/checkout/session` → return hosted-checkout URL.
3. Office redirected to `checkout.thawani.om/pay/{session_id}`.
4. After pay: Thawani redirects to `/pay/sub/success?session_id=...` AND fires webhook to `/api/payments/webhook`.
5. Server (both paths converge on the same function): `GET` Thawani `/api/v1/checkout/session/{id}` as source of truth. If `paid` and not already finalized:
   - flip `office_subscription.payment_status='active'`
   - compute `starts_at`/`expires_at`
   - `UPDATE office` with `current_plan`, `subscription_expires_at`, `subscription_status='active'`
   - write `payment_event` row (`event_type='paid'`)
   - send WhatsApp confirmation.
6. Daily cron (`lib/subscription_watcher.js`):
   - subs expiring in 7/3/1 days → reminder + pre-filled checkout link.
   - subs past `expires_at + grace` → flip `office.subscription_status='expired'`, block claims.

**Idempotency**: success redirect + webhook call the same `finalizeSubscriptionPayment(session_id)`. Re-fetch Thawani, check `payment_event`, no-op if already finalized.

## 5. Citizen payment flow

Already implemented end-to-end. Polish only:

1. Default provider → `thawani`.
2. Register `sanad_payment_link` template on Meta; replace plain-text outbound with `sendWhatsAppTemplate`.
3. Surface citizen payments in admin dashboard (no schema change).

## 6. Admin dashboard

Single page `/admin.html` extended with these sections:

- **KPI strip** — active subs, MRR, expiring in 7d, citizen payments today, OMR collected today.
- **Subscriptions table** — Office | Plan | Started | Expires | Status | Auto-renew | Actions. Filters: status, plan, governorate.
- **Citizen payments table** — Date | Citizen | Service | Office | Amount | Status | Session ID. Filters: date, office, status.
- **Payment events log** — last 200 rows of `payment_event` for debugging/audit.

New admin routes:

```
GET  /api/platform-admin/subscriptions
GET  /api/platform-admin/subscriptions/:id
POST /api/platform-admin/subscriptions/:id/extend
POST /api/platform-admin/subscriptions/:id/cancel
GET  /api/platform-admin/payments
GET  /api/platform-admin/payments/events
GET  /api/platform-admin/payments/kpis
```

## 7. New routes — full list

```
POST /api/payments/sub/start         { plan_code } -> { checkout_url, session_id }
GET  /api/payments/sub/status?id=    poll while pending
GET  /pay/sub/success                redirect target — finalizes
GET  /pay/sub/cancel                 redirect target — shows cancel
POST /api/payments/webhook           extended — also handles subscription subject
```

## 8. Phasing

| Phase  | Scope                                                            | Estimate         |
| ------ | ---------------------------------------------------------------- | ---------------- |
| **P1** | Schema + plans config (this PR)                                  | 0.5 day          |
| **P2** | Checkout flow + webhook + idempotent finalize                    | 1 day            |
| **P3** | Claim quota + expiry watcher                                     | 1 day            |
| **P4** | Admin dashboard tables + KPIs                                    | 1–2 days         |
| **P5** | WhatsApp template wiring                                         | 0.5d + Meta lag  |
| **P6** | Auto-renew (saved cards, payment_intents, dunning)               | 3–4 days, opt-in |

## 9. Env vars

```
THAWANI_ENV=sandbox|production           ✅ exists
THAWANI_SECRET_KEY=                      ✅ exists
THAWANI_PUBLISHABLE_KEY=                 ✅ exists
THAWANI_WEBHOOK_SECRET=                  ✅ exists (unused — no signing)
PUBLIC_BASE_URL=https://saned.ai         ✅ exists
SUBSCRIPTION_REMINDER_DAYS=7,3,1         🆕
SUBSCRIPTION_GRACE_PERIOD_HOURS=24       🆕
SUBSCRIPTION_WATCHER_INTERVAL_S=3600     🆕
SANAD_SUBS_V1=true                       🆕 feature flag
SANAD_SUBS_AUTORENEW=true                🆕 (Phase 6, default off)
```

## 10. Open questions / risks

1. Thawani webhook payload schema undocumented — we log raw payloads to `payment_event.raw_json` and adjust. Re-fetch pattern makes us schema-drift-tolerant.
2. Render's filesystem persistence — SQLite on mounted disk survives restarts but not service recreation. Recommend Turso for true production (separate decision).
3. 3DS for auto-renew (P6) — Thawani may return a `redirect_url` from intent confirm; handle via WhatsApp link.
4. Refund window — undocumented. Admin refund button + ops escalation note.
5. Meta template approval — ~24-48h. Runs in parallel.

## 11. Testing

- **Unit**: `lib/plans.js`, expiry math, quota SQL. Extend `features/payment-checkout/payments.test.js`.
- **Integration**: stub Thawani client, full subscribe→pay→expire→renew against in-memory libSQL.
- **Sandbox e2e**: `uatcheckout.thawani.om`, test card `4242 4242 4242 4242`, all 4 tiers.
- **Manual**: admin tables/filters click-through.

## 12. Rollout

1. PR 1 — schema migrations + `lib/plans.js` (no behavior change).
2. PR 2 — subscription checkout + webhook (behind `SANAD_SUBS_V1`).
3. PR 3 — quota gate + expiry watcher.
4. PR 4 — admin dashboard.
5. PR 5 — WhatsApp template (after Meta approval).
6. PR 6 — auto-renew (behind `SANAD_SUBS_AUTORENEW`, default off).

Each PR independently testable, deployable, and reversible via flag.
