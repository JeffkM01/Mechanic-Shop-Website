import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { createEmailConnectionTest, EMAIL_TEST_RECIPIENT } from "./emailConnectionTest.js";
import { createApp } from "./app.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createOperationTracker } from "./operationTracker.js";
import { createServerRuntime } from "./serverRuntime.js";
import { readStagingSafety } from "./stagingSafety.js";

const KEY = "synthetic-private-brevo-key-for-injected-tests-2026";
const STAFF_PASSWORD = "synthetic-probe-staff-password-2026";
const PREVIEW_PASSWORD = "Synthetic-probe-gateway-password-2026";
const ENV = { STAGING_EMAIL_TEST_ENABLED: "true", BREVO_API_KEY: KEY };
const authorization = `Basic ${Buffer.from(`staging:${PREVIEW_PASSWORD}`).toString("base64")}`;
const settings = { DEPLOYMENT_STAGE: "staging", STAGING_ACCESS_PASSWORD: PREVIEW_PASSWORD,
  MONGODB_DATABASE: "eds_staging_probe_synthetic", MONGODB_URI: "mongodb://127.0.0.1:1/eds_staging_probe_synthetic" };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("connection testing is off by default and never constructs or calls a transport", async () => {
  let sends = 0;
  for (const flag of [undefined, "false"]) {
    const probe = createEmailConnectionTest({ env: { STAGING_EMAIL_TEST_ENABLED: flag, BREVO_API_KEY: "invalid\nprivate" }, transport: { sendMail() { sends++; } } });
    assert.deepEqual(probe.status(), { enabled: false });
    await assert.rejects(probe.send(), error => error.code === "EMAIL_TEST_DISABLED");
  }
  assert.equal(sends, 0);
});

test("probe activation requires exact opt-in, protected staging and a private API key", () => {
  for (const flag of ["", "yes", "TRUE", true, 1]) assert.throws(() => createEmailConnectionTest({ staging: { enabled: true }, env: { ...ENV, STAGING_EMAIL_TEST_ENABLED: flag } }), /STAGING_EMAIL_TEST_ENABLED/);
  for (const staging of [undefined, { enabled: false }]) assert.throws(() => createEmailConnectionTest({ staging, env: ENV }), /requires protected staging/);
  for (const BREVO_API_KEY of [undefined, "", "private\nkey"]) {
    assert.throws(() => createEmailConnectionTest({ staging: { enabled: true }, env: { ...ENV, BREVO_API_KEY } }), error => {
      assert.equal(error.message.includes("private\nkey"), false);
      return /BREVO_API_KEY/.test(error.message);
    });
  }
});

test("the probe sends only a fixed synthetic message to the verified inbox", async () => {
  const messages = [];
  const env = { ...ENV, MAIL_FROM: "unrelated@other.invalid", MECHANIC_NOTIFICATION_EMAIL: "unrelated@other.invalid" };
  const probe = createEmailConnectionTest({ staging: { enabled: true }, env, now: () => 1000,
    transport: { sendMail: async message => { messages.push(message); } } });
  assert.deepEqual(probe.status(), { enabled: true, recipient: EMAIL_TEST_RECIPIENT, retryAfterSeconds: 0 });
  const result = await probe.send();
  assert.deepEqual(result, { accepted: true, recipient: EMAIL_TEST_RECIPIENT, retryAfterSeconds: 60 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, `Ed's Auto Shop <${EMAIL_TEST_RECIPIENT}>`);
  assert.equal(messages[0].to, EMAIL_TEST_RECIPIENT);
  assert.equal(messages[0].replyTo, EMAIL_TEST_RECIPIENT);
  assert.deepEqual(Object.keys(messages[0]).sort(), ["from", "replyTo", "subject", "text", "to"]);
  assert.match(messages[0].subject, /^\[TEST ONLY\]/);
  assert.match(messages[0].text, /Ordinary appointment emails remain disabled/);
  assert.doesNotMatch(JSON.stringify(messages), /https?:\/\/|unrelated@|synthetic-private-brevo-key/);
});

test("concurrent attempts reserve admission before await, including an expired cooldown while still pending", async () => {
  const delivery = deferred();
  let clock = 1000;
  let sends = 0;
  const probe = createEmailConnectionTest({ staging: { enabled: true }, env: ENV, now: () => clock,
    transport: { sendMail: async () => { sends++; await delivery.promise; } } });
  const first = probe.send();
  await assert.rejects(probe.send(), error => error.status === 429 && error.retryAfterSeconds === 60);
  clock += 60_000;
  await assert.rejects(probe.send(), error => error.status === 429);
  assert.equal(sends, 1);
  delivery.resolve();
  await first;
  await probe.send();
  assert.equal(sends, 2);
});

test("failures retain the fixed cooldown, redact provider details and do not automatically retry", async () => {
  let clock = 1000;
  let sends = 0;
  const probe = createEmailConnectionTest({ staging: { enabled: true }, env: ENV, now: () => clock,
    transport: { sendMail: async () => { sends++; throw new Error(`${KEY}: private provider response`); } } });
  await assert.rejects(probe.send(), error => error.code === "EMAIL_TEST_UNCONFIRMED" && !error.message.includes(KEY));
  clock += 59_999;
  await assert.rejects(probe.send(), error => error.status === 429 && error.retryAfterSeconds === 1);
  assert.equal(sends, 1);
  clock++;
  await assert.rejects(probe.send(), error => error.status === 503);
  assert.equal(sends, 2);
});

async function fixture(t, { transport, enabled = true, attach = true } = {}) {
  const messages = [];
  const logs = [];
  const tracker = createOperationTracker();
  const staging = readStagingSafety(settings); // Parses only; no MongoDB connection.
  const emailTest = createEmailConnectionTest({ staging, env: { ...ENV, STAGING_EMAIL_TEST_ENABLED: String(enabled) },
    transport: transport ?? { sendMail: async message => { messages.push(message); } } });
  const forbidden = () => { throw new Error("The email probe must never access appointments, scheduling or the dispatcher."); };
  const app = createApp({ Appointment: { db: { readyState: 1 }, find: forbidden, findById: forbidden, updateOne: forbidden },
    scheduling: { createAppointment: forbidden }, auth: createMechanicAuth(STAFF_PASSWORD),
    notifications: { enabled: false, kick: forbidden, processPending: forbidden, start: forbidden },
    emailTest: attach ? emailTest : null, requestGate: staging.requestGate,
    operationTracker: tracker, logger: { error: message => logs.push(message) },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(origin + path, { ...options, headers: { Authorization: authorization,
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers } });
  async function login() {
    const response = await call("/api/mechanic/login", { method: "POST", body: JSON.stringify({ password: STAFF_PASSWORD }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { Cookie: response.headers.get("set-cookie").split(";")[0], "X-Mechanic-CSRF": body.csrfToken };
  }
  return { call, login, origin, messages, logs, server, tracker };
}

test("HTTP probe requires the staging gateway, staff session and CSRF without exposing secrets", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/mechanic/email-test")).status, 401);
  assert.equal((await f.call("/api/mechanic/email-test")).status, 401);
  assert.equal((await f.call("/api/mechanic/email-test", { method: "POST", body: "{}" })).status, 401);
  const headers = await f.login();
  const status = await f.call("/api/mechanic/email-test", { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal(status.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.deepEqual(await status.json(), { enabled: true, recipient: EMAIL_TEST_RECIPIENT, retryAfterSeconds: 0 });
  const denied = await f.call("/api/mechanic/email-test", { method: "POST", headers: { Cookie: headers.Cookie }, body: "{}" });
  assert.equal(denied.status, 403);
  assert.equal(f.messages.length, 0);
  const sent = await f.call("/api/mechanic/email-test", { method: "POST", headers, body: "{}" });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).accepted, true);
  assert.equal(f.messages.length, 1);
  const limited = await f.call("/api/mechanic/email-test", { method: "POST", headers, body: "{}" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  await f.call("/api/mechanic/logout", { method: "POST", headers });
  assert.equal((await f.call("/api/mechanic/email-test", { headers })).status, 401);
  assert.equal((await f.call("/api/mechanic/email-test", { method: "POST", headers, body: "{}" })).status, 401);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.logs, []);
});

test("HTTP input cannot override recipient, sender, content, links or queue IDs", async t => {
  const f = await fixture(t);
  const headers = await f.login();
  for (const body of [{ recipient: "other@example.invalid" }, { to: EMAIL_TEST_RECIPIENT }, { from: "other@example.invalid" },
    { subject: "override", text: "private customer content" }, { appointmentId: "a".repeat(24) }, { managementLink: "https://example.invalid" }, [], null]) {
    const response = await f.call("/api/mechanic/email-test", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    // express.json rejects a top-level null before the route's body guard.
    if (body !== null) assert.equal(result.code, "INVALID_EMAIL_TEST_REQUEST");
  }
  assert.equal((await f.call("/api/mechanic/email-test?recipient=other", { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal(f.messages.length, 0);
  assert.equal((await f.call("/api/mechanic/email-test", { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal(f.messages.length, 1);
});

test("a disabled or unconfigured app never sends, and provider errors remain private", async t => {
  for (const options of [{ enabled: false }, { attach: false }, { transport: { sendMail: async () => { throw new Error(KEY); } } }]) {
    const f = await fixture(t, options);
    const headers = await f.login();
    const response = await f.call("/api/mechanic/email-test", { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes("private provider"), false);
    assert.deepEqual(f.logs, []);
  }
});

test("shutdown waits for a disconnected manual test handler to settle", { timeout: 5000 }, async t => {
  const entered = deferred();
  const delivery = deferred();
  const f = await fixture(t, { transport: { sendMail: async () => { entered.resolve(); await delivery.promise; } } });
  const headers = await f.login();
  let connected = true;
  const runtime = createServerRuntime({ server: f.server, graceMs: 1000, stopApplicationWork: f.tracker.stop,
    disconnectDatabase: () => { connected = false; } });
  t.after(async () => { delivery.resolve(); await runtime.shutdown(); });
  let closed;
  f.server.once("connection", socket => { closed = once(socket, "close"); });
  const client = request({ host: "127.0.0.1", port: f.server.address().port, path: "/api/mechanic/email-test", method: "POST",
    headers: { Authorization: authorization, ...headers, "Content-Type": "application/json" } });
  client.on("error", () => {});
  t.after(() => client.destroy());
  client.end("{}");
  await entered.promise;
  client.destroy();
  await closed;
  const stopping = runtime.shutdown();
  await setImmediate();
  assert.equal(connected, true);
  assert.equal(f.tracker.isAccepting(), false);
  delivery.resolve();
  assert.deepEqual(await stopping, { ok: true, timedOut: false });
  assert.equal(connected, false);
});
