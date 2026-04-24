// Shared test helpers. Forces an isolated test DB and disables real LLM.
import fs from 'fs';
import path from 'path';

// These env vars must be set BEFORE any module imports db/llm.
process.env.NODE_ENV = 'test';
process.env.DB_URL = 'file:./data/sanad-test.db';
process.env.QWEN_API_KEY = '';          // force heuristic mode for deterministic tests
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = '1';   // prevent server.js from auto-listening

// Wipe any previous test DB so each run is fresh.
const TEST_DB_PATH = './data/sanad-test.db';
try { fs.unlinkSync(TEST_DB_PATH); } catch {}
try { fs.unlinkSync(TEST_DB_PATH + '-journal'); } catch {}

export async function bootTestEnv() {
  // Lazy-import so env is set first
  const { migrate, seedDemoOffices } = await import('../lib/db.js');
  await migrate();
  await seedDemoOffices();
}

export async function spawnServer() {
  const { start } = await import('../server.js');
  const { server, port } = await start(0);   // port 0 = OS picks
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise(r => server.close(r))
  };
}

export async function fetchJSON(origin, path, opts = {}) {
  const res = await fetch(origin + path, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

export async function postChat(origin, sid, text, file) {
  const fd = new FormData();
  fd.append('text', text || '');
  if (file) fd.append('file', new Blob([file.content || 'x'], { type: file.mime || 'image/jpeg' }), file.name || 'doc.jpg');
  const res = await fetch(`${origin}/api/chat/${sid}`, { method: 'POST', body: fd });
  return res.json();
}

// ─── Auth helpers ──────────────────────────────────────────
// Signup + approve a test office. Returns the session cookie string so
// subsequent requests can be made as this office's owner.
// Because helpers.js sets DEBUG_MODE='true' and ADMIN_EMAILS isn't set,
// the platform-admin check treats any signed-in officer as an admin —
// so we can approve via the real API without extra scaffolding.
let _counter = 0;
export async function registerAndApproveOffice(origin, overrides = {}) {
  _counter += 1;
  const stamp = Date.now() + '-' + _counter;
  const payload = {
    office_name_en: 'Test Office ' + stamp,
    office_name_ar: 'مكتب اختبار',
    governorate: 'Muscat',
    wilayat: 'Bawshar',
    cr_number: '77' + stamp.slice(-5),
    phone: '+96890000000',
    email: `owner-${stamp}@test.om`,
    full_name: 'Test Owner',
    password: 'password123',
    ...overrides
  };
  const r = await fetch(origin + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`signup failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  // Grab the session cookie (httpOnly is fine — fetch can still forward it).
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  // Approve the office (DEBUG_MODE fallback means the owner is also an admin).
  const approve = await fetch(`${origin}/api/platform-admin/office/${data.officer.office.id}/approve`, {
    method: 'POST', headers: { cookie }
  });
  if (!approve.ok) throw new Error(`approve failed ${approve.status}: ${await approve.text()}`);
  return { cookie, officer: data.officer, office_id: data.officer.office.id };
}

// Drive the chat agent to create a 'ready' request and return its id.
export async function createReadyRequest(origin) {
  const sid = 'req-' + Math.random().toString(36).slice(2, 10);
  await postChat(origin, sid, 'renew driving licence');
  await postChat(origin, sid, 'yes');
  for (let i = 0; i < 3; i++) await postChat(origin, sid, '', { name: `doc${i}.jpg` });
  const submit = await postChat(origin, sid, 'confirm');
  if (!submit.request_id) throw new Error('request not queued');
  return { sid, request_id: submit.request_id };
}
