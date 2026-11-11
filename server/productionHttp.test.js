import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

const APP_MARKER = "isolated-built-frontend-test";
const INDEX = `<!doctype html><html><body><main>${APP_MARKER}</main><script src="/assets/app-BUILD123.js"></script></body></html>`;
const deny = (_req, res) => res.status(401).json({ error: "Synthetic authentication required." });

function dependencies(state, overrides = {}) {
  return {
    Appointment: { db: { readyState: 1 } },
    scheduling: {
      getPublicServices: async () => ({ revision: 0, services: [] }),
      createAppointment: async () => { state.bookings++; return { id: "123456789012345678901234", status: "pending" }; },
      ...overrides.scheduling,
    },
    auth: { login: deny, requireAuth: deny, requireCsrf: deny, session: deny, activity: deny, logout: deny, ...overrides.auth },
    notifications: { enabled: false, kick() {} },
    logger: { error: message => state.logs.push(message) },
    databaseReady: () => state.database,
    runtimeReady: () => state.ready,
  };
}

// Every case uses temporary synthetic build files and an ephemeral listener.
// No database, application .env, customer record, or SMTP transport is loaded.
async function fixture(t, { frontend = true, ...overrides } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eds-production-http-"));
  const state = { database: true, ready: true, bookings: 0, logs: [] };
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), INDEX);
  await writeFile(join(directory, "assets", "app-BUILD123.js"), "/* synthetic built asset */");
  const app = createApp({ ...dependencies(state, overrides), frontendDirectory: frontend ? directory : null,
    ...(overrides.trustProxy ? { trustProxy: overrides.trustProxy } : {}) });
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  return { state, directory, origin: `http://127.0.0.1:${server.address().port}` };
}

function sensitiveHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("production readiness retains the database contract while liveness is independent of MongoDB", async t => {
  const f = await fixture(t);
  let response = await fetch(`${f.origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { database: "connected" });
  sensitiveHeaders(response);
  f.state.database = false;
  response = await fetch(`${f.origin}/api/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { database: "disconnected" });
  sensitiveHeaders(response);
  response = await fetch(`${f.origin}/api/health/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  sensitiveHeaders(response);
});

test("draining returns failing health and refuses API reads and writes before reaching handlers", async t => {
  const f = await fixture(t);
  f.state.ready = false;
  const ready = await fetch(`${f.origin}/api/health`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { database: "connected", status: "draining" });
  const live = await fetch(`${f.origin}/api/health/live`);
  assert.equal(live.status, 503);
  assert.deepEqual(await live.json(), { status: "draining" });
  for (const [path, options] of [["/api/services", {}], ["/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }]]) {
    const response = await fetch(`${f.origin}${path}`, options);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SERVICE_DRAINING");
    sensitiveHeaders(response);
  }
  assert.equal(f.state.bookings, 0);
});

test("built frontend serves browser deep links with private-safe HTML response headers", async t => {
  const f = await fixture(t);
  for (const path of ["/", "/services", "/appointment?service=Oil+Change", "/mechanic", "/manage-appointment?appointment=123456789012345678901234", "/privacy"]) {
    const response = await fetch(`${f.origin}${path}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), new RegExp(APP_MARKER));
    sensitiveHeaders(response);
  }
  const head = await fetch(`${f.origin}/manage-appointment`, { method: "HEAD", headers: { Accept: "text/html" } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  sensitiveHeaders(head);
});

test("unknown API routes return uncached JSON 404 rather than the frontend shell", async t => {
  const f = await fixture(t);
  for (const path of ["/api", "/api/unknown", "/api/unknown/index.html", "/API/unknown"]) {
    const response = await fetch(`${f.origin}${path}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { error: "API route not found.", code: "API_NOT_FOUND" });
    sensitiveHeaders(response);
  }
});

test("missing assets, file extensions and non-navigation requests cannot become a successful SPA response", async t => {
  const f = await fixture(t);
  for (const path of ["/assets/missing.js", "/assets/missing", "/images/missing", "/fonts/missing", "/src/missing", "/node_modules/missing", "/favicon.svg", "/missing.json", "/missing%2Ejs", "/%61pi/unknown"]) {
    const response = await fetch(`${f.origin}${path}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), new RegExp(APP_MARKER), path);
  }
  for (const options of [{ headers: { Accept: "application/json" } }, { headers: { Accept: "text/html;q=0" } }, { method: "POST", headers: { Accept: "text/html" } }]) {
    const response = await fetch(`${f.origin}/appointment`, options);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), new RegExp(APP_MARKER));
  }
});

test("built assets are cacheable while index HTML remains uncached and no-referrer", async t => {
  const f = await fixture(t);
  const asset = await fetch(`${f.origin}/assets/app-BUILD123.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  assert.equal(asset.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await asset.text(), "/* synthetic built asset */");
  const index = await fetch(`${f.origin}/index.html`);
  assert.equal(index.status, 200);
  sensitiveHeaders(index);
});

test("API-only configuration does not expose a built frontend unless explicitly enabled", async t => {
  const f = await fixture(t, { frontend: false });
  const response = await fetch(`${f.origin}/appointment`, { headers: { Accept: "text/html" } });
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), new RegExp(APP_MARKER));
  assert.equal((await fetch(`${f.origin}/api/health`)).status, 200);
});

test("explicit frontend serving fails startup when the built index does not exist", async t => {
  const directory = await mkdtemp(join(tmpdir(), "eds-production-missing-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(() => createApp({ ...dependencies({ logs: [] }), frontendDirectory: directory }), /Build the frontend before setting SERVE_FRONTEND=true/);
});

test("malformed and oversized API bodies retain privacy headers without echoing credentials", async t => {
  const f = await fixture(t);
  const token = "synthetic-private-management-token";
  for (const [body, status] of [[`{"token":"${token}"`, 400], [JSON.stringify({ token: token.repeat(2000) }), 413]]) {
    const response = await fetch(`${f.origin}/api/customer/appointments/123456789012345678901234/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, status);
    sensitiveHeaders(response);
    assert.doesNotMatch(await response.text(), new RegExp(token));
  }
  assert.deepEqual(f.state.logs, []);
});

test("unexpected API errors expose only a generic response and fixed redacted logs", async t => {
  const secret = "mongodb://private-user:private-password@private-db/customer?token=private-bearer";
  const f = await fixture(t, { scheduling: { getPublicServices: async () => { throw new Error(secret); } } });
  const response = await fetch(`${f.origin}/api/services`);
  assert.equal(response.status, 503);
  sensitiveHeaders(response);
  assert.deepEqual(await response.json(), { error: "Unable to process the request right now. Please try again." });
  assert.deepEqual(f.state.logs, ["Appointment API request failed; the request can be retried."]);
  assert.equal(JSON.stringify(f.state.logs).includes(secret), false);
});

test("proxy trust is disabled by default and only an explicit allowlist enables forwarded client addresses", async t => {
  const auth = { login: (req, res) => res.json({ ip: req.ip }) };
  const direct = await fixture(t, { auth });
  const headers = { "X-Forwarded-For": "203.0.113.17" };
  let response = await fetch(`${direct.origin}/api/mechanic/login`, { method: "POST", headers });
  assert.deepEqual(await response.json(), { ip: "127.0.0.1" });
  const trusted = await fixture(t, { auth, trustProxy: ["127.0.0.1/32"] });
  response = await fetch(`${trusted.origin}/api/mechanic/login`, { method: "POST", headers });
  assert.deepEqual(await response.json(), { ip: "203.0.113.17" });
});
