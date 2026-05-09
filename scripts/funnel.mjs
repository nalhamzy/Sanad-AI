// Aggregate funnel report — the dashboard.
//
// Usage:
//   node scripts/funnel.mjs [--days 7] [--channel whatsapp|web|all] [--json]
//
// Examples:
//   node scripts/funnel.mjs                       # last 7 days, all channels
//   node scripts/funnel.mjs --days 30 --channel whatsapp
//   node scripts/funnel.mjs --json > funnel.json
//
// Prints:
//   stage          | sessions | conv-from-prev | drop-off
//   greeted        | 12,432   |                |
//   discovered     |  9,810   |    78.9%       |   2,622
//   confirming     |  7,118   |    72.6%       |   2,692
//   …
//
// "conv-from-prev" is the share of sessions that reached this stage among
// those that reached the previous one. "drop-off" is the absolute count
// that fell out between the previous stage and this one — your work queue
// candidates (feed each into bucket_dropoffs.mjs).

import { loadSessionsForWindow, classifySession, STAGES, STAGE_INDEX } from './_funnel_lib.mjs';

const argv = process.argv.slice(2);
const flag = (k, def) => {
  const i = argv.indexOf(`--${k}`);
  if (i > -1) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(`--${k}=`));
  return eq ? eq.slice(k.length + 3) : def;
};
const DAYS = Number(flag('days', 7));
const CHANNEL = flag('channel', 'all');
const AS_JSON = argv.includes('--json');

const sessions = await loadSessionsForWindow({ days: DAYS });

// Cumulative counts per stage. A session that reached stage N counts in
// stages 0..N (the funnel is monotonic — anyone who reached "queued" was
// also "discovered").
const cumulative = new Array(STAGES.length).fill(0);
const terminal = new Array(STAGES.length).fill(0);  // sessions whose furthest stage is exactly i
let total = 0;
let filtered = 0;

for (const s of sessions.values()) {
  total += 1;
  if (CHANNEL !== 'all' && s.channel !== CHANNEL) continue;
  filtered += 1;
  const stage = classifySession({
    stateJson: s.state_json,
    requests: s.requests,
    offers: s.offers,
    inboundCount: s.inboundCount
  });
  if (!stage) continue;
  const idx = STAGE_INDEX[stage];
  for (let i = 0; i <= idx; i++) cumulative[i] += 1;
  terminal[idx] += 1;
}

if (AS_JSON) {
  const report = {
    window_days: DAYS,
    channel: CHANNEL,
    total_sessions_in_window: total,
    sessions_after_channel_filter: filtered,
    stages: STAGES.map((name, i) => ({
      stage: name,
      reached: cumulative[i],
      terminal: terminal[i],
      conv_from_prev: i === 0 ? null : (cumulative[i - 1] ? cumulative[i] / cumulative[i - 1] : 0),
      dropoff_from_prev: i === 0 ? null : Math.max(0, cumulative[i - 1] - cumulative[i])
    }))
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── Pretty print ────────────────────────────────────────────
const w = (n) => Number(n).toLocaleString('en-US');
console.log('');
console.log(`Sanad-AI funnel — last ${DAYS} day(s), channel=${CHANNEL}`);
console.log(`sessions in window: ${w(total)}   (after filter: ${w(filtered)})`);
console.log('');
console.log('  stage          reached     conv     drop-off    terminal');
console.log('  ─────────────  ─────────   ──────   ────────    ────────');
for (let i = 0; i < STAGES.length; i++) {
  const reached = cumulative[i];
  const term = terminal[i];
  const conv = i === 0 ? '       ' : (cumulative[i - 1] ? `${(100 * reached / cumulative[i - 1]).toFixed(1)}%` : '   —  ').padStart(7);
  const drop = i === 0 ? '       ' : w(Math.max(0, cumulative[i - 1] - reached)).padStart(8);
  console.log(`  ${STAGES[i].padEnd(13)}  ${w(reached).padStart(9)}   ${conv}   ${drop}    ${w(term).padStart(8)}`);
}
console.log('');
console.log('Next:  pick the biggest drop-off and run');
console.log(`       node scripts/bucket_dropoffs.mjs --step <stage> --days ${DAYS}`);
console.log('');

process.exit(0);
