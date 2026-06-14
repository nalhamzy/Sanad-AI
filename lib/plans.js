// lib/plans.js
//
// Single source of truth for office subscription plans.
//
// Pricing curve: 30 OMR/month flat, with progressive discounts on longer
// commitments (8% / 15% / 20%). Edit the PLANS table here and the values
// propagate to: checkout pricing, admin dashboard cards, expiry math,
// invoice descriptions, and the quota gate.
//
// Quota model: time-based access (subscription must be active) + monthly
// claim quota (100 claims per calendar month, rolling reset on the 1st).
// Browsing the marketplace is free; only claim consumes quota.
//
// Currency: OMR. Thawani requires integer baisa (OMR * 1000) — convert at
// the boundary (see omrToBaisa() below) so the rest of the codebase can
// keep talking in OMR.

/** @typedef {'monthly'|'quarterly'|'semi-annual'|'annual'} PlanCode */

/**
 * @type {Record<PlanCode, {
 *   code: PlanCode,
 *   months: number,
 *   total_omr: number,
 *   per_month_omr: number,
 *   discount_pct: number,
 *   claim_quota: number,
 *   label_en: string,
 *   label_ar: string,
 *   description_en: string,
 *   description_ar: string,
 * }>}
 */
export const PLANS = {
  monthly: {
    code: 'monthly',
    months: 1,
    total_omr: 30,
    per_month_omr: 30,
    discount_pct: 0,
    claim_quota: 100,
    label_en: 'Monthly',
    label_ar: 'شهري',
    description_en: 'One month of access. 100 claims/month included.',
    description_ar: 'شهر واحد. ١٠٠ طلب شهرياً.',
  },
  quarterly: {
    code: 'quarterly',
    months: 3,
    total_omr: 82.8,
    per_month_omr: 27.6,
    discount_pct: 8,
    claim_quota: 100,
    label_en: 'Quarterly',
    label_ar: 'ربع سنوي',
    description_en: 'Three months at 8% off. 100 claims/month.',
    description_ar: 'ثلاثة أشهر بخصم ٨٪. ١٠٠ طلب شهرياً.',
  },
  'semi-annual': {
    code: 'semi-annual',
    months: 6,
    total_omr: 153,
    per_month_omr: 25.5,
    discount_pct: 15,
    claim_quota: 100,
    label_en: 'Semi-annual',
    label_ar: 'نصف سنوي',
    description_en: 'Six months at 15% off. 100 claims/month.',
    description_ar: 'ستة أشهر بخصم ١٥٪. ١٠٠ طلب شهرياً.',
  },
  annual: {
    code: 'annual',
    months: 12,
    total_omr: 288,
    per_month_omr: 24,
    discount_pct: 20,
    claim_quota: 100,
    label_en: 'Annual',
    label_ar: 'سنوي',
    description_en: 'Twelve months at 20% off. 100 claims/month.',
    description_ar: 'اثنا عشر شهراً بخصم ٢٠٪. ١٠٠ طلب شهرياً.',
  },
};

/** Ordered list (cheapest → priciest) for menu rendering. */
export const PLAN_CODES = ['monthly', 'quarterly', 'semi-annual', 'annual'];

/**
 * Look up a plan by its code. Throws on unknown code so callers can rely
 * on the return being non-null. Use isValidPlanCode() first if the input
 * is user-supplied.
 * @param {string} code
 */
export function getPlan(code) {
  const plan = PLANS[code];
  if (!plan) throw new Error(`Unknown plan code: ${code}`);
  return plan;
}

/** @param {string} code */
export function isValidPlanCode(code) {
  return Object.prototype.hasOwnProperty.call(PLANS, code);
}

/**
 * Compute the SQLite-style datetime string for when a sub starting now
 * will expire. Used by finalizeSubscriptionPayment when flipping a
 * pending row to active.
 *
 *   addMonthsAsSqlDatetime('monthly') === '2026-06-18 10:42:00'
 *
 * NOTE: we add calendar months (not 30-day chunks) so renewals always
 * land on the same day-of-month. JavaScript's Date.setMonth handles
 * end-of-month edge cases (Jan 31 + 1m = Feb 28/29) by overflowing,
 * which is fine for billing — a Jan 31 sub renews on Feb 28 then
 * Mar 31, which matches user expectation.
 *
 * @param {string} planCode
 * @param {Date} [from]
 */
export function computeExpiry(planCode, from = new Date()) {
  const plan = getPlan(planCode);
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + plan.months);
  return toSqlDatetime(d);
}

/**
 * Format a JS Date as SQLite datetime ('YYYY-MM-DD HH:MM:SS') to match
 * the rest of the schema (which uses datetime('now') as default).
 * @param {Date} d
 */
export function toSqlDatetime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + '-' +
    pad(d.getUTCMonth() + 1) + '-' +
    pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' +
    pad(d.getUTCSeconds())
  );
}

/**
 * OMR → baisa for Thawani's checkout/session and payment_intent endpoints,
 * which require integer baisa (1 OMR = 1000 baisa, NO decimals).
 *
 *   omrToBaisa(30)    === 30000
 *   omrToBaisa(82.8)  === 82800
 *   omrToBaisa(25.5)  === 25500
 *
 * Uses Math.round (not floor/ceil) to be defensive against float artifacts
 * like 82.79999999. A 0.001 OMR rounding never matters at checkout — it
 * matters that we never under- or over-charge by a full baisa due to a
 * trailing-9 representation.
 *
 * @param {number} omr
 */
export function omrToBaisa(omr) {
  return Math.round(omr * 1000);
}

/**
 * Inverse — baisa back to OMR for displaying gateway-returned amounts.
 * @param {number} baisa
 */
export function baisaToOmr(baisa) {
  return baisa / 1000;
}

/**
 * Start of the current calendar month, in SQLite datetime format.
 * Used by the claim-quota check:
 *
 *   SELECT COUNT(*) FROM request
 *    WHERE office_id=? AND claimed_at >= ?     -- <-- this value
 *
 * Returns UTC; if you want a wall-clock Asia/Muscat month boundary, swap
 * the implementation later (Oman is UTC+4, fixed, no DST — the difference
 * is at most 4 hours and would only shift the quota reset by that much).
 */
export function startOfCurrentMonthSqlDatetime() {
  const now = new Date();
  return toSqlDatetime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)));
}

/**
 * Days remaining until a sub's expires_at (SQLite datetime string).
 * Negative if already expired. Used by the reminder watcher to gate the
 * 7/3/1-day messages.
 * @param {string} expiresAtSql
 */
export function daysUntilExpiry(expiresAtSql) {
  if (!expiresAtSql) return Infinity;
  const expires = new Date(expiresAtSql.replace(' ', 'T') + 'Z').getTime();
  return Math.floor((expires - Date.now()) / 86_400_000);
}
