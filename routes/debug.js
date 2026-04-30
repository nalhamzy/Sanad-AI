import { Router } from 'express';
import { db } from '../lib/db.js';
import { LLM_ENABLED, LLM_PROVIDER, LLM_MODEL } from '../lib/llm.js';
import { storeMessage } from '../lib/agent.js';
import { markRequestPaid } from './payments.js';

export const debugRouter = Router();

// Gate every /simulate/* route behind DEBUG_MODE — these endpoints fast-forward
// state transitions that normally require an authenticated office, so they
// must NEVER ship to production.
function requireDebug(req, res, next) {
  if (process.env.DEBUG_MODE !== 'true') return res.status(403).json({ error: 'debug_only' });
  next();
}

debugRouter.get('/health', async (_req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({
      ok: true,
      llm: LLM_ENABLED,
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      debug: process.env.DEBUG_MODE === 'true'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

debugRouter.get('/state', async (_req, res) => {
  const counts = {};
  for (const t of ['service_catalog', 'request', 'request_document', 'message', 'citizen', 'office', 'officer', 'session']) {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  const { rows: latestRequests } = await db.execute(`SELECT id, status, fee_omr, officer_id, created_at FROM request ORDER BY id DESC LIMIT 10`);
  const { rows: latestMessages } = await db.execute(`SELECT id, session_id, actor_type, body_text, created_at FROM message ORDER BY id DESC LIMIT 20`);
  res.json({ counts, latestRequests, latestMessages });
});

// Reset a session (nuclear — wipes state; keeps messages for audit)
debugRouter.post('/reset/:session_id', async (req, res) => {
  await db.execute({ sql: `DELETE FROM session WHERE id=?`, args: [req.params.session_id] });
  res.json({ ok: true });
});

// Wipe ALL data tied to a phone number — sessions, messages, requests,
// documents, offers, citizen row. Only available in DEBUG_MODE so we don't
// expose a destructive endpoint in production. Lets the user start clean
// from WhatsApp without us having to SSH into the box.
debugRouter.post('/clear-phone', async (req, res) => {
  try {
  if (process.env.DEBUG_MODE !== 'true') return res.status(403).json({ error: 'debug_only' });
  const phone = (req.body?.phone || req.query?.phone || '').toString().trim();
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  const variants = Array.from(new Set([
    phone,
    phone.replace(/^\+/, ''),
    phone.replace(/^\+?968/, ''),
    phone.startsWith('+') ? phone : `+${phone}`,
  ].filter(Boolean)));

  const cit = await db.execute({
    sql: `SELECT id FROM citizen WHERE phone IN (${variants.map(()=>'?').join(',')})`,
    args: variants
  });
  const citIds = cit.rows.map(r => r.id);
  const waSessions = variants.map(v => `wa:${v}`);
  let extraSessions = [];
  if (citIds.length) {
    const r = await db.execute({
      sql: `SELECT DISTINCT session_id FROM request WHERE citizen_id IN (${citIds.map(()=>'?').join(',')})`,
      args: citIds
    });
    extraSessions = r.rows.map(x => x.session_id).filter(Boolean);
  }
  const sessions = Array.from(new Set([...waSessions, ...extraSessions]));
  const counts = { request_documents: 0, request_offers: 0, otp_windows: 0, credit_ledger: 0, messages: 0, requests: 0, sessions: 0, citizens: 0 };

  if (sessions.length) {
    const ph = sessions.map(()=>'?').join(',');
    const reqs = await db.execute({ sql: `SELECT id FROM request WHERE session_id IN (${ph})`, args: sessions });
    const reqIds = reqs.rows.map(r => r.id);
    if (reqIds.length) {
      const rp = reqIds.map(()=>'?').join(',');
      // Delete in dependency order — every table that REFERENCES request(id)
      // first, then request itself. Missing any of these triggers
      // SQLITE_CONSTRAINT_FOREIGNKEY which crashes the worker.
      counts.request_documents = (await db.execute({ sql: `DELETE FROM request_document WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0;
      try { counts.request_offers   = (await db.execute({ sql: `DELETE FROM request_offer WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0; } catch (e) { console.warn('[clear-phone] request_offer delete failed:', e.message); }
      try { counts.otp_windows      = (await db.execute({ sql: `DELETE FROM otp_window WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0; } catch (e) { console.warn('[clear-phone] otp_window delete failed:', e.message); }
      try { counts.credit_ledger    = (await db.execute({ sql: `DELETE FROM credit_ledger WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0; } catch (e) { console.warn('[clear-phone] credit_ledger delete failed:', e.message); }
      // message.request_id is nullable — null it out for any rows we are
      // about to orphan that live in OTHER sessions (rare, but safe).
      try { await db.execute({ sql: `UPDATE message SET request_id=NULL WHERE request_id IN (${rp})`, args: reqIds }); } catch {}
      counts.requests = (await db.execute({ sql: `DELETE FROM request WHERE id IN (${rp})`, args: reqIds })).rowsAffected || 0;
    }
    counts.messages = (await db.execute({ sql: `DELETE FROM message WHERE session_id IN (${ph})`, args: sessions })).rowsAffected || 0;
    counts.sessions = (await db.execute({ sql: `DELETE FROM session WHERE id IN (${ph})`, args: sessions })).rowsAffected || 0;
  }
  if (citIds.length) {
    counts.citizens = (await db.execute({
      sql: `DELETE FROM citizen WHERE id IN (${citIds.map(()=>'?').join(',')})`,
      args: citIds
    })).rowsAffected || 0;
  }

  res.json({ ok: true, phone, variants, sessions, counts });
  } catch (e) {
    console.error('[clear-phone] error:', e);
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
});

// ════════════════════════════════════════════════════════════
// /simulate/* — fast-forward the office side of the lifecycle so the
// citizen-facing /request.html can drive the entire flow with simulation
// buttons, no second tab needed. DEBUG_MODE only. Each step writes a
// system message into the citizen's thread so the polling UI shows the
// progression as if a real office had performed it.
// ════════════════════════════════════════════════════════════

// Resolve the demo "claimer" — a real office row. We always pick office_id=1
// (the seeded Sanad Al-Nahdha) and its first owner. The simulate endpoints
// don't go through requireOfficer() so they don't need a session.
async function _demoOfficeAndOfficer() {
  const { rows: o } = await db.execute({
    sql: `SELECT id, name_en, name_ar FROM office ORDER BY id ASC LIMIT 1`
  });
  if (!o[0]) throw new Error('no_demo_office');
  const { rows: officer } = await db.execute({
    sql: `SELECT id FROM officer WHERE office_id=? ORDER BY id ASC LIMIT 1`,
    args: [o[0].id]
  });
  if (!officer[0]) throw new Error('no_demo_officer');
  return { office: o[0], officer_id: officer[0].id };
}

// 1. Simulate office claim — atomic UPDATE, mirrors POST /api/officer/request/:id/claim.
debugRouter.post('/simulate/claim/:request_id', requireDebug, async (req, res) => {
  const id = Number(req.params.request_id);
  const { office, officer_id } = await _demoOfficeAndOfficer();
  // Read pricing context first.
  const { rows } = await db.execute({
    sql: `SELECT r.session_id, r.status, r.paid_at, r.service_id,
                 s.fee_omr AS catalog_gov_fee, s.name_en AS service_name, s.name_ar AS service_name_ar,
                 COALESCE(osp.office_fee_omr, off.default_office_fee_omr, 5.0) AS office_fee,
                 COALESCE(osp.government_fee_omr, s.fee_omr, 0) AS gov_fee
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
            LEFT JOIN office off        ON off.id = ?
            LEFT JOIN office_service_price osp ON osp.office_id = ? AND osp.service_id = r.service_id
           WHERE r.id = ?`,
    args: [office.id, office.id, id]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'ready') return res.status(409).json({ error: 'not_ready', status: r.status });
  const office_fee = Number(r.office_fee) || 0;
  const gov_fee    = Number(r.gov_fee) || 0;
  const total      = office_fee + gov_fee;
  const isTransfer = !!r.paid_at;
  const newStatus  = isTransfer ? 'in_progress' : 'claimed';
  const upd = await db.execute({
    sql: `UPDATE request
             SET status=?, office_id=?, officer_id=?,
                 office_fee_omr=?, government_fee_omr=?, quoted_fee_omr=?,
                 claimed_at=datetime('now'),
                 claim_review_started_at=datetime('now'),
                 last_event_at=datetime('now')
           WHERE id=? AND status='ready' AND office_id IS NULL`,
    args: [newStatus, office.id, officer_id, office_fee, gov_fee, total, id]
  });
  if (!upd.rowsAffected) return res.status(409).json({ error: 'race_lost' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer', ?, ?, 'request', ?, ?)`,
    args: [officer_id, isTransfer ? 'request_claim_transfer' : 'request_claim', id,
           JSON.stringify({ office_fee, gov_fee, total, transfer: isTransfer, simulated: true })]
  });
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'bot',
    body_text: `📥 تم استلام طلبك "${r.service_name_ar || r.service_name}" من قِبَل ${office.name_ar || office.name_en}. يراجع الموظف مستنداتك الآن وسيرسل لك رابط الدفع قريباً.`
  });
  res.json({ ok: true, status: newStatus, office_id: office.id, pricing: { office_fee, government_fee: gov_fee, total } });
});

// 2. Simulate office sends payment link — flips to awaiting_payment.
debugRouter.post('/simulate/send-link/:request_id', requireDebug, async (req, res) => {
  const id = Number(req.params.request_id);
  const { rows } = await db.execute({
    sql: `SELECT r.session_id, r.status, r.office_fee_omr, r.government_fee_omr, r.quoted_fee_omr,
                 s.name_en AS service_name, s.name_ar AS service_name_ar
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.id = ?`,
    args: [id]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'claimed') return res.status(409).json({ error: 'not_claimed', status: r.status });
  const total = Number(r.quoted_fee_omr || 0) || (Number(r.office_fee_omr || 0) + Number(r.government_fee_omr || 0));
  const merchantRef = `req${id}-sim-${Date.now()}`;
  const stubLink = `/api/payments/_stub/request_pay?ref=${encodeURIComponent(merchantRef)}`;
  const upd = await db.execute({
    sql: `UPDATE request
             SET status='awaiting_payment',
                 payment_link=?, payment_ref=?, payment_amount_omr=?,
                 payment_status='awaiting',
                 last_event_at=datetime('now')
           WHERE id=? AND status='claimed'`,
    args: [stubLink, merchantRef, total, id]
  });
  if (!upd.rowsAffected) return res.status(409).json({ error: 'race_lost' });
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'bot',
    body_text: `💳 رابط الدفع جاهز — اضغط للدفع.\nالإجمالي: ${total.toFixed(3)} ر.ع.\n${stubLink}`
  });
  res.json({ ok: true, payment_link: stubLink, merchant_ref: merchantRef, amount_omr: total });
});

// 3. Simulate citizen pays — flips to in_progress, fires markRequestPaid.
debugRouter.post('/simulate/pay/:request_id', requireDebug, async (req, res) => {
  const id = Number(req.params.request_id);
  const result = await markRequestPaid(id, 'simulate');
  if (!result.ok) return res.status(409).json({ error: result.error || 'pay_failed' });
  res.json({ ok: true, alreadyPaid: result.alreadyPaid === true });
});

// 4. Simulate office completes — flips to completed.
debugRouter.post('/simulate/complete/:request_id', requireDebug, async (req, res) => {
  const id = Number(req.params.request_id);
  const { rows } = await db.execute({
    sql: `SELECT r.session_id, r.status, r.officer_id,
                 s.name_en AS service_name, s.name_ar AS service_name_ar
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
           WHERE r.id = ?`,
    args: [id]
  });
  const r = rows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'in_progress') return res.status(409).json({ error: 'not_in_progress', status: r.status });
  const upd = await db.execute({
    sql: `UPDATE request SET status='completed', completed_at=datetime('now'), last_event_at=datetime('now')
           WHERE id=? AND status='in_progress'`,
    args: [id]
  });
  if (!upd.rowsAffected) return res.status(409).json({ error: 'race_lost' });
  await db.execute({
    sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
          VALUES ('officer', ?, 'request_complete', 'request', ?, ?)`,
    args: [r.officer_id, id, JSON.stringify({ simulated: true })]
  });
  await storeMessage({
    session_id: r.session_id, request_id: id,
    direction: 'out', actor_type: 'bot',
    body_text: `✅ تم إنجاز معاملتك "${r.service_name_ar || r.service_name}". يمكنك استلام النتيجة من المكتب.`
  });
  res.json({ ok: true });
});

// Inject a fake OTP (simulates the gov portal sending to the citizen's phone)
debugRouter.post('/simulate-otp/:request_id', async (req, res) => {
  const code = (req.body?.code || '').toString() || '123456';
  const id = Number(req.params.request_id);
  const { rows } = await db.execute({ sql: `SELECT session_id FROM request WHERE id=?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: 'no_such_request' });
  // Inject as citizen message so the agent captures it
  await db.execute({
    sql: `INSERT INTO message(session_id,request_id,direction,actor_type,body_text,channel) VALUES (?,?, 'in','citizen',?, 'web')`,
    args: [rows[0].session_id, id, code]
  });
  await db.execute({
    sql: `UPDATE otp_window SET code=?, consumed_at=datetime('now') WHERE request_id=? AND consumed_at IS NULL`,
    args: [code, id]
  });
  res.json({ ok: true, code });
});
