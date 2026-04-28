// 5-scenario LLM-as-judge evaluation for the Sanad-AI agent.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/eval_scenarios.mjs   # judge=Claude
//   LLM_PROVIDER=qwen QWEN_API_KEY=... node scripts/eval_scenarios.mjs  # judge=Qwen
//
// Runs five end-to-end scenarios against the local agent (no HTTP — invokes
// runTurn directly), captures full transcripts + state snapshots, then asks
// the configured LLM to judge each one against scenario-specific expectations.
// Writes a JSON report to ./eval-report.json and prints a summary.

import fs from 'fs';
import path from 'path';

// Use a dedicated DB so the eval doesn't pollute dev data, and skip
// auto-listening because we never need the HTTP server.
//
// Set NODE_ENV=test (not 'eval') so lib/llm.js skips its dotenv.config({override})
// reload — that lets us pin LLM_PROVIDER from the shell or here without it
// being clobbered by the .env value.
process.env.NODE_ENV = 'test';
process.env.DB_URL = process.env.DB_URL || 'file:./data/sanad-eval.db';
process.env.SANAD_NO_AUTOSTART = '1';
process.env.SANAD_AGENT_V2 = process.env.SANAD_AGENT_V2 || 'true';
process.env.DEBUG_MODE = process.env.DEBUG_MODE || 'false';

// Detect whether we have Anthropic credits or fall through to Qwen.
// CLI flag --judge=qwen forces Qwen even when Anthropic is set.
//
// Use dotenv override so an empty/stale ANTHROPIC_API_KEY in the shell env
// doesn't shadow the real value in .env (caught earlier when the eval kept
// running on Qwen despite credits being live).
import dotenv from 'dotenv';
dotenv.config({ override: true });
const forceQwen = process.argv.includes('--judge=qwen') || !process.env.ANTHROPIC_API_KEY;
if (forceQwen) {
  process.env.LLM_PROVIDER = 'qwen';
}

// Wipe any prior eval DB so each run starts clean.
const EVAL_DB = './data/sanad-eval.db';
try { fs.unlinkSync(EVAL_DB); } catch {}
try { fs.unlinkSync(EVAL_DB + '-journal'); } catch {}
fs.mkdirSync('./data', { recursive: true });

const { migrate, seedDemoOffices, autoImportCatalog } = await import('../lib/db.js');
const { runTurn } = await import('../lib/agent.js');
const { LLM_ENABLED, LLM_PROVIDER, LLM_MODEL, chat } = await import('../lib/llm.js');

if (!LLM_ENABLED) {
  console.error(`✗ No LLM available. Set ANTHROPIC_API_KEY (preferred) or QWEN_API_KEY in .env.`);
  process.exit(1);
}

console.log(`▶ provider=${LLM_PROVIDER} model=${LLM_MODEL} (used for both agent + judge)`);
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
  },
  {
    id: 'multi_file_batch_upload',
    description: 'Citizen starts driving-licence renewal then sends 3 files in a row with weak captions; bot should buffer them and ask once for descriptions, NOT ask 3 times.',
    expectations: [
      'Bot buffers multiple files and acknowledges them concisely (one ack each, ≤25 words).',
      'Does NOT ask "is this for civil_id, or extra?" repeatedly per file.',
      'When the citizen sends a comma-separated description, the bot maps each file to its slot and emits a single consolidated "✅ Saved: X, Y, Z" reply.',
      'Reply is ≤30 words after the descriptions arrive — short and scannable.',
      'Eventually transitions to reviewing or asks for the remaining required doc.'
    ],
    turns: [
      { text: 'I want to renew my driving licence' },
      { text: 'yes' },
      { text: 'here', attachment: { name: 'doc1.jpg', mime: 'image/jpeg', caption: 'here' } },
      { text: '', attachment: { name: 'doc2.jpg', mime: 'image/jpeg', caption: '' } },
      { text: '', attachment: { name: 'doc3.jpg', mime: 'image/jpeg', caption: '' } },
      { text: 'civil ID, medical fitness form, photo' }
    ]
  },
  {
    id: 'return_visit_status_query',
    description: 'Citizen with an in-flight request asks where it is on a return visit. Agent should know about their request from the auto-injected requests block and answer immediately without asking what their request is.',
    expectations: [
      'Recognises the citizen has an existing request (from the auto-injected requests block).',
      'Answers the status without re-asking what the request was.',
      'If they ask for an update, calls get_request_status — does NOT make up status.',
      'Stays concise (≤40 words for the status reply).'
    ],
    // The runner plants a real request row before this scenario starts so
    // the auto-injected requests block has something to surface. See the
    // `plant` field below.
    plant: {
      service_name_like: 'driver license renewal',
      status: 'in_progress',
      citizen_phone: '+96890000099',
      office_id: 1
    },
    turns: [
      { text: 'hello, I want to follow up on my driving licence request' },
      { text: 'whats the status?' }
    ]
  },
  {
    id: 'short_fast_reply',
    description: 'Citizen asks a simple status / fee question — bot must answer in ≤2 lines. No essays.',
    expectations: [
      'Reply is ≤30 words.',
      'No bullet lists or markdown headers; plain text only.',
      'Answers the question directly without preamble like "Sure! Let me look that up…"',
      'Ends with a single short next-step prompt or no question at all.'
    ],
    turns: [
      { text: 'how much is civil ID issuance?' }
    ]
  }
];

// ── Run a scenario ────────────────────────────────────────────────
async function runScenario(s) {
  const sid = `eval-${s.id}-${Date.now()}`;
  // Some scenarios need pre-existing state (e.g. an in-flight request to
  // test return-visit status queries). Plant before the first turn so the
  // requests-injection block has real data to surface.
  if (s.plant) {
    const { db } = await import('../lib/db.js');
    try {
      // Find a service matching the requested name pattern.
      const { rows: svc } = await db.execute({
        sql: `SELECT id, fee_omr FROM service_catalog WHERE LOWER(name_en) LIKE ? LIMIT 1`,
        args: [`%${s.plant.service_name_like}%`]
      });
      if (svc[0]) {
        // Citizen row (idempotent).
        const phone = s.plant.citizen_phone || `+96890000${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
        const { rows: cExist } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
        let citizenId;
        if (cExist[0]) citizenId = cExist[0].id;
        else {
          const r = await db.execute({ sql: `INSERT INTO citizen(phone,name) VALUES (?,?)`, args: [phone, 'Eval Citizen'] });
          citizenId = Number(r.lastInsertRowid);
        }
        // Request row.
        await db.execute({
          sql: `INSERT INTO request(session_id,citizen_id,service_id,status,office_id,fee_omr,governorate,created_at,claimed_at,last_event_at)
                VALUES (?,?,?,?,?,?,'Muscat', datetime('now','-2 days'), datetime('now','-1 days'), datetime('now'))`,
          args: [sid, citizenId, svc[0].id, s.plant.status || 'in_progress', s.plant.office_id || 1, svc[0].fee_omr || 5]
        });
      }
    } catch (e) { /* ignore — scenario will just behave like fresh session */ }
  }
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

CATALOGUE GROUND TRUTH (authoritative for all judging — overrides anything you "know" from training data):
The current catalogue has 453 services scraped from 7 entities (MM, MOH, MOL, MOHUP, MTCIT, MOC, ROP). It DOES NOT include:
  • Civil ID renewal — only first-issuance: "Issuing Civil Status Card Service" (id 140018, ROP).
  • Passport renewal — only first-issuance: "Omani Passport Issuance Service" (id 140020, ROP).
  • Many other "renewal" or specific services may also be missing.

When a citizen asks for one of these gap services, the CORRECT bot behavior is to:
  1. Honestly say "this isn't in our catalogue" (do NOT fabricate a renewal flow), AND
  2. Surface the closest available match by id + name from the actual catalogue, AND
  3. Mention that fees will be confirmed by the receiving Sanad office (because most scraped rows have null fee_omr).

Do NOT penalize the bot for saying "civil ID renewal isn't in our catalogue" — that's the FACTUALLY CORRECT response for our specific scraped catalogue. Do NOT recommend "fixing" the catalogue to include services that genuinely aren't in it. Judge only the bot's handling of the conversation given what's actually in the catalogue.

You will receive a single scenario, the expectations a competent agent should meet, and the full transcript of one run. Judge strictly but fairly. Many "renewal" expectations should be evaluated against the bot's gap-handling skill, not its ability to invent missing data.

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
