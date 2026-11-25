import test from "node:test";
import assert from "node:assert/strict";
import { readAppointmentEmailTestConfiguration } from "./appointmentEmailTest.js";
import { OWNED_EMAIL_TEST_FROM, OWNED_EMAIL_TEST_RECIPIENT } from "./appointmentEmailScope.js";

const RUN = "38e5960b-d567-4b72-a826-195111ffae41";
const KEY = "synthetic-private-api-key-for-workflow-configuration";
const SECRET = Buffer.alloc(32, 47).toString("base64url");
const fixture = () => ({ NODE_ENV: "production", STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: "true",
  STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: RUN, STAGING_EMAIL_TEST_ENABLED: "false", BREVO_API_KEY: KEY,
  PUBLIC_WEBSITE_ORIGIN: "https://edsautoshop.com", APPOINTMENT_MANAGEMENT_SECRET: SECRET,
  MAIL_FROM: "unapproved@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "unapproved@example.invalid", EMAIL_TRANSPORT: "smtp" });

test("workflow mode is disabled by default without requiring keys, origin or a run identity", () => {
  for (const STAGING_APPOINTMENT_EMAIL_TEST_ENABLED of [undefined, "false"]) {
    assert.deepEqual(readAppointmentEmailTestConfiguration({ env: { STAGING_APPOINTMENT_EMAIL_TEST_ENABLED } }), {
      enabled: false, deliveryScope: null, notificationEnv: null,
    });
  }
});

test("enabled workflow creates only a locked HTTPS environment and a fixed-inbox scoped run, offline", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Real email forbidden"); });
  const env = fixture();
  const original = structuredClone(env);
  const result = readAppointmentEmailTestConfiguration({ staging: { enabled: true }, env });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.deliveryScope, { runId: RUN, recipient: OWNED_EMAIL_TEST_RECIPIENT });
  assert.equal(Object.isFrozen(result.deliveryScope), true);
  assert.equal(Object.isFrozen(result.notificationEnv), true);
  assert.deepEqual(result.notificationEnv, { NODE_ENV: "production", DEPLOYMENT_STAGE: "staging", EMAIL_TRANSPORT: "brevo_api",
    BREVO_API_KEY: KEY, MAIL_FROM: OWNED_EMAIL_TEST_FROM, MECHANIC_NOTIFICATION_EMAIL: OWNED_EMAIL_TEST_RECIPIENT,
    PUBLIC_WEBSITE_ORIGIN: env.PUBLIC_WEBSITE_ORIGIN, APPOINTMENT_MANAGEMENT_SECRET: SECRET });
  assert.deepEqual(env, original);
});

test("workflow refuses unprotected activation, mixed probe modes, invalid run IDs or incomplete private link configuration", () => {
  for (const staging of [undefined, { enabled: false }]) assert.throws(() => readAppointmentEmailTestConfiguration({ staging, env: fixture() }), /requires protected staging/);
  for (const patch of [
    { STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: "yes" }, { STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: true },
    { STAGING_EMAIL_TEST_ENABLED: "true" }, { STAGING_EMAIL_TEST_ENABLED: "yes" },
    { STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: undefined }, { STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: "old-test-request" },
    { BREVO_API_KEY: undefined }, { BREVO_API_KEY: "private\nkey" },
    { PUBLIC_WEBSITE_ORIGIN: undefined }, { PUBLIC_WEBSITE_ORIGIN: "http://edsautoshop.com" },
    { PUBLIC_WEBSITE_ORIGIN: "https://edsautoshop.com/path" }, { APPOINTMENT_MANAGEMENT_SECRET: "short" },
  ]) {
    assert.throws(() => readAppointmentEmailTestConfiguration({ staging: { enabled: true }, env: { ...fixture(), ...patch } }), error => {
      for (const secret of [KEY, SECRET, "private\nkey", "old-test-request"]) assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});
