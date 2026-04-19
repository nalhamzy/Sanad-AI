// ────────────────────────────────────────────────────────────
// Catalogue + intelligent search pipeline.
//
// Pipeline (highest-confidence → lowest):
//   1. Launch-service phrase keyword match (for the 5 supported flows)
//   2. Multi-stage normalized search on `search_blob`:
//        a) AND-match on all content tokens (strict)
//        b) AND-match on longest content token + any other
//        c) Permissive OR fallback
//   3. Post-ranking by token-hit count (rare tokens matter more)
//   4. Optional LLM rerank when QWEN_API_KEY is set
// ────────────────────────────────────────────────────────────

import { db } from './db.js';
import { chat, LLM_ENABLED } from './llm.js';

// ─── Launch services (hand-curated flows) ───────────────────
export const LAUNCH_SERVICES = {
  'drivers_licence_renewal': {
    match_keywords: ['driving licence','driving license','driver licence','driver license','renew licence','renew license','رخصة قيادة','رخصة سياقة','رخصة السياقة','تجديد رخصة القيادة'],
    entity_en: 'Royal Oman Police', entity_ar: 'شرطة عمان السلطانية',
    name_en: "Driver's licence renewal", name_ar: 'تجديد رخصة القيادة',
    fee_omr: 5.5,
    required_documents: [
      { code:'civil_id', label_en:'Civil ID (front + back)', label_ar:'البطاقة المدنية' },
      { code:'medical',  label_en:'Medical fitness form',    label_ar:'الفحص الطبي' },
      { code:'photo',    label_en:'Personal photo (white background)', label_ar:'صورة شخصية' }
    ]
  },
  'civil_id_renewal': {
    match_keywords: ['civil id','renew id','بطاقة مدنية','تجديد البطاقة المدنية'],
    entity_en:'Civil Status Directorate', entity_ar:'دائرة الأحوال المدنية',
    name_en:'Civil ID renewal', name_ar:'تجديد البطاقة المدنية',
    fee_omr: 3.0,
    required_documents: [
      { code:'old_id_photo', label_en:'Photo of existing Civil ID', label_ar:'صورة البطاقة الحالية' },
      { code:'photo',        label_en:'Personal photo',             label_ar:'صورة شخصية' }
    ]
  },
  'passport_renewal': {
    match_keywords: ['renew passport','passport renewal','تجديد جواز','تجديد الجواز'],
    entity_en:'Royal Oman Police', entity_ar:'شرطة عمان السلطانية',
    name_en:'Passport renewal', name_ar:'تجديد جواز السفر',
    fee_omr: 20.0,
    required_documents: [
      { code:'civil_id',    label_en:'Civil ID',          label_ar:'البطاقة المدنية' },
      { code:'old_passport',label_en:'Current passport',  label_ar:'الجواز الحالي' },
      { code:'photo',       label_en:'Personal photo',    label_ar:'صورة شخصية' }
    ]
  },
  'mulkiya_renewal': {
    match_keywords: ['mulkiya','vehicle registration','car registration','ملكية','تجديد الملكية'],
    entity_en:'Royal Oman Police', entity_ar:'شرطة عمان السلطانية',
    name_en:'Vehicle registration (Mulkiya) renewal', name_ar:'تجديد ملكية المركبة',
    fee_omr: 12.5,
    required_documents: [
      { code:'mulkiya',   label_en:'Current Mulkiya card', label_ar:'الملكية الحالية' },
      { code:'insurance', label_en:'Valid insurance policy', label_ar:'بوليصة التأمين' },
      { code:'civil_id',  label_en:'Civil ID', label_ar:'البطاقة المدنية' }
    ]
  },
  'cr_issuance': {
    match_keywords: ['commercial registration','cr issuance','سجل تجاري','تسجيل تجاري'],
    entity_en:'MOCIIP', entity_ar:'وزارة التجارة والصناعة',
    name_en:'Commercial registration issuance', name_ar:'إصدار سجل تجاري',
    fee_omr: 18.0,
    required_documents: [
      { code:'civil_id',     label_en:'Civil ID of owner', label_ar:'بطاقة مدنية للمالك' },
      { code:'activity_list',label_en:'List of business activities', label_ar:'قائمة الأنشطة' },
      { code:'tenancy',      label_en:'Tenancy contract', label_ar:'عقد الإيجار' },
      { code:'address_map',  label_en:'Location map', label_ar:'خريطة الموقع' }
    ]
  }
};

// ─── Text normalization (AR + EN) ───────────────────────────

const AR_STOP = new Set(['من','الى','إلى','في','على','و','ال','او','أو','ما','هذا','هذه','ذلك','تلك','عن','كل','بعد','قبل','مع','هل','اي','أي','الي','إلي','كما','عند','لدى']);
const EN_STOP = new Set(['the','a','an','of','for','to','in','on','and','or','is','are','was','were','be','been','by','with','from','at','as','this','that','these','those','it','its','into','some','any','can','will','do','does','did','how','what','when','where','why','who','i','you','we','my','your','our','me','us','about','please','there','have','has','had']);
// These are meaningful but VERY common in gov-services — we keep them in queries
// but DE-WEIGHT them when scoring.
const LOW_WEIGHT = new Set([
  'طلب','تجديد','إصدار','اصدار','خدمة','الخدمة','ترخيص','تصريح','رخصة',
  'renew','new','issue','issuance','service','permit','license','licence',
  'request','application','apply','form','get','how','much'
]);

export function normalize(s) {
  if (!s) return '';
  let x = s.toLowerCase().trim();
  // Arabic: strip tashkeel, unify alef/yaa/taa-marbuta/hamza variants
  x = x.replace(/[\u064B-\u0652\u0670]/g, '');
  x = x.replace(/[إأآٱ]/g, 'ا');
  x = x.replace(/ى/g, 'ي');
  x = x.replace(/ة/g, 'ه');
  x = x.replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  // English: drop punctuation, collapse whitespace
  x = x.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return x;
}

function tokenize(normText, minLen = 2) {
  return normText.split(/\s+/).filter(w => w.length >= minLen);
}

function isStopword(tok) { return AR_STOP.has(tok) || EN_STOP.has(tok); }
function isLowWeight(tok) { return LOW_WEIGHT.has(tok); }

function buildSearchBlob(row) {
  return normalize([
    row.name_en, row.name_ar,
    row.description_en, row.description_ar,
    row.entity_en, row.entity_ar,
    row.fees_text, row.required_documents_json
  ].filter(Boolean).join(' '));
}

// ─── Ensure search_blob is populated (lazy migration) ───────
let _blobsReady = false;
async function ensureSearchBlobs() {
  if (_blobsReady) return;
  const { rows } = await db.execute(`SELECT id, name_en, name_ar, description_en, description_ar, entity_en, entity_ar, fees_text, required_documents_json FROM service_catalog WHERE search_blob IS NULL OR search_blob=''`);
  if (rows.length) {
    console.log(`[catalogue] backfilling search_blob for ${rows.length} rows…`);
    for (const r of rows) {
      const blob = buildSearchBlob(r);
      await db.execute({ sql: `UPDATE service_catalog SET search_blob=? WHERE id=?`, args: [blob, r.id] });
    }
    console.log(`[catalogue] done.`);
  }
  _blobsReady = true;
}

// ─── Multi-stage search ─────────────────────────────────────

async function searchStageA_phraseAll(contentTokens, limit) {
  if (contentTokens.length < 2) return [];
  const clauses = contentTokens.map(() => `search_blob LIKE ?`).join(' AND ');
  const args = contentTokens.map(t => `%${t}%`);
  args.push(limit);
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, fees_text,
                 description_en, description_ar, required_documents_json, source_url, search_blob
            FROM service_catalog WHERE ${clauses} LIMIT ?`,
    args
  });
  return rows;
}

async function searchStageB_bestPair(contentTokens, limit) {
  if (contentTokens.length < 2) return [];
  // Use the two rarest (longest) content tokens — more specific.
  const sorted = [...contentTokens].sort((a, b) => b.length - a.length);
  const [a, b] = sorted;
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, fees_text,
                 description_en, description_ar, required_documents_json, source_url, search_blob
            FROM service_catalog WHERE search_blob LIKE ? AND search_blob LIKE ? LIMIT ?`,
    args: [`%${a}%`, `%${b}%`, limit]
  });
  return rows;
}

async function searchStageC_single(contentTokens, limit) {
  if (!contentTokens.length) return [];
  // OR on single token (rarest first)
  const sorted = [...contentTokens].sort((a, b) => b.length - a.length);
  const top = sorted[0];
  const { rows } = await db.execute({
    sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, fee_omr, fees_text,
                 description_en, description_ar, required_documents_json, source_url, search_blob
            FROM service_catalog WHERE search_blob LIKE ? LIMIT ?`,
    args: [`%${top}%`, limit]
  });
  return rows;
}

// ─── Scoring ────────────────────────────────────────────────

function scoreCandidate(row, userTokens, contentTokens, stage) {
  const blob = row.search_blob || '';
  let score = 0;

  // High weight: content (non-stop, non-low-weight) tokens
  for (const t of contentTokens) {
    if (blob.includes(t)) score += 10;
  }
  // Lower weight: low-weight but present tokens ("permit", "service", "renew")
  for (const t of userTokens) {
    if (!contentTokens.includes(t) && !isStopword(t) && blob.includes(t)) score += 2;
  }
  // Bonus: token appears in the name (more important than description)
  const name = normalize((row.name_en || '') + ' ' + (row.name_ar || ''));
  for (const t of contentTokens) {
    if (name.includes(t)) score += 6;
  }
  // Stage bonus: stricter stages come with confidence
  score += (stage === 'A' ? 20 : stage === 'B' ? 10 : 0);
  return score;
}

// ─── Optional LLM rerank ───────────────────────────────────
async function llmRerank(userText, candidates, trace) {
  if (!LLM_ENABLED || candidates.length <= 1) return candidates[0]?.id ?? null;
  const list = candidates.slice(0, 6).map((c, i) =>
    `${i + 1}. [id=${c.id}] ${c.name_en || c.name_ar} — ${c.entity_en || ''}`
  ).join('\n');
  const reply = await chat({
    system: 'You pick the single most likely Oman government service the user wants. Reply with JUST the integer id, nothing else. If none of the candidates match at all, reply "none".',
    user: `User wrote: "${userText}"\n\nCandidates:\n${list}\n\nWhich id is the best match?`,
    max_tokens: 8,
    trace
  });
  if (/none/i.test(reply || '')) return null;
  const m = String(reply || '').match(/\d+/);
  return m ? Number(m[0]) : candidates[0]?.id;
}

// ─── Public API ────────────────────────────────────────────

export async function matchService(userText, { trace } = {}) {
  await ensureSearchBlobs();

  const raw = (userText || '').toLowerCase();
  const norm = normalize(userText);

  // 1. Launch-service keyword match
  for (const [code, s] of Object.entries(LAUNCH_SERVICES)) {
    for (const k of s.match_keywords) {
      const nk = normalize(k);
      if (nk && (raw.includes(k.toLowerCase()) || norm.includes(nk))) {
        trace?.push({ step: 'match', source: 'launch', code });
        return { source: 'launch', code, service: s, confidence: 1 };
      }
    }
  }

  const tokens = tokenize(norm, 2);
  const contentTokens = tokens.filter(t => !isStopword(t) && !isLowWeight(t) && t.length >= 3);

  if (!tokens.length) return null;

  // 2. Multi-stage retrieval
  let pool = [];
  const seen = new Set();
  const add = (rows, stage) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      pool.push({ ...r, _stage: stage });
    }
  };

  const tokensForSearch = contentTokens.length ? contentTokens : tokens.filter(t => !isStopword(t) && t.length >= 3);

  if (tokensForSearch.length >= 2) {
    add(await searchStageA_phraseAll(tokensForSearch, 20), 'A');
  }
  if (pool.length < 5 && tokensForSearch.length >= 2) {
    add(await searchStageB_bestPair(tokensForSearch, 20), 'B');
  }
  if (pool.length < 5 && tokensForSearch.length >= 1) {
    add(await searchStageC_single(tokensForSearch, 20), 'C');
  }
  trace?.push({ step: 'retrieval', content: contentTokens, pool_size: pool.length });

  if (!pool.length) return null;

  // 3. Score
  const allUserTokens = tokens;
  const scored = pool.map(r => ({ ...r, _score: scoreCandidate(r, allUserTokens, contentTokens, r._stage) }))
                     .sort((a, b) => b._score - a._score);

  const top = scored.slice(0, 8);
  trace?.push({ step: 'scored', top_ids: top.slice(0, 5).map(r => [r.id, r._score]) });

  // 4. Optional LLM rerank on the shortlist
  const rerankedId = await llmRerank(userText, top.slice(0, 6), trace);
  const chosen = rerankedId ? (top.find(r => r.id === rerankedId) || top[0]) : top[0];

  // Confidence = score gap / top score, clamped
  const gap = top[1] ? (chosen._score - top[1]._score) : chosen._score;
  const confidence = Math.max(0.3, Math.min(1, (chosen._score >= 10 ? 0.6 : 0.3) + gap / 40));

  return {
    source: 'catalogue',
    top: chosen,
    candidates: top.slice(0, 5),
    confidence,
    stage: chosen._stage
  };
}

export async function getServiceById(id) {
  const { rows } = await db.execute({ sql: `SELECT * FROM service_catalog WHERE id=?`, args: [id] });
  return rows[0] || null;
}

export function parseRequiredDocs(row) {
  try {
    const parsed = JSON.parse(row.required_documents_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function launchService(code) { return LAUNCH_SERVICES[code]; }
