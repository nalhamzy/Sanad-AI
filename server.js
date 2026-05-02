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
import { citizenAuthRouter } from './routes/citizen_auth.js';
import { attachSession, attachCitizenSession } from './lib/auth.js';
import { originCheck } from './lib/csrf.js';
import { startSLAWatcher } from './lib/sla.js';
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
// Hydrate req.citizen if the caller has a valid citizen-cookie. Independent
// of attachSession — both can populate the same request.
app.use(attachCitizenSession);

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

// CSRF / Origin guard for state-changing API calls. /api/whatsapp (Meta
// webhook — verified separately by HMAC) and /api/payments/webhook (Amwal
// — also signature-verified) bypass this. /api/chat is excluded because
// the citizen-side web tester posts from arbitrary localhost dev origins;
// it carries no auth-cookie that an attacker could forge.
//
// We match against req.originalUrl because mounted routers strip the
// mount prefix from req.path — `/api/payments/webhook` becomes `/webhook`
// inside the originGuard, which would defeat the bypass.
function originGuard(req, res, next) {
  const url = req.originalUrl || req.url || '';
  if (url.startsWith('/api/whatsapp/'))         return next();
  if (url.startsWith('/api/payments/webhook'))  return next();
  if (url.startsWith('/api/payments/_stub/'))   return next();
  if (url.startsWith('/api/chat/'))             return next();
  return originCheck(req, res, next);
}

// API
app.use('/api/auth', originGuard, authRouter);
app.use('/api/citizen-auth', originGuard, citizenAuthRouter);
app.use('/api/office', originGuard, officeRouter);
app.use('/api/platform-admin', originGuard, platformAdminRouter);
app.use('/api/payments', originGuard, paymentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/officer', originGuard, officerRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/debug', debugRouter);
app.use('/api/catalogue', catalogueRouter);
app.use('/api/annotator', originGuard, annotatorRouter);

// Health
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  llm: LLM_ENABLED,
  debug: DEBUG,
  whatsapp: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  test_mirror: !!(process.env.SANAD_TEST_PHONE || '').trim(),
  test_pay:    DEBUG || process.env.SANAD_TEST_PAY === 'true',
  thawani:     !!(process.env.THAWANI_SECRET_KEY && process.env.THAWANI_PUBLISHABLE_KEY),
  thawani_env: process.env.THAWANI_ENV || 'sandbox'
}));

// SPA fallback — any route not starting with /api goes to index.html
app.get(/^\/(?!api|uploads).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Boot helpers — exported so tests can drive setup without auto-listening
export async function prepare() {
  fs.mkdirSync('./data/uploads', { recursive: true });
  await migrate();

  // SANAD_FORCE_RELOAD_CATALOGUE=true triggers a one-shot wipe + re-import
  // from the canonical CSV. Used to migrate existing deployments after a
  // catalogue rebuild (e.g. sanad.om reconciliation): the persistent disk
  // would otherwise keep the OLD rows because autoImportCatalog skips when
  // the table is non-empty. Set the env var, redeploy, watch the boot log
  // confirm "[migrate] wiped N rows" and "imported M from oman_services_directory_v3.csv",
  // then UNSET the var on the next deploy so the migration doesn't re-run.
  if (process.env.SANAD_FORCE_RELOAD_CATALOGUE === 'true') {
    const { rows: before } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
    console.log(`[migrate] SANAD_FORCE_RELOAD_CATALOGUE=true — wiping ${before[0].n} existing service_catalog rows…`);
    await db.execute(`PRAGMA foreign_keys = OFF`);
    try {
      // Cascade: blow away dependent message/request_document/request rows
      // that pointed at the old IDs so the new catalogue isn't carrying
      // dangling FKs. Citizens / officers / offices are preserved.
      await db.execute(`DELETE FROM message WHERE request_id IN (SELECT id FROM request)`);
      await db.execute(`DELETE FROM request_document`);
      await db.execute(`DELETE FROM request`);
      await db.execute(`DELETE FROM service_catalog`);
      try { await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`); } catch {}
    } finally {
      await db.execute(`PRAGMA foreign_keys = ON`);
    }
    const r = await autoImportCatalog({ force: true });
    console.log(`[migrate] reload complete — imported ${r.imported} rows. UNSET SANAD_FORCE_RELOAD_CATALOGUE on next deploy.`);
  } else {
    // Normal boot: import only when the table is empty. Idempotent.
    await autoImportCatalog();
  }
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
      console.log(`\n  🇴🇲  Saned · ساند listening on http://localhost:${bound}`);
      if (info.catalogueSize === 0) {
        console.warn('⚠  service_catalog is empty — run `npm run seed` to import the CSV (optional in debug mode).');
      } else {
        console.log(`✓ service_catalog: ${info.catalogueSize} rows`);
      }
      console.log(`     • Web chat:   http://localhost:${bound}/chat.html`);
      console.log(`     • Officer:    http://localhost:${bound}/officer.html`);
      console.log(`     • Annotator:  http://localhost:${bound}/annotator.html`);
      console.log(`     • Admin:      http://localhost:${bound}/admin.html`);
      console.log(`     • Debug:      http://localhost:${bound}/api/debug/state\n`);
      if (!LLM_ENABLED) {
        console.warn('⚠  No LLM key configured — chat will use canned stub replies. Set ANTHROPIC_API_KEY or QWEN_API_KEY for real replies.');
      }
      // Kick off the office SLA watcher AFTER the server is listening so
      // the sweep doesn't fire before migrate() finishes.
      startSLAWatcher();
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
