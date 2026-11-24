import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { createCustomerManagement } from "./customerManagement.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { notificationEnvironmentForStage, readStagingSafety } from "./stagingSafety.js";
import { createEmailConnectionTest } from "./emailConnectionTest.js";

const PASSWORD = "Synthetic-stage-access-7381-unique-5962";
const ENV = { DEPLOYMENT_STAGE: "staging", STAGING_ACCESS_PASSWORD: PASSWORD,
  MONGODB_DATABASE: "eds_staging_synthetic", MONGODB_URI: "mongodb://127.0.0.1:27017/eds_staging_synthetic" };
const authorization = (password = PASSWORD, user = "staging") => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "eds-staging-http-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><main>Synthetic staging website</main>");
  await writeFile(join(directory, "assets", "fixture-HASH123.js"), "/* protected synthetic asset */");
  const state = { reads: 0, mutations: 0, logins: 0, logs: [] };
  const deny = (_req, res) => res.status(401).json({ error: "Mechanic session required." });
  const app = createApp({ Appointment: { db: { readyState: 1 } },
    requestGate: readStagingSafety(ENV).requestGate, frontendDirectory: directory,
    scheduling: { getPublicServices: async () => { state.reads++; return { services: [] }; }, createAppointment: async () => { state.mutations++; throw new Error("Unreachable mutation"); } },
    auth: { login: (_req, res) => { state.logins++; res.status(401).json({ error: "Synthetic login rejected." }); }, requireAuth: deny, requireCsrf: deny, session: deny, activity: deny, logout: deny },
    notifications: { enabled: false, kick() {} }, logger: { error: message => state.logs.push(message) },
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
}

function privateHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
}

test("staging is explicit and leaves existing production/development behavior unchanged", () => {
  for (const DEPLOYMENT_STAGE of [undefined, "production", "development"]) {
    assert.deepEqual(readStagingSafety({ DEPLOYMENT_STAGE }), { enabled: false, requestGate: null });
  }
  for (const DEPLOYMENT_STAGE of ["", "preview", "STAGING", true]) assert.throws(() => readStagingSafety({ DEPLOYMENT_STAGE }), /DEPLOYMENT_STAGE must/);
});

test("staging rejects missing, short, weak, placeholder and malformed access passwords without echoing them", () => {
  for (const STAGING_ACCESS_PASSWORD of [undefined, "private-secret", "a".repeat(40), "PLACEHOLDER-with-long-secret-3284932984", `private-${"x".repeat(30)}\n`, "x".repeat(257)]) {
    assert.throws(() => readStagingSafety({ ...ENV, STAGING_ACCESS_PASSWORD }), error => error.message === "Staging requires a private random STAGING_ACCESS_PASSWORD of 32–256 characters.");
  }
  assert.equal(readStagingSafety(ENV).enabled, true);
});

test("staging database scope is mandatory and excludes default, normal and production database names", () => {
  for (const MONGODB_DATABASE of [undefined, "", "admin", "test", "mechanic_shop", "eds_prod_actual", "eds_staging_", "eds_staging_../actual"]) {
    assert.throws(() => readStagingSafety({ ...ENV, MONGODB_DATABASE }), /explicit MONGODB_DATABASE/);
  }
});

test("staging URI must explicitly select the agreed isolated database before any connection can be made", () => {
  for (const MONGODB_URI of [undefined, "mongodb://127.0.0.1:27017", "mongodb://127.0.0.1:27017/mechanic_shop", "mongodb://127.0.0.1:27017/eds_staging_different", "mongodb://private-user:private-secret@invalid[host/eds_staging_synthetic"]) {
    assert.throws(() => readStagingSafety({ ...ENV, MONGODB_URI }), error => error.message === "Staging requires a valid MongoDB URI selecting the same staging database and verified TLS for remote hosts.");
  }
  const safety = readStagingSafety(ENV);
  assert.equal(safety.databaseName, ENV.MONGODB_DATABASE);
  assert.equal(JSON.stringify(safety).includes(PASSWORD), false);
  assert.equal(JSON.stringify(safety).includes("mongodb://"), false);
});

test("remote staging database connections require verified TLS while local synthetic MongoDB works without it", () => {
  for (const MONGODB_URI of [
    "mongodb://db.example.invalid/eds_staging_synthetic",
    "mongodb+srv://cluster.example.invalid/eds_staging_synthetic?tls=false",
    "mongodb://db.example.invalid/eds_staging_synthetic?tls=true&tlsAllowInvalidCertificates=true",
    "mongodb://db.example.invalid/eds_staging_synthetic?tls=true&tlsAllowInvalidHostnames=true",
    "mongodb://db.example.invalid/eds_staging_synthetic?tlsInsecure=true",
  ]) assert.throws(() => readStagingSafety({ ...ENV, MONGODB_URI }), /verified TLS/);
  for (const MONGODB_URI of [ENV.MONGODB_URI, "mongodb://localhost/eds_staging_synthetic", "mongodb://[::1]/eds_staging_synthetic", "mongodb://db.example.invalid/eds_staging_synthetic?tls=true", "mongodb+srv://cluster.example.invalid/eds_staging_synthetic"]) {
    assert.equal(readStagingSafety({ ...ENV, MONGODB_URI }).enabled, true);
  }
});

test("staging keeps notification processing and management-email grants disabled even with accidentally supplied SMTP credentials", async () => {
  const env = { ...ENV, NODE_ENV: "production", PUBLIC_WEBSITE_ORIGIN: "https://staging.example.invalid", APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 7).toString("base64url"),
    SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user", SMTP_PASS: "synthetic-private-password", MAIL_FROM: "sender@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "operator@example.invalid" };
  let sends = 0;
  const Appointment = { find() { throw new Error("Staging must not start a queue sweep"); } };
  const notificationEnv = notificationEnvironmentForStage(readStagingSafety(env), env);
  const management = createCustomerManagement({ Appointment, env: notificationEnv });
  const notifications = await createEmailNotifications({ Appointment, management, env: notificationEnv, transport: { sendMail() { sends++; } } });
  assert.equal(management.enabled, false);
  assert.equal(notifications.enabled, false);
  notifications.start(); notifications.kick(); await notifications.processPending(); await notifications.stop();
  assert.equal(sends, 0);
  assert.equal(env.SMTP_PASS, "synthetic-private-password", "Input configuration is never mutated");
  assert.equal(notificationEnvironmentForStage({ enabled: false }, env), env);
});

test("an explicitly enabled manual API probe never enables appointment dispatch or management grants", async () => {
  const env = { ...ENV, EMAIL_TRANSPORT: "brevo_api", BREVO_API_KEY: "synthetic-private-api-key-for-manual-probe-tests",
    STAGING_EMAIL_TEST_ENABLED: "true", NODE_ENV: "production", PUBLIC_WEBSITE_ORIGIN: "https://staging.example.invalid",
    APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 17).toString("base64url"),
    MAIL_FROM: "sender@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "operator@example.invalid" };
  let sends = 0;
  const Appointment = { find() { throw new Error("A manual probe must never drain existing pending appointment messages"); } };
  const staging = readStagingSafety(env);
  const notificationEnv = notificationEnvironmentForStage(staging, env);
  assert.deepEqual(notificationEnv, {});
  const management = createCustomerManagement({ Appointment, env: notificationEnv });
  const transport = { sendMail: async () => { sends++; } };
  const notifications = await createEmailNotifications({ Appointment, management, env: notificationEnv, transport });
  assert.equal(management.enabled, false);
  assert.equal(notifications.enabled, false);
  notifications.start(); notifications.kick(); await notifications.processPending(); await notifications.stop();
  const probe = createEmailConnectionTest({ staging, env, transport });
  assert.equal(probe.status().enabled, true);
  assert.equal(sends, 0, "configuration, status reads and disabled queue operations never send");
  await probe.send();
  assert.equal(sends, 1, "only an explicit manual probe sends its one injected synthetic message");
  assert.equal(notifications.enabled, false);
  assert.equal(management.enabled, false);
});

test("unlaunched pages, assets and all customer/staff API routes require staging access before parsing or side effects", async t => {
  const f = await fixture(t);
  for (const path of ["/", "/appointment", "/mechanic", "/assets/fixture-HASH123.js", "/api/services", "/api/mechanic/appointments", "/api/customer/appointments/synthetic", "/api/health/", "/API/health"]) {
    const response = await fetch(f.origin + path, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 401, path); privateHeaders(response);
    assert.match(response.headers.get("www-authenticate"), /^Basic /);
    assert.equal((await response.text()).includes("Synthetic staging website"), false);
  }
  for (const path of ["/api/appointments", "/api/mechanic/login", "/api/health"]) {
    const response = await fetch(f.origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "malformed JSON" });
    assert.equal(response.status, 401); privateHeaders(response);
  }
  assert.deepEqual(f.state, { reads: 0, mutations: 0, logins: 0, logs: [] });
});

test("only minimal exact GET/HEAD health probes bypass staging access", async t => {
  const f = await fixture(t);
  for (const method of ["GET", "HEAD"]) for (const path of ["/api/health", "/api/health/live"]) {
    const response = await fetch(f.origin + path, { method });
    assert.equal(response.status, 200); privateHeaders(response);
    assert.equal(response.headers.get("www-authenticate"), null);
    if (method === "HEAD") assert.equal(await response.text(), "");
    else assert.deepEqual(await response.json(), path.endsWith("live") ? { status: "ok" } : { database: "connected" });
  }
});

test("malformed, incorrect and non-Basic staging credentials remain private and do not reach staff authentication", async t => {
  const f = await fixture(t);
  for (const value of ["Bearer a-secret", "Basic !!!", "Basic c3RhZ2luZw==junk", authorization("wrong-password"), authorization(PASSWORD, "mechanic"), `Basic ${Buffer.from([255, 254]).toString("base64")}`]) {
    const response = await fetch(f.origin + "/api/mechanic/login", { method: "POST", headers: { Authorization: value, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401); privateHeaders(response);
    assert.equal((await response.text()).includes(PASSWORD), false);
  }
  assert.equal(f.state.logins, 0);
  assert.deepEqual(f.state.logs, []);
});

test("staging access permits review but never substitutes for a private mechanic session", async t => {
  const f = await fixture(t);
  const headers = { Authorization: authorization(), Accept: "text/html" };
  for (const path of ["/appointment", "/assets/fixture-HASH123.js"]) {
    const response = await fetch(f.origin + path, { headers });
    assert.equal(response.status, 200); privateHeaders(response);
  }
  const services = await fetch(f.origin + "/api/services", { headers });
  assert.equal(services.status, 200); privateHeaders(services);
  assert.deepEqual(await services.json(), { services: [] });
  assert.equal(f.state.reads, 1);
  const appointments = await fetch(f.origin + "/api/mechanic/appointments", { headers });
  assert.equal(appointments.status, 401);
  assert.deepEqual(await appointments.json(), { error: "Mechanic session required." });
  assert.equal(appointments.headers.get("set-cookie"), null);
});
