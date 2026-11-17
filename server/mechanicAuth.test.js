import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { scryptSync } from "node:crypto";
import { createMechanicAuth } from "./mechanicAuth.js";

function response() {
  return {
    code: 200, body: null, cookieValue: null, cleared: false,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookieValue = `${name}=${value}`; this.options = options; return this; },
    clearCookie(name, options) { this.cleared = true; this.clearName = name; this.clearOptions = options; return this; },
  };
}
function request({ password, cookie = "", csrf = "", ip = "127.0.0.1" } = {}) {
  return {
    ip, body: { password },
    headers: { cookie },
    get(name) { return name.toLowerCase() === "x-mechanic-csrf" ? csrf : undefined; },
  };
}
function middleware(fn, req) {
  const res = response();
  let nextCalled = false;
  fn(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const password = "an-example-unique-password-999";

test("rejects short or placeholder passwords", () => {
  assert.throws(() => createMechanicAuth("short"), /MECHANIC_ADMIN_PASSWORD/);
  assert.throws(() => createMechanicAuth("REPLACE_WITH_YOUR_OWN_LONG_RANDOM_PASSWORD"), /MECHANIC_ADMIN_PASSWORD/);
});

test("incorrect password is rejected without setting a cookie", async () => {
  const auth = createMechanicAuth(password);
  const res = response();
  await auth.login(request({ password: "incorrect" }), res);
  assert.equal(res.code, 401);
  assert.equal(res.cookieValue, null);
});

test("successful sign-in creates HTTP-only SameSite Strict cookie and CSRF token", async () => {
  const auth = createMechanicAuth(password);
  const res = response();
  await auth.login(request({ password }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.authenticated, true);
  assert.match(res.body.csrfToken, /^[a-f\d]{64}$/);
  assert.equal(res.options.httpOnly, true);
  assert.equal(res.options.sameSite, "strict");
  assert.equal(res.options.path, "/api/mechanic");
  assert.match(res.cookieValue, /^mechanic_session=[a-f\d]{64}$/);
});

test("private routes require a valid cookie", async () => {
  const auth = createMechanicAuth(password);
  const signIn = response();
  await auth.login(request({ password }), signIn);
  const denied = middleware(auth.requireAuth, request());
  assert.equal(denied.res.code, 401);
  assert.equal(denied.nextCalled, false);
  const authorized = middleware(auth.requireAuth, request({ cookie: signIn.cookieValue }));
  assert.equal(authorized.nextCalled, true);
});

test("status changes require an authenticated CSRF token", async () => {
  const auth = createMechanicAuth(password);
  const signIn = response();
  await auth.login(request({ password }), signIn);
  const req = request({ cookie: signIn.cookieValue });
  assert.equal(middleware(auth.requireAuth, req).nextCalled, true);
  const bad = middleware(auth.requireCsrf, req);
  assert.equal(bad.res.code, 403);
  req.get = () => signIn.body.csrfToken;
  assert.equal(middleware(auth.requireCsrf, req).nextCalled, true);
});

test("logout revokes the session", async () => {
  const auth = createMechanicAuth(password);
  const signIn = response();
  await auth.login(request({ password }), signIn);
  const req = request({ cookie: signIn.cookieValue });
  middleware(auth.requireAuth, req);
  const out = response();
  auth.logout(req, out);
  assert.equal(out.cleared, true);
  assert.equal(middleware(auth.requireAuth, req).res.code, 401);
});

test("expired sessions are rejected", async () => {
  let clock = 1000;
  const auth = createMechanicAuth(password, { now: () => clock });
  const signIn = response();
  await auth.login(request({ password }), signIn);
  clock += 8 * 60 * 60 * 1000 + 1;
  assert.equal(middleware(auth.requireAuth, request({ cookie: signIn.cookieValue })).res.code, 401);
});

test("login stops responding to attempts after five failures per IP", async () => {
  const auth = createMechanicAuth(password);
  for (let i = 0; i < 5; i++) {
    const res = response();
    await auth.login(request({ password: "wrong", ip: "1.2.3.4" }), res);
    assert.equal(res.code, 401);
  }
  const rateLimited = response();
  await auth.login(request({ password, ip: "1.2.3.4" }), rateLimited);
  assert.equal(rateLimited.code, 429);
});

const MINUTE = 60 * 1000;

test("sessions expire at exactly 20 idle minutes despite background reads", async () => {
  let clock = 1000;
  const auth = createMechanicAuth(password, { now: () => clock });
  const signedIn = response();
  await auth.login(request({ password }), signedIn);
  assert.equal(signedIn.body.idleExpiresAt, clock + 20 * MINUTE);
  for (let minute = 1; minute < 20; minute++) {
    clock = 1000 + minute * MINUTE;
    const req = request({ cookie: signedIn.cookieValue });
    assert.equal(middleware(auth.requireAuth, req).nextCalled, true);
    const res = response();
    auth.session(req, res);
    assert.equal(res.body.idleExpiresAt, 1000 + 20 * MINUTE);
  }
  clock = 1000 + 20 * MINUTE;
  const expired = middleware(auth.requireAuth, request({ cookie: signedIn.cookieValue }));
  assert.equal(expired.res.code, 401);
  assert.equal(expired.nextCalled, false);
});

test("explicit CSRF-protected activity renews idle time without extending absolute lifetime", async () => {
  let clock = 1000;
  const auth = createMechanicAuth(password, { now: () => clock });
  const signedIn = response();
  await auth.login(request({ password }), signedIn);
  const absolute = signedIn.body.expiresAt;
  // Stay active for nearly eight hours, with activity every 19 minutes.
  while (clock + 19 * MINUTE < absolute) {
    clock += 19 * MINUTE;
    const req = request({ cookie: signedIn.cookieValue, csrf: signedIn.body.csrfToken });
    assert.equal(middleware(auth.requireAuth, req).nextCalled, true);
    assert.equal(middleware(auth.requireCsrf, req).nextCalled, true);
    const res = response();
    auth.activity(req, res);
    assert.equal(res.body.idleExpiresAt, Math.min(clock + 20 * MINUTE, absolute));
    assert.equal(res.body.expiresAt, absolute);
  }
  clock = absolute;
  assert.equal(middleware(auth.requireAuth, request({ cookie: signedIn.cookieValue })).res.code, 401);
});

test("expired sessions cannot be revived by activity and require a fresh login", async () => {
  let clock = 1000;
  const auth = createMechanicAuth(password, { now: () => clock });
  const old = response();
  await auth.login(request({ password }), old);
  clock += 20 * MINUTE;
  const req = request({ cookie: old.cookieValue, csrf: old.body.csrfToken });
  assert.equal(middleware(auth.requireAuth, req).nextCalled, false);
  const fresh = response();
  await auth.login(request({ password }), fresh);
  assert.notEqual(fresh.cookieValue, old.cookieValue);
  assert.equal(middleware(auth.requireAuth, request({ cookie: old.cookieValue })).res.code, 401);
  assert.equal(middleware(auth.requireAuth, request({ cookie: fresh.cookieValue })).nextCalled, true);
});

test("HTTP private reads and writes are denied after idle expiry and logout", async (t) => {
  const { default: express } = await import("express");
  let clock = 1000;
  const auth = createMechanicAuth(password, { now: () => clock });
  const app = express();
  app.use(express.json());
  app.post("/login", auth.login);
  app.get("/session", auth.requireAuth, auth.session);
  app.post("/activity", auth.requireAuth, auth.requireCsrf, auth.activity);
  app.post("/logout", auth.requireAuth, auth.requireCsrf, auth.logout);
  app.get("/appointments", auth.requireAuth, (_req, res) => res.json({ appointments: [{ name: "Private Customer" }] }));
  app.patch("/appointments/1", auth.requireAuth, auth.requireCsrf, (_req, res) => res.json({ status: "confirmed" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function login() {
    const res = await fetch(`${url}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(res.status, 200);
    const data = await res.json();
    return { cookie: res.headers.get("set-cookie").split(";")[0], "X-Mechanic-CSRF": data.csrfToken };
  }
  const headers = await login();
  assert.equal((await fetch(`${url}/appointments`, { headers })).status, 200);
  clock += 19 * MINUTE;
  assert.equal((await fetch(`${url}/activity`, { method: "POST", headers: { cookie: headers.cookie } })).status, 403);
  clock += MINUTE; // A failed CSRF check cannot keep the session alive.
  for (const [path, method] of [["/appointments", "GET"], ["/appointments/1", "PATCH"], ["/session", "GET"], ["/activity", "POST"]]) {
    const denied = await fetch(url + path, { method, headers });
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /Private Customer/);
  }
  const fresh = await login();
  assert.equal((await fetch(`${url}/logout`, { method: "POST", headers: { cookie: fresh.cookie } })).status, 403);
  assert.equal((await fetch(`${url}/appointments`, { headers: fresh })).status, 200);
  const out = await fetch(`${url}/logout`, { method: "POST", headers: fresh });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /mechanic_session=;/);
  for (const [path, method] of [["/appointments", "GET"], ["/appointments/1", "PATCH"], ["/activity", "POST"], ["/session", "GET"]]) {
    assert.equal((await fetch(url + path, { method, headers: fresh })).status, 401);
  }
});

function controlledHasher() {
  const checks = [];
  return {
    checks,
    hash(candidate, salt, size) {
      return new Promise((resolve, reject) => {
        checks.push({
          fail: () => resolve(Buffer.alloc(size)),
          succeed: () => resolve(scryptSync(candidate, salt, size)),
          reject,
        });
      });
    },
  };
}

test("a concurrent burst reserves only five password hashes and retains the failure limit", async () => {
  const hashing = controlledHasher();
  const auth = createMechanicAuth(password, { hashPassword: hashing.hash });
  const responses = Array.from({ length: 20 }, response);
  const logins = responses.map(res => auth.login(request({ password: "wrong" }), res));
  assert.equal(hashing.checks.length, 5);
  assert.ok(responses.slice(5).every(res => res.code === 429 && res.cookieValue === null));
  hashing.checks.forEach(check => check.fail());
  await Promise.all(logins);
  assert.deepEqual(responses.slice(0, 5).map(res => res.code), [401, 401, 401, 401, 401]);
  const ninth = response();
  await auth.login(request({ password }), ninth);
  assert.equal(ninth.code, 429);
  assert.equal(hashing.checks.length, 5, "throttled requests must never start a hash");
});

test("the fixed window expires exactly fifteen minutes after first admission and throttles do not extend it", async () => {
  let clock = 1000;
  let hashes = 0;
  const auth = createMechanicAuth(password, { now: () => clock,
    hashPassword: async (_candidate, _salt, size) => { hashes++; return Buffer.alloc(size); },
  });
  for (let i = 0; i < 5; i++) {
    clock = 1000 + i * MINUTE;
    const rejected = response();
    await auth.login(request({ password: "wrong" }), rejected);
    assert.equal(rejected.code, 401);
  }
  clock = 1000 + 15 * MINUTE - 1;
  const limited = response();
  await auth.login(request({ password }), limited);
  assert.equal(limited.code, 429);
  assert.equal(hashes, 5);
  clock++;
  const nextWindow = response();
  await auth.login(request({ password: "wrong" }), nextWindow);
  assert.equal(nextWindow.code, 401);
  assert.equal(hashes, 6);
});

test("success clears completed failures but preserves concurrent hash reservations and later failures", async () => {
  const hashing = controlledHasher();
  const auth = createMechanicAuth(password, { hashPassword: hashing.hash });
  const signedIn = response();
  const valid = auth.login(request({ password }), signedIn);
  const invalid = Array.from({ length: 4 }, () => auth.login(request({ password: "wrong" }), response()));
  assert.equal(hashing.checks.length, 5);
  hashing.checks[0].succeed();
  await valid;
  assert.equal(signedIn.code, 200);
  assert.ok(signedIn.cookieValue);
  const oneFreeSlot = response();
  const fifthPending = auth.login(request({ password: "wrong" }), oneFreeSlot);
  const full = response();
  await auth.login(request({ password }), full);
  assert.equal(full.code, 429, "success cannot erase four still-pending checks");
  assert.equal(hashing.checks.length, 6);
  hashing.checks.slice(1).forEach(check => check.fail());
  await Promise.all([...invalid, fifthPending]);
  const countedAfterSuccess = response();
  await auth.login(request({ password }), countedAfterSuccess);
  assert.equal(countedAfterSuccess.code, 429);
  assert.equal(middleware(auth.requireAuth, request({ cookie: signedIn.cookieValue })).nextCalled, true);
});

test("a successful login resets previously settled failures for the next attempt", async () => {
  const auth = createMechanicAuth(password, {
    hashPassword: async (candidate, salt, size) => candidate === password ? scryptSync(candidate, salt, size) : Buffer.alloc(size),
  });
  for (let i = 0; i < 4; i++) await auth.login(request({ password: "wrong" }), response());
  const success = response();
  await auth.login(request({ password }), success);
  assert.equal(success.code, 200);
  for (let i = 0; i < 5; i++) {
    const next = response();
    await auth.login(request({ password: "wrong" }), next);
    assert.equal(next.code, 401);
  }
  const limited = response();
  await auth.login(request({ password }), limited);
  assert.equal(limited.code, 429);
});

test("pending checks retain their slots across a window boundary", async () => {
  let clock = 1000;
  const hashing = controlledHasher();
  const auth = createMechanicAuth(password, { now: () => clock, hashPassword: hashing.hash });
  const pending = Array.from({ length: 5 }, () => auth.login(request({ password: "wrong" }), response()));
  clock += 15 * MINUTE;
  const stillBusy = response();
  await auth.login(request({ password }), stillBusy);
  assert.equal(stillBusy.code, 429);
  assert.equal(hashing.checks.length, 5);
  hashing.checks.forEach(check => check.fail());
  await Promise.all(pending);
  const failedInNewWindow = response();
  await auth.login(request({ password }), failedInNewWindow);
  assert.equal(failedInNewWindow.code, 429);
  clock += 15 * MINUTE;
  const reopened = response();
  const next = auth.login(request({ password: "wrong" }), reopened);
  assert.equal(hashing.checks.length, 6);
  hashing.checks[5].fail();
  await next;
  assert.equal(reopened.code, 401);
});

test("hashing exceptions settle reservations while consuming failure budget", async () => {
  const hashing = controlledHasher();
  const auth = createMechanicAuth(password, { hashPassword: hashing.hash });
  for (let i = 0; i < 5; i++) {
    const rejected = assert.rejects(auth.login(request({ password: "wrong" }), response()), /synthetic hash failure/);
    hashing.checks[i].reject(new Error("synthetic hash failure"));
    await rejected;
  }
  const limited = response();
  await auth.login(request({ password }), limited);
  assert.equal(limited.code, 429);
  assert.equal(hashing.checks.length, 5);
});

test("a full IP budget does not consume another IP's hash slots", async () => {
  const hashing = controlledHasher();
  const auth = createMechanicAuth(password, { hashPassword: hashing.hash });
  const pending = Array.from({ length: 5 }, () => auth.login(request({ password: "wrong", ip: "192.0.2.1" }), response()));
  const other = response();
  const otherPending = auth.login(request({ password: "wrong", ip: "192.0.2.2" }), other);
  const limited = response();
  await auth.login(request({ password, ip: "192.0.2.1" }), limited);
  assert.equal(limited.code, 429);
  assert.equal(hashing.checks.length, 6);
  hashing.checks.forEach(check => check.fail());
  await Promise.all([...pending, otherPending]);
  assert.equal(other.code, 401);
});

test("invalid password shapes consume admission budget without hashing", async () => {
  let hashes = 0;
  const auth = createMechanicAuth(password, { hashPassword: async () => { hashes++; throw new Error("must not hash"); } });
  for (const candidate of [undefined, null, 42, {}, "x".repeat(257)]) {
    const invalid = response();
    await auth.login(request({ password: candidate }), invalid);
    assert.equal(invalid.code, 401);
  }
  const limited = response();
  await auth.login(request({ password }), limited);
  assert.equal(limited.code, 429);
  assert.equal(hashes, 0);
});

test("HTTP concurrent failed logins enforce the same five-attempt limit", async t => {
  const { default: express } = await import("express");
  const auth = createMechanicAuth(password);
  const app = express();
  app.use(express.json());
  app.post("/login", auth.login);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/login`;
  const results = await Promise.all(Array.from({ length: 20 }, () => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }),
  })));
  assert.equal(results.filter(res => res.status === 401).length, 5);
  assert.equal(results.filter(res => res.status === 429).length, 15);
  for (const res of results) assert.equal(res.headers.get("set-cookie"), null);
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) })).status, 429);
});
