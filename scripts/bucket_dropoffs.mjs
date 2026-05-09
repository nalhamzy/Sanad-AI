// Drop-off bucketing — the work queue.
//
// For one funnel stage, finds every session whose furthest stage was THIS
// stage AND that has been idle for at least --idle-hours. Writes one JSONL
// row per session to data/buckets/dropoff_at_<stage>_<YYYY-MM-DD>.jsonl
// (override with --out).
//
// Each row is self-contained: phone (masked), service, stage, last 5
// citizen↔bot turns, timestamps. Feed the JSONL into eval_whatsapp.mjs to
// replay the conversation against a fresh agent + diff the outcome.
//
// Usage:
//   node scripts/bucket_dropoffs.mjs --step collecting [--days 7]
//                                    [--idle-hours 6] [--out data/buckets/]
//                                    [--limit 200] [--channel whatsapp|web|all]
//
// Exit code 0 on success; prints summary line to stderr.

import { mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../lib/db.js';
import {
  loadSessionsForWindow, classifySession, STAGES, STAGE_INDEX, maskPhone
} from './_funnel_lib.mjs';

const argv = process.argv.slice(2);
const flag = (k, def) => {
  const i = argv.indexOf(`--${k}`);
  if (i > -1) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(`--${k}=`));
  return eq ? eq.slice(k.length + 3) : def;
};
const STEP = flag('step', '');
const DAYS = Number(flag('days', 7));
const IDLE_HOURS = Number(flag('idle-hours', 6));
const LIMIT = Number(flag('limit', 200));
const CHANNEL = flag('channel', 'all');
const OUT_DIR = flag('out', '');

if (!STEP || !STAGES.includes(STEP)) {
  console.error(`usage: node scripts/bucket_dropoffs.mjs --step <stage> [--days 7] [--idle-hours 6] [--limit 200]`);
  console.error(`stages: ${STAGES.join(', ')}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const outDir = OUT_DIR
  ? (OUT_DIR.startsWith('/') || /^[A-Za-z]:[\\/]/.test(OUT_DIR) ? OUT_DIR : join(projectRoot, OUT_DIR))
  : join(projectRoot, 'data', 'buckets');
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = join(outDir, `dropoff_at_${STEP}_${today}.jsonl`);

const sessions = await loadSessionsForWindow({ days: DAYS });
const stuck = [];
const now = Date.now();

for (const s of sessions.values()) {
  if (CHANNEL !== 'all' && s.channel !== CHANNEL) continue;
  const stage = classifySession({
    stateJson: s.state_json,
    requests: s.requests,
    offers: s.offers,
    inboundCount: s.inboundCount
  });
  if (stage !== STEP) continue;
  const lastMs = s.last_at ? Date.parse(s.last_at.replace(' ', 'T') + (s.last_at.includes('Z') ? '' : 'Z')) : 0;
  const idleHours = lastMs ? (now - lastMs) / 36e5 : Infinity;
  if (idleHours < IDLE_HOURS) continue;
  s._idleHours = idleHours;
  stuck.push(s);
}

stuck.sort((a, b) => Date.parse((b.last_at || '').replace(' ', 'T')) - Date.parse((a.last_at || '').replace(' ', 'T')));

const stream = createWriteStream(outPath, { encoding: 'utf8' });
let written = 0;

for (const s of stuck.slice(0, LIMIT)) {
  // Pull the LAST 12 messages as context — last 5 citizen turns plus the
  // bot replies they triggered, give or take.
  const msgs = await db.execute({
    sql: `SELECT direction, actor_type, body_text, media_url, created_at
            FROM message WHERE session_id=? ORDER BY id DESC LIMIT 12`,
    args: [s.session_id]
  });
  const last_turns = msgs.rows.reverse().map(m => ({
    t: m.created_at, who: m.actor_type,
    dir: m.direction,
    text: (m.body_text || '').slice(0, 400),
    media: m.media_url ? true : false
  }));

  // Best-effort service guess: from session.state_json or last request.
  let service_code = null, service_name = null;
  try {
    const cur = JSON.parse(s.state_json || '{}');
    service_code = cur?.service_code || null;
    service_name = cur?.service_name_ar || cur?.service_name_en || null;
  } catch {}
  if (!service_code && s.requests.length) {
    const lastReq = s.requests[s.requests.length - 1];
    if (lastReq.service_id) {
      const r = await db.execute({
        sql: `SELECT slug, service_name_ar, service_name_en FROM service_catalog WHERE id=?`,
        args: [lastReq.service_id]
      });
      if (r.rows[0]) {
        service_code = r.rows[0].slug;
        service_name = r.rows[0].service_name_ar || r.rows[0].service_name_en;
      }
    }
  }

  const row = {
    session_id: s.session_id,
    masked: maskPhone(s.session_id),
    channel: s.channel,
    furthest_stage: STEP,
    service_code, service_name,
    inbound_count: s.inboundCount,
    outbound_count: s.outboundCount,
    requests: s.requests.map(r => ({ id: r.id, status: r.status, service_id: r.service_id })),
    offer_count: s.offers.length,
    first_at: s.first_at,
    last_at: s.last_at,
    hours_idle: Math.round(s._idleHours * 10) / 10,
    last_turns
  };
  stream.write(JSON.stringify(row) + '\n');
  written += 1;
}

stream.end();
await new Promise(res => stream.on('finish', res));

console.error(`wrote ${written}/${stuck.length} sessions stuck at "${STEP}" → ${outPath}`);
console.error(`(window=${DAYS}d, idle≥${IDLE_HOURS}h, channel=${CHANNEL}, limit=${LIMIT})`);
console.log(outPath);
process.exit(0);
