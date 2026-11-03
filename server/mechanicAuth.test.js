import test from "node:test";
import assert from "node:assert/strict";
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
