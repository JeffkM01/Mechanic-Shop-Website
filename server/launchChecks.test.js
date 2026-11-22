import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLaunchConfiguration, LIVE_LAUNCH_CHECKS } from "./launchChecks.js";
import { businessProfile } from "../shared/businessProfile.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validEnv = () => ({
  NODE_ENV: "production", HOST: "0.0.0.0", PORT: "3001", SERVE_FRONTEND: "true", SHUTDOWN_GRACE_MS: "10000", TRUST_PROXY: "false",
  PUBLIC_WEBSITE_ORIGIN: "https://shop.synthetic-shop.org",
  MONGODB_URI: "mongodb+srv://synthetic-user:synthetic-db-secret@cluster.synthetic-shop.org/eds_production?retryWrites=true&w=majority",
  MECHANIC_ADMIN_PASSWORD: "synthetic-staff-password-not-live-2030",
  APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 94).toString("base64"),
  SMTP_HOST: "smtp.synthetic-shop.org", SMTP_PORT: "587", SMTP_USER: "synthetic-smtp-user", SMTP_PASS: "synthetic-smtp-secret-not-live",
  MAIL_FROM: "Ed's Auto Shop <appointments@synthetic-shop.org>", MECHANIC_NOTIFICATION_EMAIL: "staff@synthetic-shop.org",
});
const approvedProfile = () => ({
  schemaVersion: 1, name: "Synthetic Shop",
  contact: { confirmed: true, phone: "555-555-0123", email: "appointments@synthetic-shop.org", addressLines: ["100 Synthetic Test Road", "Synthetic City, ST 00000"] },
  privacy: { approved: true, effectiveDate: "2026-01-01", hostingProvider: "Synthetic Hosting Provider", databaseProvider: "Synthetic Database Provider", emailProvider: "Synthetic Mail Provider", retentionPolicy: "Synthetic reviewed retention statement for this isolated test.", requestInstructions: "Contact the synthetic shop inbox for requests." },
  cancellation: { approved: true, effectiveDate: "2026-01-01", policy: "until_start_no_fee" },
});
const checked = (patch = {}, profile = approvedProfile()) => checkLaunchConfiguration({ env: { ...validEnv(), ...patch }, profile });
const codePasses = (report, code) => report.checks.find(item => item.code === code)?.ok;

test("unknown business facts and absent production settings block configuration without approving launch", () => {
  const report = checkLaunchConfiguration({ env: {}, profile: businessProfile });
  assert.equal(report.configurationReady, false);
  assert.equal(report.readyForPublicLaunch, false);
  assert.equal(report.networkAccessed, false);
  assert.equal(report.databaseAccessed, false);
  for (const code of ["NODE_ENV", "PUBLIC_WEBSITE_ORIGIN", "MONGODB_URI", "PUBLIC_BUSINESS_PROFILE", "SHOP_CONTACT_UNCONFIRMED", "PRIVACY_NOTICE_UNAPPROVED", "CANCELLATION_POLICY_UNAPPROVED"]) {
    assert.equal(report.blockers.some(item => item.code === code), true, code);
  }
});

test("valid synthetic settings pass configuration only and retain every required live check as unverified", () => {
  const report = checked();
  assert.equal(report.configurationReady, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.readyForPublicLaunch, false);
  assert.equal(report.networkAccessed, false);
  assert.equal(report.databaseAccessed, false);
  assert.deepEqual(report.unverified, LIVE_LAUNCH_CHECKS);
  for (const code of ["DATABASE_ACCESS_UNVERIFIED", "SCHEDULING_UNVERIFIED", "EMAIL_DELIVERY_UNVERIFIED", "BACKUP_RECOVERY_UNVERIFIED", "PROXY_AND_WORKER_TOPOLOGY_UNVERIFIED"]) {
    assert.equal(report.unverified.some(item => item.code === code), true);
  }
});

test("production preflight enforces runtime formats without trusting arbitrary proxy headers", () => {
  assert.equal(codePasses(checked({ NODE_ENV: "development" }), "NODE_ENV"), false);
  for (const patch of [{ PORT: "0" }, { PORT: "65536" }, { PORT: "3001x" }, { HOST: "not-a-bind-address" }, { SERVE_FRONTEND: "yes" }, { SHUTDOWN_GRACE_MS: "-1" }, { TRUST_PROXY: "true" }, { TRUST_PROXY: "1" }, { TRUST_PROXY: "0.0.0.0/0" }]) {
    assert.equal(codePasses(checked(patch), "SERVER_RUNTIME"), false, JSON.stringify(Object.keys(patch)));
  }
  assert.equal(codePasses(checked({ TRUST_PROXY: "127.0.0.1/32,::1/128" }), "SERVER_RUNTIME"), true);
});

test("public origin rejects insecure, reserved, private, mapped and malformed addresses", () => {
  for (const origin of [undefined, "", "http://shop.synthetic-shop.org", "https://localhost", "https://localhost.", "https://shop.example.com.", "https://example.invalid", "https://127.0.0.1", "https://10.0.0.1", "https://172.16.0.1", "https://192.168.1.1", "https://[::1]", "https://[fd00::1]", "https://[::ffff:127.0.0.1]", "https://[::ffff:192.168.1.1]", "https://user:password@shop.synthetic-shop.org", "https://shop.synthetic-shop.org/path", "https://shop.synthetic-shop.org?tracking=x", "https://shop.synthetic-shop.org#token", "https://shop.synthetic-shop.org\n"]) {
    assert.equal(codePasses(checked({ PUBLIC_WEBSITE_ORIGIN: origin }), "PUBLIC_WEBSITE_ORIGIN"), false, String(origin));
  }
  assert.equal(codePasses(checked({ PUBLIC_WEBSITE_ORIGIN: "https://shop.synthetic-shop.org:8443/" }), "PUBLIC_WEBSITE_ORIGIN"), true);
});

test("management credentials require canonical encoded lengths without claiming to verify entropy", () => {
  for (const secret of [undefined, "", "REPLACE_WITH_RANDOM_KEY", "a".repeat(31), Buffer.alloc(31).toString("base64"), Buffer.alloc(129).toString("base64"), "not base64", `${validEnv().APPOINTMENT_MANAGEMENT_SECRET}\n`]) {
    assert.equal(codePasses(checked({ APPOINTMENT_MANAGEMENT_SECRET: secret }), "APPOINTMENT_MANAGEMENT_SECRET"), false);
  }
  assert.equal(codePasses(checked({ APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(64, 253).toString("base64url") }), "APPOINTMENT_MANAGEMENT_SECRET"), true);
  for (const password of ["short", "REPLACE_WITH_YOUR_OWN_PASSWORD", "x".repeat(257), "a\nlong-enough-password"]) assert.equal(codePasses(checked({ MECHANIC_ADMIN_PASSWORD: password }), "MECHANIC_ADMIN_PASSWORD"), false);
});

test("database checks require an explicit shop database and reject invalid URI shapes without connecting", () => {
  for (const uri of [undefined, "", "https://database.synthetic-shop.org/eds", "mongodb://db.internal", "mongodb://db.internal/", "mongodb://db.internal/admin", "mongodb://db.internal/test", "mongodb://db.internal/config", "mongodb://db.internal/eds%2fother", "mongodb://db.internal:70000/eds", "mongodb+srv://db.internal:27017/eds", "mongodb+srv://first.internal,second.internal/eds", "mongodb://bad%ZZ:secret@db.internal/eds", "mongodb://bad%0auser:secret@db.internal/eds", "mongodb://DB_USER:password@CLUSTER.mongodb.net/eds"]) {
    assert.equal(codePasses(checked({ MONGODB_URI: uri }), "MONGODB_URI"), false, String(uri));
  }
  for (const uri of ["mongodb://mongo.internal:27017/eds_prod", "mongodb://first.internal,second.internal/eds_prod?replicaSet=rs0", "mongodb://[::1]:27017/eds_prod", "mongodb://user:p%40ss@mongo.internal/eds_prod"]) assert.equal(codePasses(checked({ MONGODB_URI: uri }), "MONGODB_URI"), true);
});

test("SMTP values reject placeholders, control injection and multi-recipient headers", () => {
  for (const patch of [{ SMTP_HOST: "https://smtp.synthetic-shop.org" }, { SMTP_HOST: "localhost" }, { SMTP_HOST: "127.0.0.1" }, { SMTP_HOST: "smtp.example.invalid" }, { SMTP_PORT: "NaN" }, { SMTP_PORT: "65536" }, { SMTP_USER: "" }, { SMTP_PASS: "CHANGE_ME" }, { MAIL_FROM: "a@synthetic-shop.org,b@synthetic-shop.org" }, { MAIL_FROM: "Sender\r\nBcc:other@synthetic-shop.org" }, { MECHANIC_NOTIFICATION_EMAIL: "Staff <staff@synthetic-shop.org>" }, { MECHANIC_NOTIFICATION_EMAIL: "staff@example.invalid" }]) {
    const key = Object.keys(patch)[0];
    assert.equal(codePasses(checked(patch), key), false, key);
  }
});

test("reports contain key names and fixed advice, never supplied secret or malformed profile values", () => {
  const secret = "DO_NOT_ECHO_SYNTHETIC_SECRET_29";
  const profile = approvedProfile(); profile.contact.email = `${secret}\r\n@example.invalid`;
  const env = { ...validEnv(), PUBLIC_WEBSITE_ORIGIN: `https://${secret}:private@localhost`, MONGODB_URI: `${secret}://invalid`, MECHANIC_ADMIN_PASSWORD: `${secret}\n`, APPOINTMENT_MANAGEMENT_SECRET: secret, SMTP_PASS: `${secret}\n` };
  const result = JSON.stringify(checkLaunchConfiguration({ env, profile }));
  assert.equal(result.includes(secret), false);
  assert.equal(result.includes("MECHANIC_ADMIN_PASSWORD"), true);
  assert.equal(result.includes("INVALID_BUSINESS_PROFILE"), true);
});

test("offline validation neither mutates supplied settings nor invokes fetch", t => {
  const env = validEnv();
  const profile = approvedProfile();
  const original = structuredClone({ env, profile });
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network is allowed in offline preflight."); });
  assert.equal(checkLaunchConfiguration({ env, profile }).configurationReady, true);
  assert.deepEqual({ env, profile }, original);
});

async function cliFixture(t, profile = approvedProfile()) {
  const root = await mkdtemp(join(tmpdir(), "eds-launch-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(["server", "shared", "scripts"].map(directory => mkdir(join(root, directory))));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  for (const file of ["scripts/check-launch.js", "server/launchChecks.js", "server/runtimeConfig.js", "shared/businessProfile.js", "shared/appointmentFields.js", "shared/services.js"]) await copyFile(join(project, file), join(root, file));
  await writeFile(join(root, "shared/businessProfile.json"), JSON.stringify(profile));
  return root;
}

test("CLI JSON success means configuration only, never approval or deployment", async t => {
  const root = await cliFixture(t);
  const result = spawnSync(process.execPath, [join(root, "scripts/check-launch.js"), "--json"], { cwd: root, env: validEnv(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configurationReady, true);
  assert.equal(report.readyForPublicLaunch, false);
  assert.equal(report.unverified.length, LIVE_LAUNCH_CHECKS.length);
  for (const value of [validEnv().SMTP_PASS, validEnv().MONGODB_URI, validEnv().APPOINTMENT_MANAGEMENT_SECRET]) assert.equal(result.stdout.includes(value), false);
});

test("CLI does not load private env files and exits blocked with readable fixed messages", async t => {
  const root = await cliFixture(t);
  const secret = "SYNTHETIC_PRIVATE_ENV_FILE_MUST_NOT_BE_READ";
  await writeFile(join(root, ".env"), `NODE_ENV=production\nSMTP_PASS=${secret}\n`);
  await writeFile(join(root, "server/.env"), `NODE_ENV=production\nSMTP_PASS=${secret}\n`);
  const result = spawnSync(process.execPath, [join(root, "scripts/check-launch.js")], { cwd: root, env: {}, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /CONFIGURATION BLOCKED/);
  assert.match(result.stdout, /\[BLOCKED\] NODE_ENV/);
  assert.match(result.stdout, /\[UNVERIFIED\] BACKUP_RECOVERY_UNVERIFIED/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test("CLI malformed source-profile and argument failures do not echo private values", async t => {
  const secret = "SYNTHETIC_PROFILE_VALUE_NOT_FOR_LOGS";
  const root = await cliFixture(t, { secret });
  const failed = spawnSync(process.execPath, [join(root, "scripts/check-launch.js"), "--json"], { cwd: root, env: validEnv(), encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not read valid public\/runtime configuration/);
  assert.equal(`${failed.stdout}${failed.stderr}`.includes(secret), false);
  const argument = spawnSync(process.execPath, [join(root, "scripts/check-launch.js"), "--unknown"], { cwd: root, env: validEnv(), encoding: "utf8" });
  assert.equal(argument.status, 1);
  assert.match(argument.stderr, /^Usage:/);
});
