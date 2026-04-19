// ────────────────────────────────────────────────────────────
// Query rewriter — expands a user's raw search into multiple
// synonymous phrasings before we hit the catalogue.
//
// Two sources of expansion:
//   1. Hardcoded synonym map (Oman gov-services vocabulary)
//      — always available, covers the top 80% of cases
//   2. Qwen LLM (when QWEN_API_KEY is set) — catches dialectal
//      or paraphrased queries the map misses
//
// Output: a deduped array of 3–8 search variants, original first.
// ────────────────────────────────────────────────────────────

import { chat, LLM_ENABLED } from './llm.js';
import { normalize } from './catalogue.js';

// Bidirectional synonym groups for the Oman gov domain.
// Each group is treated as mutually-substitutable.
const SYN_GROUPS = [
  // Work / labour
  ['بطاقه عمل','بطاقه عامل','بطاقة عمل','بطاقة عامل','labour card','labor card','work card','work permit','تصريح عمل','تصريح العمل','permit to work'],

  // Driving / licence
  ['رخصه قياده','رخصة قيادة','رخصه سياقه','رخصة سياقة','driving licence','driving license','driver licence','driver license','driving permit'],

  // Civil ID
  ['بطاقه مدنيه','بطاقة مدنية','هويه','هوية','الهويه المدنيه','civil id','id card','national id','identity card'],

  // Passport
  ['جواز','جواز سفر','passport','باسبور','باسبورت'],

  // Vehicle / Mulkiya
  ['ملكيه','ملكية','ملكية المركبة','ملكيه مركبه','mulkiya','vehicle registration','vehicle licence','car registration','car licence','استماره'],

  // Commercial registration
  ['سجل تجاري','السجل التجاري','commercial registration','cr','cr renewal','تجديد سجل','تجديد السجل','business licence','business license','trade licence'],

  // Fishing / boats
  ['صيد','fishing','سفينه صيد','قارب صيد','fishing vessel','fishing boat','ترخيص صيد'],
  ['سفينه','سفينة','قارب','ship','vessel','boat'],

  // Visa
  ['تاشيره','تأشيرة','فيزا','visa','entry visa','residence visa','استقدام'],

  // Health
  ['بطاقه صحيه','بطاقة صحية','شهاده صحيه','health card','medical card','medical certificate','فحص طبي','medical fitness'],

  // Permits in general
  ['تصريح','permit','authorization','authorisation'],
  ['رخصه','license','licence'],

  // Renewal verbs (low-weight, kept so matching still works)
  ['تجديد','renew','renewal','إصدار','اصدار','issuance','issue','new','طلب','request','application','apply']
];

// Flatten to fast lookup: term → Set(siblings)
const SYN_INDEX = (() => {
  const idx = new Map();
  for (const group of SYN_GROUPS) {
    const set = new Set(group.map(t => normalize(t)));
    for (const t of set) {
      const cur = idx.get(t) || new Set();
      for (const s of set) if (s !== t) cur.add(s);
      idx.set(t, cur);
    }
  }
  return idx;
})();

// Heuristic expansion — substitute each matched term with each sibling,
// then enumerate the cartesian product (capped).
function heuristicExpand(normText) {
  const variants = new Set([normText]);
  const tokens = normText.split(/\s+/);

  // Multi-word matches first (e.g., "بطاقه عمل" before single word)
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const phrase = tokens.slice(i, i + n).join(' ');
      const sibs = SYN_INDEX.get(phrase);
      if (!sibs) continue;
      const before = tokens.slice(0, i).join(' ');
      const after  = tokens.slice(i + n).join(' ');
      for (const sib of sibs) {
        const v = [before, sib, after].filter(Boolean).join(' ').trim();
        variants.add(v);
        if (variants.size >= 14) return Array.from(variants);
      }
    }
  }
  return Array.from(variants);
}

// LLM-driven expansion. Ask Qwen to produce a JSON array of search phrases
// covering dialect/MSA/English variations for an Oman gov-services search.
async function llmExpand(original, trace) {
  const reply = await chat({
    system: `You generate short search phrases to find Oman government services in a catalogue. Given a user's free-text query (Arabic dialect, MSA, or English), produce 3-5 concise search phrases that capture the most likely intents and their synonyms. Include common Oman-specific terms (e.g. "بطاقة عامل" often means "work permit"). Output ONLY a JSON array of strings, no explanations.`,
    user: `User query: "${original}"\n\nReturn JSON array of 3-5 search phrases.`,
    max_tokens: 200,
    temperature: 0.3,
    trace
  });
  const m = (reply || '').match(/\[[\s\S]+\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => typeof x === 'string').slice(0, 6);
  } catch { return []; }
}

export async function expandQuery(text, { useLLM = LLM_ENABLED, trace } = {}) {
  const original = (text || '').trim();
  if (!original) return [];
  const norm = normalize(original);
  const variants = new Set([original, norm]);

  // 1. Heuristic (always on)
  for (const v of heuristicExpand(norm)) variants.add(v);

  // 2. LLM (when available)
  if (useLLM) {
    try {
      const llm = await llmExpand(original, trace);
      for (const v of llm) variants.add(normalize(v));
    } catch (e) { trace?.push({ step: 'expand_llm_err', msg: String(e).slice(0, 80) }); }
  }

  const out = Array.from(variants).filter(Boolean).slice(0, 10);
  trace?.push({ step: 'expand', original, variants: out });
  return out;
}
