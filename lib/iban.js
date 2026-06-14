// lib/iban.js
//
// IBAN validation — used at write-time so we don't store garbage and
// re-discover at payout-time that a citizen's transfer bounced.
//
// Two layers of defence:
//
//   1. Format check — country prefix + length. Omani IBAN is OM + 20
//      alphanumeric = 22 characters total. The standard allows other
//      country codes too; we accept anything ISO 13616-recognised but
//      WARN if it's not OM (operator can override). Stripping spaces +
//      uppercasing first so "om81 0030 1234 ..." normalises cleanly.
//
//   2. Mod-97 check digits — the actual cryptographic integrity check.
//      Move the first 4 chars to the end, replace each letter with its
//      A=10 / Z=35 numeric pair, then verify the giant integer ≡ 1 (mod 97).
//      Catches single-digit typos and most transcription errors.
//
// Exposes:
//   normaliseIban(s) → uppercase, no spaces
//   isValidIbanFormat(s) → boolean (length + alphanumeric)
//   isValidIbanChecksum(s) → boolean (mod-97 == 1)
//   validateIban(s) → { ok, normalised?, country?, error? }
//
// Spec: https://www.swift.com/standards/data-standards/iban

// Per-country IBAN length. Source: ISO 13616. We list GCC + a handful of
// common destinations operators are likely to encounter; everything else
// passes the format check if it's between 15 and 34 chars (the spec
// minimum/maximum), and the mod-97 check catches typos either way.
const IBAN_LENGTH = Object.freeze({
  // GCC
  OM: 23, BH: 22, SA: 24, AE: 23, QA: 29, KW: 30,
  // Common others (just for hint quality; checksum still gates)
  GB: 22, FR: 27, DE: 22, NL: 18, ES: 24, IT: 27, PT: 25,
  EG: 29, JO: 30, LB: 28, TR: 26, PK: 24, IN: 22
});

/**
 * Normalise an IBAN string: drop whitespace, uppercase. Returns '' for
 * null/undefined so callers can compare against empty string defensively.
 * @param {string} s
 */
export function normaliseIban(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Format-only check (length + alphanumeric only). Doesn't verify the
 * mod-97 digits — pair with isValidIbanChecksum for full validation.
 * @param {string} s
 */
export function isValidIbanFormat(s) {
  const x = normaliseIban(s);
  if (x.length < 15 || x.length > 34) return false;
  if (!/^[A-Z0-9]+$/.test(x)) return false;
  const country = x.slice(0, 2);
  const expected = IBAN_LENGTH[country];
  // If we know the country's expected length, enforce it. Otherwise the
  // generic 15..34 bracket above stands and the checksum is the last line.
  if (expected && x.length !== expected) return false;
  return true;
}

/**
 * Mod-97 check digit validation. Standard algorithm:
 *   1. Move the first 4 chars to the end (CC + 2 check digits).
 *   2. Replace each letter with its 2-digit numeric value (A=10, B=11, …).
 *   3. Treat the result as a giant integer; valid IBAN ⇒ integer mod 97 = 1.
 *
 * We use BigInt to handle the up-to-34-digit integer cleanly.
 * @param {string} s
 */
export function isValidIbanChecksum(s) {
  const x = normaliseIban(s);
  if (x.length < 4) return false;
  const rearranged = x.slice(4) + x.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') numeric += ch;
    else if (ch >= 'A' && ch <= 'Z') numeric += String(ch.charCodeAt(0) - 55); // A=10, B=11, …
    else return false;  // shouldn't reach here after format check
  }
  try {
    return BigInt(numeric) % 97n === 1n;
  } catch {
    return false;
  }
}

/**
 * Single-call validator. Returns shape suitable for surfacing to the UI.
 *
 *   { ok: true,  normalised: 'OM81...', country: 'OM' }
 *   { ok: false, error: 'bad_length' | 'bad_chars' | 'bad_checksum' | 'empty' }
 *
 * @param {string} raw
 */
export function validateIban(raw) {
  const s = normaliseIban(raw);
  if (!s) return { ok: false, error: 'empty' };
  if (!/^[A-Z0-9]+$/.test(s)) return { ok: false, error: 'bad_chars' };
  const country = s.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'bad_country' };
  if (!isValidIbanFormat(s)) return { ok: false, error: 'bad_length' };
  if (!isValidIbanChecksum(s)) return { ok: false, error: 'bad_checksum' };
  return { ok: true, normalised: s, country };
}
