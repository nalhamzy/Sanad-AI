#!/usr/bin/env node
// scripts/scenario-bench.mjs
//
// Run the 5 user-named scenarios + a couple extras through the LIVE
// agent (no LLM judge), capture transcripts, then compute the same
// metrics agent-metrics.mjs uses against the captured runs. Output
// is a single docs/scenario-bench-report.json plus a console summary.
//
// Why a separate runner: scripts/eval_scenarios.mjs ALSO calls an
// LLM judge on every scenario (~$0.50 per run). This bench is
// metrics-only — pure deterministic-handler + LLM tool-loop coverage
// with zero judge cost. Run it on every loop iteration to catch
// regressions in button-attach rate, English-leak rate, silent
// failures, etc.
//
// Usage:
//   node scripts/scenario-bench.mjs           # all scenarios
//   node scripts/scenario-bench.mjs --only=ar_typo_civil_id,ambiguous_request
//   node scripts/scenario-bench.mjs --skip=multi_per_slot_burst

import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DB_URL = process.env.DB_URL || 'file:./data/sanad-bench.db';
process.env.SANAD_NO_AUTOSTART = '1';
process.env.SANAD_AGENT_V2 = process.env.SANAD_AGENT_V2 || 'true';
process.env.DEBUG_MODE = process.env.DEBUG_MODE || 'false';

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Wipe + boot fresh bench DB.
const BENCH_DB = './data/sanad-bench.db';
try { fs.unlinkSync(BENCH_DB); } catch {}
try { fs.unlinkSync(BENCH_DB + '-journal'); } catch {}
fs.mkdirSync('./data', { recursive: true });

const { migrate, seedDemoOffices, autoImportCatalog } = await import('../lib/db.js');
await migrate();
try { await seedDemoOffices(); } catch {}
try { await autoImportCatalog(); } catch (e) { console.warn('catalog import:', e.message); }

const { runTurn } = await import('../lib/agent.js');

const argMap = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
const ONLY = argMap.only ? new Set(String(argMap.only).split(',')) : null;
const SKIP = argMap.skip ? new Set(String(argMap.skip).split(',')) : new Set();

// ── Scenarios — covers the 5 use-cases the user named + extras.
const SCENARIOS = [
  {
    id: 'doesnt_know_what_he_wants',
    label: '#1 — User doesn\'t know what they want',
    turns: [
      { text: 'مرحبا' },
      { text: 'محتاج مساعدة بخدمة حكومية' },
      { text: 'مش متأكد بالضبط… شي يخص السيارة' }
    ]
  },
  {
    id: 'service_accept_random_attachments',
    label: '#2 — Accept service, send 4 attachments in random order',
    turns: [
      { text: 'بغيت أجدد رخصة القيادة' },
      { text: '__btn__:confirm:yes' },
      { text: '', attachment: { name: 'random_3.jpg', mime: 'image/jpeg', caption: '', url: '/uploads/bench/r3.jpg', size: 80_000 } },
      { text: '', attachment: { name: 'random_1.jpg', mime: 'image/jpeg', caption: '', url: '/uploads/bench/r1.jpg', size: 80_000 } },
      { text: '', attachment: { name: 'random_2.jpg', mime: 'image/jpeg', caption: '', url: '/uploads/bench/r2.jpg', size: 80_000 } },
      { text: '', attachment: { name: 'random_4.jpg', mime: 'image/jpeg', caption: '', url: '/uploads/bench/r4.jpg', size: 80_000 } },
      { text: '__btn__:review:submit' }
    ]
  },
  {
    id: 'follow_up_request',
    label: '#3 — Follow up on existing request',
    plant: { service_name_like: 'driver license renewal', status: 'in_progress', citizen_phone: '+96890000099' },
    turns: [
      { text: 'مرحبا، أبي أعرف وضع طلبي' },
      { text: '__btn__:status:check' }
    ]
  },
  {
    id: 'mid_flow_pivot',
    label: '#4 — Mid-flow pivot to different service',
    turns: [
      { text: 'بغيت تجديد رخصة القيادة' },
      { text: '__btn__:confirm:yes' },
      { text: '__btn__:service:switch' },
      { text: 'لا في الحقيقة بغيت تجديد جواز السفر' }
    ]
  },
  {
    id: 'cancel_in_flight_request',
    label: '#5 — Cancel an in-flight request',
    plant: { service_name_like: 'driver license renewal', status: 'queued', citizen_phone: '+96890000088' },
    turns: [
      { text: 'مرحبا' },
      { text: '__btn__:status:check' },
      { text: '__btn__:service:cancel' },
      { text: '__btn__:confirm:yes' }
    ]
  },
  // Extras
  {
    id: 'free_text_status_query',
    label: '#6 — Asks status by typing (no button)',
    plant: { service_name_like: 'driver license renewal', status: 'awaiting_payment', citizen_phone: '+96890000077' },
    turns: [
      { text: 'وصلني رابط الدفع؟' }
    ]
  },
  {
    id: 'no_files_yet_then_submit_attempt',
    label: '#7 — Tap submit before sending any file',
    turns: [
      { text: 'تجديد رخصة القيادة' },
      { text: '__btn__:confirm:yes' },
      { text: '__btn__:review:submit' }
    ]
  }
];

async function plantInFlightRow(plant, sessionId) {
  const { db } = await import('../lib/db.js');
  const { rows: svc } = await db.execute({
    sql: `SELECT id, fee_omr FROM service_catalog WHERE LOWER(name_en) LIKE ? LIMIT 1`,
    args: [`%${plant.service_name_like}%`]
  });
  if (!svc[0]) return null;
  const phone = plant.citizen_phone;
  const { rows: cExist } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
  let citizenId = cExist[0]?.id;
  if (!citizenId) {
    const r = await db.execute({ sql: `INSERT INTO citizen(phone,name) VALUES (?,?)`, args: [phone, 'Bench Citizen'] });
    citizenId = Number(r.lastInsertRowid);
  }
  const r = await db.execute({
    sql: `INSERT INTO request(session_id,citizen_id,service_id,status,fee_omr,governorate,created_at,claimed_at,last_event_at)
          VALUES (?,?,?,?,?,'Muscat', datetime('now','-2 days'), datetime('now','-1 days'), datetime('now'))`,
    args: [sessionId, citizenId, svc[0].id, plant.status, svc[0].fee_omr ?? 0]
  });
  const reqId = Number(r.lastInsertRowid);
  // Plant the corresponding session row with state.status + request_id
  // so the agent's V2 path (which reads state) sees the in-flight request.
  await db.execute({
    sql: `INSERT OR REPLACE INTO session(id, state_json, updated_at)
          VALUES (?, ?, datetime('now'))`,
    args: [sessionId, JSON.stringify({
      status: plant.status,
      request_id: reqId,
      service_id: svc[0].id,
      collected: {},
      pending_doc_index: 0,
      docs: []
    })]
  });
  return { reqId, citizenId, svcId: svc[0].id, phone };
}

async function runOne(s) {
  const sid = `bench-${s.id}-${Date.now()}`;
  let planted = null;
  if (s.plant) planted = await plantInFlightRow(s.plant, sid);

  const transcript = [];
  for (const turn of s.turns) {
    const t0 = Date.now();
    let result;
    try {
      result = await runTurn({
        session_id: sid,
        user_text: turn.text || '',
        attachment: turn.attachment || null,
        citizen_phone: planted?.phone || '+96890123456'
      });
    } catch (e) {
      transcript.push({ kind: 'error', citizen: turn.text, error: e.message, ms: Date.now() - t0 });
      continue;
    }
    transcript.push({
      kind: 'turn',
      citizen: turn.text || (turn.attachment ? '(attachment)' : ''),
      bot_reply: result?.reply || '',
      ms: Date.now() - t0,
      buttons: result?._buttons ? result._buttons.map(b => b.id) : null
    });
  }

  // Wait for any pending burst-drains.
  await new Promise(r => setTimeout(r, 1500));

  // Pull final state + ALL stored bot rows.
  const { db } = await import('../lib/db.js');
  const { rows: msgs } = await db.execute({
    sql: `SELECT id, direction, actor_type, body_text, media_url, created_at
            FROM message WHERE session_id = ? ORDER BY id ASC`,
    args: [sid]
  });
  const { rows: sess } = await db.execute({
    sql: `SELECT state_json FROM session WHERE id = ?`,
    args: [sid]
  });
  const finalState = sess[0] ? JSON.parse(sess[0].state_json) : null;

  return {
    id: s.id,
    label: s.label,
    sid,
    transcript,
    final_state: finalState ? { status: finalState.status, request_id: finalState.request_id, service_id: finalState.service_id, docs_collected: Object.keys(finalState.collected || {}).length } : null,
    db_messages: msgs
  };
}

const results = [];
for (const s of SCENARIOS) {
  if (ONLY && !ONLY.has(s.id)) continue;
  if (SKIP.has(s.id)) continue;
  process.stderr.write(`▶ ${s.label}\n`);
  const t0 = Date.now();
  try {
    const r = await runOne(s);
    r.ms = Date.now() - t0;
    results.push(r);
    process.stderr.write(`  ✓ ${r.transcript.length} turns · ${r.db_messages.length} db rows · final=${r.final_state?.status || 'n/a'} · ${r.ms}ms\n`);
  } catch (e) {
    process.stderr.write(`  ✗ ${e.message}\n`);
    results.push({ id: s.id, label: s.label, error: e.message });
  }
}

// ── Compute metrics across all scenarios ────────────────
const m = {
  generated_at: new Date().toISOString(),
  scenario_count: results.length,
  passed: results.filter(r => !r.error).length,
  failed: results.filter(r => r.error).length,
  ux: {
    avg_reply_length: 0,
    button_attached_rate: 0,
    english_label_leak_rate: 0,
    deterministic_vs_llm_ratio: 0
  },
  flow: {
    sessions_reached_collecting: 0,
    sessions_reached_reviewing: 0,
    sessions_reached_queued: 0,
    sessions_reached_completed: 0
  },
  hazards: { silent_failures: 0 },
  per_scenario: []
};

const ENGLISH_LEAK_RE = /«[^»]+»‎/u;
const DETERMINISTIC_PREFIXES = ['📥 ', '📊 ', '✅ بدأت', '✅ ممتاز', '✅ استلمت', '✅ كل المست', '⚠️', '🔍', '✓ ', '🎉', '📤', '🚀', 'لا يوجد', '📦'];
const inFlightStates = new Set(['queued', 'claimed', 'in_progress', 'awaiting_payment', 'needs_more_info']);

let totalLen = 0, totalBots = 0, totalButtons = 0, totalDeterm = 0, totalLeaks = 0;
for (const r of results) {
  if (r.error) continue;
  const bots = (r.db_messages || []).filter(m => m.actor_type === 'bot');
  let scenLen = 0, scenButtons = 0, scenDeterm = 0, scenLeaks = 0;
  for (const b of bots) {
    const t = String(b.body_text || '');
    totalLen += t.length;
    scenLen += t.length;
    if (DETERMINISTIC_PREFIXES.some(p => t.startsWith(p))) { totalDeterm += 1; scenDeterm += 1; }
    if (ENGLISH_LEAK_RE.test(t)) { totalLeaks += 1; scenLeaks += 1; }
  }
  // Buttons: check the in-process transcript
  const turnsWithButtons = r.transcript.filter(t => t.buttons && t.buttons.length).length;
  const turnsWithBotReply = r.transcript.filter(t => t.kind === 'turn' && t.bot_reply).length;
  totalBots += bots.length;
  totalButtons += turnsWithButtons;

  // Flow reach
  const fs = r.final_state?.status;
  if (fs === 'collecting' || fs === 'reviewing' || inFlightStates.has(fs) || fs === 'completed') m.flow.sessions_reached_collecting += 1;
  if (fs === 'reviewing' || inFlightStates.has(fs) || fs === 'completed') m.flow.sessions_reached_reviewing += 1;
  if (inFlightStates.has(fs) || fs === 'completed') m.flow.sessions_reached_queued += 1;
  if (fs === 'completed') m.flow.sessions_reached_completed += 1;

  // Silent failures: turn with no bot_reply text
  const silent = r.transcript.filter(t => t.kind === 'turn' && !t.bot_reply).length;
  m.hazards.silent_failures += silent;

  m.per_scenario.push({
    id: r.id,
    label: r.label,
    turns: r.transcript.length,
    bot_msgs: bots.length,
    turns_with_buttons: turnsWithButtons,
    turns_with_bot_reply: turnsWithBotReply,
    avg_reply_chars: bots.length ? Math.round(scenLen / bots.length) : 0,
    deterministic_replies: scenDeterm,
    english_leaks: scenLeaks,
    final_state: r.final_state,
    ms: r.ms
  });
}

m.ux.avg_reply_length = totalBots ? Math.round(totalLen / totalBots) : 0;
m.ux.button_attached_rate = totalBots ? +(totalButtons / totalBots).toFixed(3) : 0;
m.ux.english_label_leak_rate = totalBots ? +(totalLeaks / totalBots).toFixed(3) : 0;
m.ux.deterministic_vs_llm_ratio = totalBots ? +(totalDeterm / totalBots).toFixed(3) : 0;

const summary =
  `\n📊 Scenario bench (${m.passed}/${m.scenario_count} passed):\n` +
  `  UX:\n` +
  `    avg reply length:        ${m.ux.avg_reply_length} chars\n` +
  `    button-attached rate:    ${(m.ux.button_attached_rate * 100).toFixed(1)}%\n` +
  `    deterministic vs LLM:    ${(m.ux.deterministic_vs_llm_ratio * 100).toFixed(1)}% deterministic\n` +
  `    English-label leaks:     ${(m.ux.english_label_leak_rate * 100).toFixed(1)}% of bot msgs\n` +
  `\n  Flow reach (out of ${m.passed}):\n` +
  `    collecting: ${m.flow.sessions_reached_collecting}\n` +
  `    reviewing:  ${m.flow.sessions_reached_reviewing}\n` +
  `    queued:     ${m.flow.sessions_reached_queued}\n` +
  `    completed:  ${m.flow.sessions_reached_completed}\n` +
  `\n  Hazards:\n` +
  `    silent failures:         ${m.hazards.silent_failures}\n`;
console.log(summary);

const out = path.resolve('docs/scenario-bench-report.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary: m, results }, null, 2));
console.log(`Wrote ${out}\n`);

// Per-scenario quick scoreboard
console.log('Per-scenario:');
for (const ps of m.per_scenario) {
  console.log(`  • ${ps.id.padEnd(42, ' ')} ` +
    `bots=${String(ps.bot_msgs).padStart(2)} ` +
    `btns=${String(ps.turns_with_buttons).padStart(2)} ` +
    `det=${String(ps.deterministic_replies).padStart(2)} ` +
    `leaks=${String(ps.english_leaks).padStart(2)} ` +
    `→ ${ps.final_state?.status || 'n/a'}`);
}
