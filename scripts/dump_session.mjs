// Dump one session as a human-readable timeline.
//
// Usage:
//   node scripts/dump_session.mjs <session_id|phone> [--n 100] [--json]
//
// Examples:
//   node scripts/dump_session.mjs wa:+96812345678
//   node scripts/dump_session.mjs +96812345678
//   node scripts/dump_session.mjs 12345678 --n 50
//   node scripts/dump_session.mjs wa:+96812345678 --json > trace.json
//
// Prints a single-column ledger:
//   [time]  ACTOR        text…
//                        ↳ tool: <name>(args) → ok=… transition=…
// Followed by a footer with current state and request rows.

import { db } from '../lib/db.js';
import { loadOneSession, resolveSessionId, classifySession, maskPhone } from './_funnel_lib.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/dump_session.mjs <session_id|phone> [--n 100] [--json]');
  process.exit(1);
}
const ident = args.find(a => !a.startsWith('--'));
const N = Number((args.find(a => a.startsWith('--n=')) || '--n=100').slice(4)) ||
          (() => { const i = args.indexOf('--n'); return i > -1 ? Number(args[i + 1]) : 100; })();
const AS_JSON = args.includes('--json');

const candidates = await resolveSessionId(ident);
if (!candidates.length) {
  console.error(`no session_id matched "${ident}"`);
  process.exit(2);
}

if (!AS_JSON) {
  console.log(`# Resolved "${ident}" → ${candidates.length} session_id(s):`);
  for (const c of candidates) console.log(`  · ${c}`);
  console.log('');
}

for (const sid of candidates) {
  const bundle = await loadOneSession(sid);
  const msgRows = await db.execute({
    sql: `SELECT id, request_id, direction, actor_type, body_text, media_url, meta_json, channel, created_at
            FROM message WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
    args: [sid, N]
  });
  const messages = msgRows.rows.reverse().map(m => {
    let meta = null;
    if (m.meta_json) { try { meta = JSON.parse(m.meta_json); } catch { meta = m.meta_json; } }
    return { ...m, meta };
  });

  const inbound = messages.filter(m => m.direction === 'in' && m.actor_type === 'citizen').length;
  const stage = classifySession({
    stateJson: bundle.session?.state_json,
    requests: bundle.requests,
    offers: bundle.offers,
    inboundCount: inbound
  });

  if (AS_JSON) {
    console.log(JSON.stringify({
      session_id: sid, masked: maskPhone(sid),
      furthest_stage: stage,
      session: bundle.session,
      requests: bundle.requests,
      offers: bundle.offers,
      messages
    }, null, 2));
    continue;
  }

  // ── Header ────────────────────────────────────────────────
  console.log('═'.repeat(78));
  console.log(`SESSION  ${sid}   (masked: ${maskPhone(sid)})`);
  console.log(`STAGE    ${stage || '— no traffic in window —'}`);
  console.log(`MESSAGES ${messages.length} shown   (${inbound} from citizen)`);
  if (bundle.session) {
    let cur = null; try { cur = JSON.parse(bundle.session.state_json || '{}'); } catch {}
    console.log(`STATE    ${cur ? JSON.stringify({
      status: cur.status, service_code: cur.service_code,
      docs_filled: (cur.docs || []).filter(d => d.url).length,
      docs_total:  (cur.docs || []).length,
      request_id: cur.request_id || null
    }) : '(no session row)'}`);
  }
  if (bundle.requests.length) {
    console.log('REQUESTS');
    for (const r of bundle.requests) {
      console.log(`  · #${r.id}  service=${r.service_id}  status=${r.status}  created=${r.created_at}  last=${r.last_event_at}`);
    }
  }
  if (bundle.offers.length) {
    console.log(`OFFERS   ${bundle.offers.length} (${bundle.offers.map(o => `office#${o.office_id}/${o.status}`).join(', ')})`);
  }
  console.log('─'.repeat(78));

  // ── Timeline ──────────────────────────────────────────────
  for (const m of messages) {
    const t = String(m.created_at || '').replace('T', ' ').slice(0, 19);
    const actor = labelActor(m);
    const head = String(m.body_text || '').replace(/\s+/g, ' ').slice(0, 220);
    const cont = String(m.body_text || '').length > 220 ? '…' : '';
    console.log(`[${t}] ${actor.padEnd(10)} ${head}${cont}`);
    if (m.media_url) {
      console.log(`${' '.repeat(33)}↳ 📎 ${m.media_url}`);
    }
    if (m.meta && typeof m.meta === 'object') {
      // Render trace entries inline if present.
      const trace = Array.isArray(m.meta.trace) ? m.meta.trace
                  : Array.isArray(m.meta) ? m.meta : null;
      if (trace) {
        for (const t of trace) {
          if (t?.step?.startsWith('tool')) {
            const args = t.args ? JSON.stringify(t.args).slice(0, 80) : '';
            console.log(`${' '.repeat(33)}↳ tool: ${t.name}(${args})  ok=${t.ok}  →${t.transition || '·'}`);
          } else if (t?.step) {
            console.log(`${' '.repeat(33)}↳ ${t.step}${t.next ? ` next=${t.next}` : ''}${t.transition ? ` →${t.transition}` : ''}`);
          }
        }
      } else {
        const k = Object.keys(m.meta).slice(0, 4).join(',');
        if (k) console.log(`${' '.repeat(33)}↳ meta: {${k}}`);
      }
    }
  }
  console.log('═'.repeat(78));
  console.log('');
}

process.exit(0);

function labelActor(m) {
  if (m.direction === 'in' && m.actor_type === 'citizen') return 'CITIZEN';
  if (m.direction === 'out' && m.actor_type === 'bot') return 'BOT';
  if (m.direction === 'out' && m.actor_type === 'officer') return 'OFFICER';
  if (m.actor_type === 'system') return 'SYSTEM';
  return `${m.direction}/${m.actor_type}`.toUpperCase();
}
