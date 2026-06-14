// scripts/e2e_production_test.mjs
//
// End-to-end production-readiness driver. Exercises the REAL HTTP API the
// way real users do — office signup/approve/login + dashboard, citizen
// request creation via web chat AND via the WhatsApp webhook, then the
// full office lifecycle (claim → review → payment → complete).
//
// Uses Node's fetch (proper UTF-8 — curl mangles Arabic on Windows).
// Writes a structured JSON transcript to data/e2e_report.json which the
// HTML report generator consumes.
//
// Run against a server already listening on BASE (default :3030):
//   node scripts/e2e_production_test.mjs
//
// Exit code 0 if all critical steps pass, 1 otherwise.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://localhost:3030';
const stamp = Date.now();

// Read WHATSAPP_APP_SECRET from .env so we can HMAC-sign the simulated
// inbound webhook exactly like Meta does (the server enforces the signature
// when the secret is configured — which it is in production).
function envVal(key) {
  try {
    const line = readFileSync('./.env', 'utf8').split(/\r?\n/).find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch { return ''; }
}
const WA_APP_SECRET = process.env.WHATSAPP_APP_SECRET || envVal('WHATSAPP_APP_SECRET');

// ── transcript accumulator ──────────────────────────────────
const steps = [];
let failures = 0;
function rec(phase, name, ok, detail = {}) {
  steps.push({ phase, name, ok, detail, at: new Date().toISOString() });
  if (!ok) failures++;
  const tag = ok ? '✅' : '❌';
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200);
  console.log(`${tag} [${phase}] ${name} ${d}`);
}

async function api(path, { method = 'GET', body, cookie, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (cookie) headers['cookie'] = cookie;
  // Same-origin Referer so the CSRF originGuard passes for state-changing calls.
  headers['referer'] = BASE + '/';
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, cookie: setCookie.split(';')[0] || null, headers: res.headers };
}

// Web chat turn (citizen). JSON body → proper UTF-8.
async function chat(sid, text, phone) {
  const res = await fetch(`${BASE}/api/chat/${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text, phone })
  });
  const j = await res.json().catch(() => ({}));
  return j;
}

// Web chat turn WITH an attachment (multipart). Node FormData handles UTF-8.
async function chatUpload(sid, text, fileName) {
  const fd = new FormData();
  if (text) fd.append('text', text);
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fd.append('file', new Blob([png], { type: 'image/png' }), fileName || 'doc.png');
  const res = await fetch(`${BASE}/api/chat/${encodeURIComponent(sid)}`, { method: 'POST', body: fd });
  return res.json().catch(() => ({}));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n=== Sanad-AI E2E production test @ ${BASE} ===\n`);

  // ── PHASE 0: health ───────────────────────────────────────
  const health = await api('/api/health');
  rec('health', 'GET /api/health', health.status === 200 && health.json?.ok,
    { llm: health.json?.llm, whatsapp: health.json?.whatsapp, thawani: health.json?.thawani });

  // ════════════════════════════════════════════════════════
  // PHASE 1 — OFFICE: signup → approve → login → dashboard
  // ════════════════════════════════════════════════════════
  const officeEmail = `e2e-office-${stamp}@test.om`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      office_name_en: 'E2E Test Office',
      office_name_ar: 'مكتب اختبار شامل',
      governorate: 'Muscat', wilayat: 'Bawshar',
      cr_number: 'CR' + stamp.toString().slice(-7),
      phone: '+96890' + stamp.toString().slice(-6),
      email: officeEmail,
      full_name: 'E2E Owner',
      password: 'E2ePass2026!'
    }
  });
  const officeId = signup.json?.officer?.office?.id;
  let officeCookie = signup.cookie;
  rec('office', 'signup', !!officeId && !!officeCookie, { office_id: officeId, status: signup.status });

  // Approve via platform-admin (DEBUG_MODE makes the signed-in owner an admin).
  if (officeId) {
    const approve = await api(`/api/platform-admin/office/${officeId}/approve`, {
      method: 'POST', cookie: officeCookie
    });
    rec('office', 'admin approve', approve.status === 200, { status: approve.status });
  }

  // Re-login to get an active-office session.
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: officeEmail, password: 'E2ePass2026!' }
  });
  officeCookie = login.cookie || officeCookie;
  rec('office', 'login', login.status === 200 && !!officeCookie, { status: login.status });

  // Dashboard surfaces: profile, inbox, pricing, bank.
  const profile = await api('/api/office/profile', { cookie: officeCookie });
  rec('office', 'GET /api/office/profile', profile.status === 200 && !!profile.json?.office,
    { name: profile.json?.office?.name_ar, status: profile.json?.office?.status, has_bank: profile.json?.office?.has_bank_details });

  const bank = await api('/api/office/bank', { cookie: officeCookie });
  rec('office', 'GET /api/office/bank', bank.status === 200, { has_bank: bank.json?.has_bank_details });

  // Set bank details (so payouts mark-paid is unblocked later).
  const setBank = await api('/api/office/bank', {
    method: 'PATCH', cookie: officeCookie,
    body: { iban: 'OM470030000012345678901', bank_name: 'Bank Muscat',
            account_holder_name: 'E2E Test Office LLC', phone: '+96890001234' }
  });
  rec('office', 'PATCH /api/office/bank (set IBAN)', setBank.status === 200, { updated: setBank.json?.updated });

  const inbox0 = await api('/api/officer/inbox', { cookie: officeCookie });
  rec('office', 'GET /api/officer/inbox', inbox0.status === 200 && Array.isArray(inbox0.json?.marketplace),
    { marketplace: inbox0.json?.marketplace?.length, mine: inbox0.json?.mine?.length, keys: inbox0.json ? Object.keys(inbox0.json).join(',') : 'none' });

  // ════════════════════════════════════════════════════════
  // PHASE 2 — CITIZEN (WEB): create a request via chat
  // ════════════════════════════════════════════════════════
  const webSid = `e2e-web-${stamp}`;
  let webReq = null;
  {
    const t1 = await chat(webSid, 'السلام عليكم');                         // greeting
    rec('web', 'turn 1 greeting', !!t1.reply, { status: t1.state?.status });

    const t2 = await chat(webSid, 'ابغى اجدد رخصة القيادة');               // service intent
    const matched = t2.state?.status === 'collecting' || /رخص|سياق|قياد/.test(t2.reply || '');
    rec('web', 'turn 2 service match (driving licence)', matched,
      { status: t2.state?.status, reply_head: (t2.reply || '').slice(0, 60) });

    // If the agent asked to confirm before collecting, say yes.
    let st = t2.state?.status;
    if (st !== 'collecting') {
      const t3 = await chat(webSid, 'نعم');
      st = t3.state?.status;
      rec('web', 'turn 3 confirm start', st === 'collecting', { status: st, reply_head: (t3.reply || '').slice(0, 60) });
    }

    // Upload documents until the agent says the file is complete. The matched
    // catalog service may need 5 docs; we upload up to 7 uncaptioned files
    // (the burst flow assigns them to slots in order), waiting for the
    // server-side burst timer to drain between batches, then poll /state.
    async function getState() {
      const r = await fetch(`${BASE}/api/chat/${encodeURIComponent(webSid)}/state`).catch(() => null);
      if (!r) return {};
      return r.json().catch(() => ({}));
    }
    let uploaded = 0, st2 = 'collecting';
    for (let i = 1; i <= 7 && st2 === 'collecting'; i++) {
      await chatUpload(webSid, '', `doc${i}.png`);
      uploaded++;
      await sleep(250);
      // Every couple of uploads, let the burst drain and re-check state.
      if (i % 2 === 0) {
        await sleep(2600);
        st2 = (await getState()).state?.status || st2;
      }
    }
    await sleep(2800);  // final burst drain
    st2 = (await getState()).state?.status || st2;
    rec('web', `upload documents (${uploaded}) → reviewing`, st2 === 'reviewing' || st2 === 'queued',
      { uploaded, status: st2 });

    // Confirm submission. In 'reviewing' the agent shows a summary + waits for
    // a yes/confirm. Try a couple of natural confirmations.
    let submit = await chat(webSid, 'تأكيد', '+96890' + stamp.toString().slice(-6));
    webReq = submit.request_id || submit.state?.request_id || null;
    if (!webReq && submit.state?.status === 'reviewing') {
      submit = await chat(webSid, 'نعم أرسله', '+96890' + stamp.toString().slice(-6));
      webReq = submit.request_id || submit.state?.request_id || null;
    }
    rec('web', 'submit → request created', !!webReq,
      { request_id: webReq, status: submit.state?.status, reply_head: (submit.reply || '').slice(0, 70) });

    // Fallback: if the conversational flow couldn't create a request (e.g.
    // the LLM/vision API is overloaded — a transient outage), seed a 'ready'
    // request directly so the office-lifecycle phase can still be validated.
    // This simulates exactly what a completed citizen submission produces.
    if (!webReq) {
      try {
        const { db } = await import('../lib/db.js');
        // Pick the driving-licence renewal catalog service.
        const svc = (await db.execute(
          `SELECT id, name_ar FROM service_catalog WHERE name_en LIKE '%Driver%Licen%' OR name_ar LIKE '%رخصة سياقة%' LIMIT 1`)).rows[0]
          || (await db.execute(`SELECT id, name_ar FROM service_catalog WHERE is_active=1 LIMIT 1`)).rows[0];
        const cit = await db.execute({
          sql: `INSERT INTO citizen(phone, name, language_pref) VALUES (?, ?, 'ar')`,
          args: ['+96890' + stamp.toString().slice(-6), 'مواطن اختبار']
        });
        const citizenId = Number(cit.lastInsertRowid);
        const ins = await db.execute({
          sql: `INSERT INTO request(session_id, citizen_id, service_id, status, governorate, fee_omr, created_at, last_event_at)
                VALUES (?, ?, ?, 'ready', 'Muscat', NULL, datetime('now'), datetime('now'))`,
          args: [webSid, citizenId, svc.id]
        });
        webReq = Number(ins.lastInsertRowid);
        for (let i = 1; i <= 3; i++) {
          await db.execute({
            sql: `INSERT INTO request_document(request_id, doc_code, label, storage_url, mime, status, uploaded_at)
                  VALUES (?, ?, ?, ?, 'image/png', 'pending', datetime('now'))`,
            args: [webReq, `doc_${i}`, 'مستند ' + i, `/uploads/${webSid}/doc${i}.png`]
          });
        }
        rec('web', 'FALLBACK seed ready request (LLM outage)', !!webReq,
          { request_id: webReq, service: svc.name_ar });
      } catch (e) {
        rec('web', 'FALLBACK seed ready request', false, { error: String(e.message).slice(0, 120) });
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PHASE 3 — CITIZEN (WHATSAPP): inbound via webhook
  // ════════════════════════════════════════════════════════
  const waPhone = '+96891' + stamp.toString().slice(-6);
  function waPayload(text, msgId) {
    return {
      entry: [{ changes: [{ value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'TEST_PNID' },
        messages: [{ from: waPhone.replace('+', ''), id: msgId, type: 'text', text: { body: text } }]
      } }] }]
    };
  }
  async function waSend(text, msgId) {
    const raw = JSON.stringify(waPayload(text, msgId));
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    // Sign exactly like Meta: X-Hub-Signature-256: sha256=HMAC(rawBody, app_secret).
    if (WA_APP_SECRET) {
      const sig = crypto.createHmac('sha256', WA_APP_SECRET).update(raw).digest('hex');
      headers['x-hub-signature-256'] = 'sha256=' + sig;
    }
    const res = await fetch(`${BASE}/api/whatsapp/webhook`, { method: 'POST', headers, body: raw });
    return res.status;
  }
  {
    const s1 = await waSend('السلام عليكم', `wamid.${stamp}.1`);
    rec('whatsapp', 'inbound greeting → 200 ACK', s1 === 200, { http: s1 });
    await sleep(400);
    const s2 = await waSend('ابغى تجديد رخصة القيادة', `wamid.${stamp}.2`);
    rec('whatsapp', 'inbound service intent → 200 ACK', s2 === 200, { http: s2 });
    await sleep(1500);
    // Verify the WhatsApp session produced bot messages (agent ran).
    // The WhatsApp session_id is `wa:<phone-WITHOUT-+>` (see routes/whatsapp.js).
    const waSession = 'wa:' + waPhone.replace('+', '');
    const trace = await api(`/api/debug/trace/${encodeURIComponent(waSession)}?n=12`, { cookie: officeCookie });
    const botMsgs = (trace.json?.messages || []).filter(m => m.actor_type === 'bot').length;
    rec('whatsapp', 'agent produced bot replies', botMsgs >= 1,
      { bot_messages: botMsgs, session_state: trace.json?.session?.state?.status });
  }

  // ════════════════════════════════════════════════════════
  // PHASE 4 — OFFICE LIFECYCLE on the web-created request
  // ════════════════════════════════════════════════════════
  if (webReq) {
    // The request should appear in the marketplace inbox (status 'ready').
    const inbox = await api('/api/officer/inbox', { cookie: officeCookie });
    const reqs = inbox.json?.marketplace || [];
    const found = reqs.find(r => r.id === webReq);
    rec('lifecycle', 'request visible in marketplace', !!found,
      { marketplace_count: reqs.length, found: !!found });

    // ANONYMITY check: marketplace card must NOT expose citizen phone/name.
    if (found) {
      const leaks = ['citizen_phone', 'phone', 'citizen_name'].filter(k => found[k]);
      rec('lifecycle', 'anonymity: no citizen PII in marketplace card', leaks.length === 0,
        { leaked_keys: leaks });
    }

    // Claim it.
    const claim = await api(`/api/officer/request/${webReq}/claim`, { method: 'POST', cookie: officeCookie });
    rec('lifecycle', 'claim request', claim.status === 200 && claim.json?.ok,
      { status: claim.status, new_status: claim.json?.status, pricing: claim.json?.pricing });

    // Send payment link.
    const payStart = await api(`/api/officer/request/${webReq}/payment/start`, { method: 'POST', cookie: officeCookie });
    rec('lifecycle', 'send payment link', payStart.status === 200 && (payStart.json?.payment_link || payStart.json?.ok),
      { status: payStart.status, provider: payStart.json?.provider, amount: payStart.json?.amount_omr,
        link_head: (payStart.json?.payment_link || '').slice(0, 48) });

    // Simulate citizen paying (debug stub — production uses Thawani redirect/webhook).
    const pay = await api(`/api/payments/request/${webReq}/confirm-stub`, { method: 'POST', cookie: officeCookie });
    rec('lifecycle', 'citizen pays (stub)', pay.status === 200 && (pay.json?.ok || pay.json?.alreadyPaid),
      { status: pay.status, paid: pay.json?.ok, already: pay.json?.alreadyPaid });

    // After payment the request should be in_progress; office completes it.
    await sleep(200);
    const complete = await api(`/api/officer/request/${webReq}/complete`, { method: 'POST', cookie: officeCookie });
    rec('lifecycle', 'office completes request', complete.status === 200,
      { status: complete.status, body: complete.json ? Object.keys(complete.json).join(',') : complete.text.slice(0, 80) });
  } else {
    rec('lifecycle', 'SKIPPED — no web request id', false, 'web request was not created');
  }

  // ════════════════════════════════════════════════════════
  // PHASE 5 — ADMIN visibility
  // ════════════════════════════════════════════════════════
  const adminPayments = await api('/api/platform-admin/payments?status=paid', { cookie: officeCookie });
  rec('admin', 'GET /payments (paid)', adminPayments.status === 200,
    { count: adminPayments.json?.count });
  const kpis = await api('/api/platform-admin/payments/kpis', { cookie: officeCookie });
  rec('admin', 'GET /payments/kpis', kpis.status === 200,
    { pmts_today: kpis.json?.citizen_payments_today, omr_today: kpis.json?.omr_collected_today });

  // ── write transcript ──────────────────────────────────────
  const summary = {
    base: BASE, generated_at: new Date().toISOString(),
    total: steps.length, passed: steps.length - failures, failed: failures,
    health: health.json, steps
  };
  const fs = await import('node:fs');
  fs.writeFileSync('./data/e2e_report.json', JSON.stringify(summary, null, 2));
  console.log(`\n=== DONE: ${summary.passed}/${summary.total} passed, ${failures} failed ===`);
  console.log('Transcript → data/e2e_report.json');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error('E2E driver crashed:', e); process.exit(2); });
