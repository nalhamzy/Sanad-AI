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
