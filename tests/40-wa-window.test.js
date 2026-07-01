// WhatsApp 24-hour window: knock-&-flush deferred delivery.
// Outside Meta's 24h window we queue the real content + send an approved
// template; the citizen's next inbound flushes the queue. The in-app thread /
// طلباتي is written regardless (covered in 31-office-issued-docs).
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestEnv } from './helpers.js';
import { isWindowOpen, enqueuePendingWa, flushPendingWa, tsToMs } from '../lib/wa_templates.js';
import { notifyCitizen } from '../lib/officer_helpers.js';
import { storeMessage } from '../lib/agent.js';

test('tsToMs parses SQLite UTC timestamps', () => {
  assert.ok(tsToMs('2026-06-28 12:00:00') > 0);
  assert.equal(tsToMs(null), 0);
  assert.equal(tsToMs(''), 0);
});

test('isWindowOpen: open within 24h, closed when stale or never messaged', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  assert.equal(await isWindowOpen('wa:96890000001'), false, 'never messaged → closed');

  await storeMessage({ session_id: 'wa:96890000002', direction: 'in', actor_type: 'citizen', body_text: 'hi' });
  assert.equal(await isWindowOpen('wa:96890000002'), true, 'recent inbound → open');

  await db.execute({
    sql: `INSERT INTO message(session_id,direction,actor_type,body_text,created_at)
          VALUES (?, 'in','citizen','old', datetime('now','-2 days'))`,
    args: ['wa:96890000003']
  });
  assert.equal(await isWindowOpen('wa:96890000003'), false, '>24h inbound → closed');
});

test('enqueue + flush delivers queued content and marks it sent', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  const sid = 'wa:96890000010';
  await enqueuePendingWa(sid, '96890000010', { body: 'deferred hello' });
  await enqueuePendingWa(sid, '96890000010', {
    media: { link: 'https://saned.ai/uploads/issued/1/x.pdf', filename: 'x.pdf', mime: 'application/pdf', caption: 'doc' }
  });
  let { rows } = await db.execute({ sql: `SELECT COUNT(*) n FROM pending_wa WHERE session_id=? AND sent_at IS NULL`, args: [sid] });
  assert.equal(Number(rows[0].n), 2, 'two rows queued');

  const n = await flushPendingWa(sid);
  assert.equal(n, 2, 'flushed both');
  ({ rows } = await db.execute({ sql: `SELECT COUNT(*) n FROM pending_wa WHERE session_id=? AND sent_at IS NULL`, args: [sid] }));
  assert.equal(Number(rows[0].n), 0, 'all marked sent');
});

test('notifyCitizen DEFERS to a template when the window is closed', async () => {
  await bootTestEnv();
  const { db } = await import('../lib/db.js');
  const sid = 'wa:96890000020';
  const out = await notifyCitizen({
    session_id: sid, body: 'وثيقتك جاهزة', citizen_phone: '+96890000020',
    media: { link: 'https://saned.ai/uploads/issued/1/y.pdf', filename: 'y.pdf', mime: 'application/pdf' },
    template: { kind: 'document', param: 'تجديد رخصة القيادة' }
  });
  assert.equal(out.wa_attempted, true);
  assert.equal(out.deferred, true, 'closed window → deferred to template');
  const { rows } = await db.execute({ sql: `SELECT COUNT(*) n FROM pending_wa WHERE session_id=? AND sent_at IS NULL`, args: [sid] });
  assert.equal(Number(rows[0].n), 1, 'real content queued for flush-on-reply');
});

test('notifyCitizen sends DIRECTLY when the window is open', async () => {
  await bootTestEnv();
  const sid = 'wa:96890000030';
  await storeMessage({ session_id: sid, direction: 'in', actor_type: 'citizen', body_text: 'hello' }); // opens window
  const out = await notifyCitizen({ session_id: sid, body: 'direct message', citizen_phone: '+96890000030' });
  assert.equal(out.wa_attempted, true);
  assert.notEqual(out.deferred, true, 'open window → not deferred');
  assert.ok(out.text, 'sent directly (stub ok)');
});
