import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { db, migrate, seedDemoOffices } from './lib/db.js';
import { chatRouter } from './routes/chat.js';
import { officerRouter } from './routes/officer.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { debugRouter } from './routes/debug.js';
import { catalogueRouter } from './routes/catalogue.js';
import { LLM_ENABLED } from './lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3030);
const DEBUG = process.env.DEBUG_MODE === 'true';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Simple request log
app.use((req, _res, next) => {
  if (DEBUG) console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Static UI + upload passthrough
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// API
app.use('/api/chat', chatRouter);
app.use('/api/officer', officerRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/debug', debugRouter);
app.use('/api/catalogue', catalogueRouter);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: LLM_ENABLED, debug: DEBUG }));

// SPA fallback — any route not starting with /api goes to index.html
app.get(/^\/(?!api|uploads).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Boot helpers — exported so tests can drive setup without auto-listening
export async function prepare() {
  fs.mkdirSync('./data/uploads', { recursive: true });
  await migrate();
  await seedDemoOffices();
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
  return { catalogueSize: rows[0].n };
}

export async function start(port = PORT) {
  const info = await prepare();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const bound = server.address().port;
      console.log(`\n  🇴🇲  Sanad-AI listening on http://localhost:${bound}`);
      if (info.catalogueSize === 0) {
        console.warn('⚠  service_catalog is empty — run `npm run seed` to import the CSV (optional in debug mode).');
      } else {
        console.log(`✓ service_catalog: ${info.catalogueSize} rows`);
      }
      console.log(`     • Web chat:   http://localhost:${bound}/chat.html`);
      console.log(`     • Officer:    http://localhost:${bound}/officer.html`);
      console.log(`     • Admin:      http://localhost:${bound}/admin.html`);
      console.log(`     • Debug:      http://localhost:${bound}/api/debug/state`);
      console.log(`     • LLM mode:   ${LLM_ENABLED ? 'Qwen ON' : 'stub (set QWEN_API_KEY for real replies)'}\n`);
      resolve({ server, app, port: bound });
    });
  });
}

export { app };

// Auto-start when run directly (but NOT when imported as a module by tests)
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
               process.argv[1]?.endsWith('server.js');
if (isMain && !process.env.SANAD_NO_AUTOSTART) {
  start(PORT).catch(e => {
    console.error('Boot failed:', e);
    process.exit(1);
  });
}
