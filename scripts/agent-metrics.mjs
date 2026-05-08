#!/usr/bin/env node
// scripts/agent-metrics.mjs
//
// Per-iteration metrics for the Sanad-AI WhatsApp agent. Reads message
// rows from the local SQLite (or a remote /api/debug/state dump if
// SANAD_REMOTE=https://...) and computes UX-shaped metrics that the
// loop iterations can crosscheck.
//
// Metrics produced (also written to docs/agent-metrics.json):
//   reply_count_by_session
//   avg_reply_length
//   button_attached_rate    (heuristic: replies containing **اضغط *...** OR ending with ✓/✕ button-emoji)
//   deterministic_vs_llm    (heuristic: replies starting with 📥/📊/✅ deterministic markers vs free LLM)
//   state_progression       (count of sessions reaching reviewing/queued/completed)
//   silent_failures         (citizen turns with no bot follow-up within 60s)
//   multi_message_per_burst (sessions where 2+ bot rows arrived <60s apart after multiple media msgs)
//   english_label_leaks     (bot replies containing «...»‎ — Arabic-fallback marker)
//
// Usage:
//   node scripts/agent-metrics.mjs                   # reads ./data/sanad.db
//   SANAD_REMOTE=https://saned.ai node scripts/agent-metrics.mjs
//   node scripts/agent-metrics.mjs --since=2h        # last 2 hours only
//   node scripts/agent-metrics.mjs --phone=96892888715  # one session
//
// Exits 0 always — non-blocking. Use the JSON for trend tracking.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argMap = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const SINCE_HOURS = argMap.since
  ? Number(String(argMap.since).replace(/[^\d]/g, ''))
  : 24;
const PHONE_FILTER = argMap.phone || null;
const REMOTE = process.env.SANAD_REMOTE;

// ── Fetch messages ──────────────────────────────────────
// Returns { messages, sessionStateBySid } — the second map lets us key
// flow-progression metrics on the actual saved state (codex Q3).
const sessionStateBySid = new Map();

async function fetchMessagesRemote() {
  if (PHONE_FILTER) {
    const url = `${REMOTE}/api/debug/trace/wa%3A${encodeURIComponent(PHONE_FILTER)}?n=200`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`remote trace fetch ${r.status}`);
    const d = await r.json();
    if (d.session?.state) sessionStateBySid.set(d.session_id, d.session.state);
    // /trace's SELECT doesn't include session_id on each message row
    // (only on the wrapper), so inject it so the bySession key derivation
    // below sees something other than undefined.
    return (d.messages || []).map(m => ({ ...m, session_id: m.session_id || d.session_id }));
  }
  const r = await fetch(`${REMOTE}/api/debug/state`);
  if (!r.ok) throw new Error(`remote state fetch ${r.status}`);
  const d = await r.json();
  // /state only returns the latest 20. For deeper analysis use --phone.
  return d.latestMessages || [];
}

async function fetchMessagesLocal() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  const { db } = await import('../lib/db.js');
  const sinceMs = Date.now() - SINCE_HOURS * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString().slice(0, 19).replace('T', ' ');
  const wh = ['created_at >= ?'];
  const args = [sinceIso];
  if (PHONE_FILTER) {
    wh.push("session_id LIKE ?");
    args.push(`wa:%${PHONE_FILTER}%`);
  }
  const { rows } = await db.execute({
    sql: `SELECT id, session_id, direction, actor_type, body_text, media_url, channel, created_at
            FROM message
           WHERE ${wh.join(' AND ')}
           ORDER BY id ASC`,
    args
  });
  // Capture session state for reachability metrics (codex Q3).
  const sids = [...new Set(rows.map(r => r.session_id))];
  for (const sid of sids) {
    try {
      const r2 = await db.execute({
        sql: `SELECT state_json FROM session WHERE id = ?`,
        args: [sid]
      });
      if (r2.rows[0]?.state_json) {
        sessionStateBySid.set(sid, JSON.parse(r2.rows[0].state_json));
      }
    } catch {}
  }
  return rows;
}

const messages = REMOTE ? await fetchMessagesRemote() : await fetchMessagesLocal();

// ── Compute metrics ─────────────────────────────────────
const bySession = new Map();
for (const m of messages) {
  const sid = m.session_id;
  if (!bySession.has(sid)) bySession.set(sid, []);
  bySession.get(sid).push(m);
}

const metrics = {
  generated_at: new Date().toISOString(),
  scope: { since_hours: SINCE_HOURS, phone_filter: PHONE_FILTER || null, source: REMOTE ? 'remote' : 'local' },
  totals: {
    sessions: bySession.size,
    messages: messages.length,
    bot_messages: messages.filter(m => m.actor_type === 'bot').length,
    citizen_messages: messages.filter(m => m.actor_type === 'citizen').length
  },
  ux: {
    avg_reply_length: 0,
    median_reply_length: 0,
    button_attached_rate: 0,
    deterministic_vs_llm_ratio: 0,
    english_label_leak_rate: 0,
    over_long_replies: 0,         // > 400 chars
    very_short_replies: 0          // < 10 chars (probably an error)
  },
  flow: {
    sessions_reached_collecting: 0,
    sessions_reached_reviewing: 0,
    sessions_reached_queued: 0,
    sessions_reached_completed: 0,
    sessions_with_media: 0
  },
  hazards: {
    silent_failures: 0,           // citizen → no bot follow-up within 60s
    multi_message_per_burst: 0,   // multi-bubble per upload burst
    hallucination_guard_fires: 0  // can't compute from messages alone — needs trace
  },
  per_session: []
};

// Heuristics
const DETERMINISTIC_PREFIXES = ['📥 ', '📊 ', '✅ بدأت', '✅ ممتاز', '✅ استلمت', '✅ كل المست', '⚠️', '🔍', '✓ ', '🎉', '📤', '🚀'];
const BUTTON_HINT_RE = /اضغط\s*\*[✅✓📤➕✕❌🔍📊]/u;
const ENGLISH_LEAK_RE = /«[^»]+»‎/u;

const lengths = [];
let buttonsAttached = 0;
let deterministic = 0;
let englishLeaks = 0;
let overLong = 0;
let veryShort = 0;
let silentFailures = 0;
let multiMsgBursts = 0;

// Reachability is now derived from saved session state (codex Q3 fix,
// 2026-05-08). Regex on bot text was unreliable (queued=0/1 even when
// state.status='queued'). Falls back to text regex when no state row
// is available.
const STATUS_RE = {
  collecting: /(?:بدأت طلبك|أرسل المستندات الآن)/u,
  reviewing:  /جاهز للمراجعة|اكتمل ملفك/u,
  queued:     /أرسلت طلبك إلى مكتب سند للمراجعة|رقم الطلب: \*#R-/u,
  completed:  /تم إنجاز معاملتك/u
};
const STATE_REACHED = new Set(['collecting', 'reviewing', 'queued', 'claimed',
                               'in_progress', 'awaiting_payment',
                               'needs_more_info', 'awaiting_reclassify_ack',
                               'completed']);
let reachedCol = 0, reachedRev = 0, reachedQ = 0, reachedComp = 0;
let sessionsWithMedia = 0;

for (const [sid, rows] of bySession) {
  const bots = rows.filter(r => r.actor_type === 'bot');
  const cits = rows.filter(r => r.actor_type === 'citizen');
  const hasMedia = rows.some(r => r.media_url);
  if (hasMedia) sessionsWithMedia += 1;

  let cReached = { col: false, rev: false, q: false, comp: false };
  for (const b of bots) {
    const t = String(b.body_text || '');
    lengths.push(t.length);
    if (BUTTON_HINT_RE.test(t)) buttonsAttached += 1;
    if (DETERMINISTIC_PREFIXES.some(p => t.startsWith(p))) deterministic += 1;
    if (ENGLISH_LEAK_RE.test(t)) englishLeaks += 1;
    if (t.length > 400) overLong += 1;
    if (t.length < 10) veryShort += 1;
    // Text-regex fallback (used only when state isn't loaded).
    if (STATUS_RE.collecting.test(t)) cReached.col = true;
    if (STATUS_RE.reviewing.test(t))  cReached.rev = true;
    if (STATUS_RE.queued.test(t))     cReached.q = true;
    if (STATUS_RE.completed.test(t))  cReached.comp = true;
  }
  // Authoritative reachability — saved state.status (codex Q3).
  const st = sessionStateBySid.get(sid);
  if (st && st.status) {
    const inFlightStates = new Set(['queued', 'claimed', 'in_progress',
                                    'awaiting_payment', 'needs_more_info',
                                    'awaiting_reclassify_ack']);
    if (st.status === 'collecting' || st.status === 'reviewing' ||
        inFlightStates.has(st.status) || st.status === 'completed') {
      cReached.col = true;
    }
    if (st.status === 'reviewing' || inFlightStates.has(st.status) || st.status === 'completed') {
      cReached.rev = true;
    }
    if (inFlightStates.has(st.status) || st.status === 'completed') cReached.q = true;
    if (st.status === 'completed') cReached.comp = true;
  }
  if (cReached.col)  reachedCol += 1;
  if (cReached.rev)  reachedRev += 1;
  if (cReached.q)    reachedQ += 1;
  if (cReached.comp) reachedComp += 1;

  // Silent failures: citizen msg with no bot reply within 60s.
  // EXCLUDES burst-continuation files (intentionally silent — files
  // 2..N of a burst trigger no reply by design). Per codex review
  // 2026-05-08 Q2 — was a metric false-positive, not an agent bug.
  for (let i = 0; i < cits.length; i++) {
    const c = cits[i];
    const ct = new Date(c.created_at).getTime();
    // If this is a media msg AND another media msg follows within 10s,
    // and ANY bot reply lands within 30s of the LAST media in the run,
    // treat the whole run as a burst — only the FINAL media counts for
    // silent-failure check.
    if (c.media_url && i + 1 < cits.length && cits[i + 1].media_url) {
      const nextCt = new Date(cits[i + 1].created_at).getTime();
      if (nextCt - ct < 10_000) continue; // intermediate burst file → skip
    }
    const nextBot = bots.find(b => {
      const bt = new Date(b.created_at).getTime();
      return bt > ct && bt - ct < 60_000;
    });
    if (!nextBot) silentFailures += 1;
  }

  // Multi-msg bursts: ≥2 media msgs from citizen in <30s, then ≥2 bot replies <30s after
  const mediaSpans = [];
  for (let i = 0; i < cits.length - 1; i++) {
    if (!cits[i].media_url) continue;
    const t0 = new Date(cits[i].created_at).getTime();
    let n = 1;
    let lastIdx = i;
    for (let j = i + 1; j < cits.length; j++) {
      if (!cits[j].media_url) break;
      const tj = new Date(cits[j].created_at).getTime();
      if (tj - new Date(cits[lastIdx].created_at).getTime() > 10_000) break;
      n++; lastIdx = j;
    }
    if (n >= 2) {
      mediaSpans.push({ start: t0, end: new Date(cits[lastIdx].created_at).getTime(), n });
      i = lastIdx; // skip past
    }
  }
  for (const span of mediaSpans) {
    const botsInWindow = bots.filter(b => {
      const bt = new Date(b.created_at).getTime();
      return bt >= span.start && bt < span.end + 30_000;
    });
    if (botsInWindow.length >= 2) multiMsgBursts += 1;
  }

  metrics.per_session.push({
    session_id: sid,
    bot_count: bots.length,
    citizen_count: cits.length,
    has_media: hasMedia,
    reached: cReached,
    last_msg_at: rows[rows.length - 1]?.created_at
  });
}

const sortedLen = [...lengths].sort((a, b) => a - b);
metrics.ux.avg_reply_length = lengths.length
  ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
  : 0;
metrics.ux.median_reply_length = sortedLen.length
  ? sortedLen[Math.floor(sortedLen.length / 2)]
  : 0;
metrics.ux.button_attached_rate = metrics.totals.bot_messages
  ? +(buttonsAttached / metrics.totals.bot_messages).toFixed(3)
  : 0;
metrics.ux.deterministic_vs_llm_ratio = metrics.totals.bot_messages
  ? +(deterministic / metrics.totals.bot_messages).toFixed(3)
  : 0;
metrics.ux.english_label_leak_rate = metrics.totals.bot_messages
  ? +(englishLeaks / metrics.totals.bot_messages).toFixed(3)
  : 0;
metrics.ux.over_long_replies = overLong;
metrics.ux.very_short_replies = veryShort;
metrics.flow.sessions_reached_collecting = reachedCol;
metrics.flow.sessions_reached_reviewing = reachedRev;
metrics.flow.sessions_reached_queued = reachedQ;
metrics.flow.sessions_reached_completed = reachedComp;
metrics.flow.sessions_with_media = sessionsWithMedia;
metrics.hazards.silent_failures = silentFailures;
metrics.hazards.multi_message_per_burst = multiMsgBursts;

// ── Print + write ───────────────────────────────────────
const summary =
  `\n📊 Agent metrics (last ${SINCE_HOURS}h${PHONE_FILTER ? `, phone=${PHONE_FILTER}` : ''}):\n` +
  `  sessions: ${metrics.totals.sessions} · messages: ${metrics.totals.messages} ` +
  `(bot: ${metrics.totals.bot_messages}, citizen: ${metrics.totals.citizen_messages})\n` +
  `\n  UX:\n` +
  `    avg/median reply length: ${metrics.ux.avg_reply_length} / ${metrics.ux.median_reply_length} chars\n` +
  `    button-attached rate:    ${(metrics.ux.button_attached_rate * 100).toFixed(1)}%\n` +
  `    deterministic vs LLM:    ${(metrics.ux.deterministic_vs_llm_ratio * 100).toFixed(1)}% deterministic\n` +
  `    English-label leaks:     ${(metrics.ux.english_label_leak_rate * 100).toFixed(1)}% of bot msgs\n` +
  `    over-long (>400ch):      ${metrics.ux.over_long_replies}\n` +
  `    very-short (<10ch):      ${metrics.ux.very_short_replies}\n` +
  `\n  Flow reach:\n` +
  `    collecting: ${metrics.flow.sessions_reached_collecting}/${metrics.totals.sessions}\n` +
  `    reviewing:  ${metrics.flow.sessions_reached_reviewing}/${metrics.totals.sessions}\n` +
  `    queued:     ${metrics.flow.sessions_reached_queued}/${metrics.totals.sessions}\n` +
  `    completed:  ${metrics.flow.sessions_reached_completed}/${metrics.totals.sessions}\n` +
  `    with media: ${metrics.flow.sessions_with_media}/${metrics.totals.sessions}\n` +
  `\n  Hazards:\n` +
  `    silent failures (60s):     ${metrics.hazards.silent_failures}\n` +
  `    multi-msg per burst:       ${metrics.hazards.multi_message_per_burst}\n`;

console.log(summary);

const outPath = path.resolve('docs/agent-metrics.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
console.log(`Wrote ${outPath}`);
