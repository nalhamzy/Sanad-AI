// lib/env.js
//
// Single source of truth for environment-derived safety flags. The whole
// app was previously checking `process.env.DEBUG_MODE === 'true'` in ~15
// places, and several debug/stub routes leaked into production because
// "is this a real deployment?" was conflated with "is the gateway live?".
//
// The rule this module enforces:
//
//   DEBUG features (state dumps, payment stubs, OTP simulators, the
//   platform-admin DEBUG fallback, CSRF bypass) are NEVER active when
//   NODE_ENV === 'production', regardless of what DEBUG_MODE says.
//
// So even if an operator accidentally ships DEBUG_MODE=true to prod, the
// dangerous surfaces stay closed. To actually use debug tooling you must
// be in a non-production NODE_ENV *and* have DEBUG_MODE=true.

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * True only when debug tooling should be reachable. Hard-gated off in
 * production. Use this instead of reading DEBUG_MODE directly anywhere a
 * state-changing or data-exposing shortcut is involved.
 */
export const DEBUG_ENABLED =
  process.env.DEBUG_MODE === 'true' && !IS_PRODUCTION;

/**
 * Boot-time guard. Throws if a production deployment is missing a secret
 * that, if absent, would silently disable a security control. Call this
 * from prepare()/start() so a misconfigured prod box fails fast and loud
 * instead of running wide open.
 *
 * Checks (production only):
 *   • WHATSAPP_APP_SECRET — without it the inbound webhook accepts
 *     unsigned, spoofable messages.
 *   • ADMIN_EMAILS — without it requirePlatformAdmin would have no
 *     allow-list (and the DEBUG fallback is already disabled in prod, so
 *     the panel would be unreachable — but an empty list is almost
 *     certainly a misconfiguration worth surfacing).
 *
 * NOTE: JWT_SECRET is validated separately and earlier — lib/auth.js
 * throws at import time if it's missing/weak in production, so it isn't
 * re-checked here.
 */
export function assertProductionConfig() {
  if (!IS_PRODUCTION) return { ok: true, skipped: 'not_production' };
  const problems = [];
  if (!(process.env.WHATSAPP_APP_SECRET || '').trim()) {
    problems.push('WHATSAPP_APP_SECRET is required in production (webhook signature verification).');
  }
  if (!(process.env.ADMIN_EMAILS || '').trim()) {
    problems.push('ADMIN_EMAILS must list at least one platform-admin email in production.');
  }
  if (problems.length) {
    const msg = 'FATAL: insecure production configuration:\n  - ' + problems.join('\n  - ');
    throw new Error(msg);
  }
  return { ok: true };
}
