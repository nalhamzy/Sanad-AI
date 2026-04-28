import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';

const url = process.env.DB_URL || 'file:./data/sanad.db';
const authToken = process.env.DB_AUTH_TOKEN || undefined;

export const db = createClient({ url, authToken });

export async function migrate() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS service_catalog (
       id INTEGER PRIMARY KEY,
       entity_en TEXT, entity_ar TEXT,
       name_en TEXT, name_ar TEXT,
       description_en TEXT, description_ar TEXT,
       fees_text TEXT,
       fee_omr REAL,
       required_documents_json TEXT,
       process_steps_json TEXT,
       is_active INTEGER DEFAULT 1,
       version INTEGER DEFAULT 1,
       source_url TEXT,
       search_blob TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_catalog_active ON service_catalog(is_active)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS service_catalog_fts USING fts5(
       name_en, name_ar, description_en, description_ar, entity_en, entity_ar,
       content='service_catalog', content_rowid='id'
     )`,

    `CREATE TABLE IF NOT EXISTS citizen (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       phone TEXT UNIQUE,
       name TEXT,
       civil_id TEXT,
       language_pref TEXT DEFAULT 'ar',
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS office (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name_en TEXT, name_ar TEXT,
       governorate TEXT,
       wilayat TEXT,
       plan TEXT DEFAULT 'pro',
       status TEXT DEFAULT 'active',
       wallet_baisa INTEGER DEFAULT 0,
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS officer (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       office_id INTEGER REFERENCES office(id),
       full_name TEXT,
       email TEXT UNIQUE,
       role TEXT DEFAULT 'officer',
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS request (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT,
       citizen_id INTEGER REFERENCES citizen(id),
       service_id INTEGER REFERENCES service_catalog(id),
       office_id INTEGER REFERENCES office(id),
       officer_id INTEGER REFERENCES officer(id),
       status TEXT DEFAULT 'collecting',
       governorate TEXT,
       state_json TEXT,
       fee_omr REAL,
       claimed_at TEXT,
       completed_at TEXT,
       last_event_at TEXT DEFAULT (datetime('now')),
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_request_status ON request(status)`,
    `CREATE INDEX IF NOT EXISTS idx_request_session ON request(session_id)`,

    `CREATE TABLE IF NOT EXISTS request_document (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_id INTEGER REFERENCES request(id),
       doc_code TEXT,
       label TEXT,
       storage_url TEXT,
       mime TEXT,
       size_bytes INTEGER,
       status TEXT DEFAULT 'pending',
       uploaded_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS message (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_id INTEGER REFERENCES request(id),
       session_id TEXT,
       direction TEXT,  -- in | out | bot
       actor_type TEXT, -- citizen | officer | bot | system
       actor_id INTEGER,
       body_text TEXT,
       media_url TEXT,
       meta_json TEXT,
       channel TEXT DEFAULT 'web', -- web | whatsapp
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_message_req ON message(request_id)`,
    `CREATE INDEX IF NOT EXISTS idx_message_sess ON message(session_id)`,

    `CREATE TABLE IF NOT EXISTS otp_window (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_id INTEGER REFERENCES request(id),
       officer_id INTEGER REFERENCES officer(id),
       expires_at TEXT,
       code TEXT,
       consumed_at TEXT,
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS session (
       id TEXT PRIMARY KEY,
       state_json TEXT,
       updated_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       actor_type TEXT, actor_id INTEGER,
       action TEXT, target_type TEXT, target_id INTEGER,
       diff_json TEXT,
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    `CREATE TABLE IF NOT EXISTS service_edit_proposal (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       service_id INTEGER REFERENCES service_catalog(id),
       proposer_office_id INTEGER,
       field TEXT,
       current_value_json TEXT,
       proposed_value_json TEXT,
       rationale TEXT,
       status TEXT DEFAULT 'open',
       created_at TEXT DEFAULT (datetime('now'))
     )`,

    // ─── Annotator system ─────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS annotator (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       email TEXT UNIQUE,
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS service_validation (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       service_id INTEGER REFERENCES service_catalog(id),
       annotator_id INTEGER REFERENCES annotator(id),
       status TEXT CHECK(status IN ('validated','needs_review','rejected')) DEFAULT 'validated',
       notes TEXT,
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_validation_service ON service_validation(service_id)`,
    `CREATE INDEX IF NOT EXISTS idx_validation_annotator ON service_validation(annotator_id)`,
    `CREATE INDEX IF NOT EXISTS idx_validation_latest ON service_validation(service_id, created_at DESC)`,

    // ─── Offer marketplace (offices quote, citizen picks) ─────
    // Two-part pricing:
    //   • office_fee_omr = what the office charges for their service (their margin)
    //   • government_fee_omr = قيمة المعاملة, the actual gov service fee the office will pay on behalf
    // Total shown to citizen = office_fee + government_fee (we keep them separate
    // so the citizen sees the breakdown and can compare offices fairly).
    `CREATE TABLE IF NOT EXISTS request_offer (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_id INTEGER NOT NULL REFERENCES request(id),
       office_id INTEGER NOT NULL REFERENCES office(id),
       officer_id INTEGER REFERENCES officer(id),
       office_fee_omr REAL NOT NULL,
       government_fee_omr REAL NOT NULL DEFAULT 0,
       quoted_fee_omr REAL NOT NULL, -- denormalized total (office + government)
       estimated_hours REAL,
       note_ar TEXT, note_en TEXT,
       status TEXT DEFAULT 'pending', -- pending|accepted|rejected|withdrawn|expired
       created_at TEXT DEFAULT (datetime('now')),
       updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(request_id, office_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_offer_request ON request_offer(request_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_offer_office   ON request_offer(office_id, status)`,

    // ─── Subscription + credits (Amwal Pay) ──────────────────
    // One row per purchased pack. Currently fixed at 35 OMR = 70 credits.
    // Status 'active' = paid, 'pending' = link created, 'failed' = gateway reject,
    // 'expired' = superseded by a new pack or cancelled.
    `CREATE TABLE IF NOT EXISTS office_subscription (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       office_id INTEGER NOT NULL REFERENCES office(id),
       plan_code TEXT NOT NULL DEFAULT 'starter-70',
       amount_omr REAL NOT NULL DEFAULT 35.0,
       credits_granted INTEGER NOT NULL DEFAULT 70,
       amwal_merchant_ref TEXT,
       amwal_order_id TEXT,
       amwal_payment_link TEXT,
       payment_status TEXT DEFAULT 'pending', -- pending|active|failed|expired
       paid_at TEXT,
       raw_webhook_json TEXT,
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sub_office ON office_subscription(office_id, payment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_ref    ON office_subscription(amwal_merchant_ref)`,

    // ─── Per-request credit ledger ───────────────────────────
    // One row each time a credit is consumed. Acts as both audit trail and
    // idempotency guard (we never charge the same request twice).
    `CREATE TABLE IF NOT EXISTS credit_ledger (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       office_id INTEGER NOT NULL REFERENCES office(id),
       request_id INTEGER REFERENCES request(id),
       subscription_id INTEGER REFERENCES office_subscription(id),
       delta INTEGER NOT NULL, -- negative for consumption, positive for grant
       reason TEXT NOT NULL,   -- 'offer_accepted'|'subscription_grant'|'admin_adjust'
       balance_after INTEGER NOT NULL,
       created_at TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_office ON credit_ledger(office_id, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_req_once
        ON credit_ledger(office_id, request_id) WHERE request_id IS NOT NULL`,

    // ─── Per-service pricing overrides ──────────────────────────
    // Each office can override its own office_fee_omr and the displayed
    // government_fee_omr for a specific service in the catalog. When absent,
    // the inbox falls back to office.default_office_fee_omr + catalog.fee_omr.
    // Officers can still override again per-request in the detail pane.
    `CREATE TABLE IF NOT EXISTS office_service_price (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       office_id  INTEGER NOT NULL REFERENCES office(id) ON DELETE CASCADE,
       service_id INTEGER NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
       office_fee_omr     REAL,   -- NULL → use office.default_office_fee_omr
       government_fee_omr REAL,   -- NULL → use service_catalog.fee_omr
       updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(office_id, service_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_osp_office ON office_service_price(office_id)`
  ];
  for (const sql of stmts) await db.execute(sql);

  // Migrate: add updated_at / last_edited_by columns to service_catalog if absent
  try {
    const { rows: cols } = await db.execute(`SELECT name FROM pragma_table_info('service_catalog')`);
    const names = new Set(cols.map(c => c.name));
    if (!names.has('updated_at')) {
      await db.execute(`ALTER TABLE service_catalog ADD COLUMN updated_at TEXT`);
    }
    if (!names.has('last_edited_by')) {
      await db.execute(`ALTER TABLE service_catalog ADD COLUMN last_edited_by INTEGER`);
    }
  } catch (e) { console.warn('annotator column check failed:', e.message); }

  // Idempotent ALTER for older DBs: add search_blob if missing
  try {
    const { rows } = await db.execute(`SELECT name FROM pragma_table_info('service_catalog') WHERE name='search_blob'`);
    if (!rows.length) {
      await db.execute(`ALTER TABLE service_catalog ADD COLUMN search_blob TEXT`);
      console.log('✓ migrated: added search_blob column');
    }
  } catch (e) { console.warn('search_blob check failed:', e.message); }

  // Idempotent ALTER: request_document — caption, matched_via, original_name,
  // verified_by, verified_at, reject_reason. These make officer review workable.
  try {
    const { rows: rdCols } = await db.execute(`SELECT name FROM pragma_table_info('request_document')`);
    const rdNames = new Set(rdCols.map(c => c.name));
    const addIfMissing = async (col, ddl) => {
      if (!rdNames.has(col)) await db.execute(`ALTER TABLE request_document ADD COLUMN ${ddl}`);
    };
    await addIfMissing('caption',       'caption TEXT');
    await addIfMissing('matched_via',   'matched_via TEXT');     // 'caption' | 'order' | 'extra'
    await addIfMissing('original_name', 'original_name TEXT');   // as uploaded by citizen
    await addIfMissing('verified_by',   'verified_by INTEGER');  // officer.id
    await addIfMissing('verified_at',   'verified_at TEXT');
    await addIfMissing('reject_reason', 'reject_reason TEXT');
    await addIfMissing('is_extra',      'is_extra INTEGER DEFAULT 0');   // 1 = supplementary, not in required list
    await addIfMissing('note',          'note TEXT');                    // free-text label for extras
  } catch (e) { console.warn('request_document migrate failed:', e.message); }

  // Idempotent ALTER: office — signup + verification columns
  try {
    const { rows: oCols } = await db.execute(`SELECT name FROM pragma_table_info('office')`);
    const oNames = new Set(oCols.map(c => c.name));
    const addOffice = async (col, ddl) => { if (!oNames.has(col)) await db.execute(`ALTER TABLE office ADD COLUMN ${ddl}`); };
    // Signup identity
    await addOffice('email',        "email TEXT");
    await addOffice('phone',        "phone TEXT");
    await addOffice('cr_number',    "cr_number TEXT"); // Commercial Registration
    // Status widened: active | pending_review | suspended | rejected
    // (old default stays 'active' for seeded rows — new signups go pending_review)
    // Reputation / ranking
    await addOffice('total_completed',     'total_completed INTEGER DEFAULT 0');
    await addOffice('avg_completion_hours','avg_completion_hours REAL');
    await addOffice('rating',              'rating REAL DEFAULT 5.0');
    await addOffice('offers_won',          'offers_won INTEGER DEFAULT 0');
    await addOffice('offers_abandoned',    'offers_abandoned INTEGER DEFAULT 0');
    await addOffice('reviewed_at',         'reviewed_at TEXT');
    await addOffice('reviewed_by',         'reviewed_by INTEGER');
    await addOffice('reject_reason',       'reject_reason TEXT');
  } catch (e) { console.warn('office migrate failed:', e.message); }

  // Idempotent ALTER: officer — password auth + status
  try {
    const { rows: ofCols } = await db.execute(`SELECT name FROM pragma_table_info('officer')`);
    const ofNames = new Set(ofCols.map(c => c.name));
    const addOfficer = async (col, ddl) => { if (!ofNames.has(col)) await db.execute(`ALTER TABLE officer ADD COLUMN ${ddl}`); };
    await addOfficer('password_hash','password_hash TEXT');
    await addOfficer('phone',        'phone TEXT');
    await addOfficer('status',       "status TEXT DEFAULT 'active'"); // active | invited | disabled
    await addOfficer('last_login_at','last_login_at TEXT');
    await addOfficer('invited_by',   'invited_by INTEGER');
  } catch (e) { console.warn('officer migrate failed:', e.message); }

  // Idempotent ALTER: request — offer & quote tracking
  try {
    const { rows: rCols } = await db.execute(`SELECT name FROM pragma_table_info('request')`);
    const rNames = new Set(rCols.map(c => c.name));
    const addReq = async (col, ddl) => { if (!rNames.has(col)) await db.execute(`ALTER TABLE request ADD COLUMN ${ddl}`); };
    await addReq('accepted_offer_id',    'accepted_offer_id INTEGER');
    await addReq('quoted_fee_omr',       'quoted_fee_omr REAL');
    await addReq('office_fee_omr',       'office_fee_omr REAL');      // denormalized on accept
    await addReq('government_fee_omr',   'government_fee_omr REAL');  // denormalized on accept
  } catch (e) { console.warn('request migrate failed:', e.message); }

  // Idempotent ALTER: request_offer — split pricing (old rows had only quoted_fee_omr).
  try {
    const { rows: oCols } = await db.execute(`SELECT name FROM pragma_table_info('request_offer')`);
    const oNames = new Set(oCols.map(c => c.name));
    const addOffer = async (col, ddl) => { if (!oNames.has(col)) await db.execute(`ALTER TABLE request_offer ADD COLUMN ${ddl}`); };
    await addOffer('office_fee_omr',     'office_fee_omr REAL');
    await addOffer('government_fee_omr', 'government_fee_omr REAL DEFAULT 0');
    // Backfill legacy rows: assume total was pure office fee (nothing better to do).
    await db.execute(`UPDATE request_offer
                         SET office_fee_omr = COALESCE(office_fee_omr, quoted_fee_omr),
                             government_fee_omr = COALESCE(government_fee_omr, 0)
                       WHERE office_fee_omr IS NULL`);
  } catch (e) { console.warn('request_offer migrate failed:', e.message); }

  // Idempotent ALTER: office — credits + subscription bookkeeping.
  try {
    const { rows: oCols } = await db.execute(`SELECT name FROM pragma_table_info('office')`);
    const oNames = new Set(oCols.map(c => c.name));
    const addOffice = async (col, ddl) => { if (!oNames.has(col)) await db.execute(`ALTER TABLE office ADD COLUMN ${ddl}`); };
    await addOffice('credits_remaining',   'credits_remaining INTEGER DEFAULT 0');
    await addOffice('credits_total_used',  'credits_total_used INTEGER DEFAULT 0');
    // Subscription snapshot: which pack funded the current balance, when it expires.
    await addOffice('subscription_status', "subscription_status TEXT DEFAULT 'none'"); // none|active|expired
    await addOffice('subscription_since',  'subscription_since TEXT');
    // Default service fee (office margin) applied when the officer clicks
    // one-click "Send quote". The office can override on a per-request basis
    // and also change this default from the settings panel. 5 OMR baseline.
    await addOffice('default_office_fee_omr', 'default_office_fee_omr REAL DEFAULT 5.0');
  } catch (e) { console.warn('office credits migrate failed:', e.message); }

  // Indexes that depend on migrated columns
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_catalog_blob ON service_catalog(search_blob)`); }
  catch (e) { /* ignore if column still missing on exotic setups */ }
  try { await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_office_email ON office(email) WHERE email IS NOT NULL`); } catch {}
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_office_status ON office(status)`); } catch {}

  // ─── Agent v2: expanded catalogue + embeddings ────────────
  // We want the full CSV surface for hybrid search, plus a vector column for
  // semantic retrieval. ALTERs are idempotent so old dbs upgrade cleanly.
  try {
    const { rows: scCols } = await db.execute(`SELECT name FROM pragma_table_info('service_catalog')`);
    const scNames = new Set(scCols.map(c => c.name));
    const addSc = async (col, ddl) => {
      if (!scNames.has(col)) await db.execute(`ALTER TABLE service_catalog ADD COLUMN ${ddl}`);
    };
    await addSc('beneficiary',           'beneficiary TEXT');
    await addSc('main_service',          'main_service TEXT');
    await addSc('entity_dept_en',        'entity_dept_en TEXT');
    await addSc('entity_dept_ar',        'entity_dept_ar TEXT');
    await addSc('special_conditions_en', 'special_conditions_en TEXT');
    await addSc('special_conditions_ar', 'special_conditions_ar TEXT');
    await addSc('payment_method',        'payment_method TEXT');
    await addSc('avg_time_en',           'avg_time_en TEXT');
    await addSc('avg_time_ar',           'avg_time_ar TEXT');
    await addSc('working_time_en',       'working_time_en TEXT');
    await addSc('working_time_ar',       'working_time_ar TEXT');
    await addSc('channels',              'channels TEXT');
    await addSc('num_steps',             'num_steps INTEGER');
    await addSc('popularity',            'popularity INTEGER DEFAULT 0');
    await addSc('is_launch',             'is_launch INTEGER DEFAULT 0');
    await addSc('embedding_json',        'embedding_json TEXT');
    await addSc('embedded_at',           'embedded_at INTEGER');
  } catch (e) { console.warn('service_catalog v2 migrate failed:', e.message); }

  // Rebuild FTS5 to cover the new columns. External-content still sources
  // everything from service_catalog.
  try {
    await db.execute(`DROP TABLE IF EXISTS service_catalog_fts`);
    await db.execute(`CREATE VIRTUAL TABLE service_catalog_fts USING fts5(
       name_en, name_ar, description_en, description_ar,
       entity_en, entity_ar, entity_dept_en, entity_dept_ar,
       beneficiary, main_service, search_blob,
       content='service_catalog', content_rowid='id'
     )`);
    // repopulate if the table already has data
    await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
  } catch (e) { console.warn('fts rebuild failed:', e.message); }

  // ─── Request v2: cancel intent tracking ──────────────────
  try {
    const { rows: rCols } = await db.execute(`SELECT name FROM pragma_table_info('request')`);
    const rNames = new Set(rCols.map(c => c.name));
    const addReq = async (col, ddl) => { if (!rNames.has(col)) await db.execute(`ALTER TABLE request ADD COLUMN ${ddl}`); };
    await addReq('cancel_requested',    'cancel_requested INTEGER DEFAULT 0');
    await addReq('cancel_reason',       'cancel_reason TEXT');
    await addReq('cancelled_at',        'cancelled_at TEXT');
  } catch (e) { console.warn('request v2 migrate failed:', e.message); }

  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_catalog_launch ON service_catalog(is_launch)`); } catch {}
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_catalog_entity ON service_catalog(entity_en)`); } catch {}
}

export async function seedDemoAnnotators() {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM annotator`);
  if (rows[0].n > 0) return;
  await db.batch([
    { sql: `INSERT INTO annotator(name,email) VALUES (?,?)`, args: ['Reem Al-Balushi', 'reem@sanad-ai.om'] },
    { sql: `INSERT INTO annotator(name,email) VALUES (?,?)`, args: ['Yousuf Al-Hinai', 'yousuf@sanad-ai.om'] },
    { sql: `INSERT INTO annotator(name,email) VALUES (?,?)`, args: ['Fatma Al-Kindi',  'fatma@sanad-ai.om'] }
  ], 'write');
}

export async function seedDemoOffices() {
  // Always (re-)ensure the demo officer credentials work. The office row may
  // already have been seeded on a previous boot (persistent disk on Render);
  // in that case the early-return below would have skipped re-seeding the
  // password. We refresh the demo officer's hash + status on every boot so
  // `khalid@nahdha.om` / `demo123` always logs in cleanly.
  const demoPwHash = bcrypt.hashSync('demo123', 10);
  try {
    const { rows: existing } = await db.execute({
      sql: `SELECT id FROM officer WHERE email='khalid@nahdha.om' LIMIT 1`
    });
    if (existing.length) {
      await db.execute({
        sql: `UPDATE officer SET password_hash=?, status='active', role='owner' WHERE email='khalid@nahdha.om'`,
        args: [demoPwHash]
      });
    } else {
      // Officer missing entirely (edge case: office row exists from a prior
      // boot but officer table got wiped or never seeded). Make sure office
      // #1 exists, then create the demo officer fresh.
      const { rows: o1 } = await db.execute(`SELECT id FROM office WHERE id=1 OR email='owner@nahdha.om' LIMIT 1`);
      const officeId = o1[0]?.id || 1;
      await db.execute({
        sql: `INSERT INTO officer(office_id,full_name,email,role,status,password_hash)
              VALUES (?,?,?,?,?,?)`,
        args: [officeId, 'Khalid Al-Harthy', 'khalid@nahdha.om', 'owner', 'active', demoPwHash]
      }).catch(e => console.warn('[seedDemoOffices] officer insert skipped:', e.message));
    }
    // Same for the other two demo officers.
    await db.execute({
      sql: `UPDATE officer SET password_hash=?, status='active' WHERE email IN ('noor@nahdha.om','hassan@seeb.om') AND password_hash IS NOT NULL`,
      args: [demoPwHash]
    });
  } catch (e) {
    console.warn('[seedDemoOffices] demo password refresh skipped:', e.message);
  }

  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM office`);
  if (rows[0].n > 0) return;
  // The first office is "ready to use": active subscription, 999 credits, approved,
  // owner has a known password ("demo123"). This lets DEBUG_MODE testers sign in
  // right away at /office-login.html without having to go through signup+approval.
  // (demoPwHash already declared above)
  await db.batch([
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat,email,phone,cr_number,
              status,credits_remaining,subscription_status,subscription_since,rating,total_completed,default_office_fee_omr)
            VALUES (?,?,?,?,?,?,?, 'active', 999, 'active', datetime('now'), 4.9, 42, 5.0)`,
      args: ['Sanad Al-Nahdha','مكتب سند النهضة','Muscat','Bawshar',
             'owner@nahdha.om','+96890000001','CR-1000001'] },
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat,email,phone,cr_number,
              status,rating,total_completed)
            VALUES (?,?,?,?,?,?,?, 'active', 4.6, 18)`,
      args: ['Sanad Seeb','مكتب سند السيب','Muscat','Seeb',
             'owner@seeb.om','+96890000002','CR-1000002'] },
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat,email,phone,cr_number,
              status,rating,total_completed)
            VALUES (?,?,?,?,?,?,?, 'active', 4.3, 9)`,
      args: ['Sanad Muttrah','مكتب سند مطرح','Muscat','Muttrah',
             'owner@muttrah.om','+96890000003','CR-1000003'] }
  ], 'write');
  // Record a paid subscription for office #1 so the ledger/history looks coherent.
  await db.execute({
    sql: `INSERT INTO office_subscription(office_id, plan_code, amount_omr, credits_granted,
            amwal_merchant_ref, amwal_order_id, payment_status, paid_at)
          VALUES (1, 'starter-70', 35.0, 70, 'seed-demo-001', 'seed-demo-001', 'active', datetime('now'))`,
    args: []
  });
  await db.batch([
    { sql: `INSERT INTO officer(office_id,full_name,email,role,status,password_hash)
            VALUES (1,'Khalid Al-Harthy','khalid@nahdha.om','owner','active',?)`,
      args: [demoPwHash] },
    { sql: `INSERT INTO officer(office_id,full_name,email,role,status,password_hash)
            VALUES (1,'Noor Al-Amri','noor@nahdha.om','manager','active',?)`,
      args: [demoPwHash] },
    { sql: `INSERT INTO officer(office_id,full_name,email,role,status,password_hash)
            VALUES (2,'Hassan Al-Zadjali','hassan@seeb.om','officer','active',?)`,
      args: [demoPwHash] }
  ], 'write');
}

// ─── Auto-import service catalogue CSV ────────────────────────
// The canonical service directory lives in ./oman_services_directory.csv.
// npm run seed runs this imperatively; we also call it from prepare() so a
// fresh DB is immediately browsable in the annotator dashboard. Idempotent:
// skips entirely if the table already has rows.
//
// If oman_services_directory_v2.csv exists (built by scripts/merge_catalog.mjs
// from the master + the six ministry scrapes), prefer it. Path is resolved
// inside autoImportCatalog() so a freshly written v2 is picked up on next call.
const CSV_V1 = './oman_services_directory.csv';
const CSV_V2 = './oman_services_directory_v2.csv';

function _splitDocs(txt) {
  if (!txt) return [];
  return txt
    .split(/\s+\.\s+|•|·|;|—|\r?\n/g)
    .map(s => s.replace(/^[\-\s,]+|[\-\s,]+$/g, '').trim())
    .filter(s => s.length >= 2 && s.length < 200);
}
function _parseFee(en, ar) {
  const s = (en || ar || '').toLowerCase();
  if (/no fees?|free|لا يوجد/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(omr|ريال)/);
  return m ? Number(m[1]) : null;
}
function _slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function _searchBlob(svc) {
  // Enriched blob: includes every field the LLM might filter on so FTS +
  // LIKE searches hit all the right rows.
  return [
    svc.name_en, svc.name_ar,
    svc.entity_en, svc.entity_ar,
    svc.entity_dept_en, svc.entity_dept_ar,
    svc.beneficiary, svc.main_service,
    svc.description_en, svc.description_ar,
    svc.special_conditions_en, svc.special_conditions_ar,
    svc.fees_text, svc.payment_method, svc.channels
  ].filter(Boolean).join(' ').toLowerCase();
}

// Parse the CSV's ProcessSteps field. Source format example:
//   "[1] Submit application — Fill e-form (Time: 5 min) || [2] Review — …"
// We split on "||" first, then try to peel off the numeric prefix.
function _parseProcessSteps(en, ar) {
  const split = (raw) => (raw || '')
    .split(/\s*\|\|\s*/g)
    .map(s => s.trim())
    .filter(Boolean);
  const enParts = split(en);
  const arParts = split(ar);
  const total = Math.max(enParts.length, arParts.length);
  const steps = [];
  for (let i = 0; i < total; i++) {
    const rawEn = enParts[i] || '';
    const rawAr = arParts[i] || '';
    const nMatch = rawEn.match(/^\[(\d+)\]\s*/) || rawAr.match(/^\[(\d+)\]\s*/);
    const n = nMatch ? Number(nMatch[1]) : i + 1;
    steps.push({
      n,
      en: rawEn.replace(/^\[\d+\]\s*/, '').trim(),
      ar: rawAr.replace(/^\[\d+\]\s*/, '').trim()
    });
  }
  return steps;
}

// Normalize channel strings like "الموقع الإلكتروني، التطبيق، الكاونتر" or
// "website, app, counter" into a tidy comma list of lowercase tokens.
function _normalizeChannels(en, ar) {
  const merged = [(en || ''), (ar || '')].join(' , ').toLowerCase();
  const tokens = new Set();
  const add = (tok) => { if (tok) tokens.add(tok); };
  if (/web\s?site|website|الموقع|الكتروني|إلكتروني/.test(merged)) add('web');
  if (/app|تطبيق/.test(merged)) add('app');
  if (/kiosk|كشك/.test(merged)) add('kiosk');
  if (/counter|كاونتر|مركز خدمة|مكتب/.test(merged)) add('counter');
  if (/phone|call|هاتف|اتصال/.test(merged)) add('phone');
  if (/email|بريد/.test(merged)) add('email');
  return [...tokens].join(',');
}

// The 5 curated launch flows from lib/catalogue.js. Matched by name keywords
// against the catalogue so is_launch=1 gets set on the right real rows.
const LAUNCH_MATCHERS = [
  { code: 'civil_id_renewal',        needle: /civil.*id.*renew|renew.*civil.*id|بطاق.*مدن.*تجدي|تجدي.*بطاق.*مدن/i },
  { code: 'passport_renewal',        needle: /renew.*passport|passport.*renew|تجدي.*جواز/i },
  { code: 'drivers_licence_renewal', needle: /(driving|driver).*licen.*renew|renew.*(driving|driver).*licen|تجدي.*رخص.*(قياد|سياق)/i },
  { code: 'mulkiya_renewal',         needle: /mulkiya.*renew|renew.*(vehicle|car).*registration|تجدي.*ملكي|ملكي.*مركب/i },
  { code: 'cr_issuance',             needle: /commercial.*registration.*(issue|issuance|new)|(issue|new).*commercial.*registration|سجل.*تجاري.*(إصدار|اصدار|جديد)/i }
];
function _matchLaunchCode(name_en, name_ar) {
  const hay = `${name_en || ''} ${name_ar || ''}`;
  for (const m of LAUNCH_MATCHERS) if (m.needle.test(hay)) return m.code;
  return null;
}

export async function autoImportCatalog({ force = false } = {}) {
  const CSV_PATH = fs.existsSync(CSV_V2) ? CSV_V2 : CSV_V1;
  if (!fs.existsSync(CSV_PATH)) {
    console.warn(`⚠  ${CSV_PATH} not found — skipping catalogue import`);
    return { imported: 0, skipped: true };
  }
  if (!force) {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM service_catalog`);
    if (rows[0].n > 1) return { imported: 0, alreadyPopulated: rows[0].n };
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const parsed = parse(raw, {
    columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true
  });
  console.log(`• importing ${parsed.length} services from ${CSV_PATH}…`);

  let imported = 0, launchTagged = 0;
  for (const r of parsed) {
    const id = Number(r.ServiceID);
    if (!id) continue;

    const docsEn = _splitDocs(r.RequiredDocumentsEn);
    const docsList = docsEn.map(d => ({
      code: _slug(d).slice(0, 40), label_en: d, label_ar: '', accept: ['image', 'pdf']
    }));
    const fee = _parseFee(r.FeesEn, r.FeesAr);
    const steps = _parseProcessSteps(r.ProcessStepsEn, r.ProcessStepsAr);
    const channels = _normalizeChannels(r.Channels, r.Channels);

    const payload = {
      name_en: (r.ServiceNameEn || '').trim(),
      name_ar: (r.ServiceNameAr || '').trim(),
      entity_en: (r.EntityEn || '').trim(),
      entity_ar: (r.EntityAr || '').trim(),
      entity_dept_en: (r.EntityDepartmentEn || '').trim(),
      entity_dept_ar: (r.EntityDepartmentAr || '').trim(),
      beneficiary: (r.Beneficiary || '').trim().slice(0, 200),
      main_service: (r.MainService || '').trim().slice(0, 200),
      description_en: (r.DescriptionEn || '').trim().slice(0, 1000),
      description_ar: (r.DescriptionAr || '').trim().slice(0, 1000),
      special_conditions_en: (r.SpecialConditionsEn || '').trim().slice(0, 500),
      special_conditions_ar: (r.SpecialConditionsAr || '').trim().slice(0, 500),
      fees_text: (r.FeesEn || '').trim().slice(0, 200),
      payment_method: (r.PaymentMethod || '').trim().slice(0, 60),
      avg_time_en: (r.AvgTimeTakenEn || '').trim().slice(0, 120),
      avg_time_ar: (r.AvgTimeTakenAr || '').trim().slice(0, 120),
      working_time_en: (r.WorkingTimeEn || '').trim().slice(0, 120),
      working_time_ar: (r.WorkingTimeAr || '').trim().slice(0, 120),
      channels
    };
    const launchCode = _matchLaunchCode(payload.name_en, payload.name_ar);
    const isLaunch = launchCode ? 1 : 0;
    if (isLaunch) launchTagged++;

    const numSteps = Number(r.NumSteps) || steps.length || 0;

    await db.execute({
      sql: `INSERT OR REPLACE INTO service_catalog
             (id, entity_en, entity_ar, name_en, name_ar,
              entity_dept_en, entity_dept_ar, beneficiary, main_service,
              description_en, description_ar,
              special_conditions_en, special_conditions_ar,
              fees_text, fee_omr, payment_method,
              avg_time_en, avg_time_ar, working_time_en, working_time_ar,
              channels, num_steps,
              required_documents_json, process_steps_json,
              is_active, version, source_url, search_blob,
              is_launch, embedding_json, embedded_at)
             VALUES (?,?,?,?,?, ?,?,?,?, ?,?, ?,?, ?,?,?,
                     ?,?,?,?, ?,?,
                     ?,?, 1,1,?,?, ?, NULL, NULL)`,
      args: [
        id, payload.entity_en, payload.entity_ar, payload.name_en, payload.name_ar,
        payload.entity_dept_en, payload.entity_dept_ar, payload.beneficiary, payload.main_service,
        payload.description_en, payload.description_ar,
        payload.special_conditions_en, payload.special_conditions_ar,
        payload.fees_text, fee, payload.payment_method,
        payload.avg_time_en, payload.avg_time_ar, payload.working_time_en, payload.working_time_ar,
        payload.channels, numSteps,
        JSON.stringify(docsList), JSON.stringify(steps),
        (r.ServiceURL || '').trim(), _searchBlob(payload),
        isLaunch
      ]
    });
    imported++;
  }

  // Rebuild FTS so annotator search finds everything.
  try {
    await db.execute(`INSERT INTO service_catalog_fts(service_catalog_fts) VALUES('rebuild')`);
  } catch (e) { console.warn('FTS rebuild failed:', e.message); }
  console.log(`✓ imported ${imported} services (auto) — ${launchTagged} tagged as launch`);
  return { imported, launchTagged };
}

// ─── Dummy citizen requests (DEBUG_MODE only) ─────────────────
// Populates a varied set of 'ready' requests so the officer marketplace looks
// realistic. Matches each dummy to an actual service row from the catalogue
// (after autoImportCatalog has run) so the service name, fee, and required
// documents are all real.
export async function seedDemoRequests() {
  if (process.env.DEBUG_MODE !== 'true') return;
  const { rows: reqCount } = await db.execute(`SELECT COUNT(*) AS n FROM request`);
  if (reqCount[0].n > 0) return;

  // Look up a real catalogue row. Tries each keyword in order; for each, it
  // prefers services whose name CONTAINS an additional "must_have" term (e.g.
  // renew/renewal) when supplied, so we don't match "Report Lost Passport"
  // when the scenario is passport renewal.
  const pickService = async (keywords, { mustHave = [], entityLike = null, preferredFee = null } = {}) => {
    const mhClause = mustHave.length
      ? ' AND (' + mustHave.map(() => '(name_en LIKE ? OR name_ar LIKE ?)').join(' OR ') + ')'
      : '';
    const mhArgs = mustHave.flatMap(m => [`%${m}%`, `%${m}%`]);
    const entityClause = entityLike ? ' AND entity_en LIKE ?' : '';
    const entityArgs = entityLike ? [`%${entityLike}%`] : [];
    for (const kw of keywords) {
      const { rows } = await db.execute({
        sql: `SELECT id, name_en, name_ar, entity_en, fee_omr, required_documents_json
                FROM service_catalog
               WHERE is_active=1 AND (name_en LIKE ? OR name_ar LIKE ?)
                 ${mhClause} ${entityClause}
               ORDER BY
                 CASE WHEN fee_omr IS NOT NULL THEN 0 ELSE 1 END,
                 LENGTH(name_en) ASC
               LIMIT 1`,
        args: [`%${kw}%`, `%${kw}%`, ...mhArgs, ...entityArgs]
      });
      if (rows[0]) return { ...rows[0], fee_omr: rows[0].fee_omr ?? preferredFee ?? 10 };
    }
    // Loosen: drop mustHave constraint.
    if (mustHave.length) {
      for (const kw of keywords) {
        const { rows } = await db.execute({
          sql: `SELECT id, name_en, name_ar, entity_en, fee_omr, required_documents_json
                  FROM service_catalog
                 WHERE is_active=1 AND (name_en LIKE ? OR name_ar LIKE ?) ${entityClause}
                 ORDER BY LENGTH(name_en) ASC LIMIT 1`,
          args: [`%${kw}%`, `%${kw}%`, ...entityArgs]
        });
        if (rows[0]) return { ...rows[0], fee_omr: rows[0].fee_omr ?? preferredFee ?? 10 };
      }
    }
    const { rows } = await db.execute(`SELECT id, name_en, name_ar, entity_en, fee_omr, required_documents_json
                                         FROM service_catalog WHERE is_active=1 LIMIT 1`);
    return rows[0] ? { ...rows[0], fee_omr: rows[0].fee_omr ?? preferredFee ?? 10 } : null;
  };

  // Realistic mix spanning several ministries. Keywords are tuned so the
  // fuzzy match lands on the most appropriate real catalogue row.
  const scenarios = [
    {
      citizen: { name: 'Ahmed Al-Hinai', phone: '+96899000101' },
      session: 'demo-sess-001',
      service_keywords: ['Omani Card/Renewal', 'Card/Renewal', 'ID card', 'Civil Card'],
      service_opts: { mustHave: ['Renew'], entityLike: 'Royal Oman Police' },
      governorate: 'Muscat',
      docs: [
        { label: 'Expired Civil ID (front)', mime: 'image/jpeg' },
        { label: 'Expired Civil ID (back)',  mime: 'image/jpeg' }
      ],
      msg_ar: 'السلام عليكم، بطاقتي الشخصية منتهية. أريد تجديدها بأسرع وقت.'
    },
    {
      citizen: { name: 'Mariam Al-Balushi', phone: '+96899000102' },
      session: 'demo-sess-002',
      service_keywords: ['RENEW PASSPORT', 'Renew Passport', 'Passport'],
      service_opts: { mustHave: ['Renew', 'RENEW'], entityLike: 'Royal Oman Police' },
      governorate: 'Muscat',
      docs: [
        { label: 'Current passport (bio page)', mime: 'application/pdf' },
        { label: 'Civil ID',                    mime: 'image/jpeg' },
        { label: 'Passport photo',              mime: 'image/png' }
      ],
      msg_ar: 'أحتاج تجديد جواز سفري قبل السفر الشهر القادم. مرفق المستندات.'
    },
    {
      citizen: { name: 'Saif Al-Raisi', phone: '+96899000103' },
      session: 'demo-sess-003',
      service_keywords: ['Driving License', 'Driving Licence'],
      service_opts: { mustHave: ['Renew'], entityLike: 'Royal Oman Police' },
      governorate: 'Muscat',
      docs: [
        { label: 'Driving licence (expired)', mime: 'image/jpeg' },
        { label: 'Civil ID',                  mime: 'image/jpeg' },
        { label: 'Eye test report',           mime: 'application/pdf' }
      ],
      msg_ar: 'رخصتي انتهت. أبغى تجديدها، المستندات جاهزة.'
    },
    {
      citizen: { name: 'Fatma Al-Zadjali', phone: '+96899000104' },
      session: 'demo-sess-004',
      service_keywords: ['Birth Certificate'],
      service_opts: { mustHave: ['Issuance', 'Issue'] },
      governorate: 'Muscat',
      docs: [
        { label: 'Hospital birth notification', mime: 'application/pdf' },
        { label: 'Parents\' Civil IDs',         mime: 'image/jpeg' },
        { label: 'Marriage certificate',        mime: 'application/pdf' }
      ],
      msg_ar: 'رزقنا الله بمولود جديد، أحتاج استخراج شهادة الميلاد.'
    },
    {
      citizen: { name: 'Khalid Al-Rawahi', phone: '+96899000105' },
      session: 'demo-sess-005',
      service_keywords: ['Commercial Registration'],
      service_opts: { mustHave: ['New', 'Issuance'] },
      governorate: 'Dhofar',
      docs: [
        { label: 'Owner Civil ID',           mime: 'image/jpeg' },
        { label: 'Trade name approval',      mime: 'application/pdf' },
        { label: 'Lease contract',           mime: 'application/pdf' }
      ],
      msg_ar: 'أبغى أفتح سجل تجاري لمحل جديد في صلالة. جاهز المستندات.'
    },
    {
      citizen: { name: 'Noor Al-Kindi', phone: '+96899000106' },
      session: 'demo-sess-006',
      service_keywords: ['Work Permit', 'Labour Card'],
      service_opts: { mustHave: ['New', 'Issue', 'Issuance'], entityLike: 'Labour' },
      governorate: 'Muscat',
      docs: [
        { label: 'Employer letter',       mime: 'application/pdf' },
        { label: 'Employee passport',     mime: 'application/pdf' },
        { label: 'Employee photo',        mime: 'image/png' }
      ],
      msg_ar: 'عندي موظف جديد، أحتاج تصريح عمل له.'
    },
    {
      citizen: { name: 'Yousuf Al-Amri', phone: '+96899000107' },
      session: 'demo-sess-007',
      service_keywords: ['Transfer of Vehicle', 'Vehicle Ownership', 'Ownership of Vehicle'],
      service_opts: { entityLike: 'Royal Oman Police' },
      governorate: 'Muscat',
      docs: [
        { label: 'Vehicle mulkia',          mime: 'image/jpeg' },
        { label: 'Seller Civil ID',         mime: 'image/jpeg' },
        { label: 'Buyer Civil ID',          mime: 'image/jpeg' },
        { label: 'Insurance certificate',   mime: 'application/pdf' }
      ],
      msg_ar: 'اشتريت سيارة مستعملة، أبغى نقل الملكية باسمي.'
    },
    {
      citizen: { name: 'Hassan Al-Siyabi', phone: '+96899000108' },
      session: 'demo-sess-008',
      service_keywords: ['Register Marriage Event', 'Marriage Event', 'register marriage'],
      service_opts: {},
      governorate: 'Muscat',
      docs: [
        { label: 'Groom Civil ID', mime: 'image/jpeg' },
        { label: 'Bride Civil ID', mime: 'image/jpeg' },
        { label: 'Medical test report', mime: 'application/pdf' }
      ],
      msg_ar: 'أنا عازم على الزواج الشهر القادم، أبغى توثيق عقد الزواج.'
    }
  ];

  let seeded = 0;
  for (const s of scenarios) {
    const svc = await pickService(s.service_keywords, s.service_opts || {});
    if (!svc) continue; // catalogue totally empty — bail silently
    const cIns = await db.execute({
      sql: `INSERT INTO citizen(phone,name,language_pref) VALUES (?,?,'ar')`,
      args: [s.citizen.phone, s.citizen.name]
    });
    const citizenId = Number(cIns.lastInsertRowid);
    const rIns = await db.execute({
      sql: `INSERT INTO request(session_id,citizen_id,service_id,status,governorate,fee_omr,last_event_at)
            VALUES (?,?,?,'ready',?,?,datetime('now'))`,
      args: [s.session, citizenId, svc.id, s.governorate, svc.fee_omr]
    });
    const requestId = Number(rIns.lastInsertRowid);
    // Use the catalogue's canonical document list when available; fall back to
    // the scenario's hand-crafted labels otherwise.
    let docs = [];
    try {
      const catalog = JSON.parse(svc.required_documents_json || '[]');
      if (Array.isArray(catalog) && catalog.length) {
        docs = catalog.slice(0, 4).map(d => ({
          label: d.label_en || d.label_ar || d.code || 'Document',
          mime: 'image/jpeg'
        }));
      }
    } catch {}
    if (!docs.length) docs = s.docs;
    for (const d of docs) {
      await db.execute({
        sql: `INSERT INTO request_document(request_id,doc_code,label,storage_url,mime,size_bytes,status)
              VALUES (?,?,?,?,?,?, 'pending')`,
        args: [requestId, d.label.toLowerCase().replace(/\s+/g,'_').slice(0,40),
               d.label, '/uploads/demo/placeholder.jpg', d.mime, 120000]
      });
    }
    await db.execute({
      sql: `INSERT INTO message(request_id,session_id,direction,actor_type,body_text,channel)
            VALUES (?,?,'in','citizen',?, 'web')`,
      args: [requestId, s.session, s.msg_ar]
    });
    seeded++;
  }
  console.log(`✓ seeded ${seeded} realistic demo requests (DEBUG_MODE)`);
}
