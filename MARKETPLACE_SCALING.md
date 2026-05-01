# Saned Marketplace — Unified Design (v3, Office-Review Flow)

> Canonical design doc for the request → office checkout → review → payment → completion lifecycle. Supersedes v2. Folds in Ali's revised flow (15-min office review, 3-action review panel, 15-min citizen payment window, 45-min completion).
>
> **Locked rules** (no longer up for debate):
> 1. **Pricing is fixed at the catalog level.** Defaults: `office_fee = 5 OMR`, `government_fee = 15 OMR`. No bidding, no per-office quotes.
> 2. **Citizen sees status, not options.** No office choice, no marketplace UI on the citizen side. Apply → wait → pay → progress → done.
> 3. **Citizen is anonymous to office identity.** Receipts, status updates, chat thread, message bubbles all use platform voice.
> 4. **First-come-first-served checkout.** Any eligible online office can atomically claim a request. No price-bidding, no push window.
>
> Source-of-truth references throughout point to current files. No code changed yet.

---

## 0. Stress test scenario (re-anchored)

100 offices online, 10 citizens submit 10 requests in the same minute. Under the new flow, the questions are:

1. Which of the 100 offices is **eligible** (online, has capacity, in-region) to **check out** each request?
2. **Who gets it first** under FCFS — is the atomic claim race-safe and fair?
3. What does the **office** do during the 15-min review window, and what happens if they don't act?
4. How does a **rejected / released / docs-missing** request flow back to the pool without confusing the citizen?
5. How fast does the **citizen** see meaningful status, while never seeing the office?

The marketplace is a job board with **explicit per-stage clocks**, not an auction.

---

## 1. Today's marketplace inbox (still broken under any model)

`GET /api/officer/inbox` ([routes/officer.js:109-240](routes/officer.js:109)) and the marketplace block ([routes/officer.js:131-161](routes/officer.js:131)) is one query:

```sql
SELECT … FROM request r
WHERE r.status = 'ready'
ORDER BY r.created_at ASC
LIMIT 50;
```

Missing today, all still required:

- **Governorate filter** — Dhofar offices see Muscat requests with no signal.
- **Service category / specialty** — `office.specialties` doesn't exist as a column.
- **Subscription / credits** — even an office with `credits_remaining = 0` sees the marketplace; only blocked at offer-submission ([routes/officer.js:368-378](routes/officer.js:368)).
- **Capacity** — an office with 47 active claims sees fresh requests like everyone else.
- **Online status** — no "checked-in" concept.

`ORDER BY created_at ASC` is also wrong direction. ~160 q/s of busy-poll just to render an inbox at 100 offices × ~0.4 Hz × 4 sub-queries.

---

## 2. The offer mechanic dies entirely

Both citizen-facing offer endpoints get deleted:

- HTTP `GET /api/chat/:session_id/request/:id/offers` ([routes/chat.js:320-346](routes/chat.js:320)) — gone.
- HTTP `POST /api/chat/:session_id/request/:id/offers/:offerId/accept` ([routes/chat.js:352-465](routes/chat.js:352)) — gone.
- Bot tools `list_offers` + `accept_offer` ([lib/agent_tools.js:912-979](lib/agent_tools.js:912)) — gone.
- Officer-side `POST /api/officer/request/:id/offer` ([routes/officer.js:341-440](routes/officer.js:341)) — repurposed as `POST /:id/checkout` (atomic claim, no fee body).

`request_offer` table — not even repurposed. **Drop it.** Audit trail moves to `audit_log` (offices already write `request_claim`, `request_release`, `request_reject` events there).

---

## 3. Race conditions still real (model-independent)

Survives the pivot because they're correctness gaps in the *award* path:

- **Two ACCEPT paths in current code**, only one is atomic. The agent-tool path at [lib/agent_tools.js:927-979](lib/agent_tools.js:927) has no status guard and a TOCTOU credit deduction. **Fix**: extract one shared `awardRequest()`. Even though the offer flow is gone, the same atomicity pattern applies to the new `checkout` action.
- **Sibling cleanup never happens.** `cancel_request` ([lib/agent_tools.js:993-1008](lib/agent_tools.js:993)) and SLA sweep ([lib/sla.js:67-180](lib/sla.js:67)) only mutate `request`. With `request_offer` gone this risk evaporates — but any new "interest" or "hold" rows must be swept on terminal status.
- **No capacity throttle** ([routes/officer.js:341-378](routes/officer.js:341)). Only `credits_remaining > 0` gates work.
- **`claimed → in_progress` on first chat message** ([routes/officer.js:509-515](routes/officer.js:509)) — flips status before payment, prematurely starts the 45-min work-SLA. Remove this auto-flip; status only advances on payment.
- **Cancel race**: no status guard on cancel UPDATE in [lib/agent_tools.js:993-1008](lib/agent_tools.js:993). Concurrent cancel + complete leaves an inconsistent row.

---

## 4. Office UX gaps (model-independent)

- Sort `created_at ASC` (wrong direction).
- No filter UI; API doesn't accept any.
- `LIMIT 50` permanent — at 1,000 open requests, oldest 50 forever.
- "Did I lose?" — `my_offers` ([routes/officer.js:196-209](routes/officer.js:196)) returns only `pending`, so other status changes silently disappear.
- "Is this still open?" — only by polling.

All carried into the new design's officer dashboard.

---

## 5. Fixed-price model (locked)

### 5.1 Two fees on the catalog
- `service_catalog.office_fee_omr` REAL — default **5 OMR** when NULL at read time.
- `service_catalog.government_fee_omr` REAL — default **15 OMR** when NULL. Renamed from existing `fee_omr`.
- **Total = office_fee + government_fee.** Always.

### 5.2 Snapshot at request creation
At `submit_request` / `/apply` time the request copies values from the catalog so historical requests preserve the price they were created at:

```
request.office_fee_omr     = COALESCE(svc.office_fee_omr,      5)
request.government_fee_omr = COALESCE(svc.government_fee_omr, 15)
request.payment_amount_omr = office_fee + government_fee
```

### 5.3 Single read helper
```js
// lib/marketplace.js
export function resolveServiceFees(svcRow) {
  return {
    office_fee_omr:     svcRow.office_fee_omr     ?? 5,
    government_fee_omr: svcRow.government_fee_omr ?? 15,
    total_omr: (svcRow.office_fee_omr ?? 5) + (svcRow.government_fee_omr ?? 15),
  };
}
```

Used by `submit_request`, `/apply`, payment-link generation, and catalogue browse.

### 5.4 What citizens see
- Pre-payment: no fee shown until the office sends the payment link.
- Payment screen: total only by default. Optional `SHOW_FEE_BREAKDOWN_TO_CITIZEN` flag for "15 service · 5 platform" disclosure.
- Receipt: itemized but anonymous (§11).

### 5.5 `office_service_price` legacy table
Repurpose or drop. Recommended: **drop it**. Catalog edits go through admin UI directly on `service_catalog`. Remove the column from inbox queries.

### 5.6 `request.quoted_fee_omr` legacy
- In-flight rows: leave alone.
- New rows: don't write.
- Read paths: prefer `payment_amount_omr`.
- Drop after in-flight requests drain (~30 days post-launch).

---

## 6. Lifecycle state machine (NEW — the heart of v3)

### 6.1 States

| Status | Meaning | Owner of next transition |
|---|---|---|
| `draft / collecting / reviewing` | In-bot session, no row yet | Citizen (via bot) |
| `pending_review` | Row exists, in the office pool, no office has checked out | Office (next eligible to check out) |
| `under_review` | Office has checked out; 15-min review clock running | Office |
| `awaiting_documents` | Office sent "missing/invalid docs" — citizen must respond | Citizen |
| `awaiting_payment` | Office sent payment link — citizen has 15-min window | Citizen |
| `expired_payment` | Citizen didn't pay in 15 min — request returned to pool | System (transient → `pending_review`) |
| `in_progress` | Citizen paid — office has 45-min completion clock | Office |
| `on_hold` | Office paused mid-completion (portal down, citizen OTP, etc.) | Office (or auto-resume after 4h) |
| `completed` | Done | terminal |
| `rejected_by_office` | Office hard-rejected the request as invalid | terminal |
| `cancelled_by_citizen` | Citizen cancelled before payment | terminal |
| `refund_pending` | Citizen requested cancel after payment | Office (decision) |
| `refunded` | Refund processed | terminal |
| `expired_documents` | Citizen didn't fix docs in 24h — request returned to pool | System (transient → `pending_review`) |

### 6.2 Transitions

```
                     submit_request / /apply
draft ─collecting─reviewing ───────────────► pending_review
                                                  │
                                                  │ office checkout (FCFS atomic)
                                                  ▼
                                            under_review ──┬── send_payment ────► awaiting_payment
                                            (15-min clock)  │                          │
                                                            │                          │ pay (≤15min)
                                                            │                          ▼
                                                            │                    in_progress
                                                            │                    (45-min clock)
                                                            │                          │
                                                            │ request_documents      │ complete
                                                            ▼                          │
                                                      awaiting_documents               ▼
                                                      (24-h clock, citizen)        completed
                                                            │
                                                            │ docs returned
                                                            ▼
                                                      under_review (fresh 15-min clock)
                                                            │
                                                            │ release (3c soft)
                                                            ▼
                                                      pending_review (releaser cooldown 5min)
                                                            │
                                                            │ reject (3c hard)
                                                            ▼
                                                      rejected_by_office
                                                            │
                                                            │ 15-min review timeout
                                                            ▼
                                                      pending_review (auto-release)

awaiting_payment ─15min payment timeout─► expired_payment ─► pending_review
in_progress      ─45min completion timeout─► pending_review (transfer; payment preserved)
in_progress      ─hold─► on_hold ─resume─► in_progress  (timer paused)
in_progress      ─4h hold cap─► auto-resume; if still stuck, transfer
awaiting_documents ─24h timeout─► expired_documents ─► pending_review
* (pre-pay)      ─cancel_request─► cancelled_by_citizen
in_progress      ─cancel_request─► refund_pending ─decision─► refunded | in_progress (rejected)
```

### 6.3 Triggers + actor table

| Transition | Triggered by | Surface | File / function |
|---|---|---|---|
| `pending_review → under_review` | Office | `POST /api/officer/request/:id/checkout` | new in [routes/officer.js](routes/officer.js); helper `awardRequest` in `lib/marketplace.js` |
| `under_review → awaiting_payment` (3a) | Office | `POST /api/officer/request/:id/send-payment` | renamed from current `/payment/start` ([routes/officer.js:991](routes/officer.js:991)) |
| `under_review → awaiting_documents` (3b) | Office | `POST /api/officer/request/:id/request-documents` | new — body: `{ missing: ["civil_id_clearer", …], note }` |
| `under_review → pending_review` (3c soft) | Office | `POST /api/officer/request/:id/release` | new — sets 5-min same-office cooldown, `abandonment_count++` |
| `under_review → rejected_by_office` (3c hard) | Office | `POST /api/officer/request/:id/reject` | new — body: `{ reason }`. Citizen notified, no credit charge |
| `under_review → pending_review` (15-min timeout) | System (SLA) | none — auto | `lib/sla.js::sweepReviewTimeout` |
| `awaiting_documents → under_review` | Citizen | `POST /api/chat/:session_id/request/:id/refresh-documents` (web) or bot upload | new in [routes/chat.js](routes/chat.js); resumes 15-min review clock fresh |
| `awaiting_documents → pending_review` (24h) | System | auto | `lib/sla.js::sweepDocFixTimeout` |
| `awaiting_payment → in_progress` | System | Amwal webhook | `routes/payments.js::markRequestPaid` ✅ already correct |
| `awaiting_payment → pending_review` (15-min) | System | auto, payment-link voided, request re-pooled | `lib/sla.js::sweepPaymentTimeout` |
| `in_progress → completed` | Office | `POST /api/officer/request/:id/complete` | ✅ already exists ([routes/officer.js:568](routes/officer.js:568)) |
| `in_progress → on_hold` | Office | `POST /api/officer/request/:id/hold` | new — body: `{ reason: 'portal_down'\|'citizen_otp_pending'\|'citizen_unreachable'\|'manual_review' }` |
| `on_hold → in_progress` | Office | `POST /api/officer/request/:id/resume` | new — clock resumes from where it paused |
| `on_hold → in_progress` (auto, 4h) | System | auto | `lib/sla.js::sweepHoldTimeout` |
| `in_progress → pending_review` (45-min) | System | auto, payment preserved, no credit refund | existing `lib/sla.js` post-pay-transfer logic; **delete the citizen notification at [lib/sla.js:175](lib/sla.js:175)** |
| `* (pre-pay) → cancelled_by_citizen` | Citizen | `POST /api/citizen/request/:id/cancel` | new — sweeps any same-office cooldown |
| `in_progress → refund_pending` | Citizen | `POST /api/citizen/request/:id/cancel` | new |
| `refund_pending → refunded \| in_progress` | Office (decision) or admin override | `POST /api/officer/request/:id/refund-decision` | new |

### 6.4 Atomic checkout (FCFS)

```sql
UPDATE request
   SET status = 'under_review',
       office_id = ?, officer_id = ?,
       review_started_at = datetime('now'),
       last_event_at = datetime('now')
 WHERE id = ?
   AND status = 'pending_review'
   AND id NOT IN (
     SELECT request_id FROM office_release_cooldown
      WHERE office_id = ? AND expires_at > datetime('now')
   );
```

`rowsAffected = 0` → 409 to the loser. Same atomic-UPDATE pattern as today's correct path at [routes/chat.js:374-385](routes/chat.js:374). The cooldown sub-query enforces 3c-soft penalty without needing a separate flag on the request row.

### 6.5 Eligibility predicate (for the inbox + checkout)

An office can **see and check out** a request when **all** of:

```
office.online_status         = 'online'
office.status                = 'active'
office.subscription_status   = 'active'
capacity_headroom(office)    >= 1
governorate_in_visibility_tier(request, office, age_minutes)
NOT in office_release_cooldown(request, office)   -- 5-min same-office cooldown after release
NOT abandonment_suspended(office)                  -- reputation threshold; see §12
-- credits_remaining check intentionally absent in MVP; column + ledger kept dormant
-- so credits can be re-introduced in a later iteration without schema migration.
```

`capacity_headroom = max(0, plan_cap − count(*) where status IN
('under_review','awaiting_documents','awaiting_payment','in_progress','on_hold','refund_pending'))`.

Plan caps: Starter 3, Pro 12, Enterprise unlimited.

**Discipline without credits.** All four traditional credit-gates (eligibility, charge-on-send-payment, refund-on-flake, refund-on-cancel) collapse into reputation. See §12 for the full table. The principle: a misbehaving office drops in the inbox sort and gets capacity-throttled; a pattern-of-abuse office is auto-suspended.

### 6.6 Geographic visibility tiers

```
t = 0   min     → same governorate only
t = 5   min     → + adjacent governorates
t = 30  min     → + nationwide
t = 120 min     → admin alert: unclaimable request
```

Where `t = now() − created_at`. Adjacency is a static 30-line map of Oman's 11 governorates. Lives in `lib/marketplace.js::visibilityClause(officeGov, ageMinutes)`.

### 6.7 Inbox sort: ranked, not chronological

`ORDER BY rank_score DESC, created_at ASC`. With credits gone, ranking is the **primary** discipline mechanism — not just a convenience sort:

```
rank_score = office.rating × 4
           + completion_rate_30d × 2
           − abandonment_rate_7d × 4               // heavy negative weight: bad offices sink fast
           − recent_review_breaches × 0.5          // soft signal, decays over 7d
           − recent_work_breaches × 1.5            // heavier than review breaches
           + (60 − time_to_payment_p50_min) × 0.05 // faster offices tilt up
           + governorate_match × 1
           + service_specialty_match × 1
           + rookie_bonus(office)
```

Top-ranked offices see top-of-inbox first; an office with a recent abandonment sinks below newcomers and naturally claims fewer requests until reputation recovers. Combined with the auto-suspension threshold (§12.3), this is the entire MVP discipline stack.

Top-ranked offices see top-of-inbox first. They naturally claim first under FCFS without needing exclusive push windows.

---

## 7. Office workflow + the 3-action review panel

### 7.1 Three lanes in `/officer.html`

1. **🟢 Active pool** (status='pending_review' AND eligible). Cursor-paginated, sorted by `rank_score DESC`. Each card: service, governorate, doc count, age, **Check out** button.
2. **⏱ Under review by me** (status='under_review' AND office_id == me). Big card with a 15-min countdown + 3-action panel:
   - **(a) Approve & send payment** → opens fee-confirm modal (5 + 15 = 20 OMR locked from catalog), generates Amwal link, status → `awaiting_payment`.
   - **(b) Request more documents** → opens form: pick missing slots from a checklist OR free-text reason; sends a templated message to the citizen; status → `awaiting_documents`.
   - **(c) Two split actions:**
       - **Release back to pool** — soft pass, no judgment. Confirmation modal warns about 5-min cooldown + abandonment counter increment.
       - **Reject as invalid** — destructive action; modal asks for reason (enum: `incomplete_unfixable | wrong_service | suspected_fraud | other`); citizen notified.
3. **🛠 In progress** (statuses `awaiting_payment`, `in_progress`, `on_hold`, `awaiting_documents`, `refund_pending`). Bucket UI similar to today, with payment / hold / refund banners. The 45-min completion timer is visible; **Hold** + **Resume** buttons surface in a sub-panel.

### 7.2 What's removed from `/officer.html`

- "Submit offer" form (no quoting).
- "My offers" lane (no offers).
- Any `name_en/name_ar` references to **other** offices (read-only competitor view dropped).

### 7.3 SSE notifications (drops polling for state changes)

Channels:

| Channel | Events |
|---|---|
| `office:<id>` (private) | `request.assigned_to_you` (after checkout), `review.timeout_warning` (12 of 15 min elapsed), `review.timed_out` (auto-released), `payment.received`, `payment.expired_returned_to_pool`, `request.refund_requested`, `request.transferred_to_you` (post-pay 45-min transfer), `claim.lost` (someone else got there first) |
| `gov:<governorate>` (broadcast) | `request.created`, `request.entered_pool`, `request.claimed_by_other`, `request.completed`, `request.expired` |

Not a hard requirement for v1 — polling fallback is acceptable; SSE is a low-risk add via in-process emitter, no extra dep.

### 7.4 Office check-in / heartbeat

`office.online_status` enum (`online | away | offline`), `office.last_heartbeat_at`, plus three endpoints:
- `POST /api/officer/checkin` — flips to `'online'`.
- `POST /api/officer/checkout` — flips to `'offline'`.
- `PATCH /api/officer/heartbeat` — every 30s while dashboard is in foreground.

Background sweep: `'online' → 'away'` after 90s no heartbeat; `'away' → 'offline'` after 5 min.

Eligibility predicate (§6.5) requires `online`. An office that walks away from the dashboard stops getting requests automatically.

---

## 8. Citizen experience — anonymous status timeline

### 8.1 Canonical citizen-side messages by status

| Status | Citizen sees |
|---|---|
| `pending_review` | "📨 طلبك مُسلَّم. سنبدأ المراجعة قريباً." / "Your request is in. We'll start reviewing shortly." |
| `under_review` | "🔍 طلبك قيد المراجعة." / "Your request is being reviewed." (no office name, no review-timer surfaced) |
| `awaiting_documents` | "📋 نحتاج بعض المستندات الإضافية: [list of missing items + free-text note]. أرسلها في هذه المحادثة." / "We need a few more documents: [list]. Send them in this chat." (24-h soft deadline shown) |
| `awaiting_payment` | "💳 طلبك جاهز. ادفع لتأكيد المعاملة. الإجمالي 20.000 OMR. ينتهي رابط الدفع خلال 15 دقيقة." / "Your request is ready. Pay 20.000 OMR to confirm. Payment link expires in 15 minutes." |
| `expired_payment` | "⏰ انتهت مهلة الدفع. أعدنا طلبك إلى قائمة المراجعة وسنُخطرك عند جاهزيته." / "Your payment window expired. We've returned your request to the queue — we'll notify you when it's ready again." |
| `in_progress` | "✅ تم استلام الدفعة. نُنفّذ معاملتك الآن." / "Payment received. We're working on it." (no office name) |
| `on_hold` | "🟡 ننتظر تأكيداً إضافياً قبل المتابعة." / "We're waiting on additional verification before we continue." (vague — see open question Q14) |
| `completed` | "✅ اكتملت معاملتك. الإيصال مرفق." / "Your request is complete. Receipt attached." |
| `rejected_by_office` | "نأسف، تعذّر علينا قبول طلبك. السبب: [reason]. يمكنك التقديم مرة أخرى بعد التصحيح." / "We couldn't accept your request. Reason: [reason]. You may re-apply after correcting." |
| `cancelled_by_citizen` | "✅ ألغينا طلبك." / "Your request has been cancelled." |
| `refund_pending` | "📬 طلب الإلغاء قيد المراجعة. سنُخطرك بالقرار." / "Your cancellation request is being reviewed. We'll notify you of the decision." |
| `refunded` | "✅ تم الإلغاء واسترداد المبلغ بالكامل/جزئياً (X OMR)." / "Cancelled. Refund of X OMR processed." |

### 8.2 Two SLA-driven transitions are SILENT to the citizen
1. **15-min review timeout** (`under_review → pending_review`): no message. Status display goes from "being reviewed" back to "in queue" — but if both are summarized under the same UI label ("being reviewed"), the citizen sees nothing change.
2. **45-min post-pay transfer** (`in_progress → pending_review` with payment preserved): no message — anonymity rule. Citizen continues to see "we're working on it" while the transfer happens silently.

This means the citizen-facing status mapper collapses several DB statuses into the same display label. Implemented as `mapStatusForCitizen(status)` in `lib/citizen_view.js` (new helper).

### 8.3 Bot tool list shrinks
Citizen-side agent ([lib/agent_tools.js TOOL_SPEC_V2](lib/agent_tools.js:272)) loses: `list_offers`, `accept_offer`. Adds: `submit_documents` (for the awaiting_documents path).

---

## 9. Cancellation & refund paths (expanded for new states)

### 9.1 Pre-payment cancel — free
Allowed states: `pending_review`, `under_review`, `awaiting_documents`, `awaiting_payment`, `expired_payment`.

- `request.status = 'cancelled_by_citizen'`, `cancelled_at = now`.
- If `under_review`: office gets `request.cancelled_by_citizen` SSE event. No abandonment penalty.
- If `awaiting_payment`: payment link voided (or just expires harmlessly).
- No refund logic — no money taken.

### 9.2 Post-payment cancel — refund flow
Allowed states: `in_progress`, `on_hold`, `awaiting_documents` post-payment edge case.

- Citizen confirmation modal: "إذا بدأت المعالجة، قد لا يكون الاسترداد كاملاً. هل تريد المتابعة؟"
- `request.status = 'refund_pending'`, `cancel_requested = 1`, `cancel_reason`.
- New `refund_request` row (see §10.1).
- Office sees a yellow banner; chooses **Approve full / Approve partial / Reject**.
  - **Approve full** → `refund_status='approved_full'`, refund 100% via Amwal, status → `refunded`. (No credit movement in MVP — credits dormant.)
  - **Approve partial** → `refund_status='approved_partial'`, partial refund (officer enters amount). Status → `completed` (work done = partial).
  - **Reject** → `refund_status='rejected'`, status → `in_progress`, citizen notified. Citizen can escalate to admin.
- **Admin override** within 7 days.

### 9.3 Post-completion: not allowed
Once `completed`, no cancel. Citizen complaint flow → dispute system (out of scope).

---

## 10. Data model deltas (revised)

### 10.1 Schema

```sql
-- service_catalog: split fees, defaults at read time
ALTER TABLE service_catalog ADD COLUMN office_fee_omr     REAL;          -- default 5 if NULL
ALTER TABLE service_catalog RENAME COLUMN fee_omr TO government_fee_omr; -- default 15 if NULL

-- office: check-in / capacity / specialty / reputation / cooldown
ALTER TABLE office ADD COLUMN online_status            TEXT DEFAULT 'offline';   -- online|away|offline
ALTER TABLE office ADD COLUMN last_heartbeat_at        TEXT;
ALTER TABLE office ADD COLUMN specialty_entities       TEXT;                     -- JSON, e.g. ["ROP","MOH"]
ALTER TABLE office ADD COLUMN concurrent_cap           INTEGER DEFAULT 12;
-- Reputation columns (the entire MVP discipline mechanism — no credits)
ALTER TABLE office ADD COLUMN completion_rate_30d      REAL;                     -- materialized
ALTER TABLE office ADD COLUMN abandonment_rate_7d      REAL DEFAULT 0;           -- normalized 0..1
ALTER TABLE office ADD COLUMN review_breach_count_7d   INTEGER DEFAULT 0;
ALTER TABLE office ADD COLUMN work_breach_count_7d     INTEGER DEFAULT 0;
ALTER TABLE office ADD COLUMN time_to_payment_p50_min  INTEGER;                  -- median minutes checkout → send-payment
ALTER TABLE office ADD COLUMN time_to_complete_p50_min INTEGER;                  -- median minutes paid_at → completed_at
ALTER TABLE office ADD COLUMN citizen_rating_avg       REAL;                     -- 0..5, when CSAT ships
-- credits_remaining + credits_total_used columns + credit_ledger table KEPT in schema (dormant in MVP)
-- Re-enable later by re-introducing the gate at /send-payment without schema migration.

-- request: review/payment/hold clocks + new states + reject reason
ALTER TABLE request ADD COLUMN review_started_at      TEXT;          -- 15-min review clock anchor
ALTER TABLE request ADD COLUMN payment_link_sent_at   TEXT;          -- 15-min payment clock anchor
ALTER TABLE request ADD COLUMN docs_requested_at      TEXT;          -- 24-h doc-fix clock anchor
ALTER TABLE request ADD COLUMN hold_started_at        TEXT;          -- 4-h hold cap anchor
ALTER TABLE request ADD COLUMN hold_reason            TEXT;
ALTER TABLE request ADD COLUMN hold_paused_remaining_s INTEGER;      -- elapsed work-clock paused for hold
ALTER TABLE request ADD COLUMN reject_reason          TEXT;          -- enum + free-text
ALTER TABLE request ADD COLUMN released_count         INTEGER DEFAULT 0;
ALTER TABLE request ADD COLUMN refund_status         TEXT;
ALTER TABLE request ADD COLUMN refund_amount_omr     REAL;
-- request.office_fee_omr / government_fee_omr already exist; populate from catalog snapshot at creation

-- New: 5-min cooldown after release
CREATE TABLE office_release_cooldown (
  id           INTEGER PRIMARY KEY,
  office_id    INTEGER NOT NULL REFERENCES office(id),
  request_id   INTEGER NOT NULL REFERENCES request(id),
  released_at  TEXT DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  UNIQUE(office_id, request_id)
);
CREATE INDEX idx_cooldown_lookup ON office_release_cooldown(office_id, expires_at);

-- New: refund decisions
CREATE TABLE refund_request (
  id              INTEGER PRIMARY KEY,
  request_id      INTEGER NOT NULL REFERENCES request(id),
  requested_at    TEXT DEFAULT (datetime('now')),
  requested_amount_omr REAL NOT NULL,
  decision        TEXT,         -- pending|approve_full|approve_partial|reject|admin_override
  decision_at     TEXT,
  decided_by      INTEGER,
  decided_by_kind TEXT,         -- 'officer'|'admin'
  refund_ref      TEXT,         -- Amwal refund reference
  notes           TEXT
);
```

### 10.2 Drop `request_offer` entirely
No longer needed under FCFS checkout. Audit trail moves to `audit_log` events: `request_checkout`, `request_release`, `request_reject`, `request_documents_requested`, `payment_link_sent`, `request_held`, `request_resumed`, `request_completed`, `request_transferred`, `refund_decision`.

### 10.3 `request.quoted_fee_omr` legacy
Per §5.6.

---

## 11. Citizen-side anonymity — leak inventory (locked from v2, still applies)

**Hard rule: no office name, logo, contact, or officer name on any citizen surface.**

### 11.1 Routes / API responses

| File / line | Leak | Change |
|---|---|---|
| [routes/chat.js:230](routes/chat.js:230) (`GET /my-requests`) | `off.name_en/_ar AS office_name_en/_ar` | **Remove** the JOIN columns. |
| [routes/chat.js:265](routes/chat.js:265) (`GET /my-request/:id`) | Same | **Remove**. |
| [routes/chat.js:320-346](routes/chat.js:320) (`GET .../offers`) | Whole endpoint | **Delete** — no offer concept. |
| [routes/payments.js:130, 149-150](routes/payments.js:130) | `office_name_en/_ar` in payment payload | **Remove**. |
| [routes/debug.js:130, 186](routes/debug.js:130) | Bot message names the office | **Replace** with passive copy. |
| [lib/agent.js:723-724](lib/agent.js:723) | "المكتب المتولّي: <name>" | **Replace** with status-only line. |
| [lib/agent_tools.js:249, 883, 901, 916](lib/agent_tools.js:249) | `o.name_en AS office_name` joined into citizen-facing returns | **Remove** the JOIN. |

### 11.2 SLA / system messages

| File / line | Leak | Change |
|---|---|---|
| [lib/sla.js:175](lib/sla.js:175) (post-pay-transfer notification) | "طلبك المدفوع يُحوَّل تلقائياً إلى مكتب آخر" | **Delete entirely.** Handoff is invisible to citizen. |

### 11.3 HTML templates

| File / line | Leak | Change |
|---|---|---|
| [public/account.html:569](public/account.html:569) | `req.office_name_*` in list | **Remove**. |
| [public/request.html:292-294](public/request.html:292) | `#officeName` card | **Delete card.** Replace with status timeline. |
| [public/pay.html:322](public/pay.html:322) | `#officeName` element | **Delete element.** |
| [public/i18n.js](public/i18n.js) | i18n keys imply office attribution | **Audit + remove** offending keys on citizen pages. |

### 11.4 Officer messages → citizen relay
Render all officer messages as **platform voice** (same avatar, same name "ساند / Saned") on `/chat.html` and `/request.html`. Sender metadata in the `message` table stays `actor_type='officer'`; the rendering layer collapses `actor_type IN ('officer','bot','system')` into one bubble.

### 11.5 Receipts
- Completion ([routes/officer.js:597](routes/officer.js:597)) ✅ Already anonymous. Keep.
- Payment confirmation ([routes/payments.js:74-76](routes/payments.js:74)) — **rewrite** to remove "مكتب سند الذي يتولى طلبك" phrase.
- Receipt PDF (when implemented): show service + government entity + total. No office name.

---

## 12. SLA clocks + reputation discipline (no credits in MVP)

### 12.1 SLA timer table

| Clock | Anchor column | Owner | Duration | On breach | Citizen sees | Reputation impact |
|---|---|---|---|---|---|---|
| **Review** | `review_started_at` | Office | 15 min | `under_review → pending_review`; auto-release | nothing (status display unchanged) | `review_breach_count_7d++`, `abandonment_rate_7d` recomputed |
| **Doc-fix** | `docs_requested_at` | Citizen | 24 h | `awaiting_documents → pending_review`; office SSE notified | "💬 لم تصلنا المستندات. أعدنا طلبك إلى قائمة المراجعة." | none (citizen-side breach) |
| **Payment** | `payment_link_sent_at` | Citizen | 15 min | `awaiting_payment → pending_review` (re-pool) | "⏰ انتهت مهلة الدفع. أعدنا طلبك إلى قائمة المراجعة." | none direct; `time_to_payment_p50` is computed only over completed transactions, so this doesn't punish the office |
| **Completion** | `paid_at` | Office | 45 min | `in_progress → pending_review` (transfer); payment preserved | nothing (silent transfer) | `work_breach_count_7d++` (heavier weight in `rank_score`); `abandonment_rate_7d` recomputed |
| **Hold-cap** | `hold_started_at` | System | 4 h | `on_hold → in_progress` (auto-resume); if still stuck, transfer | nothing | none on first occurrence; pattern of holds → `work_breach_count_7d++` (1 per 3 holds, smoothed) |

All clocks live in `lib/sla.js`. Sweep cadence stays 60 s. New sweep functions added per row above.

### 12.2 No credits in MVP — what disciplines offices

Per Ali's MVP scope: **no credit charge anywhere in the flow**. Discipline is reputation-only, with three reinforcing mechanisms:

#### (a) Capacity caps by subscription tier
| Plan | Concurrent claims |
|---|---|
| Starter | 3 |
| Pro | 12 |
| Enterprise | unlimited |

Hard cap. At cap, the office is **invisible** to the marketplace (eligibility predicate, §6.5) until they finish or release something. This is enforced regardless of reputation — even the highest-rated office can't grab work it can't deliver.

#### (b) Reputation-driven dispatch ranking
The score in §6.7 is the entire competitive surface. With credits gone, this is what makes offices visible:

- Bad offices **sink** in the inbox sort. At 100 offices in a governorate, a misbehaving office may not see a request until 30+ better-ranked offices have already passed.
- Reputation feedback is computed in `lib/reputation.js::updateOfficeStats(office_id)` after every state transition.
- All inputs decay over the rolling 7d / 30d windows so an office can recover by behaving well.

#### (c) Hard suspension thresholds
Auto-actions on the office row, by `lib/sla.js` sweep:

| Trigger (rolling 7d) | Action |
|---|---|
| 1 review breach | warning toast on next inbox load; no functional change |
| 3 review breaches OR 1 work breach | **24-h temp suspension** (`subscription_status='suspended'`); active claims released; office sees "your office is paused for 24h due to abandoned work" |
| 5+ breaches OR 3+ work breaches | **hard suspension**; manual review required by platform admin |

Suspension lifts automatically at the 24-h mark for soft cases; hard suspension requires `POST /api/platform-admin/office/:id/reinstate` (existing endpoint pattern).

#### (d) Revenue model without credits
The platform's per-request revenue is not credit-based. It comes from:
1. **Office monthly subscription** — Starter / Pro / Enterprise tiers (Amwal recurring).
2. **Platform commission on the fixed 5 OMR office fee per completed request** — taken at payout reconciliation, not per-checkout.
3. **AmwalPay take rate** — same as today, on the 20 OMR collected from the citizen.

This means an office that claims-and-abandons costs the platform nothing in revenue terms (no credit refund logic to manage), and the discipline machinery exists only to protect citizen experience and office quality, not platform billing.

### 12.3 Reputation feedback loop

After every state transition, the helper `lib/reputation.js::updateOfficeStats(office_id)` recomputes:

```
abandonment_rate_7d   = (review_breaches + 2 × work_breaches) / max(1, total_claims)  in last 7d
review_breach_count_7d = COUNT(audit_log: 'sla_review_release' for this office, last 7d)
work_breach_count_7d   = COUNT(audit_log: 'sla_post_pay_transfer' for this office, last 7d)
time_to_payment_p50_min = median(send_payment_at - review_started_at) over completed in 30d
time_to_complete_p50_min = median(completed_at - paid_at) over completed in 30d
completion_rate_30d   = completed / (completed + cancelled_by_office + rejected_by_office) in 30d
citizen_rating_avg    = AVG(rating.stars) over last 100 ratings (when CSAT ships)
```

These flow into `rank_score()` immediately so a misbehaving office drops in the inbox sort within seconds of a breach.

### 12.4 Credits — kept dormant for re-introduction

The `credit_ledger` table and `office.credits_remaining` / `credits_total_used` columns stay in the schema. They are not written to and not read at any gate during MVP. If abandonment patterns force credit-based discipline back in:

- Re-add the predicate `office.credits_remaining >= 1` to §6.5 eligibility.
- Re-add the atomic decrement to `/send-payment` ([routes/officer.js:991](routes/officer.js:991)).
- Re-add refund logic to `lib/sla.js::sweepPaymentTimeout`.

No schema migration required. **One-line bypass in the claim path during MVP** — explicitly comment in `lib/marketplace.js::eligibilityClause` that the credits gate is intentionally absent.

---

## 13. Push dispatcher — KILL recommendation

The previous v2 design recommended a hybrid push → FCFS dispatcher (60s exclusive window to a top-ranked office, then open to FCFS pool). **Kill it under v3.**

Reasoning:
- The new flow is fundamentally FCFS with explicit per-stage clocks. Adding a 60-s push window adds latency and a new state (`dispatched`) for marginal quality benefit.
- Quality signal can move to the inbox sort order (§6.7). Top-ranked offices see top-of-inbox first; under FCFS, they typically claim first anyway.
- Fewer states = fewer race conditions = fewer tests = simpler operator mental model.
- 100×10 stress test still solves cleanly: governorate visibility tier (§6.6) fans out from same-gov to nationwide on a deterministic timer, and capacity throttle (§6.5) caps participation.

If we ever need a quality boost beyond inbox sort, we can add a "fast-lane" preview: the top-ranked office's inbox shows new requests **5 seconds before** they appear to anyone else. Cheap to implement (just a tier-0 visibility window of `office.id == top_ranked_office_id AND age < 5s`), preserves the simple FCFS atomic claim, no new state needed. **Park as a v3.1 enhancement; not in the initial migration.**

---

## 14. File-level migration map

| # | File / function | What changes |
|---|---|---|
| 1 | [lib/db.js — schema block](lib/db.js) | All ALTERs from §10.1; create `office_release_cooldown`, `refund_request`; drop `request_offer`; drop `office_service_price`. |
| 2 | New `lib/marketplace.js` | `resolveServiceFees`, `eligibilityClause`, `visibilityClause`, `rankScore`, `awardRequest` (atomic checkout), `releaseRequest`, `rejectRequest`, `requestDocuments`, `concurrentClaimCount`, `capacityHeadroom`, `rookieBonus`. |
| 3 | New `lib/citizen_view.js` | `mapStatusForCitizen(status)` — collapses several DB statuses to the same display label so silent transitions stay silent. |
| 4 | [lib/sla.js](lib/sla.js) | Add 4 new sweepers: `sweepReviewTimeout` (15-min), `sweepDocFixTimeout` (24-h), `sweepPaymentTimeout` (15-min), `sweepHoldTimeout` (4-h). Existing post-pay-transfer logic stays but: delete the citizen notification at line 175. Each sweeper calls `lib/reputation.js::updateOfficeStats(office_id)` on the affected office. **No credit ledger writes in MVP.** |
| 5 | [lib/agent_tools.js::submit_request:823-873](lib/agent_tools.js:823) | Use `resolveServiceFees`; write `office_fee_omr + government_fee_omr + payment_amount_omr`; status to `pending_review` (renamed from `ready`). Drop `quoted_fee_omr` write. |
| 6 | [lib/agent_tools.js::accept_offer:927-979](lib/agent_tools.js:927) | **Delete.** |
| 7 | [lib/agent_tools.js::list_offers:912-925](lib/agent_tools.js:912) | **Delete.** |
| 8 | [lib/agent_tools.js::cancel_request:981-1009](lib/agent_tools.js:981) | Add status guard. Pre-pay cancel: hard-cancel + sweep cooldowns. Post-pay cancel: route through new refund flow. |
| 9 | [lib/agent_tools.js::get_my_requests, get_request_status](lib/agent_tools.js:876) | Remove `o.name_en AS office_name` JOINs. |
| 10 | New `submit_documents` tool in `lib/agent_tools.js` | Citizen sends new docs via bot — flips `awaiting_documents → under_review` (with fresh 15-min clock). |
| 11 | [lib/agent.js:30-80, 723-724](lib/agent.js:30) | System prompt: strip "show offers", "pick an office", "office X is reviewing". Strip office-naming in status formatter. |
| 12 | [routes/chat.js:39-150](routes/chat.js:39) (`/apply`) | Use `resolveServiceFees`; write fee snapshot; status `pending_review`. |
| 13 | [routes/chat.js:217-315](routes/chat.js:217) (`/my-requests`, `/my-request/:id`) | Strip `office_name_*` JOINs. Status maps via `mapStatusForCitizen`. |
| 14 | [routes/chat.js:320-465](routes/chat.js:320) (`/offers`, `/offers/:id/accept`) | **Delete both endpoints.** |
| 15 | New `POST /api/chat/:session_id/request/:id/refresh-documents` in [routes/chat.js](routes/chat.js) | Web path for citizen-resubmits-docs; flips `awaiting_documents → under_review`. |
| 16 | New `POST /api/citizen/request/:id/cancel` (or fold into chat router) | Pre-pay hard cancel + post-pay refund-request creation. |
| 17 | [routes/officer.js:131-161](routes/officer.js:131) (inbox) | Three lanes (active_pool, under_review_by_me, in_progress). Filter by eligibility + visibility tier. Server-side sort by `rank_score`. Cursor pagination. |
| 18 | [routes/officer.js:341-440](routes/officer.js:341) (`POST /:id/offer`) | **Repurpose** as `POST /:id/checkout` (atomic claim, no fee body). Old endpoint removed. |
| 19 | [routes/officer.js:445-460](routes/officer.js:445) (`POST /:id/offer/withdraw`) | **Delete.** |
| 20 | [routes/officer.js:991-1080](routes/officer.js:991) (`/payment/start`) | Rename to `/send-payment`. Total = `request.payment_amount_omr` (snapshot). Status guard `under_review`. Strip office-name copy in citizen WhatsApp message. **No credit charge in MVP** — credits dormant. |
| 21 | New `POST /api/officer/request/:id/request-documents` in [routes/officer.js](routes/officer.js) | Status `under_review → awaiting_documents`. Body: `{ missing: [], note }`. Notifies citizen via relay. |
| 22 | New `POST /api/officer/request/:id/release` in [routes/officer.js](routes/officer.js) | Status `under_review → pending_review`. Inserts `office_release_cooldown` row. Increments abandonment counter. |
| 23 | New `POST /api/officer/request/:id/reject` in [routes/officer.js](routes/officer.js) | Status `under_review → rejected_by_office`. Body: `{ reason, note }`. Notifies citizen. |
| 24 | New `POST /api/officer/request/:id/hold` and `/resume` in [routes/officer.js](routes/officer.js) | Pause / resume the 45-min completion clock. Body for hold: `{ reason }`. |
| 25 | New `POST /api/officer/request/:id/refund-decision` in [routes/officer.js](routes/officer.js) | Body: `{ decision: 'approve_full' \| 'approve_partial' \| 'reject', amount?, note }`. |
| 26 | [routes/officer.js:509-515](routes/officer.js:509) (`/message`) | Remove auto-flip `claimed → in_progress` on first message. Status only advances on payment. |
| 27 | New `POST /api/officer/checkin`, `/checkout`, `/heartbeat` in [routes/officer.js](routes/officer.js) | Online-status endpoints. |
| 28 | [routes/payments.js:74-76, 128-152](routes/payments.js:74) | Strip office name from confirmation message + payment-link payload. |
| 29 | [routes/debug.js:186](routes/debug.js:186) | Strip office name from simulated bot message. |
| 30 | [public/account.html:569](public/account.html:569) | Strip `office_name_*`. Status timeline only. |
| 31 | [public/request.html:292-294](public/request.html:292) | Delete office card. Status timeline + message thread. |
| 32 | [public/pay.html:322](public/pay.html:322) | Delete office name element. |
| 33 | [public/officer.html](public/officer.html) | Three-lane inbox. 3-action review panel with countdown. Hold/Resume buttons in In-progress lane. Online-status toggle in header. Capacity badge. SSE wiring. |
| 34 | [public/i18n.js](public/i18n.js) | Audit i18n keys for office-attribution leaks. Add new keys for new statuses + 3-action panel + hold reasons. |
| 35 | [scripts/](scripts/) | One-shot migration: backfill `request.office_fee_omr / government_fee_omr` for existing rows; rename existing `status='ready'` → `'pending_review'` and `'claimed'` → `'under_review'` (with caveats — see §15.2). |
| 36 | [tests/](tests/) | New `09-checkout-flow.test.js`, `10-anonymity.test.js`, `11-refund-flow.test.js`, `12-sla-clocks.test.js`. |

---

## 15. Migration sequence

Each step shippable on its own; flag-gate behind `SANAD_FLOW_V3=true` for the dispatcher swap.

| # | Step | Why first | Risk |
|---|---|---|---|
| 1 | **Schema additive migrations** (§10.1, but keep `request_offer` for now) | Foundation; no behavior change. | Low |
| 2 | **`resolveServiceFees` + apply paths use it** | Switches new requests to fixed pricing; no UX impact. | Low |
| 3 | **Anonymity scrub** (§11) | Hard rule. Ship before any UX changes. | Medium — many small touches, each local |
| 4 | **Fix `accept_offer` atomicity** (extract `awardRequest`) | Correctness bug; the same helper becomes the basis for `checkout`. | Low |
| 5 | **Capacity throttle + check-in / heartbeat** (§7.4) | Precondition for new flow. | Low |
| 6 | **New status values + state-machine helpers** in `lib/marketplace.js` (§6.1, §6.4, §6.5) | Skeleton for v3. | Low |
| 7 | **3-action review panel backend**: `/checkout`, `/send-payment` (renamed), `/request-documents`, `/release`, `/reject` (§14 rows 18, 20-23) | Core office workflow. | Medium |
| 8 | **SLA clocks** (§12.1): review (15-min), payment (15-min), doc-fix (24-h), hold (4-h) | Closes the timeout gaps. | Medium |
| 9 | **Citizen flow updates**: status-mapper, `/refresh-documents`, status copy revisions (§8) | Citizen UX matches new states. | Medium |
| 10 | **Refund flow** (§9.2) | Touches money; new table; admin override path. | Medium-high |
| 11 | **Hold + resume** (§14 row 24) | Edge-case workflow; ship after main path solid. | Low |
| 12 | **Citizen-side offer surfaces deletion** (§14 rows 6, 7, 14) | After v3 backend stable. | Medium |
| 13 | **Drop `request_offer` table; drop `office_service_price`** (§10.2) | After in-flight requests drain (~30 days). | Low |
| 14 | **Officer dashboard rebuild** (3-lane, countdown, hold buttons, SSE) | Frontend-heavy, ship after backend stable. | Medium |
| 15 | **Abandonment auto-suspension + monopoly cap + rookie bonus** (§12.3, §6.7) | Policy layers on stable primitives. | Low |
| 16 | **Drop `quoted_fee_omr`** | After in-flight requests drain. | Low |

### 15.2 Status rename caveat
Renaming `'ready' → 'pending_review'` and `'claimed' → 'under_review'` touches every codepath that reads/writes status. Two options:
- **Option A**: Keep DB values `'ready'` / `'claimed'`, add new statuses (`awaiting_documents`, `expired_payment`, etc.) alongside. The state machine stays semantically v3 but the column values look like v2. Lower migration risk, mild semantic confusion.
- **Option B**: Rename. Cleaner long-term, but requires a one-shot UPDATE + every `WHERE status='ready'` audit.

**Recommendation: Option A**. Keep `ready` and `claimed` as DB values; surface new names only in citizen-facing copy and tooling. Ship cleaner names later if it ever matters.

---

## 16. Tests

`tests/09-checkout-flow.test.js`:
- Concurrent `POST /:id/checkout` from two offices → exactly one wins, other 409.
- Office at capacity cap → checkout blocked with `429 too_busy`.
- Office in different governorate at t=0 → checkout 403; same office at t=6min → succeeds.
- Office in `release_cooldown` for that request → checkout blocked.
- Atomic-UPDATE guard: a `claimed` request can't be re-checked-out.

`tests/12-sla-clocks.test.js`:
- 15-min review timeout → status reverts; `review_breach_count_7d++`; **no credit_ledger row** (credits dormant in MVP).
- 15-min payment timeout → status reverts; **no credit_ledger row**; office reputation untouched (citizen-side breach).
- 24-h doc-fix timeout → status reverts; citizen notified.
- 45-min completion timeout → status `in_progress → pending_review`; payment_amount preserved; `work_breach_count_7d++`; **citizen receives no message**.
- 4-h hold-cap → auto-resume, work clock continues from snapshot.

`tests/14-reputation.test.js` (new — discipline mechanism is reputation, so test it):
- Office with `abandonment_rate_7d=0` ranks above identical office with `abandonment_rate_7d=0.3` in the same governorate.
- Office hitting 3 review breaches in 7d → `subscription_status='suspended'` after the 3rd, active claims auto-released.
- Suspension auto-lifts at 24h; office hitting 5+ breaches stays suspended (manual reinstate required).
- `updateOfficeStats` is idempotent (running it twice produces the same numbers).
- `credits_remaining` is never decremented during a full request lifecycle (MVP guarantee).

`tests/10-anonymity.test.js`:
- `GET /api/chat/my-requests` response: assert no `office_name_*` keys.
- `GET /api/chat/my-request/:id` response: same.
- Bot reply formatter: feed an `under_review` request, assert response body contains no `office_name`.
- Officer-side endpoints MAY include office identity (asymmetric).

`tests/11-refund-flow.test.js`:
- Pre-pay cancel: free, no `refund_request` row.
- Post-pay cancel: row in `pending`. Office decision drives final state. Admin override path.

`tests/13-rejection-flow.test.js`:
- Hard reject from `under_review` → status terminal `rejected_by_office`; citizen notified with reason; office reputation unchanged (legitimate rejection is desired behavior).
- Soft release from `under_review` → status `pending_review`; cooldown row inserted; abandonment_count++; same office can't re-check-out for 5 min.

---

## 17. Locked answers (RESOLVED 2026-05-01 by Ali)

All 20 questions below are RESOLVED. These are the binding answers driving the migration steps in §15.

| # | Question | RESOLVED — locked answer |
|---|---|---|
| Q1 | Credit timing / discipline mechanism | **No credits in MVP.** Schema columns kept dormant. Reputation = capacity + ranking + suspension. |
| Q1b | Suspension thresholds | **3 review breaches OR 1 work breach in 7d → 24-h auto-pause; 5+ breaches → hard suspend with manual admin review.** |
| Q2 | Citizen doc-fix clock for `awaiting_documents` | **24 hours.** Timeout → request returned to pool. |
| Q3 | Hold-cap duration | **4 hours, auto-resume.** |
| Q4 | Hold reasons enum | **`portal_down \| citizen_otp_pending \| citizen_unreachable \| manual_review_needed`** + free-text note. |
| Q5 | Soft-release cooldown (3c soft) | **5 minutes** same-office no-reclaim. |
| Q6 | Soft-release reputation weight | **0.5** (lighter than the 1.5 work-breach weight). |
| Q7 | Hard-reject reasons enum | **`incomplete_unfixable \| wrong_service \| suspected_fraud \| other`** + free-text note. |
| Q8 | After hard reject — citizen re-apply path | **Fresh request only.** No auto-resume of the original. |
| Q9 | 15-min review timeout — first-refusal on re-pool? | **None.** Pure FCFS next cycle. |
| Q10 | Push dispatcher | **KILL.** Pure FCFS with ranked inbox sort only. (See §13 for the parked v3.1 idea.) |
| Q11 | Released-to-pool cycle limit | **5 bounces or 2 hours** → admin alert. |
| Q12 | `awaiting_documents` — claim retention | **Same office retains claim, fresh 15-min on resubmit.** |
| Q13 | `awaiting_documents` UX | **Structured checklist + free-text note** (both). |
| Q14 | `on_hold` citizen-side display | **Vague status only** — "waiting on additional verification." Anonymity preserved. |
| Q15 | Payment timeout message | **Return to pool with citizen notification**: "request returned to pool, please re-apply or wait for a new office." |
| Q16 | Multi-office abandonment escalation | **3 consecutive review timeouts** (across different requests on the same office) → admin alert + downweight. |
| Q17 | Refund partial amount | **Office enters, capped at total; admin override window 7 days.** |
| Q18 | Status rename | **Keep DB values; rename only in citizen-facing copy.** |
| Q19 | Hard-reject from `awaiting_documents` | **Allowed** if new docs reveal fraud / wrong service. |
| Q20 | `expired_payment` re-pool | **Pure FCFS, no first-refusal** for previous office. |

---

## 18. Recap

The marketplace pivots to a **clean FCFS office-review flow** with five locked clocks:

```
   [pending_review]
        │
        │ checkout (FCFS atomic)
        ▼
   [under_review] ───── 15min review clock
        ├── send-payment (3a) ──► [awaiting_payment] ───── 15min citizen clock
        │                              │
        │                              ▼ (paid)
        │                          [in_progress] ───── 45min completion clock
        │                              │           ├── hold ──► [on_hold] ── 4h cap
        │                              ▼
        │                          [completed]
        │
        ├── request-documents (3b) ──► [awaiting_documents] ───── 24h citizen clock
        │
        ├── release (3c soft) ──► [pending_review] (5min same-office cooldown)
        │
        └── reject (3c hard) ──► [rejected_by_office]   (terminal)
```

Three locked rules (pricing, citizen-status-only, anonymity) carry over from v2.

The push dispatcher dies; ranked inbox sort replaces it.

`request_offer` table dies; FCFS atomic UPDATE is the whole award path.

**Credits dormant in MVP.** `credit_ledger` table and `office.credits_*` columns stay in the schema for future re-enable; they are not read or written at any gate. Discipline is reputation-only — capacity caps invisibility-throttle bad offices, ranking sinks them in the inbox, and breach thresholds auto-suspend pattern offenders.

Anonymity scrub ships **first** (after schema migrations) so no future change can re-leak office identity. Dispatcher swap ships behind `SANAD_FLOW_V3=true`. Eight migration steps before the dashboard UI rebuild.

**All 20 open questions in §17 are RESOLVED (2026-05-01).** Migration is unblocked.
