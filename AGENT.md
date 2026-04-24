# Sanad-AI Chat Agent — Architecture

This document describes the **v2 unified tool-calling agent** that powers the citizen chat at `/chat.html` and the WhatsApp webhook. v1 (the scripted state machine in `lib/agent.js`) is preserved as a fallback when `QWEN_API_KEY` is empty or `SANAD_AGENT_V2=false`.

## Why v2

v1 only ran the LLM in the `idle` state; every other state (`confirming`, `collecting`, `reviewing`, `queued`…) used regex branches. That made the agent:
- Unable to handle natural language during a flow ("actually cancel that" while collecting → fell through to nudge).
- Limited to a hardcoded 5-code allow-list for submission.
- Weak at service discovery (3-stage `LIKE` on `search_blob`, 7 synonyms, no semantics).
- Blind to most catalogue fields (beneficiary, payment method, channels, avg time).

v2 replaces the switch with a single tool-calling loop that handles every state via explicit tool calls. Service discovery is now hybrid FTS5 + semantic embeddings + RRF + structured filters.

## High-level shape

```
┌─────────────────┐  user turn  ┌─────────────────────────────────┐
│  /api/chat/:sid │────────────▶│ lib/agent.js :: runTurn         │
└─────────────────┘             └───────────────┬─────────────────┘
                                                │ AGENT_V2 && LLM?
                                   ┌───────────▶│─────────────┐
                                   │yes         │         no  ▼
                         runAgentV2 loop                 scripted v1
                                   │                     (heuristic)
                                   ▼
                   ┌───────────────────────────────┐
                   │ chatWithTools (Qwen)          │
                   │   tools = TOOL_SPEC_V2 (~17)  │
                   └──────────────┬────────────────┘
                                  │ tool_calls
                                  ▼
                   ┌───────────────────────────────┐
                   │ TOOL_IMPL_V2 (lib/agent_tools)│
                   │   • search_services ──────────┼──▶ hybrid_search.js
                   │   • get_service_details      │        ├── FTS5 (BM25)
                   │   • start_submission          │        ├── embeddings
                   │   • confirm_submission        │        ├── RRF fusion
                   │   • record_document           │        └── LLM rerank (opt)
                   │   • submit_request            │
                   │   • cancel_request            │
                   │   • accept_offer / list_offers│
                   │   • compare_services          │
                   │   • …                         │
                   └───────────────┬───────────────┘
                                   │ state mutated in-place
                                   ▼
                         saveSession → message log
```

## Hybrid search

`lib/hybrid_search.js::searchServices(query, filters, {k, useLLMRerank})`:

1. **Structured pre-filter** — `WHERE` clause built from `filters` (entity, beneficiary, payment_method, channel, is_launch, max_fee_omr, free). Returns a candidate id set.
2. **FTS5 BM25** — `MATCH` with tokenized query, top 50 by `bm25()`. If FTS returns empty, falls back to a multi-token `LIKE` scan.
3. **Semantic** — `cosineTopK(embed(query), 50, candidateIds)` against the 1024-dim Qwen vector cache.
4. **Reciprocal Rank Fusion** (k=60): `score = Σ 1/(k + rank_i)`. Boost `+0.05` for `is_launch=1` and `log1p(popularity)/50`.
5. **Optional LLM rerank** — on the top 10, Qwen emits a JSON id array to re-order.

### Graceful degradation

| QWEN_API_KEY | cache warm? | behaviour |
|---|---|---|
| set | yes | FTS + semantic + RRF (full quality) |
| set | no (first 90 s after boot) | FTS-only; semantic warms up in background |
| empty | n/a | FTS-only; `matchService` legacy path unchanged |

## Embeddings

- Model: Qwen `text-embedding-v3`, 1024 dims.
- Cost: one-time ≈ $0.20 for 3,417 rows.
- Storage: JSON array in `service_catalog.embedding_json` + `embedded_at` epoch ms.
- Cache: `lib/embeddings.js::loadEmbeddingCache()` packs all vectors into a single `Float32Array` (~14 MB). Cosine scan clocks ≈ 15 ms.
- Boot: `server.js` fires `embedPending()` in the background after `autoImportCatalog` — first boot returns fast; the cache warms while the process serves traffic.

## Tool catalogue (v2)

| Tool | Purpose | State it affects |
|---|---|---|
| `search_services` | Hybrid search + filters | none |
| `get_service_details` | Full row incl. process steps | none |
| `list_entities` | Top ministries + counts | none |
| `list_categories` | MainService groupings | none |
| `get_entity_services` | All services for one ministry | none |
| `compare_services` | Side-by-side 2-3 services | none |
| `start_submission` | Begin draft request | → confirming |
| `confirm_submission` | Citizen said yes | → collecting |
| `record_document` | Mark one doc as provided | collecting → reviewing (when full) |
| `submit_request` | Queue for office pickup | → queued |
| `get_my_requests` | List citizen's requests | none |
| `get_request_status` | Detailed status + office | none |
| `list_offers` | Anonymized office offers | none |
| `accept_offer` | Bind request to one office | → claimed |
| `cancel_request` | Hard-cancel or intent | → idle / stays |
| `replace_document` | Reopen one doc slot | → collecting |
| `add_note` | Note visible to office | none |
| `get_session_state` | Debug introspection | none |

## Cancel semantics

| Request status at time of cancel | Tool outcome | Effect |
|---|---|---|
| `collecting`, `ready`, `queued` | `hard_cancelled` | Status → `cancelled`, session → `idle` |
| `claimed`, `in_progress` | `cancel_requested` | Sets `cancel_requested=1`; office must confirm |
| `completed`, `cancelled` | `already_*` | No-op |

## Session state machine (what tools drive it)

```
       ┌─────┐
       │ idle│◀─────────────────────────┐
       └──┬──┘                          │
start_submission                         │
       │                                 │
       ▼                                 │
   ┌──────────┐ confirm_submission  ┌────────────┐  submit_request  ┌────────┐
   │confirming│ ───────────────────▶│ collecting │─────────────────▶│ queued │
   └──┬───────┘                     └──────┬─────┘ (via reviewing)  └───┬────┘
      │cancel_request                      │                            │
      └────────────────▶ idle              │record_document             │ accept_offer
                                           │(repeat until all in)       ▼
                                           ▼                        ┌────────┐
                                       ┌──────────┐                 │ claimed│
                                       │ reviewing│                 └────┬───┘
                                       └──────────┘                      │
                                                                         ▼
                                                                    ┌───────────┐
                                                                    │in_progress│
                                                                    └─────┬─────┘
                                                                          ▼
                                                                    ┌──────────┐
                                                                    │completed │
                                                                    └──────────┘
```

## Adding a new tool

1. **Spec** — append to `TOOL_SPEC_V2` in `lib/agent_tools.js` with clear `description` (the LLM reads this to decide when to call).
2. **Impl** — add handler to `TOOL_IMPL_V2`: `async toolName(ctx, args) { return { ok, ... } }`. `ctx = { session_id, state, trace, citizen_phone }` — mutate `ctx.state` freely; `runAgentV2` persists at turn end.
3. **State transition** — if the tool changes session state, include `transition: 'new_status'` in the return so the `trace` shows it and the LLM knows.
4. **Prompt** — if the new tool unlocks a new flow, add a one-liner rule to `SYSTEM_V2` in `lib/agent.js`.
5. **Test** — add a case to `tests/07-agent-v2.test.js` (requires `QWEN_API_KEY`).

## Rollback

v2 is feature-flagged. To disable:
```bash
# In .env
SANAD_AGENT_V2=false
```
…or just unset `QWEN_API_KEY`. All v1 code paths (`runLLMLoop`, `runHeuristic`, scripted handlers) remain intact and are covered by the pinned test suite (`03-agent`, `05-agent-tricky`).

## Performance

Per turn (warm cache, LLM enabled, single-tool round):
- Hybrid search: ~120 ms (query embed 80 ms + FTS 15 ms + cosine 15 ms + misc).
- Qwen tool-calling turn: 600–1200 ms.
- Tool impls (DB only): <20 ms.

First boot: catalogue import ~3 s, embeddings ~90 s in background (process already serving).

## Environment variables

| Var | Purpose |
|---|---|
| `QWEN_API_KEY` | Enables LLM + embeddings. Empty → heuristic-only. |
| `QWEN_MODEL` | Default `qwen-plus`. |
| `QWEN_EMBED_MODEL` | Default `text-embedding-v3`. |
| `QWEN_EMBED_DIM` | Default `1024`. |
| `SANAD_AGENT_V2` | `true` routes every turn through `runAgentV2`. |
| `SANAD_SKIP_EMBED` | `1` disables the background embedder (useful in tests/CI). |
