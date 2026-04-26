import 'dotenv/config';
import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { db, migrate, seedDemoOffices, seedDemoAnnotators, seedDemoRequests, autoImportCatalog } from './lib/db.js';
import { chatRouter } from './routes/chat.js';
import { officerRouter } from './routes/officer.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { debugRouter } from './routes/debug.js';
import { catalogueRouter } from './routes/catalogue.js';
import { annotatorRouter } from './routes/annotator.js';
import { authRouter } from './routes/auth.js';
import { officeRouter } from './routes/office.js';
import { platformAdminRouter } from './routes/platform_admin.js';
import { paymentsRouter } from './routes/payments.js';
import { attachSession } from './lib/auth.js';
import { LLM_ENABLED } from './lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3030);
const DEBUG = process.env.DEBUG_MODE === 'true';

const app = express();
app.disable('x-powered-by');
// `verify` captures the raw body bytes so signature-validating routes
// (e.g. WhatsApp webhook X-Hub-Signature-256, payments webhook) can hash
// the original payload — express.json() consumes the stream otherwise.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(cookieParser());
// Hydrate req.officer/req.office if the caller has a valid session cookie.
// All downstream route files can rely on req.session / requireOfficer().
app.use(attachSession);

// Simple request log
app.use((req, _res, next) => {
  if (DEBUG) console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Static UI + upload passthrough
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));
// Serve public assets without aggressive caching — the app is under active
// development and officers need to see UI changes (i18n strings, new buttons)
// immediately without a hard refresh. We bypass the browser cache on every
// HTML / JS / CSS response; uploads are still cached normally above.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// API
app.use('/api/auth', authRouter);
app.use('/api/office', officeRouter);
app.use('/api/platform-admin', platformAdminRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/officer', officerRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/debug', debugRouter);
app.use('/api/catalogue', catalogueRouter);
app.use('/api/annotator', annotatorRouter);

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
  // Auto-import the ~3.4k-row service directory on first boot so annotator
  // search has real data to find. Subsequent boots skip (table already full).
  await autoImportCatalog();
  await seedDemoOffices();
  await seedDemoAnnotators();
  await seedDemoRequests();  // no-op unless DEBUG_MODE=true
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);

  // Fire-and-forget: embed rows that still lack vectors. Runs in the
  // background so first boot returns fast; hybrid search falls back to
  // FTS-only until the cache is warm.
  if (LLM_ENABLED && !process.env.SANAD_SKIP_EMBED) {
    setTimeout(async () => {
      try {
        const { embedPending } = await import('./lib/embeddings.js');
        let total = 0, n;
        do { n = await embedPending(); total += n; }
        while (n > 0);
        if (total) console.log(`[embed] catalogue embedded (+${total} rows)`);
      } catch (e) {
        console.warn('[embed] background worker error:', e.message);
      }
    }, 500);
  }

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
      console.log(`     • Annotator:  http://localhost:${bound}/annotator.html`);
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
