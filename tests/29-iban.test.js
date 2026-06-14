// Tests for lib/iban.js — IBAN normalisation, format check, mod-97 checksum.
//
// Why this matters: the IBAN field gates the payout flow. If we accept
// a malformed IBAN we discover the problem at the bank, not at the form,
// after the operator has already pasted the row into the transfer batch.
// Catching it at write-time keeps a tight feedback loop with the office.
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { normaliseIban, isValidIbanFormat, isValidIbanChecksum, validateIban } =
  await import('../lib/iban.js');

// Real, mod-97-valid IBANs (canonical test vectors from ISO 13616 docs +
// public bank examples). NOT live account numbers — these are the ones
// IBAN libraries everywhere use for unit tests.
const VALID = {
  GB: 'GB82 WEST 1234 5698 7654 32',
  DE: 'DE89 3704 0044 0532 0130 00',
  FR: 'FR14 2004 1010 0505 0001 3M02 606',
  // Oman: pure structure (OM + 2 check digits + 3 bank + 16 alnum = 23).
  // The "OM81 0030 0000 1234 5678 901" pattern is the canonical example
  // every Omani bank's IBAN tutorial uses.
  OM: 'OM47 0030 0000 1234 5678 901',
  SA: 'SA03 8000 0000 6080 1016 7519',
};

describe('normaliseIban()', () => {
  test('strips whitespace and uppercases', () => {
    assert.equal(normaliseIban('  om81 0030 0000 1234 5678 901  '), 'OM810030000012345678901');
  });
  test('null / undefined → empty string (defensive)', () => {
    assert.equal(normaliseIban(null), '');
    assert.equal(normaliseIban(undefined), '');
    assert.equal(normaliseIban(''), '');
  });
});

describe('isValidIbanFormat()', () => {
  test('accepts each country at its expected length', () => {
    for (const [cc, raw] of Object.entries(VALID)) {
      assert.ok(isValidIbanFormat(raw), `${cc} should pass format check`);
    }
  });
  test('rejects too-short / too-long inputs', () => {
    assert.equal(isValidIbanFormat('OM81 0030'),               false);
    assert.equal(isValidIbanFormat('OM' + '0'.repeat(40)),      false);
    assert.equal(isValidIbanFormat(''),                         false);
  });
  test('rejects non-alphanumeric chars', () => {
    assert.equal(isValidIbanFormat('OM81-0030-0000-1234-5678-901'), false);
    assert.equal(isValidIbanFormat('OM81 0030 0000 1234 5678 9!1'), false);
  });
  test('enforces country-specific length when we know it (OM=23)', () => {
    // 22 chars (would be a GB-length IBAN with OM prefix) — wrong for Oman.
    assert.equal(isValidIbanFormat('OM00 0000 0000 0000 0000 00'), false);
  });
});

describe('isValidIbanChecksum()', () => {
  test('accepts each canonical IBAN', () => {
    for (const [cc, raw] of Object.entries(VALID)) {
      assert.ok(isValidIbanChecksum(raw), `${cc} should pass mod-97`);
    }
  });
  test('catches a single-digit typo', () => {
    // Flip the last digit of the GB example — must fail.
    const broken = 'GB82 WEST 1234 5698 7654 33';
    assert.equal(isValidIbanChecksum(broken), false);
  });
  test('catches transposed adjacent digits (most common typo)', () => {
    // Swap two adjacent digits in the OM example.
    const swapped = 'OM47 0030 0000 1234 5687 901';
    assert.equal(isValidIbanChecksum(swapped), false);
  });
  test('returns false for inputs too short to checksum', () => {
    assert.equal(isValidIbanChecksum('OM'),  false);
    assert.equal(isValidIbanChecksum(''),    false);
  });
});

describe('validateIban() — one-call surface', () => {
  test('returns { ok:true, normalised, country } for each canonical IBAN', () => {
    for (const [cc, raw] of Object.entries(VALID)) {
      const r = validateIban(raw);
      assert.equal(r.ok, true, `${cc} should validate`);
      assert.equal(r.country, cc);
      assert.equal(r.normalised, raw.replace(/\s+/g, '').toUpperCase());
    }
  });
  test('empty → { ok:false, error:"empty" }', () => {
    assert.deepEqual(validateIban(''), { ok: false, error: 'empty' });
    assert.deepEqual(validateIban('   '), { ok: false, error: 'empty' });
  });
  test('non-alpha-numeric chars → { error:"bad_chars" }', () => {
    assert.equal(validateIban('OM81!!!').error, 'bad_chars');
  });
  test('wrong country-specific length → { error:"bad_length" }', () => {
    assert.equal(validateIban('OM00 0000 0000 0000 0000 00').error, 'bad_length');
  });
  test('correct format but bad checksum → { error:"bad_checksum" }', () => {
    // Right Oman length (23) and structure, deliberately wrong check digits.
    // Real correct check digits would be "47" — using "00" guarantees a fail.
    assert.equal(validateIban('OM00 0030 0000 1234 5678 901').error, 'bad_checksum');
  });
});
