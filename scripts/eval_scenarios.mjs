// 5-scenario Opus-as-judge evaluation for the Sanad-AI agent.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/eval_scenarios.mjs
//
// Runs five end-to-end scenarios against the local agent (no HTTP — invokes
// runTurn directly), captures full transcripts + state snapshots, then asks
// Claude Opus to judge each one against scenario-specific expectations.
// Writes a JSON report to ./eval-report.json and prints a summary.

import fs from 'fs';
import path from 'path';

// Use a dedicated DB so the eval doesn't pollute dev data, and skip
// auto-listening because we never need the HTTP server.
process.env.NODE_ENV = process.env.NODE_ENV || 'eval';
process.env.DB_URL = process.env.DB_URL || 'file:./data/sanad-eval.db';
process.env.SANAD_NO_AUTOSTART = '1';
process.env.SANAD_AGENT_V2 = process.env.SANAD_AGENT_V2 || 'true';
process.env.DEBUG_MODE = process.env.DEBUG_MODE || 'false';

// Wipe any prior eval DB so each run starts clean.
const EVAL_DB = './data/sanad-eval.db';
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
console.log('▶ seed done. starting scenarios.\n');

// ── Scenarios ─────────────────────────────────────────────────────
// Each scenario is a sequence of citizen turns; expectations are what
// a competent Sanad-AI agent should do. The judge sees the same list.
const SCENARIOS = [
  {
    id: 'ar_typo_civil_id',
    description: 'Arabic colloquial intent for civil ID renewal.',
    expectations: [
      'Recognises the user wants to renew their civil ID (بطاقة شخصية).',
      'Either confirms the matched service before starting OR starts and tells the user what was selected.',
      'Frames the goal as preparing a request file to dispatch to Sanad offices marketplace (not as the bot processing it itself).',
      'After the user agrees, transitions to collecting documents (state should be confirming → collecting).',
      'Does not ask the user to repeat information they already gave.'
    ],
    turns: [
      { text: 'أبغى أجدد بطاقتي الشخصية' },
      { text: 'نعم تمام' }
    ]
  },
  {
    id: 'en_question_then_start',
    description: 'EN: ask about passport renewal fees, then commit to starting.',
    expectations: [
      'First answer is informational (fees / documents) — does NOT silently start a request.',
      'When the user says "ok let\'s do it", the bot starts a passport renewal request.',
      'Mentions that Sanad offices process the file once submitted.',
      'Lists required documents clearly.'
    ],
    turns: [
      { text: 'how much does passport renewal cost?' },
      { text: "ok let's do it" }
    ]
  },
  {
    id: 'wrong_routing_trap',
    description: 'User asks if the bot will send the request directly to a government ministry / police — testing whether the bot correctly explains the marketplace dispatch model.',
    expectations: [
      'Clarifies that Sanad-AI prepares the file and dispatches to Sanad offices (the human service-bureau marketplace).',
      'Does NOT claim it sends requests directly to ROP, the police, or a government ministry.',
      'Stays helpful — offers to continue or to start a real request.'
    ],
    turns: [
      { text: 'i need to renew my passport' },
      { text: 'will you send this to the police directly?' }
    ]
  },
  {
    id: 'mid_flow_topic_switch',
    description: 'User starts a driving licence renewal, uploads one document, then changes their mind and wants passport renewal instead.',
    expectations: [
      'Starts the driving licence flow correctly.',
      'When the file arrives, records it as a document (does not ask for the same file again).',
      'When the user pivots to passport, gracefully cancels/abandons the in-progress request and starts the passport flow — without insisting the user finish driving licence first.',
      'Confirms the switch with the user before throwing away progress.'
    ],
    turns: [
      { text: 'I want to renew my driving licence' },
      { text: 'yes' },
      { text: '', attachment: { name: 'old_licence.jpg', mime: 'image/jpeg', caption: 'old licence' } },
      { text: 'actually forget that, I want passport renewal instead' }
    ]
  },
  {
    id: 'ambiguous_request',
    description: 'User says "I need a license" with no other context — should disambiguate.',
    expectations: [
      'Does not silently pick a single service.',
      'Asks a clarifying question (driving licence? business licence? import licence?).',
      'Stays in idle state until clarified.',
      'Does not get stuck in a loop or repeat the same question if the user clarifies.'
    ],
    turns: [
      { text: 'i need a license' },
      { text: 'driving licence' }
    ]
  }
];

// ── Run a scenario ────────────────────────────────────────────────
async function runScenario(s) {
  const sid = `eval-${s.id}-${Date.now()}`;
  const transcript = [];
  for (let i = 0; i < s.turns.length; i++) {
    const t = s.turns[i];
    let attachment = null;
    if (t.attachment) {
      // Simulate a real upload: a fake URL pointing into uploads/sid/.
      attachment = {
        url: `/uploads/${sid}/fake-${i}.jpg`,
        mime: t.attachment.mime || 'image/jpeg',
        size: 1234,
        name: t.attachment.name || `doc${i}.jpg`,
        caption: t.attachment.caption || ''
      };
    }
    let out;
    try {
      out = await runTurn({
        session_id: sid,
        user_text: t.text || '',
        attachment,
        citizen_phone: null
      });
    } catch (e) {
      out = { reply: `[runTurn threw: ${e.message}]`, state: null, request_id: null };
    }
    transcript.push({
      turn: i + 1,
      user: t.text || '(file upload)',
      attachment: attachment ? { name: attachment.name, caption: attachment.caption } : null,
      bot: out.reply,
      state: out.state,
      request_id: out.request_id ?? null
    });
  }
  return { sid, transcript };
}

// ── Judge with Opus ───────────────────────────────────────────────
const JUDGE_SYSTEM = `You are an expert evaluator of Sanad-AI, a chatbot whose job is to PREPARE a complete request file (correct service + required documents + fees) and DISPATCH it to the Sanad offices marketplace (human service-bureau offices that process government paperwork on the citizen's behalf). The bot does NOT process requests itself; it does NOT send requests directly to ministries/ROP/police. It is a preparation and dispatch layer.

You will receive a single scenario, the expectations a competent agent should meet, and the full transcript of one run. Judge strictly but fairly.

Output STRICT JSON, nothing else, in this shape:
{
  "verdict": "PASS" | "NEEDS_IMPROVEMENT",
  "score": <integer 0-10>,
  "passed_expectations": [<expectation strings that were met>],
  "failed_expectations": [<expectation strings that were not met>],
  "issues": [
    {"severity": "high"|"med"|"low", "description": "...", "fix": "concrete change to prompts/tools/state-machine"}
  ],
  "summary": "one short paragraph on overall quality"
}

Score rubric:
- 9-10: PASS. All expectations met; replies are concise, accurate, on-mission.
- 7-8: PASS with minor polish needed.
- 5-6: NEEDS_IMPROVEMENT. One or more material expectations failed.
- 0-4: NEEDS_IMPROVEMENT. Major mission/safety/UX failure.

Verdict is PASS only if score >= 7.`;

async function judge(s, run) {
  const userMsg = `SCENARIO ID: ${s.id}
DESCRIPTION: ${s.description}

EXPECTATIONS:
${s.expectations.map((e, i) => `${i + 1}. ${e}`).join('\n')}

TRANSCRIPT (${run.transcript.length} turns):
${run.transcript.map(t => {
    const stateStr = t.state ? `[state=${t.state.status} req=${t.request_id ?? '-'}]` : '[no state]';
    return `--- Turn ${t.turn} ${stateStr} ---
USER: ${t.user}${t.attachment ? `  (attached: ${t.attachment.name}, caption="${t.attachment.caption}")` : ''}
BOT:  ${t.bot}`;
  }).join('\n\n')}

Judge this run. Output JSON only — no markdown fences, no commentary.`;

  const reply = await chat({
    system: JUDGE_SYSTEM,
    user: userMsg,
    temperature: 0,
    max_tokens: 1500
  });
  // Tolerate accidental ```json wrapping.
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
    transcript: run.transcript,
    verdict: v
  });
}

console.log('\n══════════ REPORT ══════════');
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
  if (v.issues?.length) {
    console.log('  Issues:');
    for (const i of v.issues) console.log(`    [${i.severity}] ${i.description}\n        fix: ${i.fix}`);
  }
}
console.log(`\n══ ${passes}/${report.length} scenarios PASSED ══`);

const outPath = path.resolve('./eval-report.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Saved full report → ${outPath}`);

process.exit(passes === report.length ? 0 : 1);
