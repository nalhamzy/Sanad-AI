// ────────────────────────────────────────────────────────────
// TOOLS the agent can call.
//
// Each tool has a JSON Schema (for Qwen function calling) and an async
// implementation. The same tools are used by the LLM path AND the heuristic
// fallback, so behaviour is consistent whether a Qwen key is set or not.
// ────────────────────────────────────────────────────────────

import { db } from './db.js';
import { matchService, getServiceById, LAUNCH_SERVICES, normalize } from './catalogue.js';
import { expandQuery } from './query_rewriter.js';

// ─── Schema (shared by both paths) ──────────────────────────

export const TOOL_SPEC = [
  {
    type: 'function',
    function: {
      name: 'search_services',
      description: 'Search the Oman government services catalogue (3,422 services). Returns the best matches with id, name, entity, fee. Use this FIRST any time the user asks about a service.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the user is looking for, in their own words (AR or EN).' },
          limit: { type: 'integer', default: 5 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_service_details',
      description: 'Get FULL details of one service: description, fees, required documents, process steps, source URL. Call after search_services.',
      parameters: {
        type: 'object',
        properties: { service_id: { type: 'integer' } },
        required: ['service_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_entities',
      description: 'List all government entities with service counts. Call when the user wants to browse or asks "which ministries".',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_entity_services',
      description: 'List services offered by one entity. Call when the user says "ROP services", "خدمات وزارة الصحة", etc.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Entity name (EN or AR) or common abbreviation (rop, moh, mol, …).' },
          limit: { type: 'integer', default: 10 }
        },
        required: ['entity']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_submission',
      description: 'Begin the document-collection flow for a SUPPORTED service. The bot will then walk the citizen through each required document. Only call after the user has clearly confirmed they want to submit.',
      parameters: {
        type: 'object',
        properties: {
          service_code: {
            type: 'string',
            enum: Object.keys(LAUNCH_SERVICES),
            description: 'One of: drivers_licence_renewal, civil_id_renewal, passport_renewal, mulkiya_renewal, cr_issuance.'
          }
        },
        required: ['service_code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_request_status',
      description: 'Look up the status of an existing request the citizen already submitted.',
      parameters: {
        type: 'object',
        properties: { request_id: { type: 'integer' } },
        required: ['request_id']
      }
    }
  }
];

// ─── Entity alias map ───────────────────────────────────────
const ENTITY_ALIASES = {
  'rop':'Royal Oman Police','شرطة':'Royal Oman Police','royal oman police':'Royal Oman Police',
  'mociip':'MOCIIP','تجارة':'MOCIIP','commerce':'MOCIIP',
  'mol':'Ministry of Labour','العمل':'Ministry of Labour','labour':'Ministry of Labour',
  'moh':'Ministry of Health','الصحة':'Ministry of Health','health':'Ministry of Health',
  'moe':'Ministry of Education','التربية':'Ministry of Education','education':'Ministry of Education',
  'maf':'Ministry of Agriculture','الزراعة':'Ministry of Agriculture','agriculture':'Ministry of Agriculture',
  'mtcit':'Ministry of Transport','النقل':'Ministry of Transport','transport':'Ministry of Transport',
  'civil status':'Civil Status','الأحوال':'Civil Status','الاحوال':'Civil Status',
  'judiciary':'Judiciary','القضاء':'Judiciary'
};

function resolveEntity(raw) {
  if (!raw) return '';
  const key = raw.toLowerCase().trim();
  return ENTITY_ALIASES[key] || ENTITY_ALIASES[normalize(raw)] || raw;
}

// ─── Implementations ───────────────────────────────────────

export const TOOL_IMPL = {

  async search_services({ query, limit = 5 }) {
    // 1. Expand the query into synonymous phrasings (dialect + MSA + EN)
    const variants = await expandQuery(query);

    // 2. Run each variant through matchService, union candidates by id
    const pool = new Map();   // id → { row, best_score, via: [queries that hit] }
    let launchHit = null;
    for (const v of variants) {
      const m = await matchService(v, {});
      if (!m) continue;
      if (m.source === 'launch' && !launchHit) {
        launchHit = { code: m.code, service: m.service, via: v };
      }
      if (m.source === 'catalogue') {
        for (const c of m.candidates) {
          const prev = pool.get(c.id);
          if (!prev || (c._score || 0) > prev.best_score) {
            pool.set(c.id, {
              row: c,
              best_score: c._score || 0,
              via: prev ? prev.via.concat([v]) : [v]
            });
          } else {
            prev.via.push(v);
          }
        }
      }
    }

    // 3. Rank: launch hit always first; catalogue by best_score
    const catalogue = Array.from(pool.values())
      .sort((a, b) => b.best_score - a.best_score)
      .slice(0, launchHit ? limit - 1 : limit);

    const services = [];
    if (launchHit) {
      const s = launchHit.service;
      services.push({
        id: -1,                             // sentinel — caller uses launch_code
        name_en: s.name_en, name_ar: s.name_ar,
        entity_en: s.entity_en, entity_ar: s.entity_ar,
        fee_omr: s.fee_omr,
        required_documents: s.required_documents.map(d => d.label_en),
        can_submit: true,
        matched_via: launchHit.via
      });
    }
    for (const c of catalogue) {
      services.push({
        id: c.row.id,
        name_en: c.row.name_en, name_ar: c.row.name_ar,
        entity_en: c.row.entity_en, entity_ar: c.row.entity_ar,
        fee_omr: c.row.fee_omr, fees_text: c.row.fees_text,
        can_submit: false,
        matched_via: c.via[0]        // the phrase that best matched
      });
    }

    // 4. Confidence: gap between top and runner-up (or launch → 1.0)
    let confidence;
    if (launchHit) {
      confidence = 1;
    } else if (catalogue.length <= 1) {
      confidence = catalogue.length ? 0.6 : 0;
    } else {
      const gap = catalogue[0].best_score - catalogue[1].best_score;
      confidence = Math.min(1, Math.max(0.3, 0.5 + gap / 40));
    }

    return {
      ok: true,
      count: services.length,
      confidence: Math.round(confidence * 100) / 100,
      launch_code: launchHit?.code,
      variants_tried: variants.slice(0, 5),
      services
    };
  },

  async get_service_details({ service_id }) {
    const s = await getServiceById(service_id);
    if (!s) return { ok: false, error: 'not_found' };
    let docs = [];
    try { docs = JSON.parse(s.required_documents_json || '[]'); } catch {}
    const isLaunch = !!Object.values(LAUNCH_SERVICES).find(ls => ls.name_en === s.name_en);
    return {
      ok: true, service: {
        id: s.id,
        name_en: s.name_en, name_ar: s.name_ar,
        entity_en: s.entity_en, entity_ar: s.entity_ar,
        description_en: (s.description_en || '').slice(0, 400),
        description_ar: (s.description_ar || '').slice(0, 400),
        fee_omr: s.fee_omr, fees_text: s.fees_text,
        required_documents: docs.map(d => d.label_en || d.code),
        source_url: s.source_url,
        can_submit: isLaunch
      }
    };
  },

  async list_entities() {
    const { rows } = await db.execute(`
      SELECT entity_en, entity_ar, COUNT(*) AS n
        FROM service_catalog WHERE entity_en != ''
        GROUP BY entity_en ORDER BY n DESC LIMIT 12`);
    return { ok: true, entities: rows };
  },

  async get_entity_services({ entity, limit = 10 }) {
    const key = resolveEntity(entity);
    const { rows } = await db.execute({
      sql: `SELECT id, name_en, name_ar, fee_omr FROM service_catalog
             WHERE LOWER(entity_en) LIKE ? OR entity_ar LIKE ?
             ORDER BY id LIMIT ?`,
      args: [`%${key.toLowerCase()}%`, `%${key}%`, limit]
    });
    return { ok: true, entity: key, count: rows.length, services: rows };
  },

  async start_submission({ service_code }) {
    if (!LAUNCH_SERVICES[service_code]) return { ok: false, error: 'unsupported_service' };
    return { ok: true, service_code, transition: 'collecting' };
  },

  async get_request_status({ request_id }) {
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.status, r.fee_omr, r.created_at, r.claimed_at, r.completed_at,
                   s.name_en AS service_name, o.name_en AS office_name
              FROM request r
              LEFT JOIN service_catalog s ON s.id = r.service_id
              LEFT JOIN office o ON o.id = r.office_id
             WHERE r.id=?`,
      args: [request_id]
    });
    if (!rows.length) return { ok: false, error: 'not_found' };
    return { ok: true, request: rows[0] };
  }
};
