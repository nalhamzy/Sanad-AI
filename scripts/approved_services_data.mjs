// Office-APPROVED services — the verified, fulfillable set.
//
// Source: Mohammed Sanad (Qurm office), 2026-06-22. These are real, confirmed
// Ministry-of-Labour services with their REQUIRED INPUTS and the office's FIXED
// COMMISSION (office_fee_omr). The GOVERNMENT fee is unknown up front (the office
// only sees it after logging into the gov portal) → gov_fee_tbd:true, and
// fee_omr stays NULL so the office is prompted to enter it before billing.
//
// Field `type` per input:
//   file   — an upload (image/pdf)            text — free text
//   date   — a date                           number — a number
//   optional:true — "إن وجد" (only if available)
//
// `key` is a stable slug used as the natural key so the loader is idempotent
// (re-running upserts the same row instead of duplicating).
//
// Loaded by scripts/load_approved_services.mjs. These rows get
// verification_status='office_approved', verification_source='office'.

const F = (code, label_ar, label_en, extra = {}) => ({ code, label_ar, label_en, type: 'file', ...extra });
const T = (code, label_ar, label_en) => ({ code, label_ar, label_en, type: 'text' });
const D = (code, label_ar, label_en) => ({ code, label_ar, label_en, type: 'date' });
const N = (code, label_ar, label_en) => ({ code, label_ar, label_en, type: 'number' });

export const APPROVED_SERVICES = [
  {
    key: 'renew_worker_residence',
    name_ar: 'تجديد إقامة عامل',
    name_en: 'Renew Worker Residence Permit',
    office_fee_omr: 3,
    documents: [
      F('passport_copy', 'صورة من الجواز', 'Passport copy'),
      F('photo', 'صورة شمسية', 'Personal photo'),
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
    ],
  },
  {
    key: 'cancel_absconding_expat',
    name_ar: 'إلغاء بلاغ هروب عامل (وافد)',
    name_en: 'Cancel Worker Absconding Report (Expat)',
    office_fee_omr: 3,
    documents: [
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
      F('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      T('cancel_reason', 'سبب إلغاء البلاغ', 'Reason for cancelling the report'),
    ],
  },
  {
    key: 'work_contract_omani',
    name_ar: 'عقد عمل عامل (عماني)',
    name_en: 'Work Contract (Omani Worker)',
    office_fee_omr: 3,
    documents: [
      F('employee_card', 'صورة بطاقة الموظف', 'Employee card copy'),
      T('monthly_salary', 'توضيح الراتب الشهري', 'Monthly salary'),
      T('job_title', 'مهنة الموظف', 'Job title'),
      D('contract_start_date', 'تاريخ بداية العقد', 'Contract start date'),
    ],
  },
  {
    key: 'work_contract_expat',
    name_ar: 'عقد عمل عامل (وافد)',
    name_en: 'Work Contract (Expat Worker)',
    office_fee_omr: 3,
    documents: [
      F('passport_copy', 'صورة جواز العامل', 'Worker passport copy'),
      T('monthly_salary', 'توضيح الراتب الشهري', 'Monthly salary'),
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
      D('contract_start_date', 'تاريخ بداية العقد', 'Contract start date'),
    ],
  },
  {
    key: 'worker_absconding_report',
    name_ar: 'بلاغ هروب عامل',
    name_en: 'Worker Absconding Report',
    office_fee_omr: 5,
    documents: [
      F('passport_copy', 'صورة جواز العامل', 'Worker passport copy'),
      F('wage_proof', 'إثبات تسليم الأجور', 'Proof of wage payment'),
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
      D('absconding_date', 'تاريخ الهروب', 'Absconding date'),
    ],
  },
  {
    key: 'register_new_worker',
    name_ar: 'تسجيل عامل جديد',
    name_en: 'Register New Worker',
    office_fee_omr: 3,
    documents: [
      F('passport_copy', 'صورة جواز العامل', 'Worker passport copy'),
      F('photo', 'صورة شمسية', 'Personal photo'),
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
    ],
  },
  {
    key: 'transfer_worker_sponsorship',
    name_ar: 'نقل كفالة عامل',
    name_en: 'Transfer Worker Sponsorship',
    office_fee_omr: 3,
    documents: [
      F('passport_copy', 'صورة جواز العامل', 'Worker passport copy'),
      F('photo', 'صورة شمسية', 'Personal photo'),
      F('residence_card', 'صورة بطاقة الإقامة', 'Residence card copy'),
      F('work_permit', 'تصريح العمل (المأذونية)', 'Work permit (Maathuniya)'),
    ],
  },
  {
    key: 'permit_horse_groom',
    name_ar: 'تصريح عمل (مأذونية سائس خيل)',
    name_en: 'Work Permit (Horse Groom)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('horse_ownership', 'إثبات تملك الخيل', 'Proof of horse ownership'),
    ],
  },
  {
    key: 'permit_gardener',
    name_ar: 'تصريح عمل (مأذونية حدائقي)',
    name_en: 'Work Permit (Gardener)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('house_ownership', 'ملكية وكروكي المنزل', 'House ownership & sketch'),
    ],
  },
  {
    key: 'permit_nanny',
    name_ar: 'تصريح عمل (مأذونية مربية أطفال)',
    name_en: 'Work Permit (Nanny)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('children_birth_cert', 'شهادة ميلاد الأولاد', "Children's birth certificates"),
      F('house_ownership', 'ملكية المنزل', 'House ownership'),
    ],
  },
  {
    key: 'permit_private_driver',
    name_ar: 'تصريح عمل (مأذونية سائق خاص)',
    name_en: 'Work Permit (Private Driver)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('birth_or_marriage', 'شهادة ميلاد / عقد الزواج', 'Birth certificate / marriage contract'),
      F('vehicle_ownership', 'ملكية المركبة', 'Vehicle ownership'),
    ],
  },
  {
    key: 'permit_domestic_worker',
    name_ar: 'تصريح عمل (مأذونية عامل/ة منزل)',
    name_en: 'Work Permit (Domestic Worker)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('birth_or_marriage', 'شهادة ميلاد / عقد الزواج', 'Birth certificate / marriage contract'),
    ],
  },
  {
    key: 'permit_laundry',
    name_ar: 'تصريح عمل (مأذونية مغسلة ملابس)',
    name_en: 'Work Permit (Laundry)',
    office_fee_omr: 5,
    documents: [
      F('lease_contract', 'عقد الإيجار', 'Lease contract'),
      F('municipal_license', 'الترخيص البلدي', 'Municipal licence'),
      F('worker_salary_transfer', 'كشف تحويل رواتب عمال', 'Worker salary-transfer statement', { optional: true }),
      F('shop_survey', 'الرسم المساحي للمحل', 'Shop survey drawing', { optional: true }),
    ],
  },
  {
    key: 'permit_barber',
    name_ar: 'تصريح عمل (مأذونية حلاق)',
    name_en: 'Work Permit (Barber)',
    office_fee_omr: 5,
    documents: [
      F('lease_contract', 'عقد الإيجار', 'Lease contract'),
      F('municipal_license', 'الترخيص البلدي', 'Municipal licence'),
      F('worker_salary_transfer', 'كشف تحويل رواتب عمال', 'Worker salary-transfer statement', { optional: true }),
      F('shop_survey', 'الرسم المساحي للمحل', 'Shop survey drawing', { optional: true }),
    ],
  },
  {
    key: 'permit_agricultural_worker',
    name_ar: 'تصريح عمل (مأذونية عامل زراعي)',
    name_en: 'Work Permit (Agricultural Worker)',
    office_fee_omr: 5,
    documents: [
      F('farm_ownership', 'ملكية وكروكي المزرعة / عقد إيجار مزرعة', 'Farm ownership & sketch / farm lease'),
      F('livestock_proof', 'إثبات الحيازة الحيوانية', 'Proof of livestock holding'),
    ],
  },
  {
    key: 'permit_camel_herder',
    name_ar: 'تصريح عمل (مأذونية مربي إبل)',
    name_en: 'Work Permit (Camel Herder)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('livestock_proof', 'إثبات الحيازة الحيوانية للإبل', 'Proof of camel holding'),
    ],
  },
  {
    key: 'permit_apiary_worker',
    name_ar: 'تصريح عمل (مأذونية عامل مناحل)',
    name_en: 'Work Permit (Apiary Worker)',
    office_fee_omr: 5,
    documents: [
      F('salary_cert_6m', 'شهادة الراتب / كشف حساب 6 أشهر', 'Salary certificate / 6-month bank statement'),
      F('apiary_ownership', 'إثبات تملك المناحل', 'Proof of apiary ownership'),
    ],
  },
  {
    key: 'activate_jobseeker',
    name_ar: 'تنشيط حالة الباحث عن عمل',
    name_en: 'Activate Jobseeker Status',
    office_fee_omr: 1,
    documents: [
      F('civil_id', 'صورة من البطاقة الشخصية', 'Civil ID copy'),
    ],
  },
  {
    key: 'refund_absconding_ticket',
    name_ar: 'استرداد ثمن تذكرة لبلاغ ترك العامل (هروب عامل)',
    name_en: 'Refund Ticket Price for Absconding Report',
    office_fee_omr: 5,
    documents: [
      F('residence_card', 'صورة بطاقة الإقامة (الوافدين)', 'Residence card copy (expat)'),
      F('passport_copy', 'صورة من جواز العامل', 'Worker passport copy'),
      T('bank_details', 'تفاصيل الحساب البنكي', 'Bank account details'),
    ],
  },
  {
    key: 'labor_complaint',
    name_ar: 'تقديم الشكاوى العمالية',
    name_en: 'Submit Labour Complaint',
    office_fee_omr: 5,
    documents: [
      F('id_copy', 'صورة بطاقة الإقامة (الوافدين) / البطاقة الشخصية (العمانيين)', 'Residence card (expat) / Civil ID (Omani)'),
      T('complaint_details', 'تفاصيل الشكوى', 'Complaint details'),
    ],
  },
  {
    key: 'accept_work_contract_individual',
    name_ar: 'قبول عقد العمل (الأفراد)',
    name_en: 'Accept Work Contract (Individuals)',
    office_fee_omr: 1,
    documents: [
      F('passport_copy', 'صورة من الجواز', 'Passport copy'),
      F('id_copy', 'صورة بطاقة الإقامة (الوافدين) / البطاقة الشخصية (العمانيين)', 'Residence card (expat) / Civil ID (Omani)'),
    ],
  },
  {
    key: 'permit_decor_workers',
    name_ar: 'تصريح عمل (مأذونية عمال الديكور)',
    name_en: 'Work Permit (Decor Workers)',
    office_fee_omr: 5,
    documents: [
      F('lease_contract', 'عقد الإيجار', 'Lease contract'),
      F('municipal_license', 'الترخيص البلدي', 'Municipal licence'),
      F('worker_salary_transfer', 'كشف تحويل رواتب عمال', 'Worker salary-transfer statement', { optional: true }),
      F('shop_survey', 'الرسم المساحي للمحل', 'Shop survey drawing', { optional: true }),
      F('decor_agreement', 'اتفاقية عمل ديكور', 'Decor work agreement'),
      F('ownership_survey', 'الملكية والكروكي', 'Ownership & sketch'),
    ],
  },
  {
    key: 'permit_construction_contracting',
    name_ar: 'تصريح عمل (مأذونية مقاولات البناء)',
    name_en: 'Work Permit (Building Contracting)',
    office_fee_omr: 5,
    documents: [
      F('lease_contract', 'عقد الإيجار', 'Lease contract'),
      F('municipal_license', 'الترخيص البلدي', 'Municipal licence'),
      F('worker_salary_transfer', 'كشف تحويل رواتب عمال', 'Worker salary-transfer statement', { optional: true }),
      F('shop_survey', 'الرسم المساحي للمحل', 'Shop survey drawing', { optional: true }),
      F('build_agreement', 'اتفاقية عمل بناء', 'Building work agreement'),
      F('ownership_survey', 'الملكية والكروكي', 'Ownership & sketch'),
      F('construction_start', 'إثبات الشروع في البناء', 'Proof of construction start'),
    ],
  },
  {
    key: 'extract_jobseeker_data',
    name_ar: 'استخراج بيانات الباحث عن عمل',
    name_en: 'Extract Jobseeker Data',
    office_fee_omr: 1,
    documents: [
      F('civil_id', 'صورة من البطاقة الشخصية', 'Civil ID copy'),
    ],
  },
  {
    key: 'register_operation_plan',
    name_ar: 'تسجيل خطة التشغيل',
    name_en: 'Register Operation (Employment) Plan',
    office_fee_omr: 5,
    documents: [
      F('commercial_register', 'صورة من السجل التجاري', 'Commercial register copy'),
      T('required_jobs', 'المهن المطلوبة', 'Required occupations'),
      D('plan_start_date', 'تاريخ بداية الخطة', 'Plan start date'),
      T('proposed_salary', 'الراتب المقترح', 'Proposed salary'),
      N('proposed_count', 'العدد المقترح', 'Proposed headcount'),
      T('target_activity', 'النشاط المطلوب التوظيف فيه', 'Target hiring activity'),
    ],
  },
  {
    key: 'extract_workforce_data',
    name_ar: 'استخراج بيانات القوى العاملة',
    name_en: 'Extract Workforce Data',
    office_fee_omr: 2,
    documents: [
      F('commercial_register', 'صورة من السجل التجاري', 'Commercial register copy'),
    ],
  },
  {
    key: 'cancel_old_departure',
    name_ar: 'إلغاء المغادرة القديمة للعامل',
    name_en: "Cancel Worker's Old Departure",
    office_fee_omr: 5,
    note_ar: 'تتوفر خدمة طباعة استمارة المغادرة.',
    documents: [
      F('passport_copy', 'صورة من الجواز', 'Passport copy'),
      F('residence_card', 'صورة من بطاقة الإقامة', 'Residence card copy'),
      F('departure_form', 'استمارة المغادرة', 'Departure form', { optional: true }),
    ],
  },
  {
    key: 'cancel_worker',
    name_ar: 'إلغاء عامل (كنسل)',
    name_en: 'Cancel Worker',
    office_fee_omr: 3,
    documents: [
      F('passport_copy', 'صورة من الجواز', 'Passport copy'),
      F('residence_card', 'صورة من بطاقة الإقامة', 'Residence card copy'),
      F('travel_ticket', 'صورة تذكرة السفر', 'Travel ticket copy'),
    ],
  },
  {
    key: 'register_jobseeker',
    name_ar: 'تسجيل باحث عن عمل',
    name_en: 'Register Jobseeker',
    office_fee_omr: 1,
    documents: [
      F('civil_id', 'صورة من البطاقة الشخصية', 'Civil ID copy'),
    ],
  },
];

// Default entity for all of these (Ministry of Labour). Adjust per-row later via
// the annotator if a service actually belongs to a different department.
export const APPROVED_ENTITY = { entity_ar: 'وزارة العمل', entity_en: 'Ministry of Labour' };
