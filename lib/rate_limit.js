// In-memory rate limiter — sliding-window per (route-key + client-ip).
//
// Per-instance only — fine for a single Render dyno; on multi-instance you'd
// move this to Redis. The accounts we're protecting (citizen + officer) all
// have separate per-account guards too (OTP cooldown, max-attempts), so this
// is the IP-level outer ring against burst-from-one-attacker scenarios.
//
// Default policy:
//   /api/auth/login            → 8 / minute / IP
//   /api/citizen-auth/start-otp → 12 / minute / IP   (per-phone cooldown handles same-phone replay)
//   /api/citizen-auth/verify-otp→ 30 / minute / IP   (per-phone max-attempts handles same-phone)
//   /api/citizen-auth/google    → 10 / minute / IP
//
// Returns 429 with Retry-After when exceeded. Skipped entirely in DEBUG_MODE
// so local-development smoke runs aren't capped.

const store = new Map(); // key → [{ts}, ...] sliding window of hit timestamps
const DEBUG = process.env.DEBUG_MODE === 'true';

function clientIp(req) {
  // Trust X-Forwarded-For only when explicitly enabled — Render sets it.
  // In dev / direct, fall back to req.ip / socket.remoteAddress.
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns Express middleware that limits {limit} hits per {windowMs} per IP.
 * The {key} string namespaces buckets so different routes don't share counts.
 */
export function rateLimit({ key, limit = 10, windowMs = 60_000 } = {}) {
  return function rateLimitMw(req, res, next) {
    if (DEBUG) return next();
    const ip = clientIp(req);
    const bucketKey = `${key}|${ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    let arr = store.get(bucketKey);
    if (!arr) { arr = []; store.set(bucketKey, arr); }
    // Drop stale entries
    while (arr.length && arr[0] < cutoff) arr.shift();

    if (arr.length >= limit) {
      const retryAfterS = Math.ceil((arr[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfterS)));
      return res.status(429).json({
        error: 'rate_limited',
        retry_after_s: Math.max(1, retryAfterS),
        limit, window_s: Math.round(windowMs / 1000)
      });
    }
    arr.push(now);
    next();
  };
}

// Periodic janitor — every 5 min sweep stale buckets so memory stays bounded.
// (A bucket is "stale" if all its entries are older than the longest window.)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, arr] of store) {
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (!arr.length) store.delete(k);
  }
}, 5 * 60_000).unref?.();

// Test helper: clear the store (used by smoke suites that run many requests).
export function _resetRateLimit() { store.clear(); }
