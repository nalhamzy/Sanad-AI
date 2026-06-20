// lib/payouts.js
//
// Office settlement logic — the rules for "how much do we owe each office
// at the end of the week, after platform fees". Pure data + pure SQL;
// HTTP routing lives in routes/platform_admin.js.
//
// Workflow:
//   1. Admin picks an office + date range (typically last week).
//   2. previewPayout() lists eligible paid requests + totals — read-only.
//   3. generatePayout() writes an office_payout row and stamps each request
//      with payout_id so we never settle the same request twice.
//   4. markPayoutPaid() flips status='paid' + bank reference.
//   5. cancelPayout() releases the requests back to the eligible pool.
//   6. exportPayoutsCsv() produces a CSV (with UTF-8 BOM for Excel's
//      Arabic support) listing every payout in a date range.
//
// Platform fee:
//   • Per-request, integer baisa. Set via env PLATFORM_FEE_BAISA (default 500
//     baisa = 0.5 OMR).
//   • Stored on each office_payout snapshot at generation time, so changing
//     the env later doesn't retroactively re-cost old payouts.
//   • For % fees in the future, add PLATFORM_FEE_PCT and compute net=gross*(1-pct)
//     instead. The schema doesn't need to change.
//
// Eligibility rule for inclusion in a payout:
//   request.office_id = ?              — the office we're settling
//   request.payment_status = 'paid'    — actually charged
//   request.paid_at BETWEEN ? AND ?    — within the chosen period
//   request.payout_id IS NULL          — not already in a previous payout

import { db } from './db.js';

/** Platform fee per settled request, in OMR (env-overridable). */
export function platformFeeOmr() {
  const baisa = Number(process.env.PLATFORM_FEE_BAISA);
  const safe  = Number.isFinite(baisa) && baisa >= 0 ? baisa : 500;
  return safe / 1000;
}

/** UTC YYYY-MM-DD for SQL DATE() comparison. */
function ymd(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d || '').slice(0, 10);
}

/**
 * What WOULD be in a payout for (office, period)? Read-only — no DB writes.
 * Use this to render the admin preview before they click Generate.
 *
 * @param {object} args
 * @param {number} args.officeId
 * @param {string} args.from  YYYY-MM-DD inclusive
 * @param {string} args.to    YYYY-MM-DD inclusive
 * @returns {Promise<{ office_id, period_start, period_end, request_count, gross_omr, platform_fee_omr, net_omr, requests:Array }>}
 */
export async function previewPayout({ officeId, from, to }) {
  const fromS = ymd(from) + ' 00:00:00';
  const toS   = ymd(to)   + ' 23:59:59';
  const { rows } = await db.execute({
    sql: `SELECT r.id AS request_id, r.payment_amount_omr, r.paid_at,
                 r.payment_ref, r.payment_session_id,
                 r.service_id,
                 s.name_en AS service_name_en, s.name_ar AS service_name_ar,
                 c.phone AS citizen_phone, c.name AS citizen_name
            FROM request r
            LEFT JOIN service_catalog s ON s.id = r.service_id
            LEFT JOIN citizen c         ON c.id = r.citizen_id
           WHERE r.office_id = ?
             AND r.payment_status = 'paid'
             AND r.paid_at >= ? AND r.paid_at <= ?
             AND r.payout_id IS NULL
           ORDER BY r.paid_at ASC`,
    args: [officeId, fromS, toS]
  });

  const requests = rows;
  const requestCount = requests.length;
  const grossOmr = requests.reduce((a, r) => a + (Number(r.payment_amount_omr) || 0), 0);
  const feePerRequest = platformFeeOmr();
  const platformFeeOmrTotal = requestCount * feePerRequest;
  const netOmr = Math.max(0, grossOmr - platformFeeOmrTotal);

  return {
    office_id: officeId,
    period_start: ymd(from),
    period_end:   ymd(to),
    request_count: requestCount,
    gross_omr:        round3(grossOmr),
    platform_fee_omr: round3(platformFeeOmrTotal),
    fee_per_request_omr: feePerRequest,
    net_omr:          round3(netOmr),
    requests
  };
}

/**
 * Atomically materialise a payout. Steps:
 *   1. INSERT office_payout row at status='pending' with the computed totals
 *   2. UPDATE request SET payout_id=<new> WHERE office_id, paid_at in range,
 *      payment_status='paid', payout_id IS NULL
 *   3. Re-read the row + bind the inserted request ids
 *
 * Returns null if there's nothing eligible.
 *
 * @param {object} args
 * @param {number} args.officeId
 * @param {string} args.from   YYYY-MM-DD
 * @param {string} args.to     YYYY-MM-DD
 * @param {number} [args.createdByOfficerId]
 * @returns {Promise<{ payout: object, request_ids: number[] } | null>}
 */
export async function generatePayout({ officeId, from, to, createdByOfficerId = null }) {
  const preview = await previewPayout({ officeId, from, to });
  if (preview.request_count === 0) return null;

  const ins = await db.execute({
    sql: `INSERT INTO office_payout
            (office_id, period_start, period_end,
             request_count, gross_omr, platform_fee_omr, net_omr,
             status, created_by_officer_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [
      officeId, preview.period_start, preview.period_end,
      preview.request_count, preview.gross_omr, preview.platform_fee_omr, preview.net_omr,
      createdByOfficerId
    ]
  });
  const payoutId = Number(ins.lastInsertRowid);

  // Bind all matching requests. We re-evaluate the WHERE on this UPDATE
  // (instead of using the preview's id list) so a request that flips to
  // paid in between preview-and-generate gets caught too — and we still
  // can't accidentally bind one that's already in another payout because
  // payout_id IS NULL is in the WHERE.
  const fromS = preview.period_start + ' 00:00:00';
  const toS   = preview.period_end   + ' 23:59:59';
  await db.execute({
    sql: `UPDATE request
             SET payout_id = ?
           WHERE office_id = ?
             AND payment_status = 'paid'
             AND paid_at >= ? AND paid_at <= ?
             AND payout_id IS NULL`,
    args: [payoutId, officeId, fromS, toS]
  });

  // Read back the actually-bound rows (drift-safe).
  const { rows: bound } = await db.execute({
    sql: `SELECT id FROM request WHERE payout_id = ?`,
    args: [payoutId]
  });
  const requestIds = bound.map(r => Number(r.id));

  // Recompute totals on the actually-bound set (cheap insurance against
  // the race above changing counts).
  const recompute = await recomputeTotals(payoutId);
  return {
    payout: { id: payoutId, ...recompute, status: 'pending' },
    request_ids: requestIds
  };
}

/**
 * Mark a payout as transferred. Operator supplies the bank reference for
 * audit. Idempotent — calling on an already-paid payout is a no-op (returns
 * { already: true }).
 *
 * @param {object} args
 * @param {number} args.payoutId
 * @param {string} [args.reference]
 * @param {string} [args.notes]
 * @param {number} [args.paidByOfficerId]
 */
export async function markPayoutPaid({ payoutId, reference = '', notes = '', paidByOfficerId = null }) {
  const { rows } = await db.execute({
    sql: `SELECT id, status FROM office_payout WHERE id=?`,
    args: [payoutId]
  });
  if (!rows[0]) return { ok: false, error: 'not_found' };
  if (rows[0].status === 'paid') return { ok: true, already: true };
  if (rows[0].status === 'cancelled') return { ok: false, error: 'cancelled' };
  await db.execute({
    sql: `UPDATE office_payout
             SET status='paid',
                 paid_at=datetime('now'),
                 paid_by_officer_id=COALESCE(?, paid_by_officer_id),
                 paid_reference=COALESCE(NULLIF(?,''), paid_reference),
                 notes=COALESCE(NULLIF(?,''), notes)
           WHERE id=? AND status='pending'`,
    args: [paidByOfficerId, reference, notes, payoutId]
  });
  return { ok: true };
}

/**
 * Cancel a pending payout — releases its requests back to the eligible
 * pool so the next pay-run picks them up. Only valid on 'pending' rows.
 */
export async function cancelPayout({ payoutId, notes = '' }) {
  const { rows } = await db.execute({
    sql: `SELECT id, status FROM office_payout WHERE id=?`,
    args: [payoutId]
  });
  if (!rows[0]) return { ok: false, error: 'not_found' };
  if (rows[0].status !== 'pending') return { ok: false, error: 'not_pending', current: rows[0].status };
  await db.execute({
    sql: `UPDATE office_payout SET status='cancelled', notes=COALESCE(NULLIF(?,''), notes) WHERE id=?`,
    args: [notes, payoutId]
  });
  await db.execute({
    sql: `UPDATE request SET payout_id=NULL WHERE payout_id=?`,
    args: [payoutId]
  });
  return { ok: true };
}

/**
 * Build a UTF-8 BOM-prefixed CSV of every payout in the given window.
 * The BOM is critical — Excel won't render Arabic text correctly without
 * it. Quoting follows RFC4180.
 *
 * @param {object} [args]
 * @param {string} [args.from]
 * @param {string} [args.to]
 * @param {string} [args.status]  'all' | 'pending' | 'paid' | 'cancelled'
 * @param {number} [args.officeId]
 * @returns {Promise<string>} CSV text with BOM
 */
export async function exportPayoutsCsv(args = {}) {
  const filters = [];
  const sqlArgs = [];
  if (args.status && args.status !== 'all') {
    filters.push(`p.status = ?`); sqlArgs.push(String(args.status));
  }
  if (args.officeId) {
    filters.push(`p.office_id = ?`); sqlArgs.push(Number(args.officeId));
  }
  if (args.from) { filters.push(`p.period_end >= ?`);   sqlArgs.push(ymd(args.from)); }
  if (args.to)   { filters.push(`p.period_start <= ?`); sqlArgs.push(ymd(args.to)); }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

  const { rows } = await db.execute({
    sql: `SELECT p.id, p.office_id,
                 o.name_en AS office_name_en, o.name_ar AS office_name_ar,
                 o.email AS office_email, o.phone AS office_phone,
                 o.iban, o.bank_name, o.account_holder_name, o.bank_swift,
                 o.billing_email, o.bank_verified_at,
                 p.period_start, p.period_end,
                 p.request_count, p.gross_omr, p.platform_fee_omr, p.net_omr,
                 p.status, p.paid_at, p.paid_reference, p.notes, p.created_at
            FROM office_payout p
            LEFT JOIN office o ON o.id = p.office_id
            ${where}
           ORDER BY p.created_at DESC`,
    args: sqlArgs
  });

  // Bank columns at the end so anyone doing a bank-side reconciliation
  // can paste rows straight into the transfer batch upload. Keeps the
  // historical column order intact for any downstream consumers.
  const header = [
    'Payout ID', 'Office ID', 'Office (AR)', 'Office (EN)',
    'Email', 'Phone',
    'Period start', 'Period end',
    'Requests', 'Gross OMR', 'Platform fee OMR', 'Net OMR',
    'Status', 'Paid at', 'Bank reference', 'Notes', 'Created at',
    'IBAN', 'Bank name', 'Account holder', 'SWIFT/BIC',
    'Billing email', 'Bank verified at'
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.office_id,
      r.office_name_ar || '', r.office_name_en || '',
      r.office_email || '', r.office_phone || '',
      r.period_start, r.period_end,
      r.request_count,
      Number(r.gross_omr).toFixed(3),
      Number(r.platform_fee_omr).toFixed(3),
      Number(r.net_omr).toFixed(3),
      r.status, r.paid_at || '', r.paid_reference || '', r.notes || '',
      r.created_at,
      r.iban || '', r.bank_name || '', r.account_holder_name || '',
      r.bank_swift || '', r.billing_email || '', r.bank_verified_at || ''
    ].map(csvCell).join(','));
  }
  // UTF-8 BOM (﻿) so Excel renders Arabic without manual encoding selection.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Recompute totals on a payout from its currently-bound requests. Useful
 * after manual edits OR right after generatePayout's bind step (insurance
 * against drift between preview and bind).
 *
 * @param {number} payoutId
 * @returns {Promise<{request_count:number, gross_omr:number, platform_fee_omr:number, net_omr:number}>}
 */
export async function recomputeTotals(payoutId) {
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(payment_amount_omr),0) AS gross
            FROM request WHERE payout_id=?`,
    args: [payoutId]
  });
  const count = Number(rows[0]?.n || 0);
  const gross = Number(rows[0]?.gross || 0);
  const fee   = count * platformFeeOmr();
  const net   = Math.max(0, gross - fee);
  await db.execute({
    sql: `UPDATE office_payout
             SET request_count=?, gross_omr=?, platform_fee_omr=?, net_omr=?
           WHERE id=?`,
    args: [count, round3(gross), round3(fee), round3(net), payoutId]
  });
  return {
    request_count: count,
    gross_omr:        round3(gross),
    platform_fee_omr: round3(fee),
    net_omr:          round3(net)
  };
}

/**
 * Cash position for a period — the single "where is the money" view.
 * Walks every PAID citizen request in [from, to] and buckets it by how far
 * along settlement it is, so the admin can answer "what have we transferred
 * to offices and what's still outstanding?" in one glance.
 *
 *   collected_omr        — gross collected from citizens (via Thawani)
 *   platform_fee_omr     — Sanad's retained cut (fee × request_count)
 *   owed_to_offices_omr  — net we must transfer to offices (collected − fees)
 *     ├─ transferred_omr — net already marked paid (status='paid' payouts)
 *     ├─ pending_omr     — net generated into a payout, awaiting bank transfer
 *     └─ unsettled_omr   — net for paid requests not yet batched into a payout
 *
 * @param {object} args
 * @param {string} args.from  YYYY-MM-DD inclusive
 * @param {string} args.to    YYYY-MM-DD inclusive
 */
export async function reconcile({ from, to }) {
  const fromS = ymd(from) + ' 00:00:00';
  const toS   = ymd(to)   + ' 23:59:59';
  const { rows } = await db.execute({
    sql: `SELECT
            CASE
              WHEN p.status = 'paid'    THEN 'transferred'
              WHEN p.status = 'pending' THEN 'pending'
              ELSE 'unsettled'
            END AS bucket,
            COUNT(*) AS n,
            COALESCE(SUM(r.payment_amount_omr), 0) AS gross
          FROM request r
          LEFT JOIN office_payout p ON p.id = r.payout_id
          WHERE r.payment_status = 'paid'
            AND r.paid_at >= ? AND r.paid_at <= ?
          GROUP BY bucket`,
    args: [fromS, toS]
  });

  const fee = platformFeeOmr();
  const raw = { transferred: { n: 0, gross: 0 }, pending: { n: 0, gross: 0 }, unsettled: { n: 0, gross: 0 } };
  for (const r of rows) if (raw[r.bucket]) raw[r.bucket] = { n: Number(r.n), gross: Number(r.gross) };
  const mk = (x) => ({
    request_count: x.n,
    gross_omr: round3(x.gross),
    platform_fee_omr: round3(x.n * fee),
    net_omr: round3(Math.max(0, x.gross - x.n * fee))
  });
  const transferred = mk(raw.transferred), pending = mk(raw.pending), unsettled = mk(raw.unsettled);
  const totalN = transferred.request_count + pending.request_count + unsettled.request_count;
  const collected = round3(transferred.gross_omr + pending.gross_omr + unsettled.gross_omr);
  const platformFeeTotal = round3(totalN * fee);

  return {
    period_start: ymd(from),
    period_end:   ymd(to),
    fee_per_request_omr: fee,
    request_count: totalN,
    collected_omr:       collected,
    platform_fee_omr:    platformFeeTotal,
    owed_to_offices_omr: round3(Math.max(0, collected - platformFeeTotal)),
    transferred_omr: transferred.net_omr,
    pending_omr:     pending.net_omr,
    unsettled_omr:   unsettled.net_omr,
    buckets: { transferred, pending, unsettled }
  };
}

// 3-decimal rounding (OMR has 3 fractional digits = baisa precision).
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

// CSV cell quoting — RFC4180-style: wrap in quotes if cell has comma /
// quote / newline; double up internal quotes.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
