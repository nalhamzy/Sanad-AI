// Tests for lib/doc_labels.js — Arabic-label backfill for required_documents.
//
// Why this matters: the CSV-imported service catalog has empty label_ar on
// most rows. Without this module the chat + apply.html show English doc
// labels ("Civil ID") inside an otherwise-Arabic UI. Regressions here
// silently revert the entire UI to Arabic-with-English-spots — exactly
// the bug we just fixed.
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { arabicLabelFor, enrichDocsWithArabicLabels, __test__ } =
  await import('../lib/doc_labels.js');

describe('arabicLabelFor() — preference order', () => {

  test('uses existing label_ar when present and non-empty', () => {
    const r = arabicLabelFor({ code: 'civil_id', label_en: 'Civil ID', label_ar: 'هويتي' });
    assert.equal(r, 'هويتي');
  });

  test('treats whitespace-only label_ar as missing', () => {
    const r = arabicLabelFor({ code: 'civil_id', label_en: 'Civil ID', label_ar: '   ' });
    assert.equal(r, 'البطاقة المدنية');
  });

  test('falls back to curated dictionary on known code', () => {
    assert.equal(arabicLabelFor({ code: 'civil_id', label_ar: '' }),         'البطاقة المدنية');
    assert.equal(arabicLabelFor({ code: 'passport', label_ar: '' }),         'جواز السفر');
    assert.equal(arabicLabelFor({ code: 'employment_contract', label_ar:''}),'عقد العمل');
    assert.equal(arabicLabelFor({ code: 'driving_licence', label_ar: '' }),  'رخصة القيادة');
    assert.equal(arabicLabelFor({ code: 'title_deed', label_ar: '' }),       'سند الملكية');
  });

  test('handles X_of_the_Y compositionally (e.g. civil_id_of_the_employer)', () => {
    // This is in the curated dictionary; verify exact match.
    assert.equal(arabicLabelFor({ code: 'civil_id_of_the_employer', label_ar: '' }),
      'البطاقة المدنية لصاحب العمل');
    assert.equal(arabicLabelFor({ code: 'civil_id_of_the_omani_employee', label_ar: '' }),
      'البطاقة المدنية للموظف العماني');
  });

  test('falls through to heuristic when code is unknown — still Arabic', () => {
    const r = arabicLabelFor({ code: 'medical_fitness', label_ar: '' });
    // Either the curated value or a heuristic; must be non-empty Arabic.
    assert.ok(/[؀-ۿ]/.test(r), `expected Arabic, got "${r}"`);
  });

  test('completely-unknown code with EN tokens → heuristic token translation', () => {
    // 'recent photo' isn't in the curated dict as a single key; verify heuristic.
    const r = arabicLabelFor({ code: 'recent_photo', label_ar: '' });
    assert.ok(/[؀-ۿ]/.test(r), `expected Arabic from heuristic, got "${r}"`);
  });

  test('last-resort fallback to label_en (never crashes on missing data)', () => {
    // Empty code + empty label_ar → can only fall back to label_en.
    const r = arabicLabelFor({ code: '', label_ar: '', label_en: 'Custom doc' });
    assert.equal(r, 'Custom doc');
  });

  test('null / undefined doc → empty string (defensive)', () => {
    assert.equal(arabicLabelFor(null),      '');
    assert.equal(arabicLabelFor(undefined), '');
    assert.equal(arabicLabelFor({}),        '');
  });

  test('case-insensitive code lookup', () => {
    assert.equal(arabicLabelFor({ code: 'CIVIL_ID', label_ar: '' }), 'البطاقة المدنية');
    assert.equal(arabicLabelFor({ code: 'Civil_Id', label_ar: '' }), 'البطاقة المدنية');
  });
});

describe('enrichDocsWithArabicLabels() — array mutation', () => {

  test('fills empty label_ar only when the result is actually Arabic', () => {
    const docs = [
      { code: 'civil_id', label_en: 'Civil ID', label_ar: '' },
      { code: 'passport', label_en: 'Passport', label_ar: 'جواز محرر يدوياً' }, // keep this
      // Unknown code with no Arabic mapping — must stay empty so downstream
      // "all-generic" detectors (e.g. renderDocListOrPrompt) keep working.
      { code: 'unknown_thing', label_en: 'Mystery', label_ar: '' },
    ];
    enrichDocsWithArabicLabels(docs);
    assert.equal(docs[0].label_ar, 'البطاقة المدنية');
    assert.equal(docs[1].label_ar, 'جواز محرر يدوياً', 'must not overwrite existing label_ar');
    assert.equal(docs[2].label_ar, '',
      'no-Arabic-produced codes must leave label_ar empty for downstream detection');
  });

  test('returns the same array (chainable)', () => {
    const docs = [{ code: 'civil_id', label_ar: '' }];
    const r = enrichDocsWithArabicLabels(docs);
    assert.strictEqual(r, docs);
  });

  test('handles non-array input gracefully (no throw)', () => {
    assert.equal(enrichDocsWithArabicLabels(null),      null);
    assert.equal(enrichDocsWithArabicLabels('not an array'), 'not an array');
  });

  test('skips entries that aren\'t plain objects', () => {
    const docs = [null, 'str', 42, { code: 'civil_id', label_ar: '' }];
    enrichDocsWithArabicLabels(docs);
    // Only the real object should be touched.
    assert.equal(docs[3].label_ar, 'البطاقة المدنية');
  });
});

describe('heuristicTranslate() — internal token mapper', () => {
  const { heuristicTranslate } = __test__;

  test('returns Arabic for known single tokens', () => {
    assert.ok(/[؀-ۿ]/.test(heuristicTranslate('passport')));
  });

  test('returns empty string for empty/null input', () => {
    assert.equal(heuristicTranslate(''),  '');
    assert.equal(heuristicTranslate(null),'');
  });

  test('passes through truly unknown tokens (graceful degradation)', () => {
    // 'zzz_xyz' has no Arabic mapping — heuristic returns the raw tokens.
    const r = heuristicTranslate('zzz_xyz');
    assert.ok(r.length > 0, 'must not return empty');
  });
});
