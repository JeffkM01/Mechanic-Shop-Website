// CI-only packaged configuration check. Never use against a hosted service.
// This script does not create appointments or request an email send.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";

assert.equal(process.env.CI, "true", "Only run this check in the synthetic CI container");
assert.equal(process.env.DEPLOYMENT_STAGE, "staging");
assert.match(process.env.MONGODB_DATABASE, /^eds_staging_workflow_image_test_[a-z0-9_]+$/);
assert.equal(process.env.MONGODB_URI, `mongodb://127.0.0.1:27017/${process.env.MONGODB_DATABASE}`);
assert.equal(process.env.STAGING_EMAIL_TEST_ENABLED, "false");
assert.equal(process.env.STAGING_APPOINTMENT_EMAIL_TEST_ENABLED, "true");
assert.equal(process.env.BREVO_API_KEY, "Synthetic-private-API-marker-for-packaging-only");

const preflight = spawnSync(process.execPath, ["scripts/check-staging.js", "--json"], {
  env: process.env,
  encoding: "utf8",
});
assert.equal(preflight.status, 0, "Packaged offline preflight must validate scoped workflow configuration");
const report = JSON.parse(preflight.stdout);
assert.equal(report.configurationReady, true);
assert.equal(report.deploymentApproved, false);
assert.equal(report.readyForPublicLaunch, false);
assert.equal(report.networkAccessed, false);
assert.equal(report.databaseAccessed, false);
assert.equal(report.emailConnectionTestEnabled, false);
assert.equal(report.appointmentEmailTestEnabled, true);
for (const name of ["BREVO_API_KEY", "APPOINTMENT_MANAGEMENT_SECRET", "STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID", "STAGING_ACCESS_PASSWORD", "MECHANIC_ADMIN_PASSWORD"]) {
  assert.ok(process.env[name], "Synthetic private configuration must be supplied");
  assert.ok(!`${preflight.stdout}${preflight.stderr}`.includes(process.env[name]), "Offline preflight must not expose configuration values");
}

const origin = "http://127.0.0.1:3001";
const authorization = `Basic ${Buffer.from(`staging:${process.env.STAGING_ACCESS_PASSWORD}`).toString("base64")}`;
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { healthy = (await fetch(`${origin}/api/health`)).ok; } catch { /* wait for local startup */ }
  if (healthy) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(healthy, "Packaged workflow API must connect to the disposable database");
for (const path of ["/appointment", "/api/appointment-email-test", "/api/mechanic/appointment-email-test"]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 401, path);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
}
const expectedScope = { enabled: true, recipient: "contact@edsautoshop.com" };
const publicStatus = await fetch(`${origin}/api/appointment-email-test`, { headers: { authorization } });
assert.equal(publicStatus.status, 200);
assert.equal(publicStatus.headers.get("cache-control"), "no-store");
assert.deepEqual(await publicStatus.json(), expectedScope);
assert.equal((await fetch(`${origin}/api/mechanic/appointment-email-test`, { headers: { authorization } })).status, 401);

const login = await fetch(`${origin}/api/mechanic/login`, {
  method: "POST", headers: { authorization, "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.MECHANIC_ADMIN_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie");
assert.match(cookie, /HttpOnly/i);
assert.match(cookie, /Secure/i);
assert.match(cookie, /SameSite=Strict/i);
const session = await login.json();
const privateHeaders = { authorization, cookie: cookie.split(";")[0], "Content-Type": "application/json" };
const staffStatus = await fetch(`${origin}/api/mechanic/appointment-email-test`, { headers: privateHeaders });
assert.equal(staffStatus.status, 200);
assert.deepEqual(await staffStatus.json(), expectedScope);
const appointments = await fetch(`${origin}/api/mechanic/appointments?status=all`, { headers: privateHeaders });
assert.equal(appointments.status, 200);
assert.deepEqual(await appointments.json(), { appointments: [] }, "Fresh workflow namespace must have no appointments or queued notifications");
const probeStatus = await fetch(`${origin}/api/mechanic/email-test`, { headers: privateHeaders });
assert.equal(probeStatus.status, 200);
assert.deepEqual(await probeStatus.json(), { enabled: false });
// Only staff session mutations are exercised. Never submit appointments,
// decisions, cancellations, management credentials, or email-test requests.
assert.equal((await fetch(`${origin}/api/mechanic/logout`, { method: "POST", headers: privateHeaders })).status, 403);
assert.equal((await fetch(`${origin}/api/mechanic/logout`, { method: "POST", headers: { ...privateHeaders, "x-mechanic-csrf": session.csrfToken } })).status, 200);
assert.equal((await fetch(`${origin}/api/mechanic/appointment-email-test`, { headers: privateHeaders })).status, 401);
console.log("Packaged scoped workflow: protected startup, offline preflight, private metadata, staff sessions, CSRF, and empty queue checks passed. No appointments created or email sends requested.");
