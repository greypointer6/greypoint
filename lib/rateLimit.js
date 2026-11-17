/**
 * Minimal in-memory fixed-window-ish rate limiter (sliding window of
 * timestamps per IP). Suitable for a single-process deployment; reset it
 * on restart. `now` is injectable for testing.
 */
export function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map(); // ip -> array of request timestamps

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const t = now();
    const cutoff = t - windowMs;
    const recent = (hits.get(ip) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).send("Too many attempts. Please try again later.");
      return;
    }

    recent.push(t);
    hits.set(ip, recent);

    // Keep memory bounded under address-spoofing floods (only matters when
    // trust proxy is misconfigured; req.ip is otherwise the socket address).
    if (hits.size > 10_000) {
      for (const [key, stamps] of hits) {
        if (stamps.every((ts) => ts <= cutoff)) hits.delete(key);
      }
    }

    next();
  };
}
