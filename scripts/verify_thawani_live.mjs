// Verifies the live Thawani integration end-to-end through our own code:
// office → claim → payment/start → real checkout link → retrieve session.
// Does NOT pay (no money moves — a session is just a link until a card is entered).
const BASE = 'http://localhost:3030';
const stamp = Date.now();
const api = async (p, o = {}) => {
  const h = {};
  if (o.body !== undefined) h['content-type'] = 'application/json';
  if (o.cookie) h.cookie = o.cookie;
  h.referer = BASE + '/';
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: h, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const sc = r.headers.get('set-cookie') || '';
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, cookie: sc.split(';')[0] || null };
};

const email = `thaw-${stamp}@t.om`;
const su = await api('/api/auth/signup', { method: 'POST', body: {
  office_name_en: 'Thawani Verify', office_name_ar: 'تحقق ثواني',
  governorate: 'Muscat', wilayat: 'Bawshar', cr_number: 'CR' + stamp.toString().slice(-7),
  phone: '+96890' + stamp.toString().slice(-6), email, full_name: 'V', password: 'VerifyPass2026!' } });
const oid = su.json?.officer?.office?.id; let ck = su.cookie;
await api(`/api/platform-admin/office/${oid}/approve`, { method: 'POST', cookie: ck });
const lg = await api('/api/auth/login', { method: 'POST', body: { email, password: 'VerifyPass2026!' } });
ck = lg.cookie || ck;

const { db } = await import('../lib/db.js');
const svc = (await db.execute(`SELECT id FROM service_catalog WHERE name_en LIKE '%Driver%Licen%' LIMIT 1`)).rows[0]
         || (await db.execute(`SELECT id FROM service_catalog WHERE is_active=1 LIMIT 1`)).rows[0];
const cit = await db.execute({ sql: `INSERT INTO citizen(phone,name,language_pref) VALUES (?,?,'ar')`,
  args: ['+96891' + stamp.toString().slice(-6), 'محمد العامري'] });
const ins = await db.execute({
  sql: `INSERT INTO request(session_id,citizen_id,service_id,status,governorate,created_at,last_event_at)
        VALUES (?,?,?,'ready','Muscat',datetime('now'),datetime('now'))`,
  args: ['thaw-verify-' + stamp, Number(cit.lastInsertRowid), svc.id] });
const reqId = Number(ins.lastInsertRowid);

const claim = await api(`/api/officer/request/${reqId}/claim`, { method: 'POST', cookie: ck });
const pay = await api(`/api/officer/request/${reqId}/payment/start`, { method: 'POST', cookie: ck });
console.log('claim:', claim.status, '| payment/start:', pay.status, '| amount:', pay.json?.amount_omr, 'OMR');
const link = pay.json?.payment_link || '';
console.log('payment_link:', link);
console.log('real Thawani production link:', /checkout\.thawani\.om\/pay\//.test(link));

const m = link.match(/checkout\.thawani\.om\/pay\/([^?]+)/);
if (m) {
  const { retrieveThawaniSession } = await import('../features/payment-checkout/providers/thawani.js');
  const s = await retrieveThawaniSession(m[1]);
  console.log('Thawani session →', 'status=' + s.payment_status,
    '| amount=' + (s.total_amount ?? s.products?.[0]?.unit_amount) + ' baisa',
    '| customer_name=' + (s.metadata?.customer_name || '-'),
    '| customer_phone=' + (s.metadata?.customer_phone || '-'),
    '| service=' + (s.metadata?.service || '-'));
}
process.exit(0);
