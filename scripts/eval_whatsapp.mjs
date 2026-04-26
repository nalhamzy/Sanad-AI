// WhatsApp-specific Opus-as-judge evaluation for the Sanad-AI agent.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/eval_whatsapp.mjs
//
// Sibling to scripts/eval_scenarios.mjs — same harness shape, but each
// scenario specifies the Meta inbound envelope (text.body, button.text,
// image, document with filename) and the judge gets WhatsApp-specific
// quality dimensions (no markdown leak, plaintext-friendly length, button
// replies treated as intent). The agent backend is the same `runTurn`
// either channel uses, so we drive it directly and skip the HTTP route.
//
// Writes ./eval-whatsapp-report.json and prints a summary. Exit code is 0
// only when every scenario passes.

import fs from 'fs';
import path from 'path';

// Dedicated DB so the WhatsApp eval doesn't collide with dev data or with
// scripts/eval_scenarios.mjs (which uses sanad-eval.db).
process.env.NODE_ENV = process.env.NODE_ENV || 'eval';
process.env.DB_URL = process.env.DB_URL || 'file:./data/sanad-eval-wa.db';
process.env.SANAD_NO_AUTOSTART = '1';
process.env.SANAD_AGENT_V2 = process.env.SANAD_AGENT_V2 || 'true';
process.env.DEBUG_MODE = process.env.DEBUG_MODE || 'false';

const EVAL_DB = './data/sanad-eval-wa.db';
try { fs.unlinkSync(EVAL_DB); } catch {}
try { fs.unlinkSync(EVAL_DB + '-journal'); } catch {}
fs.mkdirSync('./data', { recursive: true });

const { migrate, seedDemoOffices, autoImportCatalog } = await import('../lib/db.js');
const { runTurn } = await import('../lib/agent.js');
const { LLM_ENABLED, LLM_PROVIDER, LLM_MODEL, chat } = await import('../lib/llm.js');

if (!LLM_ENABLED || LLM_PROVIDER !== 'anthropic') {
  console.error(`✗ Need LLM_PROVIDER=anthropic and a valid ANTHROPIC_API_KEY (got provider=${LLM_PROVIDER}, enabled=${LLM_ENABLED}).`);
  process.exit(1);
}

console.log(`▶ provider=${LLM_PROVIDER} model=${LLM_MODEL}`);
console.log('▶ migrating + seeding catalogue (this can take ~30s on first run)…');
await migrate();
await seedDemoOffices();
await autoImportCatalog();
console.log('▶ seed done. starting WhatsApp scenarios.\n');

// ── Scenarios ─────────────────────────────────────────────────────
// Each turn is a Meta-shaped fragment: { text: {body}, button: {text},
// image: {mime_type, caption}, document: {mime_type, filename, caption} }.
// The runner translates this the same way routes/whatsapp.js does before
// calling runTurn — so the agent sees the same shape as a real inbound.
const SCENARIOS = [
  {
    id: 'wa_button_reply',
    description: 'Citizen taps a "Yes" quick-reply button — arrives as msg.button.text, not msg.text.body. Civil ID renewal requires documents, so the confirming → collecting transition is observable.',
    expectations: [
      'Treats the button text as the user\'s intent (confirmation), not as raw chat text.',
      'After the button tap on the confirmation prompt, transitions toward document collection and asks for the first document.',
      'Does not get confused by the button label and ask the user to repeat themselves.'
    ],
    turns: [
      { text: { body: 'I want to renew my civil id' } },
      { button: { text: 'Yes' } }
    ]
  },
  {
    id: 'wa_image_caption_intent',
    description: 'FIRST message is an image with caption "i need to renew my civil id, here is my current one" — no prior text. Tests caption-as-intent (not just caption-as-doc-label).',
    expectations: [
      'Reads the caption as the user\'s intent and identifies they want to renew their civil ID.',
      'Acknowledges the image — does not silently ignore it or treat it as random spam.',
      'Either asks one clarifying question OR starts the civil-ID flow; in either case the response refers to civil ID specifically.',
      'On the follow-up "Yes" button, advances toward document collection or submission instead of looping.'
    ],
    turns: [
      { image: { mime_type: 'image/jpeg', caption: 'i need to renew my civil id, here is my current one' } },
      { button: { text: 'Yes' } }
    ]
  },
  {
    id: 'wa_document_filename_only',
    description: 'Citizen sends a PDF named civil_id_copy.pdf with no caption. Filename should be used as caption fallback.',
    expectations: [
      'Recognises the document as a civil ID copy from the filename (no caption was provided).',
      'Auto-records it under the correct doc slot.',
      'Acknowledges receipt and continues the flow — does not loop asking for the same document.'
    ],
    turns: [
      { text: { body: 'تجديد بطاقتي الشخصية' } },
      { button: { text: 'نعم' } },
      { document: { mime_type: 'application/pdf', filename: 'civil_id_copy.pdf' } }
    ]
  },
  {
    id: 'wa_long_reply_check',
    description: 'Info-only Q&A about passport renewal — reply must render cleanly inside WhatsApp (no markdown, reasonable length).',
    expectations: [
      'Answers the citizen\'s question with required documents and fees, citing only what\'s in the catalogue.',
      'Does NOT use markdown that WhatsApp renders as raw asterisks/hashes (no `*bold*`, `# headers`, `|tables|`, ```code fences```).',
      'Reply length is reasonable for a phone screen — under ~2000 characters; ideally a short list, not a wall of text.',
      'Ends with a one-line offer to start the actual request (consistent with the prep+dispatch mission).'
    ],
    turns: [
      { text: { body: 'what documents do I need for passport renewal and how much does it cost?' } }
    ]
  },
  {
    id: 'wa_extra_documents',
    description: 'During a civil ID renewal flow, the citizen attaches a supplementary file (electricity bill as proof of address) BEFORE the required civil ID. Tests the new disambiguation flow and the record_extra_document tool — bot must NOT silently slot the file into the required civil ID slot, must ask whether it\'s required or supplementary, then record it as an extra and continue collecting the required civil ID.',
    expectations: [
      'Starts the civil ID renewal flow correctly.',
      'When the user uploads a file with a caption clearly unrelated to civil ID (proof of address / electricity bill), the bot does NOT silently record it as the required civil ID document.',
      'Asks ONE short clarifying question: is this for the required civil ID, or an extra/supplementary file?',
      'On user confirming "extra / supplementary", the bot records the file via the supplementary path and continues asking for the required civil ID.',
      'After the required civil ID is uploaded, the review summary mentions BOTH the required civil ID (as collected) AND the supplementary file (as extra/attached alongside).'
    ],
    turns: [
      { text: { body: 'I want to renew my civil id' } },
      { button: { text: 'Yes' } },
      { document: { mime_type: 'application/pdf', filename: 'electricity_bill_address.pdf', caption: 'extra supporting doc - my electricity bill as proof of address' } },
      { text: { body: "yeah it's extra supplementary, attach it alongside please" } },
      { image: { mime_type: 'image/jpeg', caption: 'this is my civil id' } }
    ]
  },
  {
    id: 'wa_session_continuity',
    description: 'Same wa:<phone> session across 4 turns of a passport-renewal flow (which has multiple required documents). Tests that session state survives between WhatsApp messages and that "what\'s next?" mid-flow returns the next pending document.',
    expectations: [
      'Treats all 4 turns as one ongoing conversation (same session id).',
      'After the user starts the passport flow and uploads one document, the next turn knows the flow is in progress — does not reset to idle.',
      'When the user asks "what\'s next?" mid-flow with documents still pending, the reply names the specific next required document — not a generic greeting and not "all done".'
    ],
    turns: [
      { text: { body: 'I want to renew my passport' } },
      { button: { text: 'Yes' } },
      { image: { mime_type: 'image/jpeg', caption: 'civil id' } },
      { text: { body: "what's next?" } }
    ]
  }
];

// ── Translate a Meta envelope turn → runTurn() input ──────────────
// Mirrors the parsing in routes/whatsapp.js so the agent sees the same
// shape it would see from a real inbound webhook.
function turnToAgentInput(turn, sid, i) {
  const text = turn.text?.body || turn.button?.text || '';
  const media = turn.image || turn.document || null;
  const caption = (media?.caption || turn.document?.filename || '').toString();

  let attachment = null;
  if (media) {
    const originalName = turn.document?.filename || null;
    const ext = (media.mime_type || '').split('/')[1]?.split(';')[0] || 'bin';
    attachment = {
      url: `/uploads/${sid}/fake-${i}.${ext}`,
      mime: media.mime_type || '',
      size: 1234,
      name: originalName,
      caption
    };
  }

  // Same effectiveText fallback as routes/whatsapp.js — when the user only
  // sent media + a caption, the caption seeds intent detection.
  const effectiveText = text || caption;
  return { effectiveText, attachment };
}

function turnLabel(turn) {
  if (turn.text?.body) return `text: "${turn.text.body}"`;
  if (turn.button?.text) return `button: "${turn.button.text}"`;
  if (turn.image) return `image (caption="${turn.image.caption || ''}")`;
  if (turn.document) return `document (filename="${turn.document.filename || ''}", caption="${turn.document.caption || ''}")`;
  return '(empty)';
}

// ── Run a scenario ────────────────────────────────────────────────
async function runScenario(s) {
  // Use a phone-shaped session id like real WhatsApp ('wa:<E.164>').
  const phone = `+9689${String(Math.floor(1e7 * Math.random())).padStart(7, '0')}`;
  const sid = `wa:${phone}-${Date.now()}`;
  const transcript = [];
  for (let i = 0; i < s.turns.length; i++) {
    const turn = s.turns[i];
    const { effectiveText, attachment } = turnToAgentInput(turn, sid, i);
    let out;
    try {
      out = await runTurn({
        session_id: sid,
        user_text: effectiveText || '',
        attachment,
        citizen_phone: phone
      });
    } catch (e) {
      out = { reply: `[runTurn threw: ${e.message}]`, state: null, request_id: null };
    }
    transcript.push({
      turn: i + 1,
      user: turnLabel(turn),
      effectiveText,
      attachment: attachment ? { name: attachment.name, mime: attachment.mime, caption: attachment.caption } : null,
      bot: out.reply,
      state: out.state,
      request_id: out.request_id ?? null
    });
  }
  return { sid, phone, transcript };
}

// ── Judge with Opus ───────────────────────────────────────────────
const JUDGE_SYSTEM = `You are an expert evaluator of Sanad-AI on the WhatsApp channel. Sanad-AI's mission is to PREPARE a complete request file (correct service + required documents + fees) and DISPATCH it to the Sanad offices marketplace (human service-bureau offices that process government paperwork on the citizen's behalf). It does NOT process requests itself; it does NOT send requests directly to ministries/ROP/police.

You will receive one scenario, the expectations a competent agent should meet on WhatsApp, and the full transcript of one run. Judge strictly but fairly.

WhatsApp-specific quality dimensions (apply across every scenario):
- Replies must be plaintext-friendly. No \`*bold*\`, no \`# headers\`, no markdown tables (\`|...|\`), no triple-backtick code fences. WhatsApp does not render these — they show as literal characters.
- Replies should fit comfortably on a phone screen. Anything over ~2000 characters is a problem unless the user explicitly asked for long content.
- Quick-reply / button taps (turns labelled \`button: "..."\`) must be interpreted as the user's intent, not as raw chat text. E.g. tapping a "Yes" button after a confirmation prompt should advance the state, not produce "I'm not sure what you mean by Yes."
- Captions on media and document filenames are valid intent signals — the bot should not ignore them.

Output STRICT JSON, nothing else, in this shape:
{
  "verdict": "PASS" | "NEEDS_IMPROVEMENT",
  "score": <integer 0-10>,
  "passed_expectations": [<expectation strings that were met>],
  "failed_expectations": [<expectation strings that were not met>],
  "whatsapp_specific_issues": [
    {"dimension": "markdown"|"length"|"button_intent"|"caption_intent"|"other", "description": "...", "fix": "concrete change"}
  ],
  "issues": [
    {"severity": "high"|"med"|"low", "description": "...", "fix": "concrete change to prompts/tools/state-machine"}
  ],
  "summary": "one short paragraph on overall quality on the WhatsApp channel"
}

Score rubric:
- 9-10: PASS. All expectations met; replies render cleanly on WhatsApp; concise.
- 7-8: PASS with minor polish needed.
- 5-6: NEEDS_IMPROVEMENT. One or more material expectations failed, or a WhatsApp-specific quality issue (markdown leak, oversized reply).
- 0-4: NEEDS_IMPROVEMENT. Major mission/safety/UX failure, or replies that would clearly break in WhatsApp.

Verdict is PASS only if score >= 7 AND there are no WhatsApp-specific issues at "high" severity.`;

async function judge(s, run) {
  const userMsg = `SCENARIO ID: ${s.id}
DESCRIPTION: ${s.description}
SESSION ID: ${run.sid}

EXPECTATIONS:
${s.expectations.map((e, i) => `${i + 1}. ${e}`).join('\n')}

TRANSCRIPT (${run.transcript.length} turns):
${run.transcript.map(t => {
    const stateStr = t.state ? `[state=${t.state.status} req=${t.request_id ?? '-'}]` : '[no state]';
    const att = t.attachment ? `  (attachment: name=${t.attachment.name || '-'}, mime=${t.attachment.mime || '-'}, caption="${t.attachment.caption || ''}")` : '';
    return `--- Turn ${t.turn} ${stateStr} ---
USER (raw): ${t.user}${att}
USER (effective text seen by agent): ${t.effectiveText || '(none — media only)'}
BOT:  ${t.bot}`;
  }).join('\n\n')}

Judge this run on the WhatsApp channel. Output JSON only — no markdown fences, no commentary.`;

  const reply = await chat({
    system: JUDGE_SYSTEM,
    user: userMsg,
    temperature: 0,
    max_tokens: 1800
  });
  let txt = (reply || '').trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) {
    return { verdict: 'NEEDS_IMPROVEMENT', score: 0, error: 'judge returned non-JSON', raw: reply };
  }
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return { verdict: 'NEEDS_IMPROVEMENT', score: 0, error: `judge JSON parse failed: ${e.message}`, raw: reply };
  }
}

// ── Main ──────────────────────────────────────────────────────────
const report = [];
for (const s of SCENARIOS) {
  process.stdout.write(`▶ ${s.id} … `);
  const t0 = Date.now();
  const run = await runScenario(s);
  const dt = Date.now() - t0;
  process.stdout.write(`run ${dt}ms, judging … `);
  const v = await judge(s, run);
  console.log(`${v.verdict || '?'} (${v.score ?? '?'}/10)`);
  report.push({
    scenario: { id: s.id, description: s.description, expectations: s.expectations },
    session_id: run.sid,
    phone: run.phone,
    transcript: run.transcript,
    verdict: v
  });
}

console.log('\n══════════ WHATSAPP REPORT ══════════');
let passes = 0;
for (const r of report) {
  const v = r.verdict;
  if (v.verdict === 'PASS') passes++;
  console.log(`\n• ${r.scenario.id}: ${v.verdict || '?'} (${v.score ?? '?'}/10)`);
  if (v.summary) console.log(`  ${v.summary}`);
  if (v.failed_expectations?.length) {
    console.log('  Failed expectations:');
    for (const e of v.failed_expectations) console.log(`    – ${e}`);
  }
  if (v.whatsapp_specific_issues?.length) {
    console.log('  WhatsApp-specific issues:');
    for (const i of v.whatsapp_specific_issues) console.log(`    [${i.dimension}] ${i.description}\n        fix: ${i.fix}`);
  }
  if (v.issues?.length) {
    console.log('  Issues:');
    for (const i of v.issues) console.log(`    [${i.severity}] ${i.description}\n        fix: ${i.fix}`);
  }
}
console.log(`\n══ ${passes}/${report.length} scenarios PASSED ══`);

const outPath = path.resolve('./eval-whatsapp-report.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Saved full report → ${outPath}`);

process.exit(passes === report.length ? 0 : 1);
