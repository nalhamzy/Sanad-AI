#!/usr/bin/env node
// scripts/codex-bench-review.mjs
//
// Sends the latest docs/scenario-bench-report.json transcripts to
// gpt-5.2-codex and asks for the THREE most valuable improvements.
// Used per /loop iteration to drive the next deploy's changes.

import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { askCodex, isCodexEnabled } from '../lib/codex.js';

if (!isCodexEnabled()) { console.error('OPENAI_API_KEY missing'); process.exit(1); }
let report;
try { report = JSON.parse(fs.readFileSync('docs/scenario-bench-report.json', 'utf8')); }
catch { console.error('docs/scenario-bench-report.json missing — run scripts/scenario-bench.mjs first'); process.exit(2); }

// Keep the prompt under ~25 KB by trimming each transcript turn to its
// essentials. Codex doesn't need the full state JSON, just the chat.
const compactResults = (report.results || []).map(r => ({
  id: r.id,
  label: r.label,
  final_state: r.final_state,
  turns: (r.transcript || []).map(t => ({
    citizen: t.citizen,
    bot:     (t.bot_reply || '').slice(0, 600),
    buttons: t.buttons || []
  })),
  db_msgs_count: (r.db_messages || []).length,
  ms: r.ms
}));

const PROMPT = `
You're GPT-5-Codex reviewing a Sanad-AI agent benchmark run. The
agent is an Arabic WhatsApp/web assistant for Omani gov-services.
Pricing is pre-set per service (no marketplace, no offers).

Below are 7 scenario transcripts captured against the live agent.
Metrics summary:
${JSON.stringify(report.summary, null, 2)}

Scenarios + transcripts:
${JSON.stringify(compactResults, null, 2)}

Specifically look for:
  • Replies in English mid-Arabic conversation (must NOT happen).
  • Buttons missing where citizen has a clear next-step decision.
  • Repeated/duplicate bot messages within a scenario.
  • Hallucinated service info (fees, doc names not in catalogue).
  • Silent failures (citizen turn → no bot reply).
  • Verbose/over-long replies (>200 chars when a question + checklist).
  • Citizen-experience regressions where the bot does something the
    citizen didn't ask for.

Output (≤300 words):
  • Per-scenario ONE-LINE verdict (✅ pass / ⚠️ minor / ❌ fail + reason)
  • TOP-3 changes to ship in the next iteration, each with:
      - file:line if you can spot it
      - the smallest concrete fix (under 10 lines)
  • One question or assumption you'd want clarified

No prose preamble. Be brutal but actionable.
`.trim();

console.error('[codex] sending bench review to gpt-5.2-codex…');
const r = await askCodex({ prompt: PROMPT, max_tokens: 4000, timeout_ms: 240_000 });
if (!r.ok) { console.error('[codex] error:', r.error, r.detail || ''); process.exit(2); }
console.error(`[codex] ${r.model} · ${r.endpoint} · ${r.ms}ms${r.fellback ? ' (fallback)' : ''}\n`);
console.log(r.text);

fs.writeFileSync('docs/agent-codex-bench-review.md',
  `# GPT-5.2-Codex bench review · ${new Date().toISOString()}\n\nModel: ${r.model}\n\n---\n\n${r.text}\n`);
console.error('Wrote docs/agent-codex-bench-review.md');
