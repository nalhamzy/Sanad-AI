// ────────────────────────────────────────────────────────────
// Canonical button-label table.
//
// Single source of truth for every WhatsApp interactive-button id we send.
// Before this existed, agent.js had ~100 author sites embedding `{id, title}`
// pairs inline — and the same id was getting different titles in different
// places (`confirm:yes` was both "✓ نعم" and "🔁 حاول الإلغاء مجدداً";
// `service:cancel` had THREE titles: "✕ إلغاء الطلب", "✕ ليس الآن",
// "❌ إلغاء الطلب"). Same id with different labels destroys the citizen's
// mental model of "what does this button do?".
//
// ⚠️ WhatsApp Cloud API hard limits (Meta Cloud API docs, 2026-05):
//   - Reply-button title MUST be ≤ 20 characters (Meta enforces ≤ 20 in
//     practice; chatwoot issue #8288 shows >24 silently DROPS the message).
//     We cap at 20 to leave headroom.
//   - List rows allow ≤ 24-char title + ≤ 72-char description.
//   - Max 3 reply buttons per interactive message.
//   - Max 10 list rows per section.
//
// `BUTTON_TITLE_MAX = 20` — enforced at construction time so we crash loud
// in tests instead of silently dropping a message in prod.
// ────────────────────────────────────────────────────────────

export const BUTTON_TITLE_MAX = 20;

// Canonical id → title. KEEP ALPHABETICAL by id so it's easy to scan.
// One entry per id. If a flow needs a context-specific variation (e.g.
// "cancel" worded differently for in-flight vs draft), add a NEW id —
// don't fork the title under the same id.
export const BUTTON_LABELS = Object.freeze({
  // Burst aggregator — drainBurst attaches these on multi-file replies.
  'burst:more':              '➕ سأرسل المزيد',
  'burst:done':              '✅ انتهيت من الرفع',

  // Confirmation prompts (yes/no). The id never changes intent — the
  // surrounding question text carries the intent. ONE label per id.
  'confirm:yes':             '✓ نعم',
  'confirm:no':              '✕ لا',

  // Cancel-specific confirmation. Used when the bot just asked
  // "أؤكد إلغاء الطلب؟" — the affirmative here means "yes, cancel"
  // and is a distinct id so flow logs are readable.
  'cancel:confirm':          '🗑️ نعم، احذف الطلب',
  'cancel:keep':             '↩️ تراجع',
  'cancel:retry':            '🔁 إعادة المحاولة',

  // Discovery shortcuts surfaced on welcome / new-service screens.
  'discover:cr':             '🏢 سجل تجاري',
  'discover:license':        '🚗 رخصة قيادة',
  'discover:title':          '📑 سند ملكية',
  'discover:passport':       '🛂 جواز السفر',
  'discover:civil_id':       '🆔 البطاقة المدنية',
  'discover:unsure':         '🤔 لست متأكد',

  // Triage intake — citizen unsure which service. Collects a free-text
  // description (+ optional papers) then dispatches it service-less to the
  // marketplace, where the claiming office sets the real service.
  'triage:submit':           '📨 أرسل طلبي للمكتب',

  // Document-collection helpers.
  'doc:wrong':               '🔄 خانة أخرى',

  // Pick-N defaults (number-only). The pickButtons() helper below
  // OVERRIDES these with the actual service name when candidates are
  // available — these are the fallback when context is missing.
  'pick:1':                  '1️⃣ ابدأ هذا',
  'pick:2':                  '2️⃣ ابدأ هذا',
  'pick:3':                  '3️⃣ ابدأ هذا',

  // Review / submit phase.
  'review:submit':           '✅ انتهيت من الرفع',

  // Service navigation (mid-flow + queued state).
  'service:switch':          '🔍 خدمة أخرى',
  'service:cancel':          '✕ إلغاء الطلب',

  // Status query (queued / claimed states).
  'status:check':            '📊 حالة الطلب',
});

// Validate at module load — every label is within Cloud API limits.
// Crashes the boot if a label is too long. Far better than silent drops.
for (const [id, title] of Object.entries(BUTTON_LABELS)) {
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error(`BUTTON_LABELS["${id}"] is empty/invalid`);
  }
  if (title.length > BUTTON_TITLE_MAX) {
    throw new Error(
      `BUTTON_LABELS["${id}"] = "${title}" is ${title.length} chars; ` +
      `WhatsApp Cloud API caps reply-button titles at ${BUTTON_TITLE_MAX}. ` +
      `Shorten the title or move it to a list message.`
    );
  }
}

// Build a single {id, title} object using the canonical title.
// Throws on unknown id so a typo doesn't silently ship.
//
// The optional 2nd arg `titleOverride` is for ONE legitimate case: the
// pickButtons() helper truncating a service name into the slot. Other
// callers should NEVER pass it — the whole point of this module is one
// canonical title per id.
export function button(id, titleOverride) {
  if (!Object.prototype.hasOwnProperty.call(BUTTON_LABELS, id)) {
    throw new Error(`Unknown button id "${id}". Add it to lib/buttons.js BUTTON_LABELS first.`);
  }
  const title = titleOverride != null ? String(titleOverride) : BUTTON_LABELS[id];
  if (title.length > BUTTON_TITLE_MAX) {
    // For overrides we truncate rather than throw — runtime data (service
    // names) shouldn't crash the bot. Keep a trailing ellipsis so the
    // citizen sees that the label was cut.
    return { id, title: title.slice(0, BUTTON_TITLE_MAX - 1) + '…' };
  }
  return { id, title };
}

// Convenience: build {id,title}[] from a list of canonical ids.
// Throws if more than 3 are passed (Cloud API hard limit for reply buttons).
export function buttons(ids) {
  if (!Array.isArray(ids)) throw new Error('buttons() expects an array of ids');
  if (ids.length > 3) {
    throw new Error(`buttons(): WhatsApp Cloud API allows max 3 reply buttons; got ${ids.length}. Use a list message.`);
  }
  return ids.map(id => button(id));
}

// Build pick:N buttons from search-result service rows. The button title
// becomes "{N} {first 17 chars of service name}" so the citizen can read
// the keypad without scrolling back to the message body.
//
// Per the WhatsApp UX research (Infobip + Landbot): putting just "1️⃣" on
// a button forces the user to context-switch back to the body. The
// number-glyph stays as a prefix so the visual hierarchy still maps to
// the numbered lines in the body, but adds the truncated name.
//
// Returns at most 3 buttons (Cloud API ceiling). For >3 candidates the
// caller should use a list message instead.
export function pickButtons(candidates, { max = 3 } = {}) {
  const NUM_GLYPHS = ['1️⃣', '2️⃣', '3️⃣'];
  const out = [];
  const slice = (candidates || []).slice(0, Math.min(max, NUM_GLYPHS.length));
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const name = (c?.name_ar || c?.name_en || '').trim();
    // Strip generic prefixes that waste characters: "خدمة ", "طلب ", etc.
    const trimmed = name
      .replace(/^خدمة\s+(?:طلب\s+)?/, '')
      .replace(/^طلب\s+/, '')
      .replace(/^Service\s+/, '');
    // WhatsApp caps reply-button titles at 20 chars. Most Omani catalogue
    // service names are far longer — and truncating them produces unreadable,
    // frequently IDENTICAL labels (e.g. three residency results all sharing the
    // prefix "تجديد بيانات القوى العاملة…" collapse to the same "تجديد بيانات…").
    // So put the name on the button ONLY when it fits in FULL; otherwise show the
    // number glyph alone — the message body always lists the full numbered names,
    // so "1️⃣ / 2️⃣ / 3️⃣" maps cleanly and is never ambiguous.
    const room = BUTTON_TITLE_MAX - NUM_GLYPHS[i].length - 1;
    const id = `pick:${i + 1}`;
    const title = !trimmed
      ? BUTTON_LABELS[id]                  // missing name → canonical "1️⃣ ابدأ هذا"
      : (trimmed.length <= room)
        ? `${NUM_GLYPHS[i]} ${trimmed}`     // fits in full → number + name
        : NUM_GLYPHS[i];                    // too long → number glyph (full name is in the body)
    out.push({ id, title });
  }
  return out;
}
