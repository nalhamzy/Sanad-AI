// ────────────────────────────────────────────────────────────
// seed_qurm_services.mjs — insert 25 Sanad-office services into the
// GLOBAL service catalogue as VERIFIED (annotator_validated) + ACTIVE so
// they are immediately searchable by the hybrid search.
//
// Mirrors routes/office.js `POST /catalog/service` (the canonical "office
// adds a service to the shared catalogue" path):
//   • required_documents_json shape = [{code,label_ar,label_en,type:'file'}]
//   • search_blob = lowercased name_en/name_ar/entity_en/entity_ar
//   • external-content FTS5 row inserted via INSERT … (rowid, …)
// Differences from that route (intentional, per seed spec):
//   • verification_status = 'annotator_validated' (passes verified gate)
//   • explicit ids from 200001 (avoid collision with 140xxx/190xxx)
//   • office_fee_omr = listed office commission; fee_omr stays NULL
//     (the gov fee wasn't provided)
//
// IDEMPOTENT: a service is skipped if a row with the same name_ar already
// exists (normalized), so this can be re-run safely on prod.
//
// Embeddings: if QWEN_API_KEY is set, the new rows are embedded via
// lib/llm.js `embed()` and stored in embedding_json/embedded_at so the
// semantic lane finds them too. With no key it skips gracefully — FTS still
// works on its own.
//
// Run:  node scripts/seed_qurm_services.mjs
// ────────────────────────────────────────────────────────────

import 'dotenv/config';
import { db } from '../lib/db.js';
import { normalize } from '../lib/catalogue.js';
import { computeEmbeddingText } from '../lib/embeddings.js';
import { embed } from '../lib/llm.js';

const ID_BASE = 200001;

// Entities (ROP = visa/licence/vehicle/company-reg/police-clearance/phone;
// Customs = Bayan/export/import).
const ROP = { entity_ar: 'شرطة عمان السلطانية', entity_en: 'Royal Oman Police' };
const CUSTOMS = { entity_ar: 'الإدارة العامة للجمارك', entity_en: 'Directorate General of Customs' };

// Small helper: turn a verbatim Arabic doc label + an English translation into
// the canonical required-document shape. `code` is a short ascii slug.
const doc = (code, label_ar, label_en) => ({ code, label_ar, label_en, type: 'file' });

// ── The 25 services ───────────────────────────────────────────
// office_fee_omr = the listed عمولة المكتب (office commission).
const SERVICES = [
  {
    name_ar: 'خدمة تقديم تأشيرة عمل (جديدة)',
    name_en: 'Work Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('labour_permit', 'المأذونية (تصريح العمل)', 'Labour clearance (work permit)'),
      doc('medical_test', 'الفحص الطبي', 'Medical examination'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة زيارة عائليّة (جديدة)',
    name_en: 'Family Visit Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('labour_permit', 'المأذونية (تصريح العمل)', 'Labour clearance (work permit)'),
      doc('kinship_proof', 'إثبات صلة القرابة', 'Proof of kinship'),
      doc('undertaking_letter', 'رسالة تعهد', 'Letter of undertaking'),
      doc('sponsor_passport', 'صورة من جواز الملتحق به', 'Sponsor passport copy'),
      doc('sponsor_residency', 'صورة من اقامة الملتحق به', 'Sponsor residency-card copy'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة التحاق بالاقارب (جديدة)',
    name_en: 'Family Join (Relatives) Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('labour_permit', 'المأذونية (تصريح العمل)', 'Labour clearance (work permit)'),
      doc('kinship_proof', 'إثبات صلة القرابة', 'Proof of kinship'),
      doc('undertaking_letter', 'رسالة تعهد', 'Letter of undertaking'),
      doc('sponsor_contract', 'عقد العمل الملتحق به', 'Sponsor employment contract'),
      doc('sponsor_passport', 'صورة من جواز الملتحق به', 'Sponsor passport copy'),
      doc('sponsor_residency', 'صورة من اقامة الملتحق به', 'Sponsor residency-card copy'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة سريعة (جديدة)',
    name_en: 'Express Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('labour_permit', 'المأذونية (تصريح العمل) ان وجد', 'Labour clearance (work permit) if any'),
      doc('visit_reason', 'إثبات سبب الزيارة', 'Proof of reason for visit'),
      doc('undertaking_letter', 'رسالة تعهد', 'Letter of undertaking'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة سياحية (جديدة)',
    name_en: 'Tourist Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة زوجة مواطن (جديدة)',
    name_en: "Citizen's Wife Visa Application (New)",
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من الجواز', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('husband_passport', 'صورة من جواز الزوج', "Husband's passport copy"),
      doc('husband_id', 'صورة البطاقة الشخصية للزوج', "Husband's ID card copy"),
      doc('marriage_contract', 'إثبات عقد الزواج (مصدق)', 'Marriage contract (attested)'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة الدراسية (جديدة)',
    name_en: 'Student Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('photos', 'صورتين شخصية', 'Two personal photos'),
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      doc('gov_approval', 'رسالة الموافقة من الجهة الحكومية', 'Approval letter from the government entity'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة مستثمر (جديدة)',
    name_en: 'Investor Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('photos', 'صورتين شخصية', 'Two personal photos'),
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      doc('medical_test', 'الفحص الطبي', 'Medical examination'),
      doc('labour_permit', 'تصريح العمل (المأذونية)', 'Work permit (labour clearance)'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تأشيرة مالك وحدة سكنية (جديدة)',
    name_en: 'Property Owner Visa Application (New)',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('photo', 'صورة شخصية', 'Personal photo'),
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      doc('title_deed_sketch', 'الملكية والكروكي', 'Title deed and site plan (kroki)'),
    ],
  },
  {
    name_ar: 'خدمة تقديم إصدار رخصة قيادة (جديدة)',
    name_en: 'Driving Licence Issuance Application (New)',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('photo', 'صورة شخصية', 'Personal photo'),
      doc('id_or_passport', 'صورة من جواز السفر او بطاقة الاقامة', 'Passport or residency-card copy'),
      doc('eye_test', 'فحص النظر', 'Eye (vision) test'),
    ],
  },
  {
    name_ar: 'خدمة تقديم تجديد رخصة قيادة (تجديد)',
    name_en: 'Driving Licence Renewal Application',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('photo', 'صورة شخصية', 'Personal photo'),
      doc('id_or_passport', 'صورة من جواز السفر او بطاقة الاقامة', 'Passport or residency-card copy'),
      doc('eye_test', 'فحص النظر', 'Eye (vision) test'),
    ],
  },
  {
    name_ar: 'خدمة تقديم نقل مركبة',
    name_en: 'Vehicle Ownership Transfer Application',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('mulkiya', 'ملكية المركبة', 'Vehicle ownership (Mulkiya)'),
      doc('seller_id', 'بطاقة الإقامة او الشخصية للبائع', "Seller's residency or ID card"),
      doc('buyer_id', 'بطاقة الإقامة او الشخصية للمشتري', "Buyer's residency or ID card"),
    ],
  },
  {
    name_ar: 'خدمة تقديم تجديد مركبة',
    name_en: 'Vehicle Registration Renewal Application',
    office_fee_omr: 2, ...ROP,
    docs: [
      doc('mulkiya', 'ملكية المركبة', 'Vehicle ownership (Mulkiya)'),
      doc('owner_id', 'بطاقة الإقامة او الشخصية صاحب المركبة', "Vehicle owner's residency or ID card"),
    ],
  },
  {
    name_ar: 'خدمة دفع المخالفات',
    name_en: 'Traffic Fines Payment',
    office_fee_omr: 1, ...ROP,
    docs: [
      doc('mulkiya', 'صور من ملكية المركبة', 'Vehicle ownership (Mulkiya) copy'),
      doc('owner_id', 'بطاقة الإقامة او الشخصية صاحب المركبة', "Vehicle owner's residency or ID card"),
    ],
  },
  {
    name_ar: 'خدمة تغير لون المركبة',
    name_en: 'Vehicle Colour Change',
    office_fee_omr: 1, ...ROP,
    docs: [
      doc('mulkiya', 'صور من ملكية المركبة', 'Vehicle ownership (Mulkiya) copy'),
      doc('colour_change_request', 'رسالة بطلب تغير لون المركبة', 'Letter requesting the vehicle colour change'),
      doc('insurance_approval', 'رسالة موافقة التأمين بتغير لون المركبة', 'Insurance approval letter for the colour change'),
    ],
  },
  {
    name_ar: 'خدمة تسجيل الشركات في موقع شرطة عمان السلطانية',
    name_en: 'Company Registration on the Royal Oman Police Portal',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('id_card', 'صور من بطاقة الإقامة او الشخصية', 'Residency or ID card copy'),
      doc('authorization_request', 'رسالة بطلب التفويض', 'Authorization request letter'),
      doc('cr_papers', 'أوراق السجل التجاري', 'Commercial registration (CR) papers'),
      doc('affiliation_cert', 'شهادة الانتساب', 'Membership / affiliation certificate'),
    ],
  },
  {
    name_ar: 'خدمة نقل تأشيرة عمل',
    name_en: 'Work Visa Transfer',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('residency_card', 'صورة من بطاقة الإقامة', 'Residency-card copy'),
      doc('noc_old_sponsor', 'رسالة عدم الممانعة من الكفيل القديم', 'No-objection letter from the previous sponsor'),
      doc('labour_permit', 'تصريح العمل (المأذونية)', 'Work permit (labour clearance)'),
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('transfer_form', 'استمارة نقل الخدمات', 'Services-transfer form'),
      doc('medical_test', 'الفحص الطبي', 'Medical examination'),
    ],
  },
  {
    name_ar: 'خدمة تحديث رقم الهاتف',
    name_en: 'Phone Number Update',
    office_fee_omr: 1, ...ROP,
    docs: [
      doc('new_number', 'الرقم الجديد', 'The new phone number'),
    ],
  },
  {
    name_ar: 'خدمة استخراج عدم المحكومية',
    name_en: 'Police Clearance Certificate Issuance',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('id_card', 'صورة من البطاقة الشخصية او الإقامة', 'ID or residency-card copy'),
      doc('reason', 'توضيح سبب استخراج عدم المحكومية', 'Statement of the reason for the certificate'),
      doc('email', 'ايميل/بريد إلكتروني ساري', 'Valid email address'),
    ],
  },
  {
    name_ar: 'خدمة تسجيل في بيان الجمركي',
    name_en: 'Bayan Customs Registration',
    office_fee_omr: 5, ...CUSTOMS,
    docs: [
      doc('id_card', 'صورة من البطاقة الشخصية او بطاقة الإقامة', 'ID or residency-card copy'),
      doc('email', 'ايميل/بريد إلكتروني ساري المفعول', 'Valid email address'),
      doc('reason', 'توضيح سبب تسجيل البيان', 'Statement of the reason for the Bayan registration'),
    ],
  },
  {
    name_ar: 'خدمة تصدير بضائع او مركبة',
    name_en: 'Export of Goods or a Vehicle',
    office_fee_omr: 5, ...CUSTOMS,
    docs: [
      doc('id_card', 'صورة من البطاقة الشخصية او بطاقة الإقامة', 'ID or residency-card copy'),
      doc('email', 'ايميل/بريد إلكتروني ساري المفعول', 'Valid email address'),
      doc('export_type', 'توضيح نوع التصدير', 'Statement of the export type'),
      doc('bayan_registration', 'بيان تسجيل في بيان', 'Bayan registration statement'),
    ],
  },
  {
    name_ar: 'خدمة استيراد بضائع او مركبة',
    name_en: 'Import of Goods or a Vehicle',
    office_fee_omr: 5, ...CUSTOMS,
    docs: [
      doc('id_card', 'صورة من البطاقة الشخصية او بطاقة الإقامة', 'ID or residency-card copy'),
      doc('email', 'ايميل/بريد إلكتروني ساري المفعول', 'Valid email address'),
      doc('import_type', 'توضيح نوع الاستيراد', 'Statement of the import type'),
      doc('bayan_registration', 'بيان تسجيل في بيان', 'Bayan registration statement'),
    ],
  },
  {
    name_ar: 'خدمة دفع مخالفة تاشيرة',
    name_en: 'Visa Violation Payment',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('id_card', 'صورة من البطاقة الشخصية او بطاقة الإقامة', 'ID or residency-card copy'),
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
    ],
  },
  {
    name_ar: 'خدمة تغير نوع تأشيرة من والى عمل',
    name_en: 'Visa Type Change To/From Work',
    office_fee_omr: 5, ...ROP,
    docs: [
      doc('passport_copy', 'صورة من جواز السفر', 'Passport copy'),
      doc('noc_issuer', 'عدم الممانعة من الجهة الصادرة للتأشيرة', 'No-objection from the visa-issuing entity'),
      doc('labour_permit', 'صورة تصريح العمل (المأذونية)', 'Work permit (labour clearance) copy'),
      doc('photo', 'صورة شمسية', 'Personal photo'),
      doc('medical_test', 'الفحص الطبي', 'Medical examination'),
    ],
  },
  {
    name_ar: 'خدمة تفويض تخليص تأشيرة',
    name_en: 'Visa Clearance Authorization',
    office_fee_omr: 3, ...ROP,
    docs: [
      doc('authorizer_id', 'صورة من البطاقة الشخصية او الإقامة لصاحب التفويض', "Authorizer's ID or residency-card copy"),
      doc('request_form', 'صورة نموذج الطلب', 'Application-form copy'),
      doc('labour_permit', 'تصريح العمل (المأذونية)', 'Work permit (labour clearance)'),
      doc('authorization_letter', 'رسالة التفويض', 'Authorization letter'),
      doc('authorized_id', 'صورة من بطاقة الإقامة او الشخصية للمفوض', "Authorized person's residency or ID card copy"),
    ],
  },
];

// Common attributes for every seeded row.
const BENEFICIARY = 'G2C • الأفراد';

function buildBlob(s) {
  // Mirror routes/office.js: lowercased name_en/name_ar/entity_en/entity_ar.
  // We also fold the doc labels in so token search hits on document phrases.
  const docPhrases = s.docs.map(d => `${d.label_ar} ${d.label_en}`).join(' ');
  return [s.name_en, s.name_ar, s.entity_en, s.entity_ar, docPhrases]
    .filter(Boolean).join(' ').toLowerCase();
}

async function main() {
  // Pull existing active names once for the idempotency check (mirrors the
  // route's dup-check: normalized name_ar / name_en).
  const { rows: existing } = await db.execute({
    sql: `SELECT id, name_ar, name_en FROM service_catalog`
  });
  const existingNorm = new Set();
  for (const r of existing) {
    if (r.name_ar) existingNorm.add(normalize(r.name_ar));
    if (r.name_en) existingNorm.add(normalize(r.name_en));
  }

  let nextId = ID_BASE;
  const inserted = []; // { id, name_ar }
  let skipped = 0;

  for (const s of SERVICES) {
    const nAr = normalize(s.name_ar);
    if (existingNorm.has(nAr)) {
      skipped++;
      console.log(`  ⏭  skip (exists): ${s.name_ar}`);
      continue;
    }

    const id = nextId++;
    const blob = buildBlob(s);
    const docsJson = JSON.stringify(s.docs);

    await db.execute({
      sql: `INSERT INTO service_catalog
              (id, entity_en, entity_ar, name_en, name_ar,
               required_documents_json, fee_omr, office_fee_omr, gov_fee_tbd,
               beneficiary, verification_status, verification_source, verified_at,
               is_active, is_launch, popularity, version, search_blob, source_url, updated_at)
            VALUES (?,?,?,?,?, ?, NULL, ?, 1,
                    ?, 'annotator_validated', 'annotator', datetime('now'),
                    1, 0, 0, 1, ?, ?, datetime('now'))`,
      args: [id, s.entity_en, s.entity_ar, s.name_en, s.name_ar,
             docsJson, s.office_fee_omr,
             BENEFICIARY, blob, `seed_qurm:${id}`]
    });

    // External-content FTS5: index the row by rowid. We populate every column
    // that has data so both lexical lanes (name + blob) can hit.
    try {
      await db.execute({
        sql: `INSERT INTO service_catalog_fts
                (rowid, name_en, name_ar, description_en, description_ar,
                 entity_en, entity_ar, entity_dept_en, entity_dept_ar,
                 beneficiary, main_service, search_blob)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, s.name_en, s.name_ar, '', '',
               s.entity_en, s.entity_ar, '', '',
               BENEFICIARY, '', blob]
      });
    } catch (e) {
      console.warn(`  ⚠ FTS index failed for ${id}: ${e.message}`);
    }

    // Audit trail (mirrors the route).
    try {
      await db.execute({
        sql: `INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,diff_json)
              VALUES ('system', 0, 'service_seed', 'service', ?, ?)`,
        args: [id, JSON.stringify({ name_ar: s.name_ar, name_en: s.name_en, office_fee_omr: s.office_fee_omr, docs: s.docs.length })]
      });
    } catch { /* audit is best-effort */ }

    existingNorm.add(nAr);
    inserted.push({ id, name_ar: s.name_ar, ...s });
    console.log(`  ✓ inserted #${id}: ${s.name_ar}  (office_fee=${s.office_fee_omr} OMR, ${s.docs.length} docs)`);
  }

  // ── Embeddings (Qwen) — only the rows we just inserted. ──────
  let embedded = 0;
  if (inserted.length) {
    if (!process.env.QWEN_API_KEY) {
      console.log('\nℹ QWEN_API_KEY not set — skipping embeddings (FTS-only). ' +
                  'The boot embedPending() loop will fill embedding_json later when a key is present.');
    } else {
      console.log(`\nEmbedding ${inserted.length} new rows via Qwen…`);
      // Re-read the canonical rows so computeEmbeddingText sees exactly what's
      // stored (matches lib/embeddings.js embedPending columns).
      const ids = inserted.map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      const { rows } = await db.execute({
        sql: `SELECT id, name_en, name_ar, entity_en, entity_ar, entity_dept_en, entity_dept_ar,
                     beneficiary, main_service, description_en, description_ar, process_steps_json
                FROM service_catalog WHERE id IN (${ph})`,
        args: ids
      });
      const inputs = rows.map(computeEmbeddingText);
      const vecs = await embed(inputs);
      if (!vecs) {
        console.warn('  ⚠ embed() returned null (API unavailable) — rows left unembedded; boot loop will retry.');
      } else {
        const now = Date.now();
        await db.batch(
          rows.map((r, j) => ({
            sql: `UPDATE service_catalog SET embedding_json=?, embedded_at=? WHERE id=?`,
            args: [JSON.stringify(vecs[j] || []), now, r.id]
          })),
          'write'
        );
        embedded = rows.length;
        console.log(`  ✓ embedded ${embedded} rows (dim=${vecs[0]?.length}).`);
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  inserted: ${inserted.length}`);
  console.log(`  skipped (already present): ${skipped}`);
  console.log(`  embedded: ${embedded}${process.env.QWEN_API_KEY ? '' : ' (no QWEN_API_KEY)'}`);
  if (inserted.length) {
    console.log(`  id range: ${inserted[0].id}–${inserted[inserted.length - 1].id}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('seed failed:', e); process.exit(1); });
