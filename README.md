# Sanad-AI · v0.1 (dev build)

One WhatsApp assistant for every Sanad service in Oman. Web-first dev mode, WhatsApp-ready.

This repo implements [SANAD_AI_PLAN_V2.md](SANAD_AI_PLAN_V2.md). It ships:
- A full citizen agent driven by a state machine + optional Qwen 3.5 LLM (tool-calling).
- A **web test chatbot** (`/chat.html`) that talks to the *same backend agent* as WhatsApp will.
- An **officer dashboard** (`/officer.html`) with marketplace, atomic claim, request detail, chat relay, OTP window, grid/list views, command palette (⌘K).
- An **admin/debug page** (`/admin.html`) with DB counts, latest requests, OTP simulator.
- A **WhatsApp Cloud API webhook** stub (`/api/whatsapp/webhook`) that reuses the same agent — just drop in Meta credentials.
- A **test suite** (37 tests, Node built-in runner) covering unit, catalogue search, agent state machine, and HTTP integration.

---

## Quickstart for an AI assistant resuming this project

**You are likely here because this project was handed off mid-stream.** Read this section first.

- **Source of truth for the product vision:** [SANAD_AI_PLAN_V2.md](SANAD_AI_PLAN_V2.md) (read it first, it's the spec).
- **Source of truth for design decisions:** [SANAD_AI_DESIGN.md](SANAD_AI_DESIGN.md).
- **Verify you haven't broken anything:** `npm test` — must be 37/37 green before you change anything risky.
- **Never** introduce a new dependency without strong reason — the stack is intentionally small (Express + libSQL + csv-parse + multer + dotenv).
- **The agent is LLM-first with heuristic fallback.** If `QWEN_API_KEY` is empty, the heuristic path (regex + rule-based tool dispatch) runs — tests rely on this path for determinism.
- **Arabic matters.** Every user-facing string has an AR + EN variant. `normalize()` in `lib/catalogue.js` handles tashkeel/alef/yaa-variants; use it, don't re-implement.
- **Don't break the state machine.** See `§ Architecture → Agent state machine` below. Transitions must stay: `idle → confirming → collecting → reviewing → queued → claimed → completed`.

---

## 1 · Run locally

```bash
cp .env.example .env       # if missing, just run without it — sensible defaults
npm install
npm start                  # port 3030 by default
# or:
npm run dev                # node --watch for live reload
```

Open:

| URL | What |
|---|---|
| http://localhost:3030 | Landing with links |
| http://localhost:3030/chat.html | Citizen web tester (WhatsApp-style UI) |
| http://localhost:3030/officer.html | Officer dashboard (marketplace + claim) |
| http://localhost:3030/admin.html | Admin / debug (counts, OTP sim) |
| http://localhost:3030/catalogue.html | Browse the full services catalogue |
| http://localhost:3030/api/health | JSON health probe |

No API keys required. With `QWEN_API_KEY` empty, the agent falls back to a deterministic heuristic for the 5 launch services (driving licence, civil ID, passport, Mulkiya, CR).

## 2 · End-to-end smoke test (manual)

1. Open `/chat.html`. Type `I want to renew my driving licence`.
2. Follow the prompts. Attach any 3 files via 📎 when the bot asks for ID / medical / photo.
3. Type `تأكيد` (or `confirm`) to submit. You'll get a request number like `#R-1`.
4. Open `/officer.html` in another tab (defaults to officer #1, Khalid Al-Harthy).
5. Click **⚡ Claim** on the new request → opens the three-pane view.
6. Send a reply from the officer — the citizen sees it in `/chat.html` within ~2s (polling).
7. Click **Request OTP** → go to `/chat.html` and paste any 6-digit number → officer UI auto-captures it.
8. Click **✓ Complete** to close the request.

## 3 · Seed data

```bash
npm run seed            # imports oman_services_directory.csv (3,417 rows) into service_catalog + rebuilds FTS
npm run seed:mock       # adds mock citizens/requests/officers for UI testing
```

The 5 launch services still win via hand-curated flows in `lib/catalogue.js`; the CSV import expands the "search / info" coverage to everything else.

---

## 4 · Testing

**Always run before committing:** `npm test`

```bash
npm test                 # full suite, 37 tests, ~2s (serial to avoid DB clashes)
npm run test:unit        # just normalize + expandQuery (fast, no DB I/O beyond setup)
npm run test:watch       # re-run on change
```

**Test files** (`tests/`):

| File | Covers |
|---|---|
| `helpers.js` | Shared harness. Sets `DB_URL=file:./data/sanad-test.db`, forces `QWEN_API_KEY=''` (heuristic mode), exposes `spawnServer()`, `postChat()`, `fetchJSON()`. |
| `01-unit.test.js` | Pure fns: `normalize()` (tashkeel, alef/yaa/taa-marbuta, typos with `=`), `expandQuery()` synonym heuristics. |
| `02-catalogue.test.js` | `matchService()` — launch services hit correctly; **regression**: `تح=جديد تصريح سفينة` must NOT match driving licence; dialectal `بطاقة عامل` must surface work-permit / health-card. Seeds 5 deterministic rows (ids 900001–900005). |
| `03-agent.test.js` | `runTurn()` state machine — greetings, full happy path (`renew driving licence → yes → 3 uploads → confirm → queued`), DB side-effects (request row + 3 doc rows with codes `['civil_id','medical','photo']` + citizen FK), **regression**: greeting must pop out of stuck `confirming`, upload in idle must not dump a service card, `cancel` resets. |
| `04-routes.test.js` | HTTP integration against a real Express app on a random port. Pages return 200, `/api/health`, chat + history, officer inbox, **atomic claim** (first wins, second gets 409), officer→citizen messaging, complete transition, catalogue search. |

**Adding a test:**
- Pure function → `01-unit.test.js`.
- Anything touching the DB → `02-catalogue.test.js` or `03-agent.test.js` (and `await bootTestEnv()` first).
- HTTP-level → `04-routes.test.js` (use `postChat`, `fetchJSON` helpers; server already spun up in `before`).

**Server must not auto-listen when imported.** `server.js` checks `SANAD_NO_AUTOSTART` and `isMain` (set by the harness). If you refactor boot, preserve this — otherwise integration tests will hang.

**Deterministic LLM path.** Tests set `QWEN_API_KEY=''` so the heuristic branch runs. If you add new behaviour behind the LLM, also add the heuristic fallback, or your tests become flaky/network-dependent.

---

## 5 · Architecture

### High-level

```
Browser (chat.html | officer.html | admin.html)
     │   fetch()
     ▼
Express (server.js) ───► routes/{chat,officer,whatsapp,debug,catalogue}.js
     │                                │
     │                                ▼
     │                       lib/agent.js  (state machine + tool calls)
     │                          │     │
     │                          │     └─► lib/llm.js    (Qwen 3.5 / stub)
     │                          │     └─► lib/catalogue.js (matchService)
     │                          │     └─► lib/query_rewriter.js (synonym expansion)
     │                          ▼
     └──────────► lib/db.js  (libSQL + migrations + demo seed)
                             │
                             └─► data/sanad.db (dev) | Turso (prod)
```

### Agent state machine (`lib/agent.js`)

```
idle ─► confirming ─► collecting ─► reviewing ─► queued
 ▲          │             │            │           │
 │          │             │            │           ▼
 │          │             │            │         claimed  (officer claims)
 │          │             │            │           │
 │          │             │            │           ▼
 │          │             │            │         completed
 └──────────┴─────────────┴────────────┘
    (greeting, 'cancel', 'new service', or service-info question pop back to idle)
```

- `idle` — default. Greetings, help, search, service-info questions.
- `confirming` — a launch service matched with high confidence; bot asks "shall I start the submission?"
- `collecting` — user said yes; bot iterates over `required_documents[]`, awaiting each.
- `reviewing` — all docs uploaded; bot shows summary + asks to submit.
- `queued` — request row exists, awaiting officer pickup (status=`ready` in DB).
- `claimed` — officer has taken it; two-way chat via `/api/officer/request/:id/message` + `/api/chat/:sid/poll`.
- `completed` — officer closed it.

**Global exits** from any state: `cancel` / `إلغاء` / `new service` → `idle`. Greetings also pop to idle from `confirming` / `collecting` (regression guard tested in `03-agent.test.js`).

### Tool-calling (when `QWEN_API_KEY` is set)

`lib/llm.js` exposes tools the LLM can call:
- `search_catalogue(query)` — calls `matchService()`, returns top candidates.
- `start_submission(service_code)` — transitions to `collecting`, overrides LLM reply with a deterministic first-doc prompt (prevents the LLM from role-playing "I've started" without actually starting).
- `answer_service_info(service_code, question)` — RAG-style Q&A using the matched row as context.
- `submit_request(...)` — creates the `request` + `request_document` rows.

The heuristic path (no key) mimics these via regex + rule dispatch in `handleIdle` / `handleConfirming` / `handleCollecting`.

### Search pipeline (`lib/catalogue.js`)

1. `normalize()` — strip tashkeel, unify `إأآٱ→ا`, `ى→ي`, `ة→ه`, lowercase, strip punctuation. Handles user typos with stray `=` (real trace: `تح=جديد`).
2. **Launch-service match** — hand-curated regex patterns for the 5 priority services. Highest confidence.
3. **Catalogue AND-match** — tokenize query, run AND across `search_blob`. Best precision.
4. **LIKE fallback** — OR-style substring match when AND is empty.
5. **Synonym expansion** (`lib/query_rewriter.js`) — dialectal Arabic → MSA + English. Hardcoded synonym groups + optional LLM expansion.
6. **Rarity-weighted scoring** — rare tokens (e.g. "سفينة") score higher than common ones ("تجديد").
7. Optional **LLM rerank** when ambiguous.

### Officer authorization

- Officers send `x-officer-id: <id>` header. No real auth in dev (§8 of plan).
- `routes/officer.js` scopes every query to the officer's `office_id`.
- **Atomic claim** uses a conditional UPDATE: `UPDATE request SET officer_id=? WHERE id=? AND officer_id IS NULL`. Rows-affected=0 → 409. Tested in `04-routes.test.js`.

### Design system (`public/theme.css`)

- Overlay scrollbars (macOS-style, hover-reveal) — `overflow: overlay` + `::-webkit-scrollbar` tuned thin.
- Surface system (`--surface-0..3`) replaces hard borders with soft elevations.
- Ambient gradient backgrounds on body.
- Focus halos on interactive elements.
- Skeleton loaders for async content.
- Command palette (`⌘K` / `Ctrl+K`) on officer dashboard.

---

## 6 · File tree

```
server.js              Express app + boot (exports prepare/start/app for tests)
seed.js                CSV → service_catalog importer
seed-mock.js           Demo citizens/requests for UI testing
oman_services_directory.csv   3,417-row Sanad services catalogue
lib/
  db.js                libSQL client + migrations + demo office seed
  llm.js               Qwen (OpenAI-compatible) client + stub fallback
  catalogue.js         5 launch services + normalize() + matchService()
  query_rewriter.js    Synonym expansion (heuristic + LLM)
  agent.js             State machine, per-state handlers, tool dispatch
routes/
  chat.js              Citizen API (/api/chat)
  officer.js           Officer dashboard API (/api/officer)
  whatsapp.js          Meta Cloud API webhook (/api/whatsapp)
  debug.js             Debug + OTP sim (/api/debug)
  catalogue.js         Catalogue browse/search API (/api/catalogue)
public/
  index.html           Landing
  chat.html            Citizen web UI
  officer.html         Officer dashboard (grid/list, command palette)
  admin.html           Debug / counts / OTP sim
  catalogue.html       Browse 3,417 services
  theme.css            Shared design system
  i18n.js              EN/AR string bundles
  ui.js                Shared UI helpers (toasts, modals, skeletons)
tests/
  helpers.js           Test harness (isolated DB, spawnServer, postChat)
  01-unit.test.js      normalize(), expandQuery()
  02-catalogue.test.js matchService() regression suite
  03-agent.test.js     runTurn() state machine
  04-routes.test.js    HTTP integration
Dockerfile             Production image
render.yaml            Render Blueprint
SANAD_AI_PLAN_V2.md    Product spec (read this)
SANAD_AI_DESIGN.md     Design decisions log
```

---

## 7 · Common tasks

### Add a new launch service

1. Edit `LAUNCH_SERVICES` in `lib/catalogue.js`. Add an entry with `code`, `name_en/ar`, `entity_en/ar`, `fee_omr`, `required_documents[]`, and a `match` regex array (English + Arabic variants).
2. If the docs checklist is new, add doc codes (e.g. `medical`, `photo`, `civil_id`) — they're used as `doc_code` in `request_document`.
3. Run `npm test` — the launch-service tests will exercise your match pattern.
4. Smoke test in `/chat.html`.

### Add a new LLM tool

1. Declare the tool JSON in `lib/llm.js` (`tools` array) — name, description, parameters schema.
2. In `lib/agent.js`, add a handler in the tool-dispatch switch. Return `{ reply, state, ... }`.
3. **Also add a heuristic fallback** for the no-key test path — otherwise tests break.
4. Add a test in `03-agent.test.js`.

### Change the system prompt

Edit `systemPrompt` in `lib/llm.js`. Keep the language-purity rule (no mid-word language switches — we had an `إ issuance` franken-word bug before).

### Add a new DB table

1. Add a migration block in `lib/db.js` `ensureSchema()`. Migrations are idempotent `CREATE TABLE IF NOT EXISTS`.
2. Bump nothing — no migration versioning; schemas are additive only. Columns use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
3. If it's queryable, add FTS5 trigger if appropriate (see `service_catalog_fts`).

### Reset everything locally

```bash
rm -rf data/
npm start    # migrations + demo offices re-seed on boot
```

---

## 8 · Qwen 3.5 + WhatsApp

### Qwen

Set `QWEN_API_KEY` in `.env` and restart. OpenAI-compatible endpoint (DashScope). Model is `qwen-plus` by default. See `lib/llm.js`.

### WhatsApp

1. Create a Meta App + WhatsApp Cloud API number (verified business).
2. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` in `.env`.
3. Configure the webhook on Meta → `https://<your-domain>/api/whatsapp/webhook` with the same verify token.
4. Subscribe to `messages` events.

The agent code is **identical** on both channels — the channel adapter lives in `routes/whatsapp.js` vs `routes/chat.js`.

---

## 9 · Deploy

### Render (recommended for v0.1)
Push to GitHub → Render → **New → Blueprint** → point to repo. `render.yaml` provisions:
- Web service (free tier works for pilot).
- 1 GB persistent disk at `./data/` so the SQLite file survives deploys.
- Env vars prompted at deploy (Qwen key, WhatsApp credentials).
- Health check on `/api/health`.

### Docker
```bash
docker build -t sanad-ai .
docker run -p 3030:3030 -v $PWD/data:/app/data --env-file .env sanad-ai
```

### Turso (multi-region reads)
Change `DB_URL` to `libsql://<db>.turso.io` + add `DB_AUTH_TOKEN`. Code path is identical.

> ⚠️ The plan recommends **Postgres with RLS** as production system-of-record once real offices are live. Current libSQL/SQLite is a pragmatic dev/pilot choice — tenancy is enforced in app middleware (`officer_id`), not DB-level RLS.

---

## 10 · What's NOT in this v0.1

Deliberately deferred until after pilot (§19 of the plan):
- AmwalPay integration (payment is mocked: "paid" is auto-assumed on submit)
- Office onboarding wizard backend (3 demo offices seeded at boot)
- RBAC / Firebase auth (officer identity via `x-officer-id` header in dev)
- Postgres RLS (libSQL has no native RLS)
- Catalogue edit-proposal voting UI (DB table exists, no UI)
- Qwen-VL document validation
- Realtime WebSockets (UIs poll every 2.5–3s — fine at pilot scale)

---

## 11 · Troubleshooting

- **Node version:** `>=18.17.0`. Tested on Node 22.
- **`better-sqlite3` errors:** we use `@libsql/client`, no native compile step.
- **Port in use:** `PORT=4000 npm start`.
- **Can't see Arabic:** browser needs Noto Kufi Arabic — loaded via Google Fonts, ensure outbound HTTPS.
- **Reset everything:** `rm -rf data/` then `npm start`.
- **Tests hang:** server must not auto-listen on import. Check `SANAD_NO_AUTOSTART` guard in `server.js`.
- **Tests fail with "module not found":** `package.json` test script passes each file explicitly (Node's `--test` directory mode has quirks on some Node 22 versions).

---

## 12 · Recent decisions log

These are the non-obvious choices an AI assistant resuming the project should know about. Append, don't edit.

- **2026-04-19 · Tests are the safety net.** 37-test suite added (`tests/`). Node built-in runner, runs in ~2s. Heuristic-mode only — deterministic, no network. Run before every commit.
- **2026-04-19 · Server refactored to support testing.** `server.js` now exports `prepare()/start()/app` and only auto-listens when run directly (or when `SANAD_NO_AUTOSTART` unset). Integration tests spin up a real Express on a random port.
- **2026-04-19 · Greeting regex dropped `\b`.** `\b` word boundary is a no-op between two Arabic characters (both non-word in JS regex), so `^مرحب\b` never matched `مرحبا`. Regressed the "pop out of stuck confirming" guard. Fixed in `handleConfirming` + `handleCollecting`.
- **Earlier · LLM-first with heuristic fallback.** Agent architecture evolved from rigid state machine to tool-calling. Heuristic path is kept as (1) the deterministic test path, and (2) the no-key fallback.
- **Earlier · `start_submission` tool sets state + overrides LLM reply.** LLMs role-played "تم البدء" without actually starting the flow. Now the tool sets `state.status='collecting'` and returns a deterministic `firstDocPrompt()`.
- **Earlier · `sanitizeReply()` for LLM output.** Strips mid-word language switches — Qwen occasionally emitted franken-words like `إ issuance`. Also tightened the system prompt.
- **Earlier · Atomic claim via conditional UPDATE.** `UPDATE ... WHERE officer_id IS NULL`. Rows-affected=0 → 409. Tested.
- **Earlier · Design system in `public/theme.css`.** Replaced hard-box UI (~3.5/10 per user) with surface elevations, overlay scrollbars, ambient gradients, focus halos, skeleton loaders. Officer dashboard got grid/list toggle + ⌘K command palette + explicit action buttons on claimed cards.
- **Earlier · Query rewriter with hardcoded synonyms.** Dialectal `بطاقة عامل` → work-permit / labour-card / `تصريح عمل`. Prevents driving-licence false positives for unrelated queries.

---

2026-04-19 · dev build · 37 tests passing
