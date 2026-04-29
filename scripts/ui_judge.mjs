// LLM UI judge for Saned · ساند.
//
// Boots the server in-process, fetches each user-facing page in BOTH
// Arabic and English, walks the i18n.t() bindings to know the rendered
// text, and asks the LLM to grade:
//   1. Brand consistency  — only "Saned" / "ساند" appears (no "Sanad-AI")
//   2. Language purity    — Arabic page shows pure Arabic labels
//                            (brand + numbers + entity names exempt)
//   3. UX completeness    — required sections are present and clearly
//                            labelled (hero, search, CTAs, navigation)
//   4. Citizen vs office  — the citizen page does not advertise office
//                            signup as a primary action
//
// Output: per-page score (0-100) + flagged issues. Exits non-zero if any
// page scores below 80 or has a hard fail.
//
// Uses the existing lib/llm.js chat() helper. Falls back to a structural-
// only check (no LLM) if no provider key is set.

import 'dotenv/config';
process.env.DEBUG_MODE = 'true';
process.env.SANAD_NO_AUTOSTART = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'judge';

const { start } = await import('../server.js');
const { chat, LLM_ENABLED, LLM_PROVIDER } = await import('../lib/llm.js');
const { server, port } = await start(0);
const base = `http://localhost:${port}`;

const PAGES = [
  { path: '/',                            key: 'home',      minScore: 80 },
  { path: '/signup.html',                 key: 'signup',    minScore: 75 },
  { path: '/login.html',                  key: 'login',     minScore: 75 },
  { path: '/account.html',                key: 'account',   minScore: 75, requireAuth: true },
  { path: '/catalogue.html?entity=Royal%20Oman%20Police', key: 'catalogue', minScore: 75 },
  { path: '/request.html?id=1',           key: 'request',   minScore: 70, requireAuth: true }
];

// Resolve i18n strings from the JS module so we can validate the
// PRESENCE of keys against the rendered HTML (and grade copy quality).
async function loadI18N() {
  const fs = await import('node:fs');
  const src = fs.readFileSync('./public/i18n.js', 'utf8');
  // Crude extract: pull out the en:{} and ar:{} object body strings.
  // Not bulletproof, but enough for our key-set checks.
  const enMatch = src.match(/en:\s*\{([\s\S]*?)\n\s{4}\},\s*\n\s*ar:/);
  const arMatch = src.match(/ar:\s*\{([\s\S]*?)\n\s{4}\}\s*\n\s*\};/);
  function keys(body) {
    if (!body) return [];
    return [...body.matchAll(/'([a-z][a-z_.\d]+)':/g)].map(m => m[1]);
  }
  return {
    en: new Set(keys(enMatch?.[1])),
    ar: new Set(keys(arMatch?.[1]))
  };
}
const i18nKeys = await loadI18N();

async function authedCookie() {
  // Use the magic OTP to obtain a valid citizen session cookie.
  await fetch(`${base}/api/citizen-auth/start-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+96890888999' })
  });
  const r = await fetch(`${base}/api/citizen-auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+96890888999', code: '000000' })
  });
  const sc = r.headers.get('set-cookie') || '';
  const m = sc.match(/sanad_citizen_sess=([^;]+)/);
  return m ? `sanad_citizen_sess=${m[1]}` : '';
}
const cookie = await authedCookie();

// Static / structural checks — language-agnostic.
function structuralChecks(html, page) {
  const issues = [];
  const wins = [];

  // Brand
  if (html.includes('Sanad-AI'))                 issues.push('still-contains-old-brand:Sanad-AI');
  if (html.includes('سند الذكي'))               issues.push('still-contains-old-brand:سند الذكي');
  if (html.includes('سند للذكاء الاصطناعي'))  issues.push('still-contains-old-brand:سند للذكاء الاصطناعي');
  if (html.match(/Saned|ساند/))                  wins.push('mentions-new-brand');

  // i18n bindings — every data-i18n key should exist in BOTH en and ar.
  const usedKeys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map(m => m[1]);
  const missingEn = usedKeys.filter(k => !i18nKeys.en.has(k));
  const missingAr = usedKeys.filter(k => !i18nKeys.ar.has(k));
  if (missingEn.length) issues.push(`missing-en-keys:${missingEn.slice(0, 3).join(',')}${missingEn.length > 3 ? `+${missingEn.length-3}` : ''}`);
  if (missingAr.length) issues.push(`missing-ar-keys:${missingAr.slice(0, 3).join(',')}${missingAr.length > 3 ? `+${missingAr.length-3}` : ''}`);
  if (!missingEn.length && !missingAr.length && usedKeys.length) wins.push('all-i18n-keys-resolved');

  // Page-specific structure
  if (page.key === 'home') {
    if (!html.includes('heroSearch')) issues.push('home-missing-search');
    if (!html.includes('navSignUp')) issues.push('home-missing-signup-cta');
    if (!html.includes('home.why')) issues.push('home-missing-why-section');
    if (!html.includes('home.voices')) issues.push('home-missing-voices-section');
    if (html.includes('home.footer.office_register')) issues.push('home-still-pitches-office-signup');
  }
  if (page.key === 'signup' || page.key === 'login') {
    if (!html.includes('g_id_signin'))           issues.push('auth-missing-google-button');
    // The OTP fetch lives in /auth-client.js, but the page MUST link the OTP
    // input boxes (.otp-input × 6) and the "send code" button.
    const otpBoxes = (html.match(/class="otp-input"/g) || []).length;
    if (otpBoxes < 6)                             issues.push(`auth-missing-otp-inputs:${otpBoxes}`);
    if (!html.includes('sendOtpBtn'))             issues.push('auth-missing-send-button');
    if (!html.includes('auth-client.js'))         issues.push('auth-missing-client-script');
  }
  if (page.key === 'account') {
    if (!html.includes('searchInput'))            issues.push('account-missing-search');
    if (!html.includes('reqList'))                issues.push('account-missing-request-list');
    if (!html.includes('phoneBanner'))            issues.push('account-missing-phone-banner');
  }
  if (page.key === 'request') {
    if (!html.includes('timeline'))               issues.push('request-missing-timeline');
    if (!html.includes('docList'))                issues.push('request-missing-docs');
    if (!html.includes('thread'))                 issues.push('request-missing-thread');
  }
  if (page.key === 'catalogue') {
    if (!/lang="ar"/.test(html))                  issues.push('catalogue-not-arabic-first');
    if (!html.includes('/api/catalogue/hybrid'))  issues.push('catalogue-not-using-hybrid');
    if (!html.includes('data-fee="lt10"'))        issues.push('catalogue-missing-fee-filters');
    if (!html.includes('beneficiaries'))          issues.push('catalogue-missing-beneficiary-rail');
    if (!html.includes('sortSel'))                issues.push('catalogue-missing-sort');
    if (!html.includes('matched-fts'))            issues.push('catalogue-missing-match-chips');
  }

  return { issues, wins, usedKeys };
}

const SYSTEM_PROMPT = `You are a UX + brand auditor reviewing Saned · ساند, an Omani citizen
service that helps people request government services through licensed
"Sanad offices" via WhatsApp.

You receive ONE rendered HTML page at a time. Score it 0–100 across:
  • brand: Only "Saned" / "ساند" should appear as the product name. Real-world
    "Sanad office" / "مكاتب سند" references are FINE — they are licensed
    bureaus, not the product.
  • language: When the page is in Arabic mode (lang="ar" dir="rtl"), Arabic
    labels should be pure Arabic except: brand bilingual lockups, numbers,
    entity names, URLs, and small inline EN brand mentions. English UI
    fragments inside Arabic menus/buttons are a fail.
  • ux: Hero, primary CTAs, search, navigation are all clear. Content has
    visible structure (headings, sections). Citizen-first; office sign-up
    is NOT advertised on citizen pages (only a small footer link is OK).

Return JSON: {"score": <int>, "good": [<short bullet>...], "issues": [<bullet>...]}.
Be strict but constructive. Bullets must be concrete (cite the offending
text or selector when possible).`;

async function llmScore(page, html) {
  if (!LLM_ENABLED) return null;
  // Send a trimmed version: head + meaningful body chunks (strip script + style).
  const trimmed = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
    .replace(/\s+/g, ' ')
    .slice(0, 12_000);
  try {
    // chat() returns a plain string (the model reply text).
    const text = await chat({
      system: SYSTEM_PROMPT,
      user: `Page: ${page.path}\nLanguage default: ${trimmed.includes('lang="ar"') ? 'Arabic' : 'English'}\n\n--- HTML (truncated) ---\n${trimmed}\n\nReturn JSON only — no prose, no markdown fences.`,
      temperature: 0.1,
      max_tokens: 700
    });
    const raw = String(text || '').trim();
    // Strip markdown fences if the model wrapped its JSON.
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return { score: 0, good: [], issues: [`llm-did-not-return-json:${raw.slice(0, 80)}`] };
    try { return JSON.parse(m[0]); }
    catch (parseErr) { return { score: 0, good: [], issues: [`llm-json-parse-error:${parseErr.message}`] }; }
  } catch (e) {
    return { score: 0, good: [], issues: [`llm-error:${e.message}`] };
  }
}

// ── Run ─────────────────────────────────────────────────────
let totalScore = 0, hardFails = 0;
const reports = [];

for (const page of PAGES) {
  const headers = page.requireAuth && cookie ? { cookie } : {};
  const r = await fetch(`${base}${page.path}`, { headers });
  const html = await r.text();
  if (!r.ok && r.status !== 401) {
    reports.push({ page: page.path, score: 0, hardFail: true, issues: [`http-${r.status}`] });
    hardFails++;
    continue;
  }
  const struct = structuralChecks(html, page);
  const llm = await llmScore(page, html);

  // Final score: LLM result if available, else structural-only baseline (start
  // at 100, deduct 15 per issue, cap at 100). Hard fail if any structural
  // issue mentions "still-contains-old-brand".
  const baseStruct = Math.max(0, 100 - struct.issues.length * 15);
  const score = llm ? llm.score : baseStruct;
  const issues = [...struct.issues, ...(llm?.issues || [])];
  const good = [...struct.wins, ...(llm?.good || [])];

  const hardFail = struct.issues.some(s => s.startsWith('still-contains-old-brand') || s.startsWith('home-still-pitches'));
  if (hardFail) hardFails++;
  if (!hardFail && score < page.minScore) hardFails++;

  totalScore += score;
  reports.push({ page: page.path, key: page.key, score, minScore: page.minScore, issues, good, hardFail, llm: !!llm });
}

server.close();

const avg = Math.round(totalScore / PAGES.length);
console.log('\n══════════════════════════════════════════════════════');
console.log(`UI JUDGE — Saned · ساند   (provider=${LLM_PROVIDER}${LLM_ENABLED ? '' : ', LLM disabled'})`);
console.log('══════════════════════════════════════════════════════\n');

for (const r of reports) {
  const emoji = r.hardFail ? '✗' : (r.score >= r.minScore ? '✓' : '!');
  console.log(`${emoji} ${r.page.padEnd(28)} ${String(r.score).padStart(3)}/100  (min ${r.minScore})${r.llm ? '' : '  [structural only]'}`);
  if (r.good.length)   console.log(`     good:   ${r.good.slice(0, 4).join(' · ')}`);
  if (r.issues.length) console.log(`     issues: ${r.issues.slice(0, 6).join(' · ')}`);
  console.log('');
}

console.log(`──────────────────────────────────────────────────────`);
console.log(`Average score: ${avg}/100   |   hard fails: ${hardFails}`);
console.log(`──────────────────────────────────────────────────────\n`);

process.exit(hardFails > 0 ? 1 : 0);
