#!/usr/bin/env node
// scripts/codex-doc-review.mjs
//
// Sends docs/agent-behavior.md + docs/agent-metrics.json to gpt-5.2-codex
// and asks for: (1) bugs/contradictions in the doc, (2) UX issues
// implied by the metrics, (3) the smallest concrete change to ship now.
//
// Used by the per-iteration /loop step that "evaluates using gpt codex".

import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { askCodex, isCodexEnabled } from '../lib/codex.js';

if (!isCodexEnabled()) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

let doc = '', metrics = '';
try { doc = fs.readFileSync('docs/agent-behavior.md', 'utf8'); }
catch { console.error('docs/agent-behavior.md missing — run iter 1 first'); process.exit(2); }
try { metrics = fs.readFileSync('docs/agent-metrics.json', 'utf8'); }
catch { metrics = '(no metrics yet)'; }

const PROMPT = `
You're GPT-5-Codex reviewing the Sanad-AI WhatsApp agent for the
Khidmat-style citizen-services flow. Two artefacts:

  1. The behaviour spec at docs/agent-behavior.md (12 sections + 12
     test scenarios + button matrix + state machine).
  2. The latest metrics from docs/agent-metrics.json (computed from
     real production traces over 24h).

Goal: find the THREE most valuable changes I should ship in the next
deploy. For each: name the issue, the file:line if you can spot it
in the doc, and the smallest concrete fix.

Constraints — apply them silently while reviewing:
  • The agent runs claude-opus-4-5 (3× slower than Sonnet) so
    deterministic handlers > LLM handlers wherever possible.
  • Pricing is pre-set per service (no marketplace, no offers, no
    "pick an office"). The doc should reflect that. Code already
    does.
  • Citizen language is Arabic by default; English replies in
    Arabic threads are bugs.
  • Buttons are the primary input surface; typing is fallback.
  • Multi-file bursts must produce ONE bot bubble.

Specifically address:
  Q1. The 60% "English-label leak" rate in the metrics — is this
      stale data (pre-fix) or a real leak path?
  Q2. The 5 "silent failures (60s)" hazard — false-positive burst
      continuations or real bugs?
  Q3. queued=0/1 in the flow reach despite an actually-submitted
      request — is the regex right? Suggest a better detection.
  Q4. The doc claims hallucination guards are layered. Are there
      patterns the regex doesn't cover that real LLMs would emit?
      List 2.
  Q5. Anything in the test scenarios that's NOT being tested but
      should be (e.g. payment-link flow, OTP forwarding, office
      cancel-rejection)? Name 2.

────────────────────── BEHAVIOUR SPEC ──────────────────────
${doc}

────────────────────── METRICS JSON ────────────────────────
${metrics}

────────────────────── END ─────────────────────────────────

Output: 5 bullet sections (Q1–Q5) + a final section "TOP-3 CHANGES
TO SHIP NOW". Each bullet ≤ 3 lines. No prose preamble. Be brutal.
`.trim();

console.error('[codex] sending doc+metrics review to gpt-5.2-codex…');
const r = await askCodex({ prompt: PROMPT, max_tokens: 4000, timeout_ms: 180_000 });
if (!r.ok) { console.error('[codex] error:', r.error, r.detail || ''); process.exit(2); }
console.error(`[codex] ${r.model} · ${r.endpoint} · ${r.ms}ms${r.fellback ? ' (fallback)' : ''}\n`);
console.log(r.text);

// Persist the latest review for the iteration commit message.
fs.writeFileSync('docs/agent-codex-review.md',
  `# GPT-5.2-Codex review · ${new Date().toISOString()}\n\nModel: ${r.model}\n\n---\n\n${r.text}\n`);
console.error('Wrote docs/agent-codex-review.md');
