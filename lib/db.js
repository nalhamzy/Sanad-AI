import { createClient } from '@libsql/client';
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
     )`
  ];
  for (const sql of stmts) await db.execute(sql);

  // Idempotent ALTER for older DBs: add search_blob if missing
  try {
    const { rows } = await db.execute(`SELECT name FROM pragma_table_info('service_catalog') WHERE name='search_blob'`);
    if (!rows.length) {
      await db.execute(`ALTER TABLE service_catalog ADD COLUMN search_blob TEXT`);
      console.log('✓ migrated: added search_blob column');
    }
  } catch (e) { console.warn('search_blob check failed:', e.message); }

  // Indexes that depend on migrated columns
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_catalog_blob ON service_catalog(search_blob)`); }
  catch (e) { /* ignore if column still missing on exotic setups */ }
}

export async function seedDemoOffices() {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM office`);
  if (rows[0].n > 0) return;
  await db.batch([
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat) VALUES (?,?,?,?)`, args: ['Sanad Al-Nahdha','مكتب سند النهضة','Muscat','Bawshar'] },
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat) VALUES (?,?,?,?)`, args: ['Sanad Seeb','مكتب سند السيب','Muscat','Seeb'] },
    { sql: `INSERT INTO office(name_en,name_ar,governorate,wilayat) VALUES (?,?,?,?)`, args: ['Sanad Muttrah','مكتب سند مطرح','Muscat','Muttrah'] }
  ], 'write');
  await db.batch([
    { sql: `INSERT INTO officer(office_id,full_name,email,role) VALUES (1,'Khalid Al-Harthy','khalid@nahdha.om','owner')`, args: [] },
    { sql: `INSERT INTO officer(office_id,full_name,email,role) VALUES (1,'Noor Al-Amri','noor@nahdha.om','manager')`, args: [] },
    { sql: `INSERT INTO officer(office_id,full_name,email,role) VALUES (2,'Hassan Al-Zadjali','hassan@seeb.om','officer')`, args: [] }
  ], 'write');
}
