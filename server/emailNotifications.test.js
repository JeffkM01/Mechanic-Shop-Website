import test from "node:test";
import assert from "node:assert/strict";
import { buildEmail } from "./emailTemplates.js";
import { createEmailNotifications } from "./emailNotifications.js";

const config = {
  SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "test-user",
  SMTP_PASS: "test-password", MAIL_FROM: "shop@example.test",
  MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.test",
};

const sample = {
  _id: "0123456789abcdef01234567", name: "Sample Customer", email: "customer@example.test",
  phone: "555-0101", vehicle: "2016 Sedan", service: "Brake Repairs",
  date: "2026-11-06", time: "10:30", notes: "Noise at low speeds", status: "pending",
  notificationState: { requestCustomer: "pending", requestMechanic: "pending", decisionCustomer: "not-applicable" },
};

function fakeAppointmentModel(records) {
  return {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() {
          return records.filter((item) => Object.values(item.notificationState || {}).includes("pending"));
        },
      };
    },
    async updateOne(query, change) {
      const record = records.find((item) => item._id === query._id);
      const [field, value] = Object.entries(change.$set)[0];
      const kind = field.split(".").at(-1);
      if (record.notificationState[kind] === "pending") {
        record.notificationState[kind] = value;
      }
    },
  };
}

test("customer receipt says pending, not confirmed", () => {
  const email = buildEmail("requestCustomer", sample, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.to, sample.email);
  assert.match(email.text, /PENDING/);
  assert.doesNotMatch(email.text, /CONFIRMED/);
});

test("mechanic request includes contact and notes", () => {
  const email = buildEmail("requestMechanic", sample, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.to, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.match(email.text, /Noise at low speeds/);
  assert.equal(email.replyTo, sample.email);
});

test("decision email reflects approved and declined statuses", () => {
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  assert.match(buildEmail("decisionCustomer", { ...sample, status: "confirmed" }, options).text, /CONFIRMED/);
  assert.match(buildEmail("decisionCustomer", { ...sample, status: "declined" }, options).text, /DECLINED/);
  assert.throws(() => buildEmail("decisionCustomer", sample, options), /pending appointment/);
});

test("email service is disabled when credentials are absent", async () => {
  const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([]), env: {} });
  assert.equal(service.enabled, false);
  await service.processPending();
});

test("mailer failure leaves pending status and a later sweep retries", async () => {
  const records = [{ ...sample, notificationState: { ...sample.notificationState } }];
  const sent = [];
  let failOnce = true;
  const transport = {
    async sendMail(message) {
      if (failOnce) { failOnce = false; throw new Error("Simulated SMTP outage"); }
      sent.push(message);
    },
  };
  const logger = { error() {} };
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel(records), env: config, transport, logger,
  });
  await service.processPending();
  assert.equal(records[0].notificationState.requestCustomer, "pending");
  assert.equal(records[0].notificationState.requestMechanic, "sent");
  await service.processPending();
  assert.equal(records[0].notificationState.requestCustomer, "sent");
  assert.equal(sent.length, 2);
});

test("old appointments without queue flags are skipped", async () => {
  const records = [{ ...sample, notificationState: undefined }];
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel(records), env: config,
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  assert.equal(sent.length, 0);
});

test("pending scheduling receipts explain expiring holds without a false confirmation", () => {
  const email = buildEmail("requestCustomer", { ...sample, scheduling: { timezone: "America/Chicago", durationMinutes: 60, holdExpiresAt: "2026-11-08T12:00:00Z" } }, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.match(email.text, /PENDING/);
  assert.match(email.text, /request remains on file after expiry/);
  assert.match(email.text, /not a guaranteed repair completion time/);
  assert.doesNotMatch(email.text, /CONFIRMED/);
});

test("verified automatic confirmation receipts agree with confirmed status", () => {
  const appointment = { ...sample, status: "confirmed", scheduling: { confirmationSource: "automatic", timezone: "America/Chicago" } };
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  for (const kind of ["requestCustomer", "requestMechanic", "decisionCustomer"]) {
    const email = buildEmail(kind, appointment, options);
    assert.match(email.text, /CONFIRMED/);
    assert.doesNotMatch(email.text, /PENDING|NOT been approved/);
  }
});
