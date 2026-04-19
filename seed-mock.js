// Inserts a realistic set of mock data for demoing the officer dashboard:
// • 5 citizens  • 9 requests across all statuses  • docs + transcripts
// Idempotent-ish: clears mock rows on each run so you can re-run freely.

import 'dotenv/config';
import { db, migrate, seedDemoOffices } from './lib/db.js';
import { LAUNCH_SERVICES } from './lib/catalogue.js';

const MOCK_TAG = 'mock:';

async function clearMock() {
  // delete mock sessions / requests and everything that cascades by FK-in-app
  const { rows: reqs } = await db.execute(`SELECT id FROM request WHERE session_id LIKE '${MOCK_TAG}%'`);
  for (const r of reqs) {
    await db.execute({ sql: `DELETE FROM request_document WHERE request_id=?`, args: [r.id] });
    await db.execute({ sql: `DELETE FROM message WHERE request_id=?`, args: [r.id] });
    await db.execute({ sql: `DELETE FROM otp_window WHERE request_id=?`, args: [r.id] });
  }
  await db.execute(`DELETE FROM message WHERE session_id LIKE '${MOCK_TAG}%'`);
  await db.execute(`DELETE FROM request WHERE session_id LIKE '${MOCK_TAG}%'`);
  await db.execute(`DELETE FROM session WHERE id LIKE '${MOCK_TAG}%'`);
  await db.execute(`DELETE FROM citizen WHERE phone LIKE '+968%' AND name IS NOT NULL`);
}

async function ensureService(code) {
  const s = LAUNCH_SERVICES[code];
  const { rows } = await db.execute({ sql: `SELECT id FROM service_catalog WHERE name_en=? LIMIT 1`, args: [s.name_en] });
  if (rows.length) return { id: rows[0].id, svc: s };
  const r = await db.execute({
    sql: `INSERT INTO service_catalog(entity_en,entity_ar,name_en,name_ar,fee_omr,required_documents_json,is_active)
          VALUES (?,?,?,?,?,?,1)`,
    args: [s.entity_en, s.entity_ar, s.name_en, s.name_ar, s.fee_omr, JSON.stringify(s.required_documents)]
  });
  return { id: Number(r.lastInsertRowid), svc: s };
}

async function createCitizen(phone, name, civil_id) {
  const { rows } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
  if (rows.length) {
    await db.execute({ sql: `UPDATE citizen SET name=?, civil_id=? WHERE id=?`, args: [name, civil_id, rows[0].id] });
    return rows[0].id;
  }
  const r = await db.execute({
    sql: `INSERT INTO citizen(phone,name,civil_id,language_pref) VALUES (?,?,?,?)`,
    args: [phone, name, civil_id, 'ar']
  });
  return Number(r.lastInsertRowid);
}

async function createRequest({ session_id, citizen_id, service_id, svc, status, office_id=null, officer_id=null, ago_minutes=0, fee_override=null }) {
  const now = `datetime('now','-${ago_minutes} minutes')`;
  const r = await db.execute({
    sql: `INSERT INTO request(session_id,citizen_id,service_id,office_id,officer_id,status,governorate,fee_omr,
                              state_json,claimed_at,completed_at,last_event_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,${status!=='ready'?now:'NULL'},${status==='completed'?now:'NULL'},${now},${now})`,
    args: [session_id, citizen_id, service_id, office_id, officer_id, status, 'Muscat',
           fee_override ?? svc.fee_omr,
           JSON.stringify({ status:'queued', service_code:null, collected:{}, request_id:null })]
  });
  const id = Number(r.lastInsertRowid);
  // docs
  for (const d of svc.required_documents) {
    await db.execute({
      sql: `INSERT INTO request_document(request_id,doc_code,label,storage_url,mime,size_bytes,status)
            VALUES (?,?,?,?,?,?,'pending')`,
      args: [id, d.code, d.label_en, placeholderUrl(d.code), 'image/jpeg', 184_000]
    });
  }
  return id;
}

function placeholderUrl(code) {
  // inline SVG placeholders so the officer dashboard shows *something* for each doc.
  const color = { civil_id:'#0e7c86', medical:'#126e3d', photo:'#8a1a2b', old_passport:'#c9a227', mulkiya:'#0b656e', insurance:'#3b82f6', activity_list:'#7c3aed', tenancy:'#ec4899', address_map:'#059669', old_id_photo:'#f97316' }[code] || '#334155';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='260'>
    <rect width='400' height='260' fill='${color}' opacity='.15'/>
    <rect x='12' y='12' width='376' height='236' fill='none' stroke='${color}' stroke-width='3' stroke-dasharray='6 4'/>
    <text x='200' y='120' font-family='Inter,sans-serif' font-size='20' font-weight='700' text-anchor='middle' fill='${color}'>${code.toUpperCase()}</text>
    <text x='200' y='150' font-family='Inter,sans-serif' font-size='12' text-anchor='middle' fill='${color}' opacity='.7'>mock document</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

async function addMsg(req_id, session_id, actor_type, body_text, direction, minutes_ago=0) {
  await db.execute({
    sql: `INSERT INTO message(request_id,session_id,direction,actor_type,body_text,channel,created_at)
          VALUES (?,?,?,?,?,?,datetime('now','-${minutes_ago} minutes'))`,
    args: [req_id, session_id, direction, actor_type, body_text, 'web']
  });
}

async function transcript(req_id, session_id, svc, { claimed_by=null, completed=false, minutes_offset=0 } = {}) {
  // Simulates the bot collection flow so the officer has something to scroll through
  const o = minutes_offset;
  const serviceAr = svc.name_ar;
  await addMsg(req_id, session_id, 'citizen', 'مرحبا', 'in', o+18);
  await addMsg(req_id, session_id, 'bot', `مرحبا! أنا مساعد سند. كيف أقدر أساعدك؟`, 'out', o+18);
  await addMsg(req_id, session_id, 'citizen', `أحتاج ${serviceAr}`, 'in', o+17);
  await addMsg(req_id, session_id, 'bot', `تمام — ${serviceAr}. الرسوم المتوقعة: ${svc.fee_omr.toFixed(3)} ريال. نبدأ؟`, 'out', o+17);
  await addMsg(req_id, session_id, 'citizen', 'نعم', 'in', o+16);
  for (let i = 0; i < svc.required_documents.length; i++) {
    const d = svc.required_documents[i];
    await addMsg(req_id, session_id, 'bot', `ابعث: ${d.label_ar}`, 'out', o+15-i*2);
    await addMsg(req_id, session_id, 'citizen', `📎 ${d.code}.jpg`, 'in', o+14-i*2);
    await addMsg(req_id, session_id, 'bot', `✅ استلمنا ${d.label_ar}.`, 'out', o+14-i*2);
  }
  await addMsg(req_id, session_id, 'citizen', 'تأكيد', 'in', o+5);
  await addMsg(req_id, session_id, 'bot', `تم إرسال طلبك رقم #R-${req_id}. في انتظار أحد مكاتب سند.`, 'out', o+5);

  if (claimed_by) {
    await addMsg(req_id, session_id, 'system', `مرحبا، معك ${claimed_by} من مكتب سند. سأبدأ المعاملة.`, 'out', o+3);
    await addMsg(req_id, session_id, 'citizen', 'شكراً', 'in', o+2);
    await addMsg(req_id, session_id, 'officer', 'سأحتاج رمز OTP قريباً', 'out', o+2);
  }
  if (completed) {
    await addMsg(req_id, session_id, 'bot', '📲 أرسل رمز التحقق', 'out', o+1);
    await addMsg(req_id, session_id, 'citizen', '482917', 'in', o+1);
    await addMsg(req_id, session_id, 'bot', '✅ تم إنجاز معاملتك! شكراً لاستخدامك سند.', 'out', o);
  }
}

async function main() {
  await migrate();
  await seedDemoOffices();
  await clearMock();
  console.log('✓ cleared previous mock data');

  // Services
  const licence = await ensureService('drivers_licence_renewal');
  const civilId = await ensureService('civil_id_renewal');
  const passport = await ensureService('passport_renewal');
  const mulkiya = await ensureService('mulkiya_renewal');
  const cr = await ensureService('cr_issuance');
  console.log('✓ ensured 5 launch services');

  // Citizens
  const aisha = await createCitizen('+96872411234', 'Aisha Al-Habsi', '98741234');
  const saif = await createCitizen('+96899123456', 'Saif Al-Maamari', '76129812');
  const moh = await createCitizen('+96895762100', 'Mohammed Al-Kindi', '88276105');
  const noura = await createCitizen('+96894210987', 'Noura Al-Balushi', '98421099');
  const fatma = await createCitizen('+96877654321', 'Fatma Al-Said', '66543210');
  console.log('✓ 5 citizens');

  // 3 READY (marketplace)
  const r1 = await createRequest({ session_id: `${MOCK_TAG}aisha-1`, citizen_id: aisha, service_id: licence.id, svc: licence.svc, status: 'ready', ago_minutes: 3 });
  await transcript(r1, `${MOCK_TAG}aisha-1`, licence.svc);

  const r2 = await createRequest({ session_id: `${MOCK_TAG}saif-1`,  citizen_id: saif,  service_id: civilId.id, svc: civilId.svc, status: 'ready', ago_minutes: 8 });
  await transcript(r2, `${MOCK_TAG}saif-1`, civilId.svc);

  const r3 = await createRequest({ session_id: `${MOCK_TAG}moh-1`,   citizen_id: moh,   service_id: cr.id,      svc: cr.svc,      status: 'ready', ago_minutes: 12, fee_override: 18.0 });
  await transcript(r3, `${MOCK_TAG}moh-1`, cr.svc);

  // 2 CLAIMED by Khalid (officer 1, office 1)
  const r4 = await createRequest({ session_id: `${MOCK_TAG}noura-1`, citizen_id: noura, service_id: passport.id, svc: passport.svc, status: 'claimed', office_id: 1, officer_id: 1, ago_minutes: 22 });
  await transcript(r4, `${MOCK_TAG}noura-1`, passport.svc, { claimed_by: 'Khalid Al-Harthy' });

  const r5 = await createRequest({ session_id: `${MOCK_TAG}fatma-1`, citizen_id: fatma, service_id: mulkiya.id, svc: mulkiya.svc, status: 'in_progress', office_id: 1, officer_id: 1, ago_minutes: 35 });
  await transcript(r5, `${MOCK_TAG}fatma-1`, mulkiya.svc, { claimed_by: 'Khalid Al-Harthy' });

  // 1 CLAIMED by Noor (officer 2, office 1)
  const r6 = await createRequest({ session_id: `${MOCK_TAG}aisha-2`, citizen_id: aisha, service_id: mulkiya.id, svc: mulkiya.svc, status: 'claimed', office_id: 1, officer_id: 2, ago_minutes: 14 });
  await transcript(r6, `${MOCK_TAG}aisha-2`, mulkiya.svc, { claimed_by: 'Noor Al-Amri' });

  // 1 CLAIMED by Hassan (officer 3, office 2 - Seeb)
  const r7 = await createRequest({ session_id: `${MOCK_TAG}moh-2`, citizen_id: moh, service_id: licence.id, svc: licence.svc, status: 'claimed', office_id: 2, officer_id: 3, ago_minutes: 6 });
  await transcript(r7, `${MOCK_TAG}moh-2`, licence.svc, { claimed_by: 'Hassan Al-Zadjali' });

  // 2 COMPLETED by Khalid earlier today
  const r8 = await createRequest({ session_id: `${MOCK_TAG}saif-2`, citizen_id: saif, service_id: licence.id, svc: licence.svc, status: 'completed', office_id: 1, officer_id: 1, ago_minutes: 120 });
  await transcript(r8, `${MOCK_TAG}saif-2`, licence.svc, { claimed_by: 'Khalid Al-Harthy', completed: true });

  const r9 = await createRequest({ session_id: `${MOCK_TAG}noura-2`, citizen_id: noura, service_id: civilId.id, svc: civilId.svc, status: 'completed', office_id: 1, officer_id: 1, ago_minutes: 240 });
  await transcript(r9, `${MOCK_TAG}noura-2`, civilId.svc, { claimed_by: 'Khalid Al-Harthy', completed: true });

  // mark some documents verified so it looks like real work
  await db.execute(`UPDATE request_document SET status='verified' WHERE request_id IN (${r4},${r5},${r6},${r7},${r8},${r9})`);

  // Counts
  const c = await db.execute(`SELECT status, COUNT(*) AS n FROM request GROUP BY status`);
  console.log('\n✓ requests created:');
  for (const row of c.rows) console.log(`   ${row.status.padEnd(14)} ${row.n}`);
  console.log('\n✓ mock data ready — start the server (`npm start`) and open /officer.html');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
