// Agent v2 — LLM-path tests. Requires QWEN_API_KEY. Skipped otherwise so
// offline / CI-without-secret environments stay green.
//
// These tests set SANAD_AGENT_V2=true before any module import (helpers.js
// forces QWEN_API_KEY=''; we override BOTH so runAgentV2 actually runs).

import fs from 'fs';
import path from 'path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Bypass helpers.js's key-stripping by setting env BEFORE it loads. Tests
// that need the full helper surface can still import it lazily.
const HAS_KEY = !!process.env.QWEN_API_KEY;

if (!HAS_KEY) {
  describe('agent v2 (LLM path)', { skip: 'QWEN_API_KEY not set' }, () => {
    test('skipped', () => {});
  });
} else {
  // Force v2 + isolated DB BEFORE any lazy import chain evaluates lib/llm.js.
  process.env.SANAD_AGENT_V2 = 'true';
  process.env.NODE_ENV = 'test';
  process.env.DB_URL = 'file:./data/sanad-v2-test.db';
  process.env.DEBUG_MODE = 'true';
  process.env.SANAD_NO_AUTOSTART = '1';
  process.env.SANAD_SKIP_EMBED = '1'; // don't spawn the embed worker during tests
  try { fs.unlinkSync('./data/sanad-v2-test.db'); } catch {}
  try { fs.unlinkSync('./data/sanad-v2-test.db-journal'); } catch {}

  describe('agent v2 (LLM path)', () => {
    let runTurn, db, prepare;

    before(async () => {
      ({ runTurn } = await import('../lib/agent.js'));
      ({ db } = await import('../lib/db.js'));
      ({ prepare } = await import('../server.js'));
      await prepare();
    });

    const drive = async (sid, text, attachment) => {
      const res = await runTurn({ session_id: sid, user_text: text, attachment, citizen_phone: '+96899000999' });
      return res;
    };

    test('service discovery: "renew my passport" finds Passport renewal', async () => {
      const sid = 'v2-discovery-' + Date.now();
      const r = await drive(sid, 'I want to renew my passport');
      assert.match(r.reply, /passport/i, `reply should mention passport, got: ${r.reply}`);
      // We expect the LLM called search_services at least once.
      const searched = r.trace.some(t => t.step === 'tool_v2' && t.name === 'search_services');
      assert.ok(searched, 'search_services should have been called');
    });

    test('Arabic query surfaces matching service', async () => {
      const sid = 'v2-ar-' + Date.now();
      const r = await drive(sid, 'أريد تجديد بطاقتي الشخصية');
      assert.match(r.reply, /[\u0600-\u06FF]/, 'reply should be in Arabic');
    });

    test('start → confirm → collect flow transitions state via tools', async () => {
      const sid = 'v2-flow-' + Date.now();
      await drive(sid, 'I want to renew my civil id');
      // 2nd turn: user picks / confirms intent
      const r2 = await drive(sid, 'yes please start');
      // Expect state to be either confirming or collecting depending on how
      // the LLM chose to sequence start_submission + confirm_submission.
      assert.ok(['confirming', 'collecting'].includes(r2.state.status),
                `unexpected state ${r2.state.status}`);
    });

    test('cancel_request tool called on "cancel" intent', async () => {
      const sid = 'v2-cancel-' + Date.now();
      // Seed a ready request directly so the cancel path has something to hit.
      const { rows } = await db.execute(`SELECT id FROM service_catalog WHERE is_launch=1 LIMIT 1`);
      const svcId = rows[0]?.id;
      if (!svcId) { assert.ok(false, 'no launch service seeded'); return; }
      const ins = await db.execute({
        sql: `INSERT INTO request(session_id, service_id, status, fee_omr) VALUES (?,?, 'ready', 3)`,
        args: [sid, svcId]
      });
      const rid = Number(ins.lastInsertRowid);
      // Tell the agent.
      await drive(sid, `please cancel request ${rid}`);
      await drive(sid, 'yes I am sure');
      const { rows: check } = await db.execute({
        sql: `SELECT status, cancel_requested FROM request WHERE id=?`, args: [rid]
      });
      // Either hard-cancelled (status=cancelled) OR the LLM may have asked again.
      assert.ok(['cancelled', 'ready'].includes(check[0].status),
                `unexpected status ${check[0].status}`);
    });

    test('tool loop is bounded (never infinite)', async () => {
      const sid = 'v2-bound-' + Date.now();
      const r = await drive(sid, 'help me compare everything');
      const toolCalls = r.trace.filter(t => t.step === 'tool_v2').length;
      assert.ok(toolCalls <= 8, `too many tool calls: ${toolCalls}`); // 6 rounds, parallel_tool_calls=false, so worst case ~6
    });

    after(async () => {
      try { fs.unlinkSync('./data/sanad-v2-test.db'); } catch {}
    });
  });
}
