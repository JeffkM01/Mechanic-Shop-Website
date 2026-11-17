import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createBookingRateLimiter, readBookingAbuseConfig } from "./bookingAbuseProtection.js";

function request(limiter, ip = "synthetic-client") {
  const result = { status: 200, headers: {}, admitted: false };
  const res = { set(values) { Object.assign(result.headers, values); return this; }, status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
  limiter({ ip }, res, () => { result.admitted = true; });
  return result;
}

test("booking quota is opt-in, with validated conservative defaults and configurable bounds", () => {
  assert.deepEqual(readBookingAbuseConfig({}), { enabled: false, maxAttempts: 5, windowMs: 900_000 });
  assert.equal(createBookingRateLimiter(), null);
  assert.deepEqual(readBookingAbuseConfig({ BOOKING_RATE_LIMIT_ENABLED: "true", BOOKING_RATE_LIMIT_MAX: "8", BOOKING_RATE_LIMIT_WINDOW_MINUTES: "30" }), { enabled: true, maxAttempts: 8, windowMs: 1_800_000 });
  for (const BOOKING_RATE_LIMIT_ENABLED of ["", "yes", true, "1"]) assert.throws(() => readBookingAbuseConfig({ BOOKING_RATE_LIMIT_ENABLED }), /BOOKING_RATE_LIMIT_ENABLED must/);
  for (const BOOKING_RATE_LIMIT_MAX of ["0", "1001", "1.5", " 5", 5]) assert.throws(() => readBookingAbuseConfig({ BOOKING_RATE_LIMIT_MAX }), /BOOKING_RATE_LIMIT_MAX must/);
  for (const BOOKING_RATE_LIMIT_WINDOW_MINUTES of ["0", "1441", "1.5", " 15", 15]) assert.throws(() => readBookingAbuseConfig({ BOOKING_RATE_LIMIT_WINDOW_MINUTES }), /BOOKING_RATE_LIMIT_WINDOW_MINUTES must/);
});

test("five synchronous admissions share one fixed fifteen-minute budget, including a burst", async () => {
  const limiter = createBookingRateLimiter({ enabled: true }, { now: () => 0 });
  const results = await Promise.all(Array.from({ length: 12 }, async () => request(limiter)));
  assert.equal(results.filter(result => result.admitted).length, 5);
  assert.equal(results.filter(result => result.status === 429).length, 7);
  for (const result of results.filter(result => !result.admitted)) {
    assert.equal(result.headers["Retry-After"], "900");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.body.code, "BOOKING_RATE_LIMITED");
  }
});

test("rejecting repeated submissions does not extend the window or consume another client's budget", () => {
  let clock = 0;
  const limiter = createBookingRateLimiter({ enabled: true, maxAttempts: 1, windowMs: 60_000 }, { now: () => clock });
  assert.equal(request(limiter, "first").admitted, true);
  assert.equal(request(limiter, "second").admitted, true);
  clock = 59_500;
  assert.equal(request(limiter, "first").headers["Retry-After"], "1");
  clock = 60_000;
  assert.equal(request(limiter, "first").admitted, true);
  assert.equal(request(limiter, "second").admitted, true);
});

test("bounded quota memory rejects new keys rather than evicting a still-limited client", () => {
  let clock = 0;
  const limiter = createBookingRateLimiter({ enabled: true, maxAttempts: 1, windowMs: 60_000 }, { now: () => clock, maxClients: 2 });
  assert.equal(request(limiter, "first").admitted, true);
  assert.equal(request(limiter, "second").admitted, true);
  for (let i = 0; i < 5; i++) assert.equal(request(limiter, `new-${i}`).status, 429);
  assert.equal(request(limiter, "first").status, 429);
  clock = 60_000;
  assert.equal(request(limiter, "third").admitted, true);
});

test("application quota runs before JSON parsing and cannot be bypassed with forged forwarded IPs", async t => {
  let clock = 0;
  let mutations = 0;
  const deny = (_req, res) => res.sendStatus(401);
  const app = createApp({ Appointment: { db: { readyState: 1 } },
    scheduling: { createAppointment: async () => { mutations++; } },
    auth: { login: deny, requireAuth: deny, requireCsrf: deny, session: deny, activity: deny, logout: deny },
    notifications: { enabled: false, kick() {} },
    bookingRateLimiter: createBookingRateLimiter({ enabled: true, maxAttempts: 2, windowMs: 60_000 }, { now: () => clock }),
  });
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(origin + "/api/appointments", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${attempt + 1}` }, body: "invalid JSON" });
    assert.equal(response.status, attempt < 2 ? 400 : 429);
    if (attempt >= 2) assert.equal((await response.json()).code, "BOOKING_RATE_LIMITED");
  }
  assert.equal(mutations, 0);
  const health = await fetch(origin + "/api/health");
  assert.equal(health.status, 200, "Unrelated readiness probes are not rate-limited");
  clock = 60_000;
  const expired = await fetch(origin + "/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(expired.status, 400, "A new window reaches ordinary validation");
});
