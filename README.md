# Sanad-AI · v0.1 (dev build)

One WhatsApp assistant for every Sanad service in Oman. Web-first dev mode, WhatsApp-ready.

This repo implements [SANAD_AI_PLAN_V2.md](SANAD_AI_PLAN_V2.md). It ships:
- A **unified tool-calling citizen agent (v2)** — every session state (idle → confirming → collecting → reviewing → queued → claimed) is driven by explicit tool calls, not scripted regex branches. Architecture documented in [AGENT.md](AGENT.md). Heuristic v1 kept as graceful fallback when `QWEN_API_KEY` is empty.
- **Hybrid service search** — FTS5 BM25 + Qwen `text-embedding-v3` (1024-dim) + structured filters, fused via RRF (k=60) with launch/popularity boosts. ~120 ms per turn, warm.
- Full **3,417-service catalogue** (`oman_services_directory.csv`) imported with all 33 columns: beneficiary, main_service, payment method, channels, working/avg time, process steps parsed to JSON.
- A **web test chatbot** (`/chat.html`) that talks to the *same backend agent* as WhatsApp will.
- An **officer dashboard** (`/officer.html`) with marketplace, atomic claim, request detail, chat relay, OTP window, grid/list views, command palette (⌘K).
- An **admin/debug page** (`/admin.html`) with DB counts, latest requests, OTP simulator.
- A **WhatsApp Cloud API webhook** stub (`/api/whatsapp/webhook`) that reuses the same agent — just drop in Meta credentials.
- A **test suite** (70 tests, Node built-in runner) covering unit, catalogue search, hybrid search (deterministic fixture), agent state machine, HTTP integration, auth/offers. Plus an LLM-path suite (`tests/07-agent-v2.test.js`, 5 cases) that runs with a real Qwen key.

---

## Quickstart for an AI assistant resuming this project

**You are likely here because this project was handed off mid-stream.** Read this section first.

- **Source of truth for the product vision:** [SANAD_AI_PLAN_V2.md](SANAD_AI_PLAN_V2.md) (read it first, it's the spec).
- **Source of truth for the chat agent architecture:** [AGENT.md](AGENT.md) (v2 tool loop, hybrid search, 17-tool surface).
- **Source of truth for design decisions:** [SANAD_AI_DESIGN.md](SANAD_AI_DESIGN.md).
- **Verify you haven't broken anything:** `npm test` — must be 70/70 green before you change anything risky.
- **Never** introduce a new dependency without strong reason — the stack is intentionally small (Express + libSQL + csv-parse + multer + dotenv).
- **Two agent paths coexist.** v2 (default when `QWEN_API_KEY` is set and `SANAD_AGENT_V2=true`) is a single Qwen tool-calling loop. v1 (heuristic state machine) runs when the key is empty or the flag is `false`. All pinned tests (`03-agent`, `05-agent-tricky`) target v1 for determinism; v2 has its own LLM-path suite (`tests/07-agent-v2.test.js`).
- **Arabic matters.** Every user-facing string has an AR + EN variant. `normalize()` in `lib/catalogue.js` handles tashkeel/alef/yaa-variants; use it, don't re-implement.
- **Don't break the state machine.** See [AGENT.md](AGENT.md) for the full diagram. Transitions must stay: `idle → confirming → collecting → reviewing → queued → claimed → in_progress → completed`. v2 enforces transitions via explicit tool returns (`transition: '<new_status>'`).

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

No API keys required. With `QWEN_API_KEY` empty, the agent falls back to v1 (deterministic heuristic for the 5 launch services: driving licence, civil ID, passport, Mulkiya, CR) and search collapses to FTS-only (no semantic lane).

With a Qwen key set, on first boot the server kicks off a background embed worker that vectorises all 3,417 services in ~90 s (≈$0.20, one-time). The process serves traffic immediately; semantic search activates as the cache warms.

### Environment variables

| Var | Purpose |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `qwen`. Auto-picks `anthropic` when `ANTHROPIC_API_KEY` is set, else `qwen`. |
| `ANTHROPIC_API_KEY` | Enables Claude as the chat / tool-calling backend. |
| `ANTHROPIC_MODEL` | Default `claude-opus-4-5`. |
| `QWEN_API_KEY` | Required for embeddings (Anthropic has no embedding API). Also enables Qwen as chat provider when `LLM_PROVIDER=qwen`. Empty → FTS-only search. |
| `QWEN_MODEL` | Default `qwen-plus`. |
| `QWEN_EMBED_MODEL` | Default `text-embedding-v3`. |
| `QWEN_EMBED_DIM` | Default `1024`. |
| `SANAD_AGENT_V2` | `true` (default when key is set) routes every turn through the unified tool-calling loop. `false` forces v1. |
| `SANAD_SKIP_EMBED` | `1` disables the background embedder (useful in tests / CI without key). |
| `DB_URL` | Default `file:./data/sanad.db`. Turso: `libsql://...`. |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta Cloud API. Empty → webhook is a no-op. |

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
npm test                 # full suite, 70 tests, ~3s (serial to avoid DB clashes)
npm run test:unit        # just normalize + expandQuery (fast, no DB I/O beyond setup)
npm run test:watch       # re-run on change
QWEN_API_KEY=sk-… npm run test:llm   # 5 extra agent-v2 LLM-path cases (hits real Qwen)
```

**Test files** (`tests/`):

| File | Covers |
|---|---|
| `helpers.js` | Shared harness. Sets `DB_URL=file:./data/sanad-test.db`, forces `QWEN_API_KEY=''` (heuristic mode), exposes `spawnServer()`, `postChat()`, `fetchJSON()`. |
| `01-unit.test.js` | Pure fns: `normalize()` (tashkeel, alef/yaa/taa-marbuta, typos with `=`), `expandQuery()` synonym heuristics. |
| `02-catalogue.test.js` | `matchService()` — launch services hit correctly; **regression**: `تح=جديد تصريح سفينة` must NOT match driving licence; dialectal `بطاقة عامل` must surface work-permit / health-card. Seeds 5 deterministic rows (ids 900001–900005). |
| `03-agent.test.js` | v1 `runTurn()` state machine — greetings, full happy path (`renew driving licence → yes → 3 uploads → confirm → queued`), DB side-effects (request row + 3 doc rows with codes `['civil_id','medical','photo']` + citizen FK), **regression**: greeting must pop out of stuck `confirming`, upload in idle must not dump a service card, `cancel` resets. |
| `04-routes.test.js` | HTTP integration against a real Express app on a random port. Pages return 200, `/api/health`, chat + history, officer inbox, **atomic claim** (first wins, second gets 409), officer→citizen messaging, complete transition, catalogue search. |
| `05-agent-tricky.test.js` | 52 adversarial conversations exercising v1 heuristic edge cases (multi-intent, mid-flow cancels, language switches, spoof tool calls). |
| `06-auth-offers.test.js` | Auth, sessions, credit ledger, and the anonymized offers / accept-offer flow. |
| `08-hybrid-search.test.js` | Hybrid-search determinism — seeds a 7-row fixture and asserts FTS ordering, filter pruning (beneficiary, free, max_fee, channel), launch boost over ties, empty-query guard, typo OR-fallback. Runs without LLM key (semantic lane absent → fusion collapses to FTS-only). |
| `07-agent-v2.test.js` *(test:llm)* | LLM-path coverage: discovery EN + AR, start→confirm→collect transitions via explicit tool calls, cancel intent, tool-loop bound (≤8 calls). Skipped when `QWEN_API_KEY` is missing. |

**Adding a test:**
- Pure function → `01-unit.test.js`.
- Anything touching the DB → `02-catalogue.test.js` or `03-agent.test.js` (and `await bootTestEnv()` first).
- HTTP-level → `04-routes.test.js` (use `postChat`, `fetchJSON` helpers; server already spun up in `before`).

**Server must not auto-listen when imported.** `server.js` checks `SANAD_NO_AUTOSTART` and `isMain` (set by the harness). If you refactor boot, preserve this — otherwise integration tests will hang.

**Deterministic LLM path.** The main `npm test` suite sets `QWEN_API_KEY=''` so the v1 heuristic branch runs. If you add new behaviour behind the LLM, either (a) add a v1 heuristic fallback for the pinned suites, or (b) cover it in `tests/07-agent-v2.test.js` which runs with a real key via `npm run test:llm`.

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
     │                       lib/agent.js  :: runTurn
     │                          │
     │                 AGENT_V2 && QWEN key?
     │          yes ◄──┴──► no
     │          │              │
     │   runAgentV2            runLLMLoop / runHeuristic (v1)
     │    (unified             (scripted state machine — pinned tests)
     │     tool loop)
     │          │
     │          ▼
     │   lib/agent_tools.js :: TOOL_IMPL_V2  (17 tools)
     │          │
     │          ├─► lib/hybrid_search.js  (FTS5 + semantic + RRF)
     │          │     └─► lib/embeddings.js  (Float32Array cache, cosineTopK)
     │          │     └─► lib/llm.js :: embed()
     │          ├─► lib/llm.js :: chatWithTools()  (Qwen qwen-plus)
     │          └─► lib/db.js  (libSQL)
     │                             │
     └──────────────────────────── └─► data/sanad.db (dev) | Turso (prod)
```

See [AGENT.md](AGENT.md) for full tool catalogue, state diagram, and extension guide.

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

### Search pipeline

Two pipelines coexist:

**Hybrid search (`lib/hybrid_search.js`, default when Qwen key is set):**

1. **Structured pre-filter** — SQL `WHERE` built from `filters` (entity, beneficiary, payment_method, channel, is_launch, max_fee_omr, free). Returns candidate ID set.
2. **FTS5 BM25** — `MATCH` with tokenized query, top 50. If FTS returns empty, multi-token `LIKE` fallback.
3. **Semantic** — `cosineTopK(embed(query), 50, candidateIds)` against the 1024-dim Qwen vector cache (~15 ms on 3,417 rows).
4. **Reciprocal Rank Fusion** (k=60): `score = Σ 1/(k + rank_i)` + `+0.05` launch boost + `log1p(popularity)/50`.
5. **Optional LLM rerank** on top 10 (off by default).

**v1 fallback (`lib/catalogue.js`, no key or `SANAD_AGENT_V2=false`):**

1. `normalize()` — strip tashkeel, unify `إأآٱ→ا`, `ى→ي`, `ة→ه`, lowercase, strip punctuation.
2. Launch-service regex → catalogue AND-match → LIKE fallback.
3. Synonym expansion via `lib/query_rewriter.js`.

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
server.js              Express app + boot (exports prepare/start/app; background embed worker)
seed.js                CSV → service_catalog importer
seed-mock.js           Demo citizens/requests for UI testing
oman_services_directory.csv   3,417-row Sanad services catalogue
lib/
  db.js                libSQL client + migrations + 33-column CSV import + FTS5 rebuild
  llm.js               Qwen (OpenAI-compatible) client + chatWithTools() + embed()
  embeddings.js        Float32Array vector cache + embedPending() + cosineTopK()
  hybrid_search.js     FTS5 + semantic + structured filters + RRF fusion
  catalogue.js         Launch services + normalize() + matchService() (v1 fallback)
  query_rewriter.js    Synonym expansion (heuristic + LLM)
  agent.js             runTurn() dispatcher + v2 unified tool loop + v1 state machine
  agent_tools.js       TOOL_SPEC_V2 (17 tools) + TOOL_IMPL_V2 + v1 tool handlers
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
  helpers.js                 Test harness (isolated DB, spawnServer, postChat)
  01-unit.test.js            normalize(), expandQuery()
  02-catalogue.test.js       matchService() regression suite
  03-agent.test.js           v1 runTurn() state machine
  04-routes.test.js          HTTP integration
  05-agent-tricky.test.js    52 adversarial v1 conversations
  06-auth-offers.test.js     Auth, sessions, credit ledger, offers flow
  07-agent-v2.test.js        LLM-path coverage (requires QWEN_API_KEY)
  08-hybrid-search.test.js   FTS + filters + RRF deterministic fixture
Dockerfile                   Production image
render.yaml                  Render Blueprint
SANAD_AI_PLAN_V2.md          Product spec (read this)
SANAD_AI_DESIGN.md           Design decisions log
AGENT.md                     Chat agent architecture (v2 tool loop, hybrid search)
```

---

## 7 · Common tasks

### Add a new launch service

1. Edit `LAUNCH_SERVICES` in `lib/catalogue.js`. Add an entry with `code`, `name_en/ar`, `entity_en/ar`, `fee_omr`, `required_documents[]`, and a `match` regex array (English + Arabic variants).
2. If the docs checklist is new, add doc codes (e.g. `medical`, `photo`, `civil_id`) — they're used as `doc_code` in `request_document`.
3. Run `npm test` — the launch-service tests will exercise your match pattern.
4. Smoke test in `/chat.html`.

### Add a new LLM tool (agent v2)

1. Append the spec to `TOOL_SPEC_V2` in `lib/agent_tools.js` — name, description (LLM reads this to decide when to call), parameters schema.
2. Add the handler to `TOOL_IMPL_V2`: `async toolName(ctx, args) { return { ok, ... } }` where `ctx = { session_id, state, trace, citizen_phone }`. Mutate `ctx.state` freely — `runAgentV2` persists at turn end.
3. If the tool changes session state, include `transition: 'new_status'` in the return so `trace` shows it and the LLM knows.
4. Add a one-liner rule to `SYSTEM_V2` in `lib/agent.js` if the tool unlocks a new flow.
5. Add a case to `tests/07-agent-v2.test.js` (requires `QWEN_API_KEY`).

See [AGENT.md § Adding a new tool](AGENT.md#adding-a-new-tool) for the full walkthrough.

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

Full Meta Developer Console walkthrough is in **[docs/FACEBOOK_SETUP.md](docs/FACEBOOK_SETUP.md)** — Render-targeted, covers app creation, credentials, webhook URL + verify token, signature validation (`X-Hub-Signature-256`), test-number setup, and the path to a production system-user token.

Required `.env` keys: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`. With any of them empty the webhook stays a no-op (logs only) — useful for local dev.

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

- **2026-04-24 · Chat agent v2 landed.** Unified Qwen tool-calling loop (17 tools) replaces the v1 state-machine switch for every state, not just `idle`. Hybrid search (FTS5 + semantic embeddings + RRF + structured filters) replaces the 3-stage LIKE. Catalogue expanded to all 33 CSV columns. Background embed worker warms a 14 MB Float32Array cache on first boot. v1 kept intact as graceful fallback (empty `QWEN_API_KEY` or `SANAD_AGENT_V2=false`) so the pinned test suites stay deterministic. See [AGENT.md](AGENT.md).
- **2026-04-19 · Tests are the safety net.** 37-test suite added (`tests/`). Node built-in runner, runs in ~2s. Heuristic-mode only — deterministic, no network. Run before every commit. (Now 70 tests after agent-v2 landed.)
- **2026-04-19 · Server refactored to support testing.** `server.js` now exports `prepare()/start()/app` and only auto-listens when run directly (or when `SANAD_NO_AUTOSTART` unset). Integration tests spin up a real Express on a random port.
- **2026-04-19 · Greeting regex dropped `\b`.** `\b` word boundary is a no-op between two Arabic characters (both non-word in JS regex), so `^مرحب\b` never matched `مرحبا`. Regressed the "pop out of stuck confirming" guard. Fixed in `handleConfirming` + `handleCollecting`.
- **Earlier · LLM-first with heuristic fallback.** Agent architecture evolved from rigid state machine to tool-calling. Heuristic path is kept as (1) the deterministic test path, and (2) the no-key fallback.
- **Earlier · `start_submission` tool sets state + overrides LLM reply.** LLMs role-played "تم البدء" without actually starting the flow. Now the tool sets `state.status='collecting'` and returns a deterministic `firstDocPrompt()`.
- **Earlier · `sanitizeReply()` for LLM output.** Strips mid-word language switches — Qwen occasionally emitted franken-words like `إ issuance`. Also tightened the system prompt.
- **Earlier · Atomic claim via conditional UPDATE.** `UPDATE ... WHERE officer_id IS NULL`. Rows-affected=0 → 409. Tested.
- **Earlier · Design system in `public/theme.css`.** Replaced hard-box UI (~3.5/10 per user) with surface elevations, overlay scrollbars, ambient gradients, focus halos, skeleton loaders. Officer dashboard got grid/list toggle + ⌘K command palette + explicit action buttons on claimed cards.
- **Earlier · Query rewriter with hardcoded synonyms.** Dialectal `بطاقة عامل` → work-permit / labour-card / `تصريح عمل`. Prevents driving-licence false positives for unrelated queries.

---

2026-04-24 · dev build · 70 tests passing (+ 5 LLM-path tests behind `npm run test:llm`)
