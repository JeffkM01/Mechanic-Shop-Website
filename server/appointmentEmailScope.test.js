import test from "node:test";
import assert from "node:assert/strict";
import { appointmentEmailScopeQuery, appointmentMatchesEmailScope, isOwnedEmailTestRecipient,
  OWNED_EMAIL_TEST_FROM, OWNED_EMAIL_TEST_RECIPIENT, protectAppointmentTestEmail, validateEmailDeliveryScope } from "./appointmentEmailScope.js";

const runId = "38e5960b-d567-4b72-a826-195111ffae41";
const scope = { runId, recipient: OWNED_EMAIL_TEST_RECIPIENT };

test("delivery scope accepts only the fixed inbox and canonical UUID run identity", () => {
  assert.equal(validateEmailDeliveryScope(), null);
  assert.deepEqual(validateEmailDeliveryScope({ ...scope, runId: runId.toUpperCase() }), scope);
  assert.equal(Object.isFrozen(validateEmailDeliveryScope(scope)), true);
  for (const value of [{}, [], { ...scope, recipient: "other@example.invalid" }, { ...scope, runId: "older-request" }, { ...scope, runId: `${runId}\n` }, { ...scope, extra: true }]) {
    assert.throws(() => validateEmailDeliveryScope(value));
  }
});

test("scoped eligibility requires both run identity and the verified inbox, while ordinary delivery excludes every test tag", () => {
  const record = { notificationTestRunId: runId, email: OWNED_EMAIL_TEST_RECIPIENT };
  assert.equal(appointmentMatchesEmailScope(record, scope), true);
  assert.equal(appointmentMatchesEmailScope({ ...record, email: OWNED_EMAIL_TEST_RECIPIENT.toUpperCase() }, scope), true);
  for (const value of [null, {}, { email: OWNED_EMAIL_TEST_RECIPIENT }, { ...record, notificationTestRunId: "43e5960b-d567-4b72-a826-195111ffae41" }, { ...record, email: "other@example.invalid" }]) {
    assert.equal(appointmentMatchesEmailScope(value, scope), false);
  }
  for (const value of [runId, "", null, "invalid-tag"]) assert.equal(appointmentMatchesEmailScope({ notificationTestRunId: value, email: OWNED_EMAIL_TEST_RECIPIENT }), false);
  assert.equal(appointmentMatchesEmailScope({ email: OWNED_EMAIL_TEST_RECIPIENT }), true);
  assert.equal(appointmentMatchesEmailScope(record, { runId: undefined, recipient: OWNED_EMAIL_TEST_RECIPIENT }), false);
  assert.equal(isOwnedEmailTestRecipient(` ${OWNED_EMAIL_TEST_RECIPIENT.toUpperCase()} `), true);
  for (const value of [null, [], `${OWNED_EMAIL_TEST_RECIPIENT},other@example.invalid`, "other@example.invalid"]) assert.equal(isOwnedEmailTestRecipient(value), false);
});

test("candidate queries isolate the active run and never admit old requests or production replay", () => {
  assert.deepEqual(appointmentEmailScopeQuery(scope), { notificationTestRunId: runId, email: OWNED_EMAIL_TEST_RECIPIENT });
  assert.deepEqual(appointmentEmailScopeQuery(), { notificationTestRunId: { $exists: false } });
  assert.throws(() => appointmentEmailScopeQuery({ runId: undefined }));
});

test("test mail decoration is explicit, preserves the original template and refuses any recipient or identity override", () => {
  const message = { from: OWNED_EMAIL_TEST_FROM, to: OWNED_EMAIL_TEST_RECIPIENT, replyTo: OWNED_EMAIL_TEST_RECIPIENT,
    subject: "Appointment confirmed", text: "Synthetic appointment content" };
  const decorated = protectAppointmentTestEmail(message, scope);
  assert.equal(decorated.subject, "[TEST ONLY] Appointment confirmed");
  assert.match(decorated.text, /^PRIVATE APPOINTMENT EMAIL TEST/);
  assert.match(decorated.text, /Synthetic appointment content$/);
  assert.equal(message.subject, "Appointment confirmed");
  assert.equal(protectAppointmentTestEmail(message), message);
  for (const field of ["from", "to", "replyTo"]) assert.throws(() => protectAppointmentTestEmail({ ...message, [field]: "other@example.invalid" }, scope));
});
