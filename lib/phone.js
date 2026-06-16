// lib/phone.js
// Single source of truth for phone-number canonicalization across every channel
// (WhatsApp inbound `from`, web OTP signup/login, seed data).
//
// Why this exists: WhatsApp Cloud API sends `from` WITHOUT a "+"
// (e.g. "96892888715"), and the WhatsApp citizen-creation path stored it
// verbatim — while the web OTP path omanised the same number to "+96892888715".
// That produced TWO citizen rows for one person, so a citizen who signed in by
// OTP could not see the request they had created over WhatsApp.
//
// Oman-first rules (matching routes/citizen_auth.js omanise/normPhone, which is
// the canonical web path):
//   • strip spaces / hyphens / parens / a leading "+"
//   • a bare 8-digit local number → prepend the Oman country code 968
//   • result must be 8–15 digits (strict E.164 length)
//   • return "+<digits>" (E.164 with "+"), or null if unparseable.
//
// canonicalPhone("96892888715")  → "+96892888715"
// canonicalPhone("92888715")     → "+96892888715"
// canonicalPhone("+968 9288 8715")→ "+96892888715"
export function canonicalPhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (/^\d{8}$/.test(s)) s = `968${s}`;     // local 8-digit → add Oman country code
  if (!/^\d{8,15}$/.test(s)) return null;   // strict E.164 digit count
  return `+${s}`;
}
