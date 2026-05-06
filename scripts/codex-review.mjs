#!/usr/bin/env node
// scripts/codex-review.mjs
//
// Sends a design-review question to GPT-5-Codex via lib/codex.js and prints
// the answer. Used to validate proposed agent-flow changes BEFORE shipping
// them. Reads OPENAI_API_KEY from .env.
//
// Usage:
//   node scripts/codex-review.mjs               # uses the default review prompt
//   node scripts/codex-review.mjs path/to.md    # reads the prompt from a file
//   echo "question" | node scripts/codex-review.mjs -   # reads from stdin

import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { askCodex, isCodexEnabled } from '../lib/codex.js';

const DEFAULT_PROMPT = `
Sanad-AI is an Arabic WhatsApp + web agent that helps Omani citizens
prepare gov-service request files. The WhatsApp pipeline is:

  webhook → fetchMedia → runTurn (per-session lock) → runAgentV2
  → tool-loop (record_document, record_extra_document, submit_request, …)
  → burst aggregator (1.2s quiet window) → sendWhatsAppText/Buttons.

Three production complaints just landed:

  (1) Buttons are missing in too many turns. The current heuristic
      attaches buttons only when (a) the file just landed in pending_uploads
      with no caption, (b) classification was ambiguous, or (c) a regex
      detects "yes/no" phrasing. Many natural turns ("send the next
      doc, or skip?") don't trigger any of these and the citizen has to
      type Arabic on a phone keyboard.

  (2) When the citizen sends 4-5 files in a rapid burst, the bot
      occasionally still produces multiple replies. The burst aggregator
      uses a 1.2s quiet window + an in-flight counter, but a slow
      record_document call can let the timer fire on file 1 before file 2
      enters the lock.

  (3) After a file is auto-recorded into a slot, the bot sometimes asks
      "is this for X?" instead of just confirming receipt and asking for
      the next doc — friction the citizen can't resolve except by typing.

Proposed fix:

  • Replace the post-LLM button heuristic with a CONTEXT-DRIVEN attacher:
      - state collecting + just recorded → [📋 المتبقي, ➕ إضافي, ⏸ إيقاف]
      - state collecting + all docs in     → [📤 أرسل للمراجعة, ➕ إضافي, ✕ إلغاء]
      - state reviewing                    → [📤 أرسل, ➕ إضافي, ✕ إلغاء]
      - file just buffered (no caption)    → keep the existing 3-button doc:* set
      - generic yes/no detected            → keep the existing confirm:yes/no
    Always returns SOME button set when the bot is asking the citizen for
    any action.

  • For (2): bump the in-flight gate so it ALSO checks the SESSION_BURST
    pendingBurst window: if pending count > 0 AND another file is queued
    in the lock, re-arm rather than flush. Also de-duplicate identical
    consecutive bot replies in the WA send layer (defensive).

  • For (3): when record_document succeeds inside the V2 loop, override
    the LLM reply with a deterministic short ack:
        ✅ استلمت {label}
        التالي: {next_label}
    and attach the collecting buttons above. Skip this override only when
    the LLM also requested record_extra (mixed-batch case).

  • Wire routes/whatsapp.js to call sendWhatsAppButtons when runTurn returns
    a non-empty _buttons array (currently the route only calls
    sendWhatsAppText, dropping any LLM-suggested buttons on text turns).

Questions for you:

  1. Are there failure modes in this design we should handle BEFORE
     shipping? (Particularly: any case where attaching buttons would
     CONFUSE the citizen rather than help — e.g. a free-text answer
     expected.)
  2. Is the "always attach contextual buttons" stance too aggressive?
     Should there be states where we deliberately leave buttons OFF?
  3. For (2), is there a simpler fix than the in-flight + dedup combo?

Be terse and specific. File:line refs OK. No "as an AI…".
`.trim();

async function main() {
  if (!isCodexEnabled()) {
    console.error('OPENAI_API_KEY not set. Add it to .env, then re-run.');
    process.exit(1);
  }

  let prompt = DEFAULT_PROMPT;
  const arg = process.argv[2];
  if (arg === '-') {
    prompt = fs.readFileSync(0, 'utf8'); // stdin
  } else if (arg) {
    prompt = fs.readFileSync(arg, 'utf8');
  }

  console.error('[codex] sending review request… (model: ' + (process.env.OPENAI_CODEX_MODEL || 'gpt-5-codex') + ')');
  const r = await askCodex({ prompt, max_tokens: 900, temperature: 0.2 });
  if (!r.ok) {
    console.error('[codex] error:', r.error, r.detail || '');
    process.exit(2);
  }
  console.error(`[codex] ${r.model} · ${r.ms}ms${r.fellback ? ' (fallback)' : ''}`);
  console.log('\n' + r.text + '\n');
}

main().catch(e => { console.error(e); process.exit(3); });
