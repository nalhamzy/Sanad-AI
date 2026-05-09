// Build a worklist for online verification of catalogue services across the
// 6 priority entities (ROP, MOC, MOL, MM, MOH, MOHUP). Picks the services
// most likely to be high-value for citizens (those that already have docs
// AND steps populated, or are within the launch service set).
//
// Output: data/verify_worklist.json — array of {id, entity, name, url, ar_name, current_docs, current_steps, priority}.
//
// Usage: node scripts/_build_verify_worklist.mjs [--per-entity 20]

import { db } from '../lib/db.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));

const argv = process.argv.slice(2);
const perEnt = Number((argv.find(a => a.startsWith('--per-entity')) || '--per-entity=20').split('=')[1]) ||
              (() => { const i = argv.indexOf('--per-entity'); return i >= 0 ? Number(argv[i+1]) : 20; })();

const ENTITIES = [
  { tag: 'ROP',  en: 'Royal Oman Police' },
  { tag: 'MOC',  en: 'Ministry of Commerce, Industry and Investment Promotion' },
  { tag: 'MOL',  en: 'Ministry of Labour' },
  { tag: 'MM',   en: 'Muscat Municipality' },
  { tag: 'MOH',  en: 'Ministry of Health' },
  { tag: 'MOHUP',en: 'Ministry of Housing and Urban Planning' }
];

const out = [];
for (const ent of ENTITIES) {
  // Prioritize services with BOTH docs AND steps already present (high
  // signal for "well-documented service in catalogue we can cross-check"),
  // then fill with docs-only or fee-known rows.
  const r = await db.execute({
    sql: `
      SELECT id, name_en, name_ar, source_url, fee_omr, fees_text,
             required_documents_json, process_steps_json
        FROM service_catalog
       WHERE entity_en = ?
         AND source_url IS NOT NULL AND source_url != ''
       ORDER BY
         (CASE WHEN required_documents_json IS NOT NULL AND length(required_documents_json) > 5
                AND process_steps_json     IS NOT NULL AND length(process_steps_json)     > 5
               THEN 0 ELSE 1 END),
         (CASE WHEN required_documents_json IS NOT NULL AND length(required_documents_json) > 5 THEN 0 ELSE 1 END),
         id
       LIMIT ?`,
    args: [ent.en, perEnt]
  });
  for (const row of r.rows) {
    let docs = []; let steps = [];
    try { docs  = JSON.parse(row.required_documents_json || '[]'); } catch {}
    try { steps = JSON.parse(row.process_steps_json     || '[]'); } catch {}
    out.push({
      id: row.id,
      entity: ent.tag,
      entity_en: ent.en,
      name_en: row.name_en,
      name_ar: row.name_ar,
      url: row.source_url,
      fee_omr: row.fee_omr,
      fees_text: row.fees_text,
      current_docs_count: docs.length,
      current_steps_count: steps.length,
      current_docs: docs,
      current_steps: steps
    });
  }
}

mkdirSync(join(projectRoot, 'data'), { recursive: true });
const path = join(projectRoot, 'data', 'verify_worklist.json');
writeFileSync(path, JSON.stringify(out, null, 2), 'utf8');
console.log(`worklist: ${out.length} services → ${path}`);
const byEnt = out.reduce((acc, x) => { acc[x.entity] = (acc[x.entity] || 0) + 1; return acc; }, {});
for (const [k, v] of Object.entries(byEnt)) console.log(`  ${k}: ${v}`);
process.exit(0);
