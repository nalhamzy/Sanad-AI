# Officer Dashboard — Button & Control Audit

Comprehensive audit of every interactive control in [`public/officer.html`](public/officer.html) (~3070 lines). Generated 2026-05-02.

**Scope:** every clickable button, dropdown, chip, modal trigger, and inline doc-tile action. Each entry documents location, label, JS handler line, the API endpoint hit, expected behaviour, user feedback, and any code-level smells found during the trace.

**Test scenarios per critical button:** happy path + race + error + edge case. Cross-referenced against [`routes/officer.js`](routes/officer.js) endpoint shapes.

---

## Index

| § | Region | # Controls |
|---|---|---|
| 1 | Topbar | 7 |
| 2 | Sidebar nav + quick-claim | 11 |
| 3 | KPI strip + manual refresh | 6 |
| 4 | Filter toolbar (search / sort / facets) | 11 |
| 5 | Inbox card actions | 9 |
| 6 | View mode toggles | 2 |
| 7 | Detail header (close) | 1 |
| 8 | Step strip (visual) | 4 (read-only) |
| 9 | Primary CTA strip | 7 (state-driven) |
| 10 | Secondary toolbar | 4 |
| 11 | Shortcuts bar (post-claim) | 6 |
| 12 | Tabs | 3 |
| 13 | Doc tile actions | 8 |
| 14 | Chat drawer | 6 |
| 15 | Settings modal | 5 |
| 16 | Reclassify modal | 11 |
| 17 | Request-info modal | 7 |
| 18 | Help overlay | 3 |
| 19 | Command palette | 6 |
| 20 | Keyboard shortcuts | 12 |
| 21 | pay.html (citizen-facing test) | 2 |

**Total controls audited:** 132

---

## 1. Topbar

| Label | Selector | Handler | Endpoint | Behavior | Feedback |
|---|---|---|---|---|---|
| ≡ Toggle sidebar | `#toggleSidebar` | line 2630 | — | Show/hide left rail | DOM only |
| 🔔/🔕 Sound | `#soundBtn` | 2639 | `localStorage.sanad.sound` | Toggle audio cues on chat ping / OTP arrival | Toast 1.2 s |
| 🌙 Dark mode | `#themeBtn` | 2634 | `localStorage.sanad.theme` | Toggle `.dark` on `<html>` | Visual swap |
| 🌐 AR/EN | `#langBtn` | 2645 | i18n module | Toggle current language, re-render visible strings | UI flips |
| ⌘K Command palette | `#openCmd` | 2595 | — | Open palette modal | Modal + focus input |
| ❓ Help | `#helpBtn` | 2626 | — | Show keyboard-shortcut overlay | Modal |
| ↗ Logout | `#logoutBtn` | 1058 | `POST /api/auth/logout` | Clear session cookie + redirect | `→ /office-login.html` |

---

## 2. Sidebar nav + quick-claim

| Label | Selector | Handler | Endpoint | Behavior |
|---|---|---|---|---|
| ⚡ Quick claim (next ready) | `#quickClaim` | 2510 | `POST /:id/claim` | Picks the next un-quoted marketplace card and claims it |
| 💰 My pricing | `<a href="/pricing.html">` | — | — | Same-tab nav |
| ⚙ Office settings | `#openSettings` | 2516 | — | Open settings modal |
| 🛒 Marketplace mode | `[data-filter="ready"]` | 2465 | local | Filter pool → unclaimed |
| 📋 طلباتي mode | `[data-filter="mine"]` | 2465 | local | Filter pool → my office's claimed |
| ⏳ بانتظار المواطن (sub) | `[data-filter="waiting"]` | 2465 | local | Sub-filter inside طلباتي |
| ⚠ مهلة قريبة (sub) | `[data-filter="sla"]` | 2465 | local | Requests with SLA < 2 min |
| ✓ مكتمل (sub) | `[data-filter="done"]` | 2465 | local | Filter to completed |
| 💬 محادثة المواطن (تجربة) | `<a target=_blank>` | — | — | New tab → `/chat.html` |
| 📚 دليل الخدمات | `<a>` | — | — | Same-tab → `/catalogue.html` |
| Live activity (read-only) | `#activity` | 2671 | `GET /api/debug/state` (4 s poll) | Latest 6 messages |

**Mode persistence:** active mode written to `localStorage.sanad.officer.mode`. Sub-filters auto-hide when `mine` is not active (CSS).

---

## 3. KPI strip + manual refresh

| Label | Selector | Source | Notes |
|---|---|---|---|
| المستلم اليوم | `#kpi_claimed` | mine.filter(today(claimed_at)).length | — |
| المنجز | `#kpi_done` | mine.filter(today(completed_at)) | — |
| قيد التنفيذ | `#kpi_inflight` | claimed + in_progress | — |
| السوق | `#kpi_mkt` | marketplace.length | — |
| الأرباح التقديرية | `#kpi_money` | sum(today × 0.1 × fee_omr) | Heuristic — replace with real ledger pull when wallet GA's |
| ↻ Refresh | `#refreshBtn` | `loadInbox()` | Skeleton briefly visible |

---

## 4. Filter toolbar

State persisted to `localStorage.sanad.officer.filters` (`{status, age, signal, entity, gov, feeMin, feeMax, sort}`).

| Label | Selector | Behavior |
|---|---|---|
| Search | `#filterInput` | Substring match across `service_name`, `service_name_ar`, `entity_en`, `entity_ar`, `governorate`, `id`, `note`, `payment_ref` |
| Sort dropdown | `#filterSort` | `fresh_first`, `newest` (default), `oldest`, `sla_urgent`, `fee_high`, `fee_low` |
| ↺ إعادة ضبط | `#filterReset` | Clears all facets + search |
| ⚙ تصفية متقدمة | `#filterMoreBtn` | Toggles `#filterAdvanced` row |
| Status chips (5) | `[data-facet="status"]` | claimed / needs_more_info / awaiting_payment / in_progress / completed. **Hidden in marketplace mode** (every unclaimed card is `ready`). |
| Age chips (3) | `[data-facet="age"]` | today / 7d / 30d |
| Signal chips (4) | `[data-facet="signal"]` | 💬 fresh_reply / ✕ rejected_doc (≈ status `needs_more_info`) / 💰 paid / ⚠ sla_warn |
| Entity chips (dynamic) | `.filter-chip[data-facet="entity"]` | Auto-populated from currently visible requests, sorted by count, count badge `·N` |
| Governorate dropdown | `#filterGov` | 11-gov Oman list |
| Fee min/max | `#filterFeeMin` `#filterFeeMax` | Numeric range filter |

**Counter:** `#filterCounter` shows `N من M طلب — فلاتر مفعّلة` when filters trim the result.

---

## 5. Inbox card actions

Card click (anywhere except buttons/inputs) calls `openDetail(id)`. Per-card buttons stop propagation.

| Action | Selector | Endpoint | Toast | Notes |
|---|---|---|---|---|
| Open detail | card itself | `GET /:id` | — | — |
| ⚡ استلام | `[data-claim]` | `POST /:id/claim` | `✅ Claimed R-N · TOTAL OMR` | Auto-opens detail. Backwards-compat: `data-send-quote` alias |
| 🚩 إبلاغ | `[data-flag]` | `POST /:id/flag` | `🚩 N/2` or `🚫 الطلب حُذف من السوق` | Multi-office quality vote |
| ↪ سحب العرض | `[data-withdraw]` | `POST /:id/offer/withdraw` | `↩ Withdraw` | Legacy multi-bid path |
| ✓ Quick complete | `[data-complete]` | `POST /:id/complete` | `✓ Completed R-N` | `confirm()` first |
| ↩ Release | `[data-release]` | `POST /:id/release` | `↩ Released` or `⚠ refund-required` | Refund warning when paid |
| → فتح | `[data-open]` | `GET /:id` | — | Same as card click |
| Inline fee editor | `[data-office-fee-input]` `[data-gov-fee-input]` | local | `= TOTAL OMR` updates | Only persists on claim |

---

## 6. View mode toggles

| Label | Selector | Persisted as |
|---|---|---|
| ▦ Grid | `#vmGrid` | `localStorage.sanad.view='grid'` |
| ☰ List | `#vmList` | `localStorage.sanad.view='list'` |

---

## 7. Detail header

| Label | Selector | Behavior |
|---|---|---|
| ✕ Close workspace | `#closeWorkspace` | Hide workspace + backdrop, return to inbox. Esc also closes. |

---

## 8. Step strip (visual progression)

Read-only. State machine: `setStepStrip(status, paid_at)`:

| Step | Active when | Done when | Blocked when |
|---|---|---|---|
| 1 مراجعة المستندات | `claimed` | after payment | `needs_more_info` / `flagged` / `cancelled` |
| 2 إرسال رابط الدفع | `awaiting_payment` | `in_progress` / paid | — |
| 3 تنفيذ المعاملة | `in_progress` (paid) | `completed` | — |
| 4 إنجاز | `completed` | — | — |

---

## 9. Primary CTA strip

`renderActions(r)` selects ONE prominent button per state. Side actions go to the secondary toolbar (§10).

| Status | Primary CTA | Endpoint | Hint |
|---|---|---|---|
| `ready` (anonymized) | ⚡ استلام الطلب | `POST /:id/claim` | Pricing locked at claim time |
| `claimed` | 💳 إرسال رابط الدفع | `POST /:id/payment/start` | Review docs first |
| `needs_more_info` | 💳 إرسال رابط الدفع | same | ⏳ بانتظار ردّ المواطن |
| `awaiting_payment` | ↻ إعادة إرسال الرابط | same (idempotent) | Citizen hasn't paid yet |
| `in_progress` | ✓ إنهاء المعاملة | `POST /:id/complete` | Payment received |
| `completed` | (disabled chip) | — | Final |
| `flagged` / `cancelled*` | (disabled status text) | — | — |

Refresh fires `await openDetail(id) + await loadInbox()` after every mutation so the chip + step strip flip immediately.

---

## 10. Secondary toolbar

Side actions (`#detailActionsSecondary`):

| Button | Endpoint | Notes |
|---|---|---|
| 📝 طلب توضيح | (modal → `POST /:id/request-info`) | Cap = 2 pre-pay (env `SANAD_REQ_INFO_PREPAY_LIMIT`) |
| 🔄 تغيير الخدمة | (modal → `POST /:id/reclassify`) | Citizen must approve via 'موافق'/'رفض'; allowed in claimed / needs_more_info / awaiting_payment / awaiting_reclassify_ack |
| ↩ إرجاع | `POST /:id/release` | Refund-required hint when paid |
| 🚩 إبلاغ (marketplace only) | `POST /:id/flag` | Auto-quarantine after 2 distinct flags |
| 🧪 اختبار: تأكيد الدفع (debug only) | `POST /api/payments/request/:id/confirm-stub` | Visible only when `health.test_pay === true` |

---

## 11. Shortcuts bar (post-claim only)

| Button | Selector | Action |
|---|---|---|
| 🔗 البوابة | `#sc_portal` | `window.open('https://www.rop.gov.om')` |
| 📲 طلب رمز (60 s window) | `#sc_otp` | `POST /:id/otp-window` + 1.5 s poll on `GET /:id/otp` |
| 📋 البطاقة | `#sc_copyid` | Clipboard copy of `r.civil_id` |
| 📋 الهاتف | `#sc_copyphone` | Clipboard copy of `r.citizen_phone` |
| 💰 الرسوم | `#sc_copyfee` | Clipboard copy of `r.fee_omr` |
| OTP status (read-only) | `#otpStatus` | `⏳ بانتظار` → `✅ <code>` |

**OTP poll cleanup (FIXED):** loop now snapshots `otpRequestId = currentRequestId`; bails if user opens a different request mid-window. Final render also re-checks identity before painting. (Prevents stale 70-s polls leaking when user races between requests.)

---

## 12. Tabs

| Tab | Renderer |
|---|---|
| نظرة عامة | `renderOverview(r)` |
| المستندات (default) | `renderDocs(docs)` |
| الجدول الزمني | `renderTimeline(r, msgs)` |

---

## 13. Doc tile actions

For each `request_document` row:

| Button | Behavior | Backend |
|---|---|---|
| ⬇ Download | Browser save-as | `<a download>` |
| ↗ Open new tab | New tab | `<a target=_blank>` |
| ✓ قبول | Internal-only ack, citizen NOT notified, chip → green | `POST /:docId/verify` |
| ✕ رفض… | Modal: pick reason (blurry / wrong_doc / expired / missing_side / cropped / other-with-note) | `POST /:docId/reject` |
| Quick: 🌫 غير واضحة | One-tap reject + standard AR message | `POST /:docId/reject` reason=blurry |
| Quick: ↻ الوجه الآخر | Same | reason=missing_side |
| Quick: ⏱ منتهي | Same | reason=expired |
| ↩ إلغاء الرفض | Recovers from misclick; citizen messaged "no need to resend" | `POST /:docId/unreject` |

**Optimistic UI:** verify and quickReject flip the chip color before the round-trip; on error the full request re-fetches and the optimistic state rolls back.

---

## 14. Chat drawer

| Control | Notes |
|---|---|
| Toggle / Expand / Close | Visual only |
| 4 canned replies | Insert into composer; no API call until submit |
| Send (FIXED) | Now uses `api()` helper so 401 → login redirect, 403 → AR hint surfaces in toast (was bare `fetch()` so auth/payment-gate errors were silent) |
| 📎 Attach | Placeholder, no handler wired |
| Pre-pay banner | "🔒 الدردشة الحرة مقفلة حتى الدفع — يمكنك قراءة ردود المواطن واستخدام الإجراءات المنظَّمة." Composer disabled. |

---

## 15. Settings modal

| Control | Endpoint | Validation |
|---|---|---|
| Default office fee (OMR) | `PATCH /api/office/settings` | 0 ≤ fee ≤ 500 |
| Save | (form submit) | Owner-only on server (403 otherwise) |
| Cancel / Close / Backdrop click | Hide overlay | — |

---

## 16. Reclassify modal

Auto-browse on open (no need to type a query). Filters compose with AND logic.

| Control | Behavior |
|---|---|
| Search input | Debounced 250 ms → `GET /api/catalogue/hybrid?q=…` |
| Beneficiary dropdown | للجميع / للأفراد / للشركات |
| مجانية فقط | `&free=1` |
| الخدمات المعتمدة | `&is_launch=1` |
| Entity chips (top 12 + "أكثر…") | Loaded once from `/api/catalogue/entities`; sets hidden `#rcEntity` value; AR shorthand for top ministries (شرطة عُمان, بلدية مسقط, الصحة, …) |
| Service result tile | Click → `rcSelect()`, green border, pricing preview |
| Old vs new total preview | `OLD = office_fee + gov_fee` vs `NEW = office.default_office_fee_omr + service.fee_omr` |
| Reason textarea | Server scrubs phone/URL/email/handle |
| 📤 إرسال | `POST /:id/reclassify` → status flips to `awaiting_reclassify_ack`, citizen must approve |
| Cancel / Close / Backdrop | Hide overlay |
| No-results state | Shows 🔍 + "↺ إزالة كل الفلاتر" button |

**Allowed pre-pay states (broadened):** `claimed`, `needs_more_info`, `awaiting_payment` (silently rolls back the un-paid link), `awaiting_reclassify_ack` (replaces previous proposal).

---

## 17. Request-info modal

| Control | Behavior |
|---|---|
| Per-doc issue dropdown (one per uploaded doc) | غير واضحة / ينقصها الوجه الخلفي / ينقصها الأمامي / منتهي / مستند خاطئ / يحتاج توقيعاً / مقصوص / دقة منخفضة / أخرى-مع-ملاحظة |
| `.ri-doc-other` text input | Auto-shown when "أخرى" picked |
| 10 common-doc tickboxes | Civil ID back, passport photo page, signed authorization, sponsor letter, tenancy contract, no-objection, medical form, ID photo, bank statement, clear ID copy |
| Custom-doc input + `+ إضافة` button | Adds chip; click chip to remove |
| Note textarea | Optional cover text — server scrubs phones/URLs |
| 📤 إرسال للمواطن | `POST /:id/request-info` |
| Pre-pay limit | Banner "⚠ مقفل قبل الدفع: 2 طلب توضيح كحد أقصى". Server returns 429 with hint; toast surfaces it. |

---

## 18. Help overlay

Single overlay listing all keyboard shortcuts (§ 20). Open via `#helpBtn` or `?` key.

---

## 19. Command palette

| Trigger | Cmd+K / Ctrl+K |
|---|---|
| Search | Substring match against 11 built-in commands + the office's own request list (id / service name / entity) |
| Navigate | ↑ / ↓ / Enter |
| Built-ins | claim_next, filter_mine, filter_ready, filter_waiting, toggle_theme, toggle_lang, open_chat, request_otp, open_catalogue, open_chat_tab, refresh |

---

## 20. Keyboard shortcuts

| Key | Action |
|---|---|
| Cmd+K / Ctrl+K | Open command palette |
| Cmd+D / Ctrl+D | Toggle dark mode |
| Esc | Close (priority: cmd → help → chat → detail) |
| / | Focus search |
| ? | Open help |
| T | Toggle chat drawer |
| C | Trigger quick-claim |
| R | Refresh inbox |
| O | Open OTP window (if a request is open) |
| J / ↓ | Next card |
| K / ↑ | Previous card |
| Enter | Open selected card |

---

## 21. pay.html

Citizen-facing checkout page (used as Thawani fallback / dev stub):

| Button | Behavior |
|---|---|
| ادفع | `POST /api/payments/dummy/pay` — accepts any 12+ digit card |
| 🧪 محاكاة دفع ناجح (وضع الاختبار) | Visible only when `health.test_pay === true`. Resolves request id via `/dummy/session/:ref`, then `POST /api/payments/request/:id/confirm-stub` → marks paid → redirect to `/request.html?id=N&paid=1` |

---

## Routes cross-reference

| Endpoint | Method | Triggered by | Notable response shapes |
|---|---|---|---|
| `/api/officer/inbox` | GET | boot, refresh, every action | `{me, office, credits, settings, sla, marketplace, my_offers, mine, lifecycle}` |
| `/api/officer/request/:id` | GET | open detail | TWO shapes: full (`{request, documents, messages, chat_unlocked}`) when claimed; anonymized (`{request, documents, my_offer, anonymized:true}`) when marketplace card. **Renderers must default `messages`/`chat_unlocked`** — fixed in `c5731f9`. |
| `/api/officer/request/:id/claim` | POST | ⚡ Claim | `{ok, status, transfer, pricing}` |
| `/api/officer/request/:id/payment/start` | POST | 💳 Send link | `{ok, reused, payment_link, amount_omr, merchant_ref, stubbed}`; with AR hints on 400/409/502 |
| `/api/officer/request/:id/complete` | POST | ✓ Complete | `{ok, already?, status?}` |
| `/api/officer/request/:id/release` | POST | ↩ Release | `{ok, refund_required}` |
| `/api/officer/request/:id/message` | POST | Chat send | `{ok, delivery}`; 403 with AR hint when pre-pay |
| `/api/officer/request/:id/otp-window` | POST | 📲 OTP | `{ok}` |
| `/api/officer/request/:id/otp` | GET | OTP poll | `{otp:{code,consumed_at,expires_at}\|null}` |
| `/api/officer/request/:id/document/:docId/verify` | POST | ✓ قبول | `{ok}` |
| `/api/officer/request/:id/document/:docId/reject` | POST | ✕ رفض / quick-reject | `{ok, status:'needs_more_info', reason_code}` |
| `/api/officer/request/:id/document/:docId/unreject` | POST | ↩ إلغاء الرفض | `{ok, new_status}` |
| `/api/officer/request/:id/request-info` | POST | 📝 modal send | 429 (cap), 400 (empty after sanitize) |
| `/api/officer/request/:id/reclassify` | POST | 🔄 modal send | `{ok, status:'awaiting_reclassify_ack', new_service_id, pricing, sanitized_reason}` |
| `/api/officer/request/:id/flag` | POST | 🚩 Flag | `{ok, flag_count, threshold, removed}` |
| `/api/catalogue/entities` | GET | reclassify modal | `{entities:[{entity_en,entity_ar,n}]}` |
| `/api/catalogue/hybrid` | GET | reclassify search | `{results:[…], total, …}` (legacy: `items`) |
| `/api/office/settings` | PATCH | settings modal | `{ok}` |
| `/api/payments/request/:id/confirm-stub` | POST | 🧪 test-pay buttons | `{ok, alreadyPaid?, request_id}` |

---

## Issues found and fixed in this audit

| Severity | Issue | File:line | Fix |
|---|---|---|---|
| **High** | Chat send used bare `fetch()` instead of `api()` — 401 errors silent, payment-gate (403) not surfaced | `public/officer.html:2442` | Switched to `api(...)`; toast now shows AR hint or `الدردشة مغلقة حتى يتم الدفع — استخدم الإجراءات المنظَّمة` |
| **High** | OTP poll loop didn't bail when user opened a different request — kept polling stale id for up to 70 s | `public/officer.html:2335` | Snapshot `otpRequestId` at open; loop checks `currentRequestId !== otpRequestId` each tick + before final render |
| Verified false-positive | Audit flagged `dataset.nameAr` as kebab/camel mismatch | `public/officer.html:2841` | HTML5 `dataset` API auto-camel-cases `data-name-ar` → `dataset.nameAr`. Working as intended. |

## Issues from previous audits already fixed

| Issue | Commit |
|---|---|
| `openRequest` referenced instead of `openDetail` in verify/reject/unreject | `cdc9f90` |
| `data.messages.filter()` crashed for anonymized marketplace shape | `c5731f9` |
| Send-payment didn't refresh detail/inbox (status chip stuck on قيد المراجعة) | `f994a85` |
| Reclassify rejected `awaiting_payment` and `awaiting_reclassify_ack` states | `466b1cc` |
| Generic 'Open failed' toast hid actual error | `4be039f` |
| Reclassify modal didn't auto-browse on open | `91c9f40` |
| Burst of WhatsApp uploads triggered "is this for a 2nd request?" via v2 LLM | `c635df3` |
| Payment link used wrong host (PUBLIC_BASE_URL stale) | `a1ff416` |

## Open / lower-severity items (not yet fixed)

| Severity | Issue | File:line | Suggested fix |
|---|---|---|---|
| 3 (polish) | Live-ticker poll has no exponential backoff or visible failure indicator | `public/officer.html:2671` | Add jitter + a small "offline" pill when 3+ ticks fail |
| 3 (polish) | `📎 attach` button in chat composer has no handler (placeholder) | `public/officer.html:721` | Wire to multer endpoint or remove icon |
| 3 (polish) | Inline `onclick="verifyDoc(...)"` etc. work, but minifier-fragile | doc tile renderer | Migrate to event delegation when refactoring |
| 3 (polish) | `kpi_money` formula uses hard-coded 0.1 of fee_omr | `public/officer.html:1073` | Replace with real wallet ledger pull when wallet GA's |

---

## Test scenario matrix (critical paths)

### Path 1 — Marketplace claim → review → payment → complete

| Step | Trigger | Expected status | Expected UI |
|---|---|---|---|
| 1 | Citizen submits via chat | `ready` | Card appears in 🛒 marketplace |
| 2 | ⚡ استلام | `claimed`, `office_id=mine` | Card moves to my-board "reviewing"; step strip step 1 active |
| 3 | ✓ قبول on every doc | unchanged | Chips turn green internally |
| 4 | 💳 إرسال رابط الدفع | `awaiting_payment` | Step strip step 2 active; secondary actions update; CTA flips to ↻ resend |
| 5 | Citizen taps payment button or 🧪 fake-purchase | `in_progress`, `paid_at` set | Chat unlocks; primary CTA flips to ✓ إنهاء |
| 6 | ✓ إنهاء المعاملة | `completed` | Step strip step 4 active; receipt sent to citizen |

### Path 2 — Reject + replace doc

| Step | Trigger | Expected |
|---|---|---|
| 1 | 🌫 غير واضحة on a doc | Status `needs_more_info`, citizen gets specific AR message + slot reopened |
| 2 | Citizen sends new image | `request_document` table: old row → `replaced`, new row → `pending`; status back to `claimed`; gallery shows both ("↻ نسخة سابقة — استُبدلت") |
| 3 | ✓ قبول new image | Internal verification |

### Path 3 — Switch service mid-flow

| Step | Trigger | Expected |
|---|---|---|
| 1 | 🔄 تغيير الخدمة → modal → pick service → 📤 إرسال | Status `awaiting_reclassify_ack`; citizen sees old-vs-new total + buttons موافق/رفض |
| 2 | Citizen taps موافق / types موافق | `service_id` swapped, pricing updated, status → `claimed`; office can now send payment link |
| 2-alt | Citizen taps رفض / types رفض | Pending values cleared, status → `claimed`; office can release or stay on original service |
| 3 | Office tries 💳 إرسال before citizen replies | 409 + hint *"لا يمكن إرسال رابط الدفع قبل قبول المواطن"* |

### Path 4 — Burst of files

| Step | Trigger | Expected |
|---|---|---|
| 1 | Citizen sends 5 photos in <12 s on WhatsApp | All 5 stored as supplementary docs; ZERO ack messages during the burst |
| 2 | 4.5 s of silence after the last file | ONE summary lands: *"✅ استلمت 5 ملفات إضافية وأرسلتها للمكتب."* + buttons `[✓ تم] [+ سأرسل المزيد]` |
| 3 | Citizen taps `[✓ تم]` | Bot replies *"تمام 👍 الملفات في يد المكتب الآن."* |
| 4 | Office side | Inbox card pulses 💬 ردّ جديد until officer opens the request |

### Path 5 — Concurrent claim race

| Step | Trigger | Expected |
|---|---|---|
| 1 | Office A and Office B both click ⚡ on the same card | `UPDATE … WHERE office_id IS NULL AND status='ready'` is atomic — first wins |
| 2 | Loser | 409 `already_claimed` with the winner's status; card disappears from B's marketplace on next refresh |

### Path 6 — Multi-office flag → auto-quarantine

| Step | Trigger | Expected |
|---|---|---|
| 1 | Office A flags with reason `wrong_service` | `request_flag` row inserted; `flag_count=1`; toast `🚩 1/2`; card hidden from A only |
| 2 | Office B flags same request | `flag_count=2 ≥ threshold` → atomic `UPDATE … status='flagged'`; toast `🚫 الطلب حُذف من السوق`; card disappears for everyone |
| 3 | Citizen | Receives bot message *"⚠ تمت مراجعة طلبك من قبل أكثر من مكتب…"* + offered to fix or cancel |

---

_Audit generated by tracing handlers in `public/officer.html` against `routes/officer.js`. Any discrepancy between this doc and the live deploy is a bug — please flag in PR review._
