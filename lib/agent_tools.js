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
import { searchServices as hybridSearch } from './hybrid_search.js';

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

// ────────────────────────────────────────────────────────────
// Agent v2 — unified tool surface used by runAgentV2.
//
// These tools are richer than v1: they operate on the full catalogue (not
// just the 5 launch codes), expose filters (entity / beneficiary / payment
// method / channel / launch-only / price), and drive session state directly
// (confirm, record_document, cancel, accept_offer, ...). v1 TOOL_SPEC and
// TOOL_IMPL above are kept intact so the heuristic fallback keeps working
// and all pinned tests stay green.
// ────────────────────────────────────────────────────────────

export const TOOL_SPEC_V2 = [
  {
    type: 'function',
    function: {
      name: 'search_services',
      description: 'Hybrid search over the 3,400+ Oman gov services (FTS5 keywords + semantic embeddings). Use this whenever the user asks about ANY service. You can combine the free-text query with structured filters.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'User intent in their own words (AR or EN).' },
          entity: { type: 'string', description: 'Filter by ministry/entity name (EN or AR), e.g. "Royal Oman Police", "شرطة عمان".' },
          beneficiary: { type: 'string', description: 'Who the service is for: "Citizen", "Resident", "Business".' },
          payment_method: { type: 'string', description: '"Online", "On-site", etc.' },
          channel: { type: 'string', description: 'One of: web, app, kiosk, counter, phone, email.' },
          is_launch: { type: 'boolean', description: 'Restrict to the 5 curated launch flows (fast submission).' },
          max_fee_omr: { type: 'number', description: 'Only services whose fee is <= this.' },
          free: { type: 'boolean', description: 'Only services that cost 0 OMR.' },
          limit: { type: 'integer', default: 8 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_service_details',
      description: 'Return ALL details for a single service: description, fees, docs, process steps, avg time, channels, working hours.',
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
      description: 'List top entities with service counts. Use when the user asks "which ministries" / "قائمة".',
      parameters: { type: 'object', properties: { beneficiary: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_categories',
      description: 'List the top MainService categories (parent groupings) in the catalogue.',
      parameters: { type: 'object', properties: { entity: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_entity_services',
      description: 'All services from one ministry.',
      parameters: {
        type: 'object',
        properties: { entity: { type: 'string' }, limit: { type: 'integer', default: 20 } },
        required: ['entity']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_services',
      description: 'Side-by-side diff of 2-3 services (fees, docs, avg time, channels).',
      parameters: {
        type: 'object',
        properties: {
          service_ids: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 3 }
        },
        required: ['service_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_submission',
      description: 'Create a draft request for a service and move the session to CONFIRMING (citizen must confirm before we collect docs). Use any service_id from search_services — not just the 5 launch codes.',
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
      name: 'confirm_submission',
      description: 'Citizen confirmed they want to submit — move from CONFIRMING to COLLECTING.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_document',
      description: 'Mark one required document as provided. Use this when a file is uploaded OR when the citizen types a caption confirming they sent a specific doc.',
      parameters: {
        type: 'object',
        properties: {
          doc_code: { type: 'string', description: 'Matches one of the keys from get_service_details.required_documents.' },
          filename: { type: 'string' },
          caption:  { type: 'string' }
        },
        required: ['doc_code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_request',
      description: 'All documents collected — queue the request for office pickup. Confirms the final total and transitions to QUEUED.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_my_requests',
      description: 'List the citizen\'s active + recent requests.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Optional filter: collecting|ready|queued|claimed|in_progress|completed|cancelled' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_request_status',
      description: 'Detailed status of one request. If request_id is omitted, falls back to the current session request.',
      parameters: {
        type: 'object',
        properties: { request_id: { type: 'integer' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_offers',
      description: 'List the offers offices have submitted for a request (anonymized — only office_id, fees, ETA, rating).',
      parameters: {
        type: 'object',
        properties: { request_id: { type: 'integer' } },
        required: ['request_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'accept_offer',
      description: 'Citizen accepts one offer. Binds the request to that office and transitions to CLAIMED.',
      parameters: {
        type: 'object',
        properties: { offer_id: { type: 'integer' } },
        required: ['offer_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_request',
      description: 'Cancel a request. Hard-cancels while ready/queued; after claimed it just marks a cancel intent and pings the office.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'integer' },
          reason:     { type: 'string' }
        },
        required: ['request_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_document',
      description: 'Reopen one document slot on an existing request so the citizen can upload a fresh file. Sets status back to collecting.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'integer' },
          doc_code:   { type: 'string' }
        },
        required: ['request_id', 'doc_code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: 'Attach a free-text note from the citizen to a request (visible to the assigned office).',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'integer' },
          text:       { type: 'string' }
        },
        required: ['request_id', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_session_state',
      description: 'Debug-only: read the current session state. Use if you\'re unsure what state you\'re in.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ─── Agent v2 implementations ──────────────────────────────
//
// Every tool handler here takes (ctx, args) where ctx is:
//   { session_id, state, trace, citizen_phone }
// Handlers may mutate ctx.state in place; runAgentV2 persists it at the end
// of the turn. They return { ok, ... } JSON the LLM can read.

async function _ensureCitizen(phone) {
  if (!phone) return null;
  const { rows } = await db.execute({ sql: `SELECT id FROM citizen WHERE phone=?`, args: [phone] });
  if (rows.length) return rows[0].id;
  const r = await db.execute({ sql: `INSERT INTO citizen(phone) VALUES (?)`, args: [phone] });
  return Number(r.lastInsertRowid);
}

function _parseDocs(row) {
  try { return JSON.parse(row.required_documents_json || '[]'); } catch { return []; }
}

function _parseSteps(row) {
  try { return JSON.parse(row.process_steps_json || '[]'); } catch { return []; }
}

export const TOOL_IMPL_V2 = {

  async search_services(ctx, args) {
    const { query, limit = 8, ...filters } = args || {};
    const filterClean = {};
    for (const k of ['entity', 'beneficiary', 'payment_method', 'channel', 'is_launch', 'max_fee_omr', 'free']) {
      if (args?.[k] !== undefined && args[k] !== null && args[k] !== '') filterClean[k] = args[k];
    }
    const { services, count } = await hybridSearch(query || '', filterClean, { k: limit, trace: ctx.trace });
    return { ok: true, count, query, filters: filterClean, services };
  },

  async get_service_details(ctx, { service_id }) {
    const svc = await getServiceById(service_id);
    if (!svc) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      service: {
        id: svc.id,
        name_en: svc.name_en, name_ar: svc.name_ar,
        entity_en: svc.entity_en, entity_ar: svc.entity_ar,
        entity_dept_en: svc.entity_dept_en, entity_dept_ar: svc.entity_dept_ar,
        beneficiary: svc.beneficiary, main_service: svc.main_service,
        description_en: (svc.description_en || '').slice(0, 500),
        description_ar: (svc.description_ar || '').slice(0, 500),
        special_conditions_en: svc.special_conditions_en,
        special_conditions_ar: svc.special_conditions_ar,
        fee_omr: svc.fee_omr, fees_text: svc.fees_text,
        payment_method: svc.payment_method,
        avg_time_en: svc.avg_time_en, avg_time_ar: svc.avg_time_ar,
        working_time_en: svc.working_time_en, working_time_ar: svc.working_time_ar,
        channels: svc.channels, num_steps: svc.num_steps,
        required_documents: _parseDocs(svc),
        process_steps: _parseSteps(svc),
        is_launch: !!svc.is_launch,
        source_url: svc.source_url
      }
    };
  },

  async list_entities(ctx, { beneficiary } = {}) {
    const wh = [`entity_en != ''`];
    const args = [];
    if (beneficiary) { wh.push(`LOWER(COALESCE(beneficiary,'')) LIKE ?`); args.push(`%${beneficiary.toLowerCase()}%`); }
    const { rows } = await db.execute({
      sql: `SELECT entity_en, entity_ar, COUNT(*) AS n
              FROM service_catalog WHERE ${wh.join(' AND ')}
             GROUP BY entity_en ORDER BY n DESC LIMIT 15`,
      args
    });
    return { ok: true, entities: rows };
  },

  async list_categories(ctx, { entity } = {}) {
    const wh = [`COALESCE(main_service,'') != ''`];
    const args = [];
    if (entity) { wh.push(`(LOWER(entity_en) LIKE ? OR entity_ar LIKE ?)`); args.push(`%${entity.toLowerCase()}%`, `%${entity}%`); }
    const { rows } = await db.execute({
      sql: `SELECT main_service, COUNT(*) AS n
              FROM service_catalog WHERE ${wh.join(' AND ')}
             GROUP BY main_service ORDER BY n DESC LIMIT 15`,
      args
    });
    return { ok: true, categories: rows };
  },

  async get_entity_services(ctx, { entity, limit = 20 }) {
    const { rows } = await db.execute({
      sql: `SELECT id, name_en, name_ar, fee_omr, is_launch
              FROM service_catalog
             WHERE is_active=1 AND (LOWER(entity_en) LIKE ? OR entity_ar LIKE ?)
             ORDER BY is_launch DESC, id LIMIT ?`,
      args: [`%${entity.toLowerCase()}%`, `%${entity}%`, limit]
    });
    return { ok: true, entity, count: rows.length, services: rows };
  },

  async compare_services(ctx, { service_ids }) {
    if (!Array.isArray(service_ids) || service_ids.length < 2) {
      return { ok: false, error: 'need_at_least_two' };
    }
    const rows = [];
    for (const id of service_ids.slice(0, 3)) {
      const svc = await getServiceById(id);
      if (!svc) continue;
      rows.push({
        id: svc.id,
        name_en: svc.name_en, name_ar: svc.name_ar,
        entity_en: svc.entity_en,
        fee_omr: svc.fee_omr, fees_text: svc.fees_text,
        avg_time_en: svc.avg_time_en,
        channels: svc.channels,
        required_documents: _parseDocs(svc).slice(0, 6).map(d => d.label_en || d.code)
      });
    }
    return { ok: true, compared: rows };
  },

  async start_submission(ctx, { service_id }) {
    const svc = await getServiceById(service_id);
    if (!svc) return { ok: false, error: 'service_not_found' };
    // Draft request — state stays 'collecting' in the DB but the session
    // is 'confirming' until confirm_submission fires, so the LLM can
    // re-describe the service and wait for user OK.
    ctx.state.status = 'confirming';
    ctx.state.service_id = svc.id;
    ctx.state.service_code = svc.name_en; // informational only
    ctx.state.collected = {};
    ctx.state.pending_doc_index = 0;
    ctx.state.docs = _parseDocs(svc);
    return {
      ok: true,
      service_id: svc.id,
      name_en: svc.name_en,
      fee_omr: svc.fee_omr,
      required_documents: ctx.state.docs.map(d => ({ code: d.code, label_en: d.label_en, label_ar: d.label_ar })),
      next: 'ask_user_to_confirm',
      transition: 'confirming'
    };
  },

  async confirm_submission(ctx) {
    if (ctx.state.status !== 'confirming') return { ok: false, error: `not_in_confirming (state=${ctx.state.status})` };
    ctx.state.status = 'collecting';
    ctx.state.pending_doc_index = 0;
    const docs = ctx.state.docs || [];
    return {
      ok: true,
      transition: 'collecting',
      total_docs: docs.length,
      first_doc: docs[0] || null
    };
  },

  async record_document(ctx, { doc_code, filename, caption }) {
    if (!['collecting', 'reviewing'].includes(ctx.state.status)) {
      return { ok: false, error: `not_collecting (state=${ctx.state.status})` };
    }
    const docs = ctx.state.docs || [];
    const doc = docs.find(d => d.code === doc_code);
    if (!doc) return { ok: false, error: 'unknown_doc_code', available: docs.map(d => d.code) };

    // Pull the real upload details off the attachment if present. The chat
    // route hands us { url, mime, size, name } on multer uploads; without
    // these the officer dashboard can't render / download the doc.
    const att = ctx.attachment || null;
    ctx.state.collected = ctx.state.collected || {};
    ctx.state.collected[doc_code] = {
      filename: filename || att?.name || null,
      storage_url: att?.url || null,
      mime: att?.mime || null,
      size_bytes: att?.size || null,
      caption: caption || null,
      at: Date.now()
    };
    // Mark attachment consumed so a single upload isn't double-recorded if the
    // LLM loops or recovers — important for burst-message safety.
    if (att) ctx.attachment = null;

    // Advance pointer past already-filled slots
    let idx = 0;
    while (idx < docs.length && ctx.state.collected[docs[idx].code]) idx++;
    ctx.state.pending_doc_index = idx;
    const done = idx >= docs.length;
    if (done) ctx.state.status = 'reviewing';
    return {
      ok: true,
      recorded: doc_code,
      has_file: !!att?.url,
      collected_count: Object.keys(ctx.state.collected).length,
      total_docs: docs.length,
      next_doc: done ? null : docs[idx],
      transition: done ? 'reviewing' : 'collecting'
    };
  },

  async submit_request(ctx) {
    if (ctx.state.status !== 'reviewing') {
      return { ok: false, error: `not_ready (state=${ctx.state.status}) — collect docs first` };
    }
    const service_id = ctx.state.service_id;
    if (!service_id) return { ok: false, error: 'no_active_service' };
    const svc = await getServiceById(service_id);
    if (!svc) return { ok: false, error: 'service_missing' };
    const citizen_id = await _ensureCitizen(ctx.citizen_phone);
    const ins = await db.execute({
      sql: `INSERT INTO request(session_id,citizen_id,service_id,status,fee_omr,governorate,state_json)
            VALUES (?,?,?, 'ready', ?, 'Muscat', ?)`,
      args: [ctx.session_id, citizen_id, svc.id, svc.fee_omr ?? null, JSON.stringify(ctx.state)]
    });
    const request_id = Number(ins.lastInsertRowid);
    const docs = ctx.state.docs || [];
    for (const doc of docs) {
      const hit = ctx.state.collected?.[doc.code];
      if (!hit) continue;
      await db.execute({
        sql: `INSERT INTO request_document(request_id,doc_code,label,storage_url,mime,size_bytes,status,caption,matched_via,original_name)
              VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
        args: [request_id, doc.code, doc.label_en || doc.code,
               hit.storage_url || null, hit.mime || null, hit.size_bytes || null,
               hit.caption || null, hit.storage_url ? 'upload' : 'caption',
               hit.filename || null]
      });
    }
    ctx.state.status = 'queued';
    ctx.state.request_id = request_id;
    return { ok: true, request_id, fee_omr: svc.fee_omr, transition: 'queued' };
  },

  async get_my_requests(ctx, { status } = {}) {
    const wh = [`r.session_id=?`];
    const args = [ctx.session_id];
    if (status) { wh.push(`r.status=?`); args.push(status); }
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.status, r.fee_omr, r.created_at, r.cancel_requested,
                   s.name_en AS service_name, s.name_ar AS service_name_ar,
                   o.name_en AS office_name
              FROM request r
              LEFT JOIN service_catalog s ON s.id=r.service_id
              LEFT JOIN office o ON o.id=r.office_id
             WHERE ${wh.join(' AND ')}
             ORDER BY r.id DESC LIMIT 20`,
      args
    });
    return { ok: true, count: rows.length, requests: rows };
  },

  async get_request_status(ctx, { request_id }) {
    const rid = request_id ?? ctx.state.request_id;
    if (!rid) return { ok: false, error: 'no_request' };
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.status, r.fee_omr, r.created_at, r.claimed_at, r.completed_at,
                   r.cancel_requested, r.cancelled_at,
                   s.name_en AS service_name, s.name_ar AS service_name_ar,
                   o.name_en AS office_name, o.rating AS office_rating
              FROM request r
              LEFT JOIN service_catalog s ON s.id=r.service_id
              LEFT JOIN office o ON o.id=r.office_id
             WHERE r.id=?`,
      args: [rid]
    });
    if (!rows.length) return { ok: false, error: 'not_found' };
    return { ok: true, request: rows[0] };
  },

  async list_offers(ctx, { request_id }) {
    const { rows } = await db.execute({
      sql: `SELECT ro.id AS offer_id, ro.office_fee_omr, ro.government_fee_omr,
                   ro.quoted_fee_omr, ro.estimated_hours, ro.status,
                   o.name_en AS office_name, o.name_ar AS office_name_ar,
                   o.rating, o.total_completed
              FROM request_offer ro
              JOIN office o ON o.id=ro.office_id
             WHERE ro.request_id=? AND ro.status='pending'
             ORDER BY ro.quoted_fee_omr ASC LIMIT 10`,
      args: [request_id]
    });
    return { ok: true, count: rows.length, offers: rows };
  },

  async accept_offer(ctx, { offer_id }) {
    const { rows } = await db.execute({
      sql: `SELECT id, request_id, office_id, officer_id, office_fee_omr,
                   government_fee_omr, quoted_fee_omr, status
              FROM request_offer WHERE id=?`,
      args: [offer_id]
    });
    if (!rows.length) return { ok: false, error: 'offer_not_found' };
    const off = rows[0];
    if (off.status !== 'pending') return { ok: false, error: `offer_${off.status}` };

    // Transactional-ish update: mark this offer accepted, others rejected,
    // bind the request, deduct credit. Any one failure leaves the system
    // in a recoverable state (offer row survives for audit).
    await db.execute({
      sql: `UPDATE request_offer SET status='accepted', updated_at=datetime('now') WHERE id=?`,
      args: [offer_id]
    });
    await db.execute({
      sql: `UPDATE request_offer SET status='rejected', updated_at=datetime('now')
             WHERE request_id=? AND id <> ? AND status='pending'`,
      args: [off.request_id, offer_id]
    });
    await db.execute({
      sql: `UPDATE request SET status='claimed', office_id=?, officer_id=?,
                   accepted_offer_id=?, quoted_fee_omr=?, office_fee_omr=?, government_fee_omr=?,
                   claimed_at=datetime('now'), last_event_at=datetime('now')
             WHERE id=?`,
      args: [off.office_id, off.officer_id, off.id, off.quoted_fee_omr,
             off.office_fee_omr, off.government_fee_omr, off.request_id]
    });
    // Credit deduction (idempotent — UNIQUE index on (office_id, request_id)).
    try {
      const { rows: oRows } = await db.execute({
        sql: `SELECT credits_remaining FROM office WHERE id=?`, args: [off.office_id]
      });
      const remaining = (oRows[0]?.credits_remaining ?? 0) - 1;
      await db.execute({
        sql: `UPDATE office SET credits_remaining=?, credits_total_used=credits_total_used+1,
                     offers_won=offers_won+1 WHERE id=?`,
        args: [remaining, off.office_id]
      });
      await db.execute({
        sql: `INSERT INTO credit_ledger(office_id,request_id,delta,reason,balance_after)
              VALUES (?,?, -1, 'offer_accepted', ?)`,
        args: [off.office_id, off.request_id, remaining]
      });
    } catch (e) { /* already charged for this request — fine */ }

    ctx.state.status = 'claimed';
    ctx.state.request_id = off.request_id;
    return { ok: true, request_id: off.request_id, office_id: off.office_id, transition: 'claimed' };
  },

  async cancel_request(ctx, { request_id, reason }) {
    const rid = request_id ?? ctx.state.request_id;
    if (!rid) return { ok: false, error: 'no_request' };
    const { rows } = await db.execute({
      sql: `SELECT id, status FROM request WHERE id=?`, args: [rid]
    });
    if (!rows.length) return { ok: false, error: 'not_found' };
    const cur = rows[0].status;
    if (['cancelled', 'completed'].includes(cur)) {
      return { ok: false, error: `already_${cur}` };
    }
    // Hard-cancel while still in pre-claim states.
    if (['collecting', 'ready', 'queued'].includes(cur)) {
      await db.execute({
        sql: `UPDATE request SET status='cancelled', cancel_requested=1,
                     cancel_reason=?, cancelled_at=datetime('now'),
                     last_event_at=datetime('now') WHERE id=?`,
        args: [reason || null, rid]
      });
      if (ctx.state.request_id === rid) ctx.state.status = 'idle';
      return { ok: true, request_id: rid, outcome: 'hard_cancelled', from: cur };
    }
    // Post-claim: mark intent only. Office must confirm.
    await db.execute({
      sql: `UPDATE request SET cancel_requested=1, cancel_reason=?, last_event_at=datetime('now') WHERE id=?`,
      args: [reason || null, rid]
    });
    return { ok: true, request_id: rid, outcome: 'cancel_requested', from: cur, note: 'office_must_confirm' };
  },

  async replace_document(ctx, { request_id, doc_code }) {
    const rid = request_id ?? ctx.state.request_id;
    if (!rid) return { ok: false, error: 'no_request' };
    const { rows } = await db.execute({
      sql: `SELECT id, status FROM request WHERE id=?`, args: [rid]
    });
    if (!rows.length) return { ok: false, error: 'not_found' };
    if (['completed', 'cancelled'].includes(rows[0].status)) return { ok: false, error: `cannot_edit_${rows[0].status}` };
    await db.execute({
      sql: `DELETE FROM request_document WHERE request_id=? AND doc_code=?`,
      args: [rid, doc_code]
    });
    // Only bounce back to collecting for the active session request.
    if (ctx.state.request_id === rid && ['ready', 'reviewing'].includes(ctx.state.status)) {
      ctx.state.status = 'collecting';
      if (ctx.state.collected) delete ctx.state.collected[doc_code];
    }
    return { ok: true, request_id: rid, doc_code, transition: 'collecting' };
  },

  async add_note(ctx, { request_id, text }) {
    const rid = request_id ?? ctx.state.request_id;
    if (!rid) return { ok: false, error: 'no_request' };
    await db.execute({
      sql: `INSERT INTO message(request_id, session_id, direction, actor_type, body_text, channel)
            VALUES (?,?, 'in', 'citizen', ?, 'web')`,
      args: [rid, ctx.session_id, text]
    });
    return { ok: true, request_id: rid };
  },

  async get_session_state(ctx) {
    return {
      ok: true,
      state: {
        status: ctx.state.status,
        service_id: ctx.state.service_id || null,
        request_id: ctx.state.request_id || null,
        collected: Object.keys(ctx.state.collected || {}),
        pending_doc_index: ctx.state.pending_doc_index ?? 0,
        total_docs: (ctx.state.docs || []).length
      }
    };
  }
};
