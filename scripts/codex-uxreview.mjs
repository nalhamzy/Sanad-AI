#!/usr/bin/env node
// scripts/codex-uxreview.mjs
//
// Asks gpt-5.2-codex to predict the most likely "weird and confusing"
// failure modes in the as-deployed WhatsApp pipeline. Reads the AGENT
// CODE PATHS we just shipped and the SYSTEM PROMPT, asks codex to act
// as a hostile QA reviewer who has just received a vague complaint
// from a real user.
//
// Output: numbered list of likely failure modes, each with:
//   • the symptom the citizen would observe
//   • the file:line where the bug lives
//   • the smallest concrete fix
//
// We feed it the actual relevant code chunks (so it's not guessing from
// the description) — this avoids the "tell me about your design"
// abstraction layer.

import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { askCodex, isCodexEnabled } from '../lib/codex.js';

if (!isCodexEnabled()) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

function slice(path, fromLine, toLine) {
  const lines = fs.readFileSync(path, 'utf8').split('\n');
  return lines.slice(fromLine - 1, toLine).map((l, i) => `${(fromLine + i).toString().padStart(5, ' ')} | ${l}`).join('\n');
}

const PROMPT = `
You are a hostile QA reviewer on a WhatsApp citizen-services bot. A
user just complained the bot is "acting weird and confusing" and "not
ready for production". You don't have the trace yet. From the code
alone, predict the **5 most likely production failure modes** that
would cause that complaint.

## Pipeline summary
WhatsApp webhook → fetchMedia → runTurn (per-session lock + in-flight
counter) → runAgentV2 (tool-loop, max 6 rounds) → burst aggregator
(1.2s quiet window) → sendWhatsAppText/Buttons.

22 tools available (search_services, start_submission, record_document,
record_extra_document, submit_request, etc.). State machine:
idle → collecting → reviewing → queued → claimed → in_progress → completed.

Buttons are auto-attached. ID → text mappings in routes/whatsapp.js:
  doc:yes / doc:wrong / doc:extra
  doc:list      → "اعرض المتبقي من المستندات"
  review:submit → "أؤكد الإرسال للمراجعة"
  service:cancel→ "إلغاء الطلب"
  burst:done    → "تم"
  burst:more    → "سأرسل المزيد"
  confirm:yes / confirm:no

## Code I want you to review (deployed yesterday)

### routes/whatsapp.js — webhook entry + button-id mapping
\`\`\`
${slice('routes/whatsapp.js', 70, 200)}
\`\`\`

### lib/agent.js — burst aggregator (drainBurst)
\`\`\`
${slice('lib/agent.js', 130, 260)}
\`\`\`

### lib/agent.js — runAgentV2 deterministic record reply + button attacher (post-tool-loop)
\`\`\`
${slice('lib/agent.js', 2640, 2770)}
\`\`\`

### lib/agent.js — attachContextualButtons + helpers
\`\`\`
${slice('lib/agent.js', 2770, 2920)}
\`\`\`

## Specifically address these scenarios in your review

1. Citizen sends 4 files in a row, then taps "✓ تم". What does the LLM
   do with the literal text "تم"? Does state.status transition to
   reviewing automatically, or does the LLM make it up?
2. Citizen sends 1 file, vision auto-records into a slot with conf
   0.66 — what reply do they see? Is the deterministic ack ever shown
   alongside the LLM's "is this for X?" question?
3. Citizen asks "كم الرسوم؟" mid-collection. Does the agent answer the
   question AND show \`📋 المتبقي / ➕ إضافي / ✕ إلغاء\` buttons? If
   yes, is that confusing?
4. Citizen taps "✕ إلغاء" by accident. Is there a confirm step? Or
   does the draft die immediately?
5. Burst summary fires while a NEW file is mid-fetch (race between
   route fetchMedia and drainBurst flush). What does the citizen see?

For each of the 5 most likely failure modes, output:
  • Symptom (in citizen's words)
  • File + line range where the bug lives
  • Smallest concrete fix (under 10 lines of code if possible)

No prose preamble. Numbered list. Each item ≤ 5 lines. Be brutal.
`.trim();

console.error('[codex] sending UX-review request to gpt-5.2-codex…');
const r = await askCodex({ prompt: PROMPT, max_tokens: 1500 });
if (!r.ok) { console.error('[codex] error:', r.error, r.detail || ''); process.exit(2); }
console.error(`[codex] ${r.model} · ${r.endpoint} · ${r.ms}ms${r.fellback ? ' (fallback)' : ''}\n`);
console.log(r.text);
