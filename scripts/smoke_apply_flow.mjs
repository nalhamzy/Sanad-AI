// Smoke test for the new form-based apply flow.
//
// Boots the server in-process, signs in a citizen via magic OTP, picks a
// real service from the catalogue, posts a multipart application with 2
// files mapped to required slots + 1 extra, and verifies:
//   • POST /api/chat/apply returns 200 + request_id + missing_required_slots
//   • request row inserted at status='ready' with correct service_id
//   • 3 request_document rows (2 with matched_via='upload', is_extra=0;
//                              1 with is_extra=1)
//   • state_json carries source='web_form' + missing_required_slots
//   • a system message rows in 'message' table summarising the submission
//   • /api/chat/my-request/:id (citizen-side) returns the request with docs
//   • the form-only /apply.html serves with the required UI plumbing
//
// Auth + phone rules:
//   • POST /apply requires a verified phone — magic-OTP verify-otp produces
//     citizen.phone_verified_at, so the requireCitizen({requirePhone:true})
//     guard passes.
//   • An unauthenticated POST returns 401.

import 'dotenv/config';
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';

const { start } = await import('../server.js');
const { db } = await import('../lib/db.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;
console.log(`[apply-smoke] server on ${port}`);

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
}
function getCookie(res, name) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(new RegExp(`(${name}=[^;]+)`));
  return m ? m[1] : '';
}

try {
  // ── 1) Find a service that has a structured required-docs list ─
  const { rows: candidates } = await db.execute({
    sql: `SELECT id, name_en, required_documents_json
            FROM service_catalog
           WHERE is_active = 1
             AND COALESCE(required_documents_json, '') NOT IN ('', '[]', 'null')
           LIMIT 1`
  });
  ok('catalogue has a service with required docs', !!candidates[0]);
  const svc = candidates[0];
  const requiredDocs = JSON.parse(svc.required_documents_json);
  ok('required_documents_json parses to a non-empty array',
     Array.isArray(requiredDocs) && requiredDocs.length >= 1, `len=${requiredDocs.length}`);
  const slot1 = requiredDocs[0]?.code;
  ok('first slot has a code', !!slot1, JSON.stringify(requiredDocs[0]));

  // ── 2) Unauthenticated POST → 401 ──────────────────────
  let r = await fetch(`${base}/api/chat/apply`, {
    method: 'POST',
    body: new FormData()  // empty multipart
  });
  ok('POST /apply without cookie → 401', r.status === 401, `status=${r.status}`);

  // ── 3) Sign in citizen via magic OTP ───────────────────
  const phone = '+96890710001';
  r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000' })
  });
  const me = await r.json();
  ok('citizen signed in via magic OTP', r.status === 200 && me.ok, JSON.stringify(me));
  const cookie = getCookie(r, 'sanad_citizen_sess');
  ok('cookie set', !!cookie);

  // ── 4) Empty multipart with no files → 400 no_files ───
  r = await fetch(`${base}/api/chat/apply`, {
    method: 'POST',
    headers: { cookie },
    body: (() => { const fd = new FormData(); fd.set('service_id', String(svc.id)); return fd; })()
  });
  let d = await r.json();
  ok('POST /apply without files returns 400 no_files',
     r.status === 400 && d.error === 'no_files', JSON.stringify(d));

  // ── 5) Bad service_id → 404 ────────────────────────────
  r = await fetch(`${base}/api/chat/apply`, {
    method: 'POST',
    headers: { cookie },
    body: (() => {
      const fd = new FormData();
      fd.set('service_id', '99999999');
      fd.append('files', new Blob(['fake'], { type: 'image/png' }), 'a.png');
      fd.append('slot_codes', '');
      fd.append('labels', '');
      fd.append('is_extra', '1');
      return fd;
    })()
  });
  d = await r.json();
  ok('POST /apply with bad service_id → 404', r.status === 404 && d.error === 'service_not_found', JSON.stringify(d));

  // ── 6) Happy path: 2 files for slot1 + 1 extra ─────────
  const fd = new FormData();
  fd.set('service_id', String(svc.id));
  fd.set('notes', 'Audit smoke test — two documents for the first slot, plus one extra.');

  // First file → required slot1
  fd.append('files', new Blob(['front-of-card-bytes'], { type: 'image/jpeg' }), 'civil-id-front.jpg');
  fd.append('slot_codes', slot1);
  fd.append('labels', '');
  fd.append('is_extra', '0');

  // Second file → same required slot1 (multi-file per slot)
  fd.append('files', new Blob(['back-of-card-bytes'], { type: 'image/jpeg' }), 'civil-id-back.jpg');
  fd.append('slot_codes', slot1);
  fd.append('labels', '');
  fd.append('is_extra', '0');

  // Third file → extra
  fd.append('files', new Blob(['extra-pdf-bytes'], { type: 'application/pdf' }), 'noc.pdf');
  fd.append('slot_codes', '');
  fd.append('labels', 'No-Objection Certificate');
  fd.append('is_extra', '1');

  r = await fetch(`${base}/api/chat/apply`, {
    method: 'POST', headers: { cookie }, body: fd
  });
  d = await r.json();
  ok('POST /apply (3 files) returns 200 + request_id',
     r.status === 200 && d.ok && Number.isFinite(d.request_id), JSON.stringify(d).slice(0, 240));
  const reqId = d.request_id;
  ok('files_recorded === 3', d.files_recorded === 3);
  ok('missing_required_slots is an array',
     Array.isArray(d.missing_required_slots));
  ok('session_id starts with "citizen-"',
     typeof d.session_id === 'string' && d.session_id.startsWith('citizen-'));

  // ── 7) Verify the request row ──────────────────────────
  const { rows: reqRows } = await db.execute({
    sql: `SELECT status, service_id, citizen_id, state_json FROM request WHERE id=?`,
    args: [reqId]
  });
  ok('request row inserted', !!reqRows[0]);
  ok('status=ready', reqRows[0]?.status === 'ready');
  ok('service_id matches', reqRows[0]?.service_id === svc.id);
  let stateJson = {};
  try { stateJson = JSON.parse(reqRows[0]?.state_json || '{}'); } catch {}
  ok('state_json.source === "web_form"', stateJson.source === 'web_form');
  ok('state_json.missing_required_slots is array',
     Array.isArray(stateJson.missing_required_slots));
  ok('state_json.notes preserved',
     typeof stateJson.notes === 'string' && stateJson.notes.includes('Audit smoke'));

  // ── 8) Verify request_document rows ────────────────────
  const { rows: docRows } = await db.execute({
    sql: `SELECT doc_code, status, original_name, mime, is_extra, matched_via
            FROM request_document WHERE request_id=? ORDER BY id ASC`,
    args: [reqId]
  });
  ok('3 request_document rows inserted', docRows.length === 3, `got ${docRows.length}`);
  ok('first 2 have is_extra=0',
     (docRows[0]?.is_extra === 0 || docRows[0]?.is_extra === false || docRows[0]?.is_extra === 0n) &&
     (docRows[1]?.is_extra === 0 || docRows[1]?.is_extra === false || docRows[1]?.is_extra === 0n));
  ok('third has is_extra=1',
     docRows[2]?.is_extra === 1 || docRows[2]?.is_extra === true || docRows[2]?.is_extra === 1n);
  ok('all rows status=pending', docRows.every(r => r.status === 'pending'));
  ok('all rows matched_via=upload', docRows.every(r => r.matched_via === 'upload'));
  ok('original_name preserved on all rows', docRows.every(r => !!r.original_name));

  // ── 9) System message inserted in `message` table ──────
  const { rows: msgs } = await db.execute({
    sql: `SELECT actor_type, body_text FROM message
           WHERE request_id=? AND actor_type='system' LIMIT 1`,
    args: [reqId]
  });
  ok('system message inserted', msgs.length === 1);
  ok('system message references file count',
     msgs[0]?.body_text?.includes('3') && (msgs[0].body_text.includes('ملف') || msgs[0].body_text.includes('file')));

  // ── 10) Citizen-side detail endpoint reflects all of it ─
  r = await fetch(`${base}/api/chat/my-request/${reqId}`, { headers: { cookie } });
  d = await r.json();
  ok('/my-request/:id returns 200', r.status === 200);
  ok('/my-request returns 3 documents', d.documents?.length === 3);
  ok('/my-request returns the system message',
     d.messages?.some(m => m.actor_type === 'system'));

  // ── 11) Static page checks: /apply.html and rewritten /account.html ─
  const apply = await fetch(`${base}/apply.html`).then(r => r.text());
  ok('/apply.html serves Arabic-first',
     /lang="ar"/.test(apply) && /dir="rtl"/.test(apply));
  ok('/apply.html posts to /api/chat/apply',
     apply.includes("'/api/chat/apply'"));
  ok('/apply.html has "Add another file" button + slot dot indicators',
     apply.includes('apply.docs.add_file') && apply.includes('slot-dot'));
  ok('/apply.html has WhatsApp disclosure (apply.wa.title)',
     apply.includes('apply.wa.title'));
  ok('/apply.html has missing-docs warning panel',
     apply.includes('apply.missing.title'));
  ok('/apply.html ministry-vision footer',
     apply.includes('footer.ministry_vision'));

  const account = await fetch(`${base}/account.html`).then(r => r.text());
  ok('/account.html uses hybrid endpoint, not legacy /catalogue/search',
     account.includes('/api/catalogue/hybrid') && !/\/api\/catalogue\/search\?/.test(account));
  // The match-chip color classes (matched-fts/semantic/partial) now live in
  // /theme.css; the page references the base class via inline JS template.
  ok('/account.html renders match-chips (matched-chip + matched-${t} JS template)',
     account.includes('matched-chip') && /matched-\$\{[^}]+\}/.test(account));
  const themeCss = await fetch(`${base}/theme.css`).then(r => r.text());
  ok('/theme.css defines matched-fts + matched-semantic + matched-partial',
     themeCss.includes('matched-fts') && themeCss.includes('matched-semantic') && themeCss.includes('matched-partial'));
  ok('/account.html has filter rail (entity + beneficiary + sort)',
     account.includes('id="entities"') && account.includes('id="beneficiaries"') && account.includes('id="sortSel"'));
  ok('/account.html has fee-pill filters', account.includes('data-fee="lt10"'));
  ok('/account.html result cards link to /apply.html (NOT /chat.html)',
     account.includes('/apply.html?service=') && !/href="\/chat\.html\?service=/.test(account));
  ok('/account.html has WhatsApp disclosure (contact.wa.title)',
     account.includes('contact.wa.title'));
  ok('/account.html has mini-timeline class', account.includes('mini-tl'));
  ok('/account.html has ministry-vision footer',
     account.includes('footer.ministry_vision'));
  ok('/account.html drops the old "category grid"',
     !account.includes('account.categories.h2'));

  // ── Routing-fix regressions (the bugs the user reported) ──
  // Homepage hero / spotlight + catalogue modal must NEVER route applies
  // to /chat.html — they go to /apply.html (form) or /catalogue.html.
  const indexHtml = await fetch(`${base}/`).then(r => r.text());
  ok('index.html hero search routes results to /apply.html?service=',
     /href="\/apply\.html\?service=/.test(indexHtml));
  ok('index.html hero search does NOT route to /chat.html?q=',
     !/href="\/chat\.html\?q=/.test(indexHtml));
  ok('index.html spotlight cards route to /catalogue.html (not /chat.html)',
     /href="\/catalogue\.html\?q=civil\+id"/.test(indexHtml) &&
     !/href="\/chat\.html\?q=civil\+id"/.test(indexHtml));

  // catHtml + ac are loaded here (smoke_apply_flow doesn't have them yet
  // unlike smoke_citizen_auth which fetches them earlier).
  const catHtmlFa = await fetch(`${base}/catalogue.html`).then(r => r.text());
  ok('catalogue.html modal Apply CTA goes to /apply.html, not /chat.html',
     catHtmlFa.includes('/apply.html?service=${s.id}') ||
     catHtmlFa.includes('apply.html?service=${s.id}'));
  ok('catalogue.html modal does NOT use /chat.html?service=',
     !/\/chat\.html\?service=\$\{[^}]+\}/.test(catHtmlFa));

  // ── Catalogue URL-param hydration (?q= now pre-fills the search) ──
  ok('catalogue.html hydrates state.q from URL params',
     catHtmlFa.includes("_urlParams.get('q')") || catHtmlFa.includes("urlParams.get('q')"));
  ok('catalogue.html reflects state.q in the search input on boot',
     catHtmlFa.includes("if (state.q) { qInput.value = state.q;"));

  // ── auth-client.js honors ?next= for round-trip after sign-in ──
  const acFa = await fetch(`${base}/auth-client.js`).then(r => r.text());
  ok('auth-client.js carries NEXT_URL fallback to /account.html',
     acFa.includes('NEXT_URL') && acFa.includes('resolveNextUrl'));
  ok('auth-client.js redirects to NEXT_URL post-OTP (not hardcoded /account.html)',
     /window\.location\.href\s*=\s*NEXT_URL/.test(acFa));

  // ── Slot-dot CSS collision regression — must be .is-empty/.is-filled ──
  ok('apply.html uses .is-empty / .is-filled (not .empty / .filled)',
     apply.includes("'is-filled'") && apply.includes("'is-empty'") &&
     !apply.includes(".classList.toggle('empty'") &&
     !apply.includes(".classList.toggle('filled'"));

  // ── Account greeting doesn't double-render the phone ──
  ok('account.html greeting prefers name over phone, falls back to welcome_back',
     account.includes('account.welcome_back'));

} catch (e) {
  fail++;
  console.error('✗ test threw:', e);
} finally {
  server.close();
  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
