function integer(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be a whole number from 1 to ${maximum}.`);
  return Number(value);
}

export function readBookingAbuseConfig(env = process.env) {
  const value = env.BOOKING_RATE_LIMIT_ENABLED;
  if (value !== undefined && value !== "true" && value !== "false") throw new Error("BOOKING_RATE_LIMIT_ENABLED must be true or false.");
  return {
    enabled: value === "true",
    maxAttempts: integer(env.BOOKING_RATE_LIMIT_MAX, 5, 1000, "BOOKING_RATE_LIMIT_MAX"),
    windowMs: integer(env.BOOKING_RATE_LIMIT_WINDOW_MINUTES, 15, 1440, "BOOKING_RATE_LIMIT_WINDOW_MINUTES") * 60_000,
  };
}

// One process, bounded memory, no customer fields or credentials retained.
// req.ip is useful only after the actual ingress proxy allowlist is verified.
// An untrusted forwarded header never changes the default socket-based key.
export function createBookingRateLimiter({ enabled = false, maxAttempts = 5, windowMs = 15 * 60_000 } = {}, { now = Date.now, maxClients = 10_000 } = {}) {
  if (!enabled) return null;
  const attempts = new Map();
  return function limitBookingSubmissions(req, res, next) {
    const clock = now();
    for (const [key, entry] of attempts) if (entry.expiresAt <= clock) attempts.delete(key);
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let entry = attempts.get(key);
    if (!entry && attempts.size < maxClients) {
      entry = { count: 0, expiresAt: clock + windowMs };
      attempts.set(key, entry);
    }
    if (!entry || entry.count >= maxAttempts) {
      const expiresAt = entry?.expiresAt ?? Math.min(...Array.from(attempts.values(), value => value.expiresAt));
      res.set({ "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil((expiresAt - clock) / 1000))) });
      return res.status(429).json({ error: "Too many appointment requests. Please wait before trying again.", code: "BOOKING_RATE_LIMITED" });
    }
    // Reserve synchronously, before parsing or awaiting the booking handler.
    // Successful/invalid submissions both count; disconnecting cannot refund it.
    entry.count++;
    next();
  };
}
