import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import { checkStagingConfiguration } from "./stagingChecks.js";

const script = fileURLToPath(new URL("../scripts/check-staging.js", import.meta.url));
const fixture = () => ({
  NODE_ENV: "production", HOST: "0.0.0.0", SERVE_FRONTEND: "true", DEPLOYMENT_STAGE: "staging",
  STAGING_ACCESS_PASSWORD: "synthetic-gateway-password-not-live-2030",
  MONGODB_DATABASE: "eds_staging_preflight",
  MONGODB_URI: "mongodb://127.0.0.1:27017/eds_staging_preflight",
  BOOKING_RATE_LIMIT_ENABLED: "true",
  PUBLIC_WEBSITE_ORIGIN: "https://preview.synthetic-shop.org",
  MECHANIC_ADMIN_PASSWORD: "synthetic-staff-password-not-live-2030",
  APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 95).toString("base64url"),
});
const workflowFixture = () => ({
  ...fixture(), STAGING_EMAIL_TEST_ENABLED: "false",
  STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: "true",
  STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: "36b1254a-1a4d-4c42-9c7d-7fc75f7915ce",
  BREVO_API_KEY: "synthetic-private-brevo-workflow-preflight-key-2026",
});

test("valid synthetic staging passes offline configuration without business approval or email configuration", () => {
  const report = checkStagingConfiguration({ env: fixture() });
  assert.equal(report.configurationReady, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.emailConnectionTestEnabled, false);
  assert.equal(report.appointmentEmailTestEnabled, false);
  for (const field of ["deploymentApproved", "readyForPublicLaunch", "networkAccessed", "databaseAccessed"]) assert.equal(report[field], false, field);
  assert.ok(report.unverified.some(item => item.includes("forcibly disabled")));
});

test("staging preflight rejects a production namespace, missing gate, disabled quota or invalid container runtime", () => {
  for (const patch of [
    { DEPLOYMENT_STAGE: "production" }, { STAGING_ACCESS_PASSWORD: "short" },
    { MONGODB_DATABASE: "eds_production" }, { MONGODB_URI: "mongodb://127.0.0.1/eds_production" },
    { BOOKING_RATE_LIMIT_ENABLED: "false" }, { BOOKING_RATE_LIMIT_MAX: "zero" },
    { NODE_ENV: "development" }, { SERVE_FRONTEND: "false" }, { HOST: "127.0.0.1" },
    { PORT: "invalid" }, { TRUST_PROXY: "true" },
    { PUBLIC_WEBSITE_ORIGIN: "http://preview.synthetic-shop.org" },
    { MECHANIC_ADMIN_PASSWORD: "short" }, { APPOINTMENT_MANAGEMENT_SECRET: "short" },
  ]) assert.equal(checkStagingConfiguration({ env: { ...fixture(), ...patch } }).configurationReady, false, Object.keys(patch)[0]);
});

test("staging preflight validates and honestly reports the optional manual email test without sending", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Real email and network access forbidden"); });
  const key = "synthetic-private-brevo-preflight-key-2026";
  const env = { ...fixture(), STAGING_EMAIL_TEST_ENABLED: "true", BREVO_API_KEY: key };
  const report = checkStagingConfiguration({ env });
  assert.equal(report.configurationReady, true);
  assert.equal(report.emailConnectionTestEnabled, true);
  assert.equal(report.networkAccessed, false);
  assert.ok(report.unverified.some(item => item.includes("fixed-inbox manual test is enabled")));
  assert.equal(JSON.stringify(report).includes(key), false);
  for (const patch of [{ STAGING_EMAIL_TEST_ENABLED: "yes" }, { BREVO_API_KEY: undefined }, { BREVO_API_KEY: "private\nkey" }, { DEPLOYMENT_STAGE: "production" }]) {
    const invalid = checkStagingConfiguration({ env: { ...env, ...patch } });
    assert.equal(invalid.configurationReady, false);
    assert.ok(invalid.blockers.some(item => item.code === "STAGING_EMAIL_TEST"));
  }
  assert.equal(checkStagingConfiguration({ env: fixture() }).emailConnectionTestEnabled, false);
});

test("offline staging preflight neither connects to MongoDB nor calls fetch or changes the environment", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden"); });
  t.mock.method(mongoose, "connect", () => { throw new Error("Database connection forbidden"); });
  t.mock.method(mongoose.mongo.MongoClient.prototype, "connect", () => { throw new Error("Driver connection forbidden"); });
  for (const env of [fixture(), workflowFixture()]) {
    const original = structuredClone(env);
    assert.equal(checkStagingConfiguration({ env }).configurationReady, true);
    assert.deepEqual(env, original);
  }
});

test("scoped appointment email preflight checks configuration only and reports its narrow scope without secrets", () => {
  const env = workflowFixture();
  const report = checkStagingConfiguration({ env });
  assert.equal(report.configurationReady, true);
  assert.equal(report.emailConnectionTestEnabled, false);
  assert.equal(report.appointmentEmailTestEnabled, true);
  assert.ok(report.checks.some(item => item.code === "STAGING_APPOINTMENT_EMAIL_TEST" && item.ok));
  assert.ok(report.unverified.some(item => /Scoped appointment email.*current reviewed run.*fixed owner inbox/.test(item)));
  assert.ok(report.unverified.some(item => item.includes("Previous requests and other runs are excluded")));
  assert.equal(report.unverified.some(item => item.includes("appointment email forcibly disabled")), false);
  for (const field of ["deploymentApproved", "readyForPublicLaunch", "networkAccessed", "databaseAccessed"]) assert.equal(report[field], false, field);
  for (const value of [env.BREVO_API_KEY, env.STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID, env.MONGODB_URI, env.APPOINTMENT_MANAGEMENT_SECRET]) {
    assert.equal(JSON.stringify(report).includes(value), false);
  }
});

test("scoped appointment email preflight rejects malformed flags, conflicting tests and incomplete private configuration", () => {
  for (const patch of [
    ...["yes", "", true, false, null].map(STAGING_APPOINTMENT_EMAIL_TEST_ENABLED => ({ STAGING_APPOINTMENT_EMAIL_TEST_ENABLED })),
    { DEPLOYMENT_STAGE: "production" }, { STAGING_ACCESS_PASSWORD: "short" },
    { STAGING_EMAIL_TEST_ENABLED: "true" },
    { STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: undefined },
    { STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: "36b1254a-1a4d-3c42-9c7d-7fc75f7915ce" },
    { BREVO_API_KEY: undefined }, { BREVO_API_KEY: "private\nkey" },
    { PUBLIC_WEBSITE_ORIGIN: "http://preview.synthetic-shop.org" },
    { APPOINTMENT_MANAGEMENT_SECRET: "short" },
  ]) {
    const report = checkStagingConfiguration({ env: { ...workflowFixture(), ...patch } });
    assert.equal(report.configurationReady, false, Object.keys(patch)[0]);
    assert.equal(report.appointmentEmailTestEnabled, false);
    assert.ok(report.blockers.some(item => item.code === "STAGING_APPOINTMENT_EMAIL_TEST"));
  }
  assert.equal(checkStagingConfiguration({ env: { ...fixture(), STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: "false" } }).configurationReady, true);
});

test("preflight reports never echo private or malformed configuration values", () => {
  const secret = "SYNTHETIC_SECRET_NOT_FOR_OUTPUT_29";
  const env = { ...fixture(), STAGING_ACCESS_PASSWORD: secret,
    MONGODB_URI: `mongodb://${secret}:password@localhost/eds_production`,
    APPOINTMENT_MANAGEMENT_SECRET: `${secret}\n`, SMTP_PASS: secret };
  const report = JSON.stringify(checkStagingConfiguration({ env }));
  assert.equal(report.includes(secret), false);
  assert.equal(JSON.parse(report).configurationReady, false);
});

test("staging CLI accepts only the documented argument and reports configuration without deployment approval", () => {
  const result = spawnSync(process.execPath, [script, "--json"], { env: fixture(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configurationReady, true);
  assert.equal(report.deploymentApproved, false);
  for (const value of [fixture().MONGODB_URI, fixture().STAGING_ACCESS_PASSWORD, fixture().APPOINTMENT_MANAGEMENT_SECRET]) assert.equal(result.stdout.includes(value), false);
  const invalid = spawnSync(process.execPath, [script, "--json", "--json"], { env: fixture(), encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^Usage:/);
});

test("staging CLI distinguishes the configured manual test from disabled appointment email without exposing its key", () => {
  const key = "synthetic-private-brevo-key-for-cli-probe-tests";
  const env = { ...fixture(), STAGING_EMAIL_TEST_ENABLED: "true", BREVO_API_KEY: key };
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ordinary appointment email disabled/);
  assert.match(result.stdout, /fixed-inbox manual test is enabled/);
  assert.equal(result.stdout.includes("Staging keeps outgoing email disabled"), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(key), false);
  const json = spawnSync(process.execPath, [script, "--json"], { env, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).emailConnectionTestEnabled, true);
  assert.equal(JSON.parse(json.stdout).appointmentEmailTestEnabled, false);
  assert.equal(json.stdout.includes(key), false);
});

test("staging CLI distinguishes a scoped appointment workflow from default mail-off staging in text and JSON", () => {
  const env = workflowFixture();
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scoped appointment email testing is enabled for new requests in the current reviewed run and fixed owner inbox only/);
  assert.match(result.stdout, /Previous requests remain excluded/);
  assert.match(result.stdout, /Public bookings are not approved/);
  assert.equal(result.stdout.includes("Staging keeps ordinary appointment email disabled"), false);
  const json = spawnSync(process.execPath, [script, "--json"], { env, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.appointmentEmailTestEnabled, true);
  assert.equal(report.emailConnectionTestEnabled, false);
  assert.equal(report.readyForPublicLaunch, false);
  for (const value of [env.BREVO_API_KEY, env.STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID, env.APPOINTMENT_MANAGEMENT_SECRET]) {
    assert.equal(`${result.stdout}${result.stderr}${json.stdout}${json.stderr}`.includes(value), false);
  }
  const invalid = spawnSync(process.execPath, [script, "--json"], {
    env: { ...env, STAGING_EMAIL_TEST_ENABLED: "true" }, encoding: "utf8",
  });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.ok(JSON.parse(invalid.stdout).blockers.some(item => item.code === "STAGING_APPOINTMENT_EMAIL_TEST"));
});

test("staging CLI does not load private development env files", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "eds-staging-cli-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "server"));
  const secret = "SYNTHETIC_ENV_FILE_MUST_NOT_BE_LOADED";
  for (const path of [join(cwd, ".env"), join(cwd, "server/.env")]) await writeFile(path, `DEPLOYMENT_STAGE=staging\nSTAGING_ACCESS_PASSWORD=${secret}\n`);
  const result = spawnSync(process.execPath, [script], { cwd, env: {}, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /CONFIGURATION BLOCKED/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});
