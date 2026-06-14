// Pure-function unit tests for lib/plans.js — no DB, no HTTP.
//
// Plans are the single source of truth for pricing/quota/expiry math.
// Every checkout, every renewal reminder, every quota gate, and every
// admin KPI calls into this module. Regressions here silently overcharge
// or undercharge offices, so the bar for changes is "tests must pass".
import './helpers.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  PLANS,
  PLAN_CODES,
  getPlan,
  isValidPlanCode,
  computeExpiry,
  toSqlDatetime,
  omrToBaisa,
  baisaToOmr,
  startOfCurrentMonthSqlDatetime,
  daysUntilExpiry,
} = await import('../lib/plans.js');

describe('PLANS table — pricing & quota math', () => {
  test('has exactly the four expected plan codes', () => {
    assert.deepEqual(Object.keys(PLANS).sort(),
      ['annual', 'monthly', 'quarterly', 'semi-annual']);
  });

  test('PLAN_CODES is ordered cheapest → priciest', () => {
    assert.deepEqual(PLAN_CODES, ['monthly', 'quarterly', 'semi-annual', 'annual']);
  });

  test('monthly is the 30-OMR / 1-month baseline', () => {
    const p = PLANS.monthly;
    assert.equal(p.months, 1);
    assert.equal(p.total_omr, 30);
    assert.equal(p.per_month_omr, 30);
    assert.equal(p.discount_pct, 0);
  });

  test('quarterly = 30×3 with 8% off → 82.80 OMR', () => {
    const p = PLANS.quarterly;
    assert.equal(p.months, 3);
    assert.equal(p.discount_pct, 8);
    assert.equal(p.total_omr, 82.8);
    assert.equal(p.per_month_omr, 27.6);
  });

  test('semi-annual = 30×6 with 15% off → 153 OMR', () => {
    const p = PLANS['semi-annual'];
    assert.equal(p.months, 6);
    assert.equal(p.discount_pct, 15);
    assert.equal(p.total_omr, 153);
    assert.equal(p.per_month_omr, 25.5);
  });

  test('annual = 30×12 with 20% off → 288 OMR', () => {
    const p = PLANS.annual;
    assert.equal(p.months, 12);
    assert.equal(p.discount_pct, 20);
    assert.equal(p.total_omr, 288);
    assert.equal(p.per_month_omr, 24);
  });

  test('all plans carry the 100/month claim quota', () => {
    for (const code of PLAN_CODES) {
      assert.equal(PLANS[code].claim_quota, 100, `${code} quota mismatch`);
    }
  });

  test('per_month_omr × months equals total_omr (within float epsilon)', () => {
    for (const code of PLAN_CODES) {
      const p = PLANS[code];
      const computed = Math.round(p.per_month_omr * p.months * 100) / 100;
      assert.equal(computed, p.total_omr, `${code} per-month math broken`);
    }
  });

  test('discount math: per_month × months × (1 - discount) ≈ total', () => {
    // Cross-check: 30 baseline × months × discount-factor lands on total_omr.
    for (const code of PLAN_CODES) {
      const p = PLANS[code];
      const expected = 30 * p.months * (1 - p.discount_pct / 100);
      assert.ok(Math.abs(expected - p.total_omr) < 0.01,
        `${code}: 30 * ${p.months} * (1-${p.discount_pct}/100) = ${expected}, table says ${p.total_omr}`);
    }
  });

  test('totals are monotonically increasing with months', () => {
    let prev = -1;
    for (const code of PLAN_CODES) {
      assert.ok(PLANS[code].total_omr > prev, `${code} total ${PLANS[code].total_omr} not > ${prev}`);
      prev = PLANS[code].total_omr;
    }
  });

  test('per-month price decreases with commitment (longer = cheaper per month)', () => {
    assert.ok(PLANS.quarterly.per_month_omr   < PLANS.monthly.per_month_omr);
    assert.ok(PLANS['semi-annual'].per_month_omr < PLANS.quarterly.per_month_omr);
    assert.ok(PLANS.annual.per_month_omr      < PLANS['semi-annual'].per_month_omr);
  });
});

describe('getPlan() / isValidPlanCode()', () => {
  test('getPlan returns the right object for each code', () => {
    assert.equal(getPlan('monthly').months, 1);
    assert.equal(getPlan('annual').months, 12);
  });
  test('getPlan throws on unknown code (callers can rely on non-null return)', () => {
    assert.throws(() => getPlan('forever'), /Unknown plan code/);
    assert.throws(() => getPlan(''),        /Unknown plan code/);
    assert.throws(() => getPlan(null),      /Unknown plan code/);
  });
  test('isValidPlanCode accepts known codes, rejects everything else', () => {
    assert.equal(isValidPlanCode('monthly'),     true);
    assert.equal(isValidPlanCode('annual'),      true);
    assert.equal(isValidPlanCode('semi-annual'), true);
    assert.equal(isValidPlanCode('starter-70'),  false);   // legacy, not a v2 plan
    assert.equal(isValidPlanCode('Monthly'),     false);   // case-sensitive
    assert.equal(isValidPlanCode(''),            false);
    assert.equal(isValidPlanCode(undefined),     false);
  });
});

describe('omrToBaisa() / baisaToOmr() — Thawani amount conversion', () => {
  test('30 OMR → 30000 baisa (the monthly plan)', () => {
    assert.equal(omrToBaisa(30), 30000);
  });
  test('82.8 OMR → 82800 baisa (quarterly — float-prone)', () => {
    // This is the case that breaks if you trust raw multiplication:
    // 82.8 * 1000 in JS = 82799.99999999999. Math.round saves us.
    assert.equal(omrToBaisa(82.8), 82800);
  });
  test('all plan totals round-trip cleanly', () => {
    for (const code of PLAN_CODES) {
      const omr = PLANS[code].total_omr;
      const baisa = omrToBaisa(omr);
      assert.equal(baisaToOmr(baisa), omr, `${code} did not round-trip`);
    }
  });
  test('per-month amounts (25.5 OMR) survive the round-trip too', () => {
    assert.equal(omrToBaisa(25.5), 25500);
    assert.equal(omrToBaisa(27.6), 27600);
    assert.equal(omrToBaisa(24),   24000);
  });
  test('0 OMR is allowed (degenerate but valid)', () => {
    assert.equal(omrToBaisa(0), 0);
  });
});

describe('toSqlDatetime() — schema-compatible date formatting', () => {
  test('formats a fixed UTC date as YYYY-MM-DD HH:MM:SS', () => {
    // Pick a date with leading-zero month/day/hour/min/sec to catch padding bugs.
    const d = new Date(Date.UTC(2026, 0, 5, 3, 7, 9));  // 2026-01-05 03:07:09Z
    assert.equal(toSqlDatetime(d), '2026-01-05 03:07:09');
  });
  test('handles double-digit fields without breaking', () => {
    const d = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    assert.equal(toSqlDatetime(d), '2026-12-31 23:59:59');
  });
});

describe('computeExpiry() — calendar-month addition', () => {
  test('monthly: today + 1 month, same day-of-month', () => {
    const from = new Date(Date.UTC(2026, 4, 18, 10, 0, 0));  // 2026-05-18
    assert.equal(computeExpiry('monthly', from), '2026-06-18 10:00:00');
  });
  test('quarterly: today + 3 months', () => {
    const from = new Date(Date.UTC(2026, 4, 18, 10, 0, 0));
    assert.equal(computeExpiry('quarterly', from), '2026-08-18 10:00:00');
  });
  test('annual: today + 12 months wraps the year', () => {
    const from = new Date(Date.UTC(2026, 4, 18, 10, 0, 0));
    assert.equal(computeExpiry('annual', from), '2027-05-18 10:00:00');
  });
  test('end-of-month overflow lands in the following month (JS setMonth semantics)', () => {
    // Jan 31 + 1 month → Feb 28/29 → JS overflows to Mar 3 (28/29 + extra days).
    // We document this as expected behaviour; users on the 31st renew on the 1st-3rd next.
    const from = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    const result = computeExpiry('monthly', from);
    // 2026 is non-leap → Jan 31 + 1m = Mar 3 in JS's overflow logic.
    assert.equal(result, '2026-03-03 12:00:00');
  });
});

describe('startOfCurrentMonthSqlDatetime()', () => {
  test('returns the 1st of the current UTC month at 00:00:00', () => {
    const result = startOfCurrentMonthSqlDatetime();
    // Format: YYYY-MM-01 00:00:00 — the day part MUST be "01" and the time all zeros.
    assert.match(result, /^\d{4}-\d{2}-01 00:00:00$/);
    // And the year/month must match "now" in UTC.
    const now = new Date();
    const expectedPrefix =
      now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
    assert.ok(result.startsWith(expectedPrefix),
      `expected prefix ${expectedPrefix}, got ${result}`);
  });
});

describe('daysUntilExpiry()', () => {
  test('returns Infinity for null/empty (no sub = never expires)', () => {
    assert.equal(daysUntilExpiry(null), Infinity);
    assert.equal(daysUntilExpiry(''),   Infinity);
    assert.equal(daysUntilExpiry(undefined), Infinity);
  });
  test('returns negative for past dates', () => {
    const yesterday = new Date(Date.now() - 25 * 3600 * 1000); // 25h ago
    assert.ok(daysUntilExpiry(toSqlDatetime(yesterday)) < 0);
  });
  test('returns ~N for N days in the future', () => {
    const inSevenDays = new Date(Date.now() + 7 * 86_400_000);
    const got = daysUntilExpiry(toSqlDatetime(inSevenDays));
    // Allow ±1 day of slack to absorb time-of-day truncation at month/UTC boundaries.
    assert.ok(got === 6 || got === 7, `expected ~7, got ${got}`);
  });
});
