// Lightweight Origin/Referer CSRF guard.
//
// We use httpOnly + SameSite=Lax cookies, which already blocks most CSRF
// vectors in modern browsers. This middleware adds belt-and-braces for
// state-changing endpoints (POST/PUT/PATCH/DELETE):
//
//   • If neither Origin nor Referer is present → 403 (browsers always send
//     at least one for cross-origin POSTs; absence usually means a
//     cross-site form submit or a script-injected fetch).
//   • If Origin/Referer host is set and doesn't match this server's host
//     → 403 (a different origin is trying to submit using the user's cookie).
//   • Same-origin or known allow-list hosts → pass.
//
// Allow-list is configurable via SANAD_CSRF_ALLOW (comma-separated hosts).
// In DEBUG_MODE the check is skipped entirely so local tooling / curl works.

const DEBUG = process.env.DEBUG_MODE === 'true';
const ALLOW = new Set(
  (process.env.SANAD_CSRF_ALLOW || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).host.toLowerCase(); }
  catch { return ''; }
}

export function originCheck(req, res, next) {
  if (DEBUG) return next();
  // Read-only methods don't need protection.
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();

  // Strict: at least one of Origin or Referer must be present.
  if (!origin && !referer) {
    return res.status(403).json({ error: 'origin_missing' });
  }

  const candidate = hostOf(origin) || hostOf(referer);
  if (!candidate) {
    return res.status(403).json({ error: 'origin_unparseable' });
  }

  // Match own host or explicit allow-list.
  if (candidate === host || ALLOW.has(candidate)) return next();

  return res.status(403).json({
    error: 'origin_mismatch',
    expected: host,
    got: candidate
  });
}
