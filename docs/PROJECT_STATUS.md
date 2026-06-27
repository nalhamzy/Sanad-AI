# Sanad-AI — Project Status & Onboarding

> **Single source of truth for the latest status, setup, deployment, and how things run.**
> If you're an engineer or AI agent picking this project up, **read this first.**
> Last updated: **2026-06-28**.

---

## 📋 Work log — what we last worked on (newest first)

> **Append a short dated entry at the end of each working session** so the next session
> (human or agent) sees the latest at a glance. `git log --oneline` is the full record;
> this is the curated narrative. Keep newest on top.

### 2026-06-28
- **Offices co-maintain the catalog.** New owner/manager-gated, audit-logged endpoints
  `GET /api/office/catalog/services` (full list incl. inactive, search/filter) + `PATCH
  /api/office/catalog/service/:id` (edit + activate/deactivate). New **"📚 إدارة الكتالوج"**
  manager in the office dashboard (browse all, search, add / edit / activate / deactivate);
  citizens still see only active. Fixed edit-modal z-index. (`eff7d5b`, `3f1d913`)
- **Full payment cycle tested live** on prod (Thawani UAT sandbox): WhatsApp request **#9**
  → office claim → payment link → paid with test card `4242…` / OTP `1234` → request flipped
  to `paid` / `in_progress`. ✅
- **Added ROP service** «خدمة زيارة سجين» (id 200026, active, office commission 3 OMR, 3 docs).
- **Office↔citizen chat opened from CLAIM** — removed the pre-pay `request-info` cap. (`e568f63`)
- **Citizen-chat hardening**: thanks + out-of-scope gates no longer fall through to search;
  entity-browse with 0 active → clean empty-state; number-pick 1–10. (`93ddb16`, `c0807f5`, `d7b719c`)
- **Catalog → citizen-active-only** + office-activates-inactive-on-assign. (`d720ec3`)
- Created this doc + `docs/credentials.html`; migrated prod DB to **Turso**; created
  platform-admin account `nalhamzy@gmail.com`. Tests: **497 green**.

**Next up / open:**
- Optional visual-simplification pass on the office board (many filter chips — all
  functional; needs a steer on what to hide).
- Known soft edge: free-text search for a genuinely non-existent service shows nearest
  active matches + the «لم أجد خدمتي» inquiry escape (a strict relevance-floor was reverted as too noisy).

---

## 1. What it is

Sanad-AI is a bilingual (Arabic-first) **WhatsApp + web** assistant that connects Omani
citizens to licensed **"Sanad" offices** for government-service transactions. The citizen
chats to discover a service and assemble the required documents; a Sanad office **claims**
the request, communicates with the citizen, collects payment (Thawani), and completes the
government-side paperwork.

**Framing:** Sanad-AI is the **prep + dispatch layer** — it prepares the file and routes it
to an office. It never claims to submit directly to ROP/ministries; the office does the
actual transaction. (See `SANED_PROJECT_OVERVIEW.md` for the product narrative.)

- **Production:** https://saned.ai (Render, auto-deploys from `main`)
- **Stack:** Node 18.17+ · Express · libSQL/Turso · Anthropic (chat) + Qwen (embeddings)
- **Tests:** `npm test` → 497 passing (node:test)

---

## 2. Current status — latest changes (2026-06-27)

These are recent and may **not** be reflected in older docs (README, SANAD_AI_PLAN_V2,
docs/agent-behavior). This section is authoritative.

| Area | Status |
|---|---|
| **Production DB** | Migrated to **Turso/libSQL** (env `DB_URL` + `DB_AUTH_TOKEN`). `file:./data/sanad.db` is the local-dev fallback only. `lib/db.js` has a Turso HTTP-driver compat shim. |
| **Catalog model** | **Curated**: 655 services total, only **54 active** (`is_active=1`). Citizens see **only active** services in **both** free-text search **and** entity-browse. |
| **Office activates services** | An office promotes an inactive service by **assigning it to a request** (reclassify) → `is_active` flips 0→1 (audit `service_activated_on_assign`). The reclassify picker shows inactive rows to **signed-in officers only** via `/api/catalogue/hybrid?include_inactive=1`. |
| **Offices co-maintain the catalog** | Owner/manager officers can **view the full catalog** (active + inactive), **add / edit / activate / deactivate** any service — via the **"📚 إدارة الكتالوج"** manager (office dashboard) backed by `GET /api/office/catalog/services` + `PATCH /api/office/catalog/service/:id` (audit-logged). Citizens still see only active. |
| **Office↔citizen chat** | **Open from CLAIM — no payment lock.** Free-text `POST /api/officer/request/:id/message` is claim-gated; the old 2-message pre-pay cap on `request-info` is **removed**. Off-platform poaching still blocked by `sanitizeOfficeText` (phone/URL/email stripped). |
| **Citizen numbered-pick** | Works for **1–10** (was 1–3); item 10 renders 🔟. |
| **Deterministic gates** | greeting / thanks / out-of-scope / triage short-circuit **before** the LLM. Thanks classifier strips tashkeel. Entity-browse with 0 active services → clean empty-state (not unrelated results). |
| **Platform admin** | An officer with `role='platform_admin'` **or** email in `ADMIN_EMAILS`. Login at `/admin-login.html` → `POST /api/auth/login`. Account `nalhamzy@gmail.com` exists (officer id 4). See `docs/credentials.html` (git-ignored, local only). |

**Last full live E2E (2026-06-27): 14/14 green** — citizen discovery/pick, active-only
visibility, and the office lifecycle (create → claim → chat-from-claim → request-info ×3 →
reclassify→activate), all verified against prod + Turso with test data cleaned up.

---

## 3. Architecture at a glance

```
Citizen (WhatsApp / web chat)
   │  POST /api/whatsapp (Meta webhook)  |  POST /api/chat/:session_id (web)
   ▼
lib/agent.js  ── runTurn() ──────────────────────────────────────────────┐
   • Deterministic GATES (before any LLM): greeting, thanks, out-of-scope, │
     triage, fee Q&A, entity-browse, hybrid search, numbered-pick,         │
     confirm, cancel, button-intent dispatch                               │
   • LLM tool-loop (v2, Anthropic) for genuine service conversations       │
   • Hybrid search (lib/hybrid_search.js): FTS5 + Qwen embeddings + RRF    │
   ▼                                                                       │
Request lifecycle (DB): collecting → ready → claimed → awaiting_payment    │
                        → in_progress → completed  (+ needs_more_info, etc.)│
   ▼                                                                       │
Office dashboard (public/officer.html → routes/officer.js)                 │
   • Marketplace inbox → CLAIM (FCFS, atomic) → chat / request-info /      │
     reclassify / send payment link (Thawani) → complete                   │
Platform admin (public/admin.html → routes/platform_admin.js)             │
   • Approve offices, catalog CRUD, payments KPIs, weekly payouts          │
```

Key modules: `lib/agent.js` (turn engine + gates), `lib/agent_tools.js` (tool impls),
`lib/hybrid_search.js` + `lib/embeddings.js` (search), `lib/db.js` (schema + Turso shim),
`lib/auth.js` (officer/citizen/admin auth), `routes/` (chat, whatsapp, officer,
platform_admin, auth, citizen_auth, payment-checkout), `public/` (web UIs).

---

## 4. The catalog model (read this — it's the #1 source of confusion)

- `service_catalog` has **655 rows**; only **54** have `is_active=1`. The 54 = the
  **verified / launch-ready** set (office-approved + Qurm-seeded).
- **Citizens see only active services** — both `searchServices` (hybrid_search filters
  `is_active=1`) and entity-browse (`lib/agent_tools.js` `get_entity_services` filters
  `is_active=1`). An entity with 0 active services (e.g. Ministry of Health today) returns
  a clean empty-state that routes to the "submit as inquiry" path.
- **Offices activate services by using them.** When an office reclassifies a request onto
  an inactive service, `routes/officer.js` flips that row to `is_active=1` (the office is the
  vetting step). The reclassify picker can see inactive rows via
  `/api/catalogue/hybrid?include_inactive=1` — honored **only** for a signed-in officer.
- `deactivateUnverifiedServices()` runs on every boot and sets `is_active=0` on any row not
  `office_approved`/`annotator_validated`. Idempotent; survives redeploys.

See `project_catalog_model` in the agent memory and `MARKETPLACE_SCALING.md` for the
deeper marketplace design.

---

## 5. Setup & local development

**Prerequisites:** Node **18.17.0+** (`package.json` engines), npm 9+.

```bash
npm ci                       # clean install
cp .env.example .env         # adjust as needed (works with NO keys — see below)
npm run dev                  # hot-reload dev server (or: npm start)
npm test                     # full suite (isolated test DB, LLM keys stubbed) → 492 pass
```

- **No API keys?** Fine for local dev. With `QWEN_API_KEY` empty the agent falls back to the
  **v1 heuristic** (5 launch flows) and search degrades to FTS-only (no semantic lane). The
  test suite (`tests/helpers.js` `bootTestEnv`) forces `NODE_ENV=test`, an isolated
  `file:./data/sanad-test.db`, and stubs LLM/WhatsApp keys for determinism.
- Useful scripts: `npm run seed`, `npm run load:approved`, `npm run test:llm` (needs a key).

---

## 6. Environment variables (the ones that matter)

Full list lives in **`render.yaml`** and **`.env.example`**. The critical ones:

| Var | Purpose | Required in prod? |
|---|---|---|
| `DB_URL` | `libsql://…turso.io` (prod) or `file:./data/sanad.db` (dev) | yes |
| `DB_AUTH_TOKEN` | Turso auth token (with a `libsql://` URL) | yes (Turso) |
| `JWT_SECRET` | signs officer/citizen/admin session cookies (≥16 chars) | **yes — fatal if missing/weak** |
| `ADMIN_EMAILS` | comma-list of platform-admin emails | **yes — boot-fatal if empty** (`lib/env.js`) |
| `WHATSAPP_APP_SECRET` | verifies Meta webhook signatures | **yes — boot-fatal if empty** |
| `ANTHROPIC_API_KEY` | Claude chat / tool-loop (v2 agent) | yes (chat) |
| `QWEN_API_KEY` | Qwen embeddings (semantic search) — Anthropic has no embed API | yes (search) |
| `THAWANI_SECRET_KEY` / `THAWANI_PUBLISHABLE_KEY` / `THAWANI_ENV` | payments | yes (payments) |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` | Meta Cloud API | yes (WhatsApp) |
| `PUBLIC_BASE_URL` | `https://saned.ai` — redirects, webhooks | yes |
| `SANAD_AGENT_V2` | `true` = LLM tool-loop; `false` = v1 heuristic | optional (prod: true) |
| `DEBUG_MODE` | dev stubs (payment/OTP); **must be false in prod** | optional |

Boot **fails fast in production** (`lib/env.js` `assertProductionConfig` + `lib/auth.js`) if
`JWT_SECRET`, `WHATSAPP_APP_SECRET`, or `ADMIN_EMAILS` are missing.

Secrets are set in the **Render dashboard → Environment**, never committed. (`render.yaml`
declares the keys with `sync:false` so values are entered in the dashboard.)

---

## 7. Deployment (Render + Turso)

- **`render.yaml`**: web service `sanad-ai`, plan `starter`, build `npm ci`, start
  `node server.js`, healthCheckPath `/api/health`, **`autoDeploy: true`**. A 1 GB disk is
  mounted at `…/src/data` (legacy file-DB / uploads).
- **Deploy = push to `main`.** Render rebuilds (`npm ci`) and restarts. Expect a **~75 s–3 min
  502 swap window** and a full deploy in **~10–15 min**. Rapid successive pushes restart the
  build (clock resets) — batch commits when you can.
- **`/api/health`** returns `{ ok, llm, debug, whatsapp, thawani, thawani_env }` (no commit
  SHA). `debug:false` + `thawani:true` is the healthy-prod shape.
- **DB cutover** (already done): set `DB_URL` + `DB_AUTH_TOKEN` (Turso) in Render env. The
  `lib/db.js` compat shim is REQUIRED for the Turso HTTP driver.

**Testing prod programmatically:** every state-changing POST is CSRF-guarded (`lib/csrf.js`)
— a raw `fetch`/`curl` POST **must** send `Origin: https://saned.ai` or it 403s. GETs don't.
Windows shells mangle Arabic in CLI args → send Arabic via a UTF-8 file or Node `fetch`.

---

## 8. How it runs in production (boot sequence)

`server.js` `prepare()` runs, in order:
1. `assertProductionConfig()` — fail fast on missing prod secrets.
2. `migrate()` — idempotent schema (`lib/db.js`).
3. Catalog load — `autoImportCatalog()` (import only if empty) → `loadApprovedServices()` →
   `deactivateUnverifiedServices()` (curate to the active set).
4. Demo seed — `seedDemoOffices()` (re-hashes demo officers to `demo123` each boot),
   annotators, and demo requests (DEBUG_MODE only).
5. `SEED_QURM=true` → spawns `scripts/seed_qurm_services.mjs` (one-shot, idempotent).
6. Embedding worker — fire-and-forget; embeds active rows for semantic search.
7. Watchers — SLA watcher + subscription watcher start.

**LLM split:** chat/tool-loop = **Anthropic Claude** (`ANTHROPIC_API_KEY`, model via
`ANTHROPIC_MODEL`); embeddings = **Qwen** (`QWEN_API_KEY`, `text-embedding-v3`, 1024-dim).
Anthropic has no embeddings API, so `QWEN_API_KEY` is what makes semantic search work.

---

## 9. Testing

- `npm test` — 492 tests (node:test), isolated DB, LLM/WhatsApp stubbed. Gate any change on
  this staying green.
- Live prod checks in this repo's history use Node `fetch` harnesses (Origin header for
  POSTs). The advanced E2E pattern: seed a `ready` request in Turso → drive the office API
  (claim → message → request-info → reclassify) → assert → **clean up the test rows**.
- Two agent eval paths exist (v1 heuristic + v2 tool-loop); see `project_agent_paths` memory.

---

## 10. Access & credentials

- **Office dashboard:** `/office-login.html`. Demo accounts (re-seeded every boot, password
  `demo123`): `khalid@nahdha.om` (owner, Sanad Al-Nahdha), `noor@nahdha.om` (manager),
  `hassan@seeb.om` (officer, Sanad Seeb).
- **Platform admin:** `/admin-login.html` → `nalhamzy@gmail.com` (role `platform_admin`).
- **Citizen:** no password — phone + OTP, or WhatsApp.
- Full, private credentials reference (plaintext, **git-ignored, not web-served**):
  `docs/credentials.html`. Infra secrets live in **Render env**, never in the repo.

---

## 11. Gotchas / where to look

- **Curated catalog** (§4) — citizens only see the 54 active; don't expect all 655.
- **CSRF** — programmatic POSTs need `Origin: https://saned.ai`.
- **Arabic matching** must normalize (strip tashkeel, أإآ→ا, ة→ه, ى→ي) — see
  `lib/catalogue.js` `normalize` + `reference_search_lanes` / `reference_prod_gotchas` memory.
- **Web chat is text-only** — interactive buttons are WhatsApp-only (`turn._buttons`); the
  web client infers state from `state.status` / `state.last_offered_buttons`.
- **`data/` is a Render disk mount** — files committed under `data/` don't exist at runtime;
  keep deployed code/data in `lib/` or `scripts/`.
- Deeper context lives in the agent memory files (`project_catalog_model`,
  `project_request_lifecycle`, `reference_prod_gotchas`, `reference_search_lanes`,
  `reference_turso_migration`, `reference_admin_access`, `project_llm_split`).
