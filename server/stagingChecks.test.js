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

test("valid synthetic staging passes offline configuration without business approval or email configuration", () => {
  const report = checkStagingConfiguration({ env: fixture() });
  assert.equal(report.configurationReady, true);
  assert.deepEqual(report.blockers, []);
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

test("offline staging preflight neither connects to MongoDB nor calls fetch or changes the environment", t => {
  const env = fixture();
  const original = structuredClone(env);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden"); });
  t.mock.method(mongoose, "connect", () => { throw new Error("Database connection forbidden"); });
  t.mock.method(mongoose.mongo.MongoClient.prototype, "connect", () => { throw new Error("Driver connection forbidden"); });
  assert.equal(checkStagingConfiguration({ env }).configurationReady, true);
  assert.deepEqual(env, original);
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
