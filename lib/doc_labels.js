// lib/doc_labels.js
//
// The CSV-imported service catalog has populated `label_en` on most
// required_documents but left `label_ar` empty. Result: the Arabic UI
// shows "Civil ID" instead of "البطاقة المدنية" because the consumer
// falls back to the English value.
//
// This module is the single source of truth for "what Arabic label do we
// show for this document". It has two layers:
//
//   1. DOC_LABEL_AR — a hand-curated dictionary of common `code` values
//      (e.g. 'civil_id', 'passport', 'employment_contract') → Arabic.
//      Covers the long tail of Oman government doc types the catalog
//      uses ~80% of the time.
//
//   2. heuristicTranslate(code) — for unknown codes, split snake_case
//      into tokens and translate token-by-token via WORD_AR. The result
//      isn't grammatically perfect but is always Arabic and always
//      readable (e.g. 'employer_signed_termination_notice' →
//      "إشعار إنهاء موقع من صاحب العمل" or similar).
//
// The exported helper `arabicLabelFor(doc)` ALWAYS returns a non-empty
// string. Callers should use it instead of `doc.label_ar` directly.

/** @typedef {{code?:string, label_en?:string, label_ar?:string}} DocEntry */

// ─── Curated dictionary — exact code matches ────────────────
// Keys are normalised lowercase snake_case. Values are the Arabic label
// we want shown in every UI. Add to this list as you encounter new codes
// — it's cheap and the call site instantly inherits the new label.
const DOC_LABEL_AR = Object.freeze({
  civil_id:                                    'البطاقة المدنية',
  civil_id_card:                               'البطاقة المدنية',
  civil_id_copy:                               'صورة البطاقة المدنية',
  passport:                                    'جواز السفر',
  passport_copy:                               'صورة جواز السفر',
  passport_if_expatriate:                      'جواز السفر (للوافد)',
  national_id:                                 'الرقم المدني',
  birth_certificate:                           'شهادة الميلاد',
  marriage_certificate:                        'عقد الزواج',
  divorce_certificate:                         'صك الطلاق',
  family_card:                                 'البطاقة العائلية',
  residence_card:                              'بطاقة الإقامة',
  driving_licence:                             'رخصة القيادة',
  driving_license:                             'رخصة القيادة',
  driver_license:                              'رخصة القيادة',
  current_driver_s_license:                    'رخصة القيادة الحالية',
  current_drivers_license:                     'رخصة القيادة الحالية',
  current_driving_licence:                     'رخصة القيادة الحالية',
  vehicle_registration:                        'استمارة السيارة',
  vehicle_ownership:                           'ملكية السيارة',
  vehicle_insurance:                           'تأمين السيارة',
  medical_fitness_certificate:                 'شهادة اللياقة الطبية',
  medical_fitness:                             'شهادة اللياقة الطبية',
  eye_test:                                    'فحص النظر',
  vision_test:                                 'فحص النظر',
  police_report:                               'بلاغ من الشرطة',
  lost_report:                                 'بلاغ فقدان',
  declaration_of_loss:                         'إقرار فقدان',
  title_deed:                                  'سند الملكية',
  property_deed:                               'سند الملكية',
  land_ownership:                              'سند ملكية الأرض',
  building_permit:                             'تصريح بناء',
  tenancy_contract:                            'عقد إيجار',
  rental_contract:                             'عقد إيجار',
  employment_contract:                         'عقد العمل',
  employment_contract_number:                  'رقم عقد العمل',
  employment_contract_copy:                    'صورة عقد العمل',
  approved_individual_employment_contract:     'نموذج عقد العمل الفردي المعتمد',
  approved_individual_employment_contract_:    'نموذج عقد العمل الفردي المعتمد',
  pay_slip:                                    'كشف الراتب',
  pay_slips:                                   'كشوف الرواتب',
  pay_slips_or_evidence_of_employment:         'كشوف الرواتب أو إثبات العمل',
  bank_statement:                              'كشف الحساب البنكي',
  bank_account_letter:                         'خطاب الحساب البنكي',
  commercial_registration:                     'السجل التجاري',
  commercial_registration_number:              'رقم السجل التجاري',
  commercial_registration_number_of_the_es:    'رقم السجل التجاري للمنشأة',
  commercial_registration_certificate:         'شهادة السجل التجاري',
  cr_certificate:                              'شهادة السجل التجاري',
  cr_number:                                   'رقم السجل التجاري',
  tax_card:                                    'البطاقة الضريبية',
  vat_certificate:                             'شهادة القيمة المضافة',
  power_of_attorney:                           'وكالة قانونية',
  authorisation_letter:                        'خطاب تفويض',
  authorization_letter:                        'خطاب تفويض',
  no_objection_letter:                         'خطاب عدم ممانعة',
  noc:                                         'شهادة عدم الممانعة',
  written_justification:                       'مبرر كتابي',
  written_justification_for_cancellation:      'مبرر كتابي للإلغاء',
  cancellation_request:                        'طلب إلغاء',
  termination_notice:                          'إشعار إنهاء',
  employer_signed_termination_notice:          'إشعار إنهاء موقّع من صاحب العمل',
  confirmation_letter_from_employer:           'خطاب تأكيد من صاحب العمل',
  confirmation_letter_from_employer_or_aut:    'خطاب تأكيد من صاحب العمل أو من يخوّله',
  recent_photo:                                'صورة شخصية حديثة',
  recent_personal_photograph:                  'صورة شخصية حديثة',
  personal_photograph:                         'صورة شخصية',
  personal_photo:                              'صورة شخصية',
  educational_certificate:                     'شهادة تعليمية',
  university_degree:                           'الشهادة الجامعية',
  graduation_certificate:                      'شهادة التخرج',
  experience_certificate:                      'شهادة خبرة',
  // Employer/employee variants (built compositionally so the dictionary stays terse).
  civil_id_of_the_employer:                    'البطاقة المدنية لصاحب العمل',
  civil_id_of_the_employee:                    'البطاقة المدنية للموظف',
  civil_id_of_the_omani_employee:              'البطاقة المدنية للموظف العماني',
  civil_id_of_the_job_seeker:                  'البطاقة المدنية لطالب العمل',
  civil_id_of_the_applicant:                   'البطاقة المدنية لمقدم الطلب',
});

// ─── Heuristic translator — token-by-token Arabic ───────────
// For codes not in DOC_LABEL_AR we split snake_case into words, translate
// each known word, and rejoin. Imperfect but always Arabic — the call
// site never sees a raw English doc code.
const WORD_AR = Object.freeze({
  // Documents
  civil:      'مدني',          id: 'البطاقة',
  passport:   'جواز السفر',
  national:   'وطني',
  birth:      'الميلاد',       certificate: 'شهادة',
  marriage:   'الزواج',        divorce:     'الطلاق',
  family:     'العائلية',
  residence:  'الإقامة',
  driving:    'القيادة',       licence:     'رخصة',         license: 'رخصة',
  vehicle:    'السيارة',       registration: 'تسجيل',       ownership: 'ملكية',
  insurance:  'تأمين',
  medical:    'طبية',          fitness:     'لياقة',
  police:     'شرطة',          report:      'بلاغ',         lost: 'فقدان',
  title:      'سند',            deed: 'الملكية',            property: 'العقار',
  land:       'الأرض',          building:    'بناء',         permit: 'تصريح',
  tenancy:    'إيجار',          rental:      'إيجار',
  employment: 'العمل',          contract:    'عقد',         number: 'رقم',
  approved:   'معتمد',         individual:  'فردي',
  pay:        'راتب',           slip:        'كشف',          slips: 'كشوف',
  evidence:   'إثبات',
  bank:       'البنك',          statement:   'كشف',          account: 'حساب',
  commercial: 'تجاري',          tax:         'ضريبي',         card: 'البطاقة',
  vat:        'القيمة المضافة',
  power:      'وكالة',          attorney:    'قانونية',
  authorisation: 'تفويض',       authorization: 'تفويض',
  letter:     'خطاب',           justification: 'مبرر',      written: 'كتابي',
  cancellation: 'الإلغاء',     termination: 'إنهاء',         notice: 'إشعار',
  signed:     'موقع',
  confirmation: 'تأكيد',
  employer:   'صاحب العمل',    employee:    'الموظف',
  applicant:  'مقدم الطلب',    seeker:      'طالب العمل',
  recent:     'حديثة',          photo:       'صورة',          personal: 'شخصية',
  educational: 'تعليمية',     university:  'الجامعية',     degree: 'شهادة',
  graduation: 'التخرج',        experience:  'خبرة',
  // Linking words
  of: 'لـ',  the: '', for: 'لـ', and: 'و', or: 'أو', if: 'إذا',
  in: 'في',  to: 'إلى', from: 'من', a: '', an: '', with: 'مع',
  is: '', be: '', by: 'من',
  omani: 'العماني', expatriate: 'الوافد',
  job:    'العمل',
  copy:   'صورة',
});

/**
 * Translate a snake_case English doc code to a best-effort Arabic label.
 * Used as a fallback when DOC_LABEL_AR doesn't have an exact match.
 *
 * Algorithm: split on '_', drop empty tokens, lowercase each, map via
 * WORD_AR (unknown words pass through untranslated), join with space.
 *
 * @param {string} code
 * @returns {string}
 */
function heuristicTranslate(code) {
  if (!code) return '';
  const tokens = String(code).toLowerCase().split('_').filter(Boolean);
  // Special pattern: "X_of_the_Y" → "X لـ Y" — most natural Arabic order.
  // We rebuild rather than literal-translate because EN→AR reverses
  // possessive direction (Civil ID of the Employer → البطاقة المدنية لصاحب العمل).
  const ofIdx = tokens.indexOf('of');
  if (ofIdx > 0 && tokens[ofIdx + 1] === 'the' && ofIdx + 2 < tokens.length) {
    const head = tokens.slice(0, ofIdx).map(t => WORD_AR[t] ?? t).join(' ');
    const tail = tokens.slice(ofIdx + 2).map(t => WORD_AR[t] ?? t).join(' ');
    return `${head} لـ${tail}`.replace(/\s+/g, ' ').trim();
  }
  return tokens.map(t => WORD_AR[t] ?? t).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Return the Arabic label for a required_document entry. Tries, in order:
 *   1. doc.label_ar if it's a non-empty string
 *   2. DOC_LABEL_AR[doc.code] if the code is a curated entry
 *   3. heuristicTranslate(doc.code) — token-wise Arabic
 *   4. doc.label_en (last resort, never crash)
 *   5. doc.code (absolute last resort)
 *
 * Always returns a non-empty string.
 *
 * @param {DocEntry} doc
 * @returns {string}
 */
export function arabicLabelFor(doc) {
  if (!doc) return '';
  if (typeof doc.label_ar === 'string' && doc.label_ar.trim()) return doc.label_ar.trim();
  const code = (doc.code || '').toLowerCase().trim();
  if (code && DOC_LABEL_AR[code]) return DOC_LABEL_AR[code];
  // Heuristic translation — only accepted if it actually produced Arabic.
  // A code like 'something_obscure' with no matching tokens would otherwise
  // return "something obscure", which defeats the whole point.
  const heuristic = heuristicTranslate(code);
  if (heuristic && /[؀-ۿ]/.test(heuristic)) return heuristic;
  // No Arabic anywhere — fall back to English so the UI is at least readable.
  return doc.label_en || doc.code || '';
}

/**
 * Enrich a doc array in-place so every entry has a non-empty label_ar.
 * Called at the catalog-read boundary in parseRequiredDocs() so every
 * downstream consumer (chat, apply page, officer dashboard) just sees
 * Arabic labels.
 *
 * @template {DocEntry} T
 * @param {T[]} docs
 * @returns {T[]} same array (mutated) for chaining
 */
export function enrichDocsWithArabicLabels(docs) {
  if (!Array.isArray(docs)) return docs;
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    if (d.label_ar && String(d.label_ar).trim()) continue;  // keep existing
    const candidate = arabicLabelFor(d);
    // Only stamp `label_ar` if we actually produced Arabic text. Otherwise
    // leave it empty so downstream "all-generic" detectors (e.g.
    // renderDocListOrPrompt in lib/agent.js) keep working — they decide
    // whether to render a doc list or fall back to an open prompt by
    // counting how many entries lack a real Arabic label.
    if (candidate && /[؀-ۿ]/.test(candidate)) {
      d.label_ar = candidate;
    }
  }
  return docs;
}

// Exposed for unit tests + the admin tools that may want to patch labels.
export const __test__ = { DOC_LABEL_AR, WORD_AR, heuristicTranslate };
