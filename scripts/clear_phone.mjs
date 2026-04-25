// One-shot: wipe all data for a given phone number.
// Usage: node scripts/clear_phone.mjs +96892888715
import { db } from '../lib/db.js';
const PHONE = process.argv[2];
if (!PHONE) { console.error('usage: node scripts/clear_phone.mjs +968XXXXXXXX'); process.exit(1); }
const variants = [PHONE, PHONE.replace(/^\+/, ''), PHONE.replace(/^\+?968/, '')];

const cit = await db.execute({
  sql: `SELECT id, phone FROM citizen WHERE phone IN (${variants.map(()=>'?').join(',')})`,
  args: variants
});
const ids = cit.rows.map(r => r.id);
console.log('citizens matched:', cit.rows);

const waSessions = variants.map(v => `wa:${v}`);
let extra = [];
if (ids.length) {
  const r = await db.execute({
    sql: `SELECT DISTINCT session_id FROM request WHERE citizen_id IN (${ids.map(()=>'?').join(',')})`,
    args: ids
  });
  extra = r.rows.map(x => x.session_id).filter(Boolean);
}
const allSessions = Array.from(new Set([...waSessions, ...extra]));
console.log('sessions to delete:', allSessions);

const counts = { request_documents: 0, offers: 0, requests: 0, messages: 0, sessions: 0, citizens: 0 };

if (allSessions.length) {
  const ph = allSessions.map(()=>'?').join(',');
  const reqs = await db.execute({ sql: `SELECT id FROM request WHERE session_id IN (${ph})`, args: allSessions });
  const reqIds = reqs.rows.map(r => r.id);
  if (reqIds.length) {
    const rp = reqIds.map(()=>'?').join(',');
    counts.request_documents = (await db.execute({ sql: `DELETE FROM request_document WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0;
    try { counts.offers = (await db.execute({ sql: `DELETE FROM offer WHERE request_id IN (${rp})`, args: reqIds })).rowsAffected || 0; } catch {}
    counts.requests = (await db.execute({ sql: `DELETE FROM request WHERE id IN (${rp})`, args: reqIds })).rowsAffected || 0;
  }
  counts.messages = (await db.execute({ sql: `DELETE FROM message WHERE session_id IN (${ph})`, args: allSessions })).rowsAffected || 0;
  counts.sessions = (await db.execute({ sql: `DELETE FROM session WHERE id IN (${ph})`, args: allSessions })).rowsAffected || 0;
}
if (ids.length) {
  counts.citizens = (await db.execute({ sql: `DELETE FROM citizen WHERE id IN (${ids.map(()=>'?').join(',')})`, args: ids })).rowsAffected || 0;
}
console.log('deleted:', counts);
process.exit(0);
