import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { EMAIL_KINDS } from "./emailTemplates.js";

// Own a new random database in the disposable test service. Never load .env or
// use an application's database name; cleanup verifies the exact owned name.
const uri = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
const START = Date.parse("2030-01-01T12:00:00Z");
const env = {
  SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user",
  SMTP_PASS: "synthetic-password", MAIL_FROM: "shop@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid",
};

async function fixture(t) {
  const dbName = `eds_email_retry_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(dbName, /^eds_email_retry_test_[a-f\d]{32}$/);
  const connection = mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    try {
      if (connection.readyState === 1) {
        assert.equal(connection.name, dbName);
        assert.match(connection.name, /^eds_email_retry_test_[a-f\d]{32}$/);
        await connection.dropDatabase();
      }
    } finally { await connection.close(); }
  });
  await connection.asPromise();
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  await Appointment.init();
  let clock = START;
  const accepted = [];
  const attempts = [];
  let reject = () => false;
  return {
    Appointment, accepted, attempts,
    setClock(value) { clock = +value; },
    setReject(callback) { reject = callback; },
    create() {
      return createEmailNotifications({ Appointment, env, now: () => new Date(clock), logger: { error() {} },
        transport: { async sendMail(message) {
          attempts.push(message.to);
          const failure = reject(message);
          if (failure) throw failure;
          accepted.push(message.to);
        } },
      });
    },
  };
}

function record(index) {
  return {
    _id: new mongoose.Types.ObjectId(), name: "Synthetic Mongo Retry Customer", email: `retry-${index}@example.invalid`,
    phone: "555-555-0167", vehicle: "2019 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", status: "pending",
    createdAt: new Date(START - 60_000 + index),
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "not-applicable" },
  };
}

test("Mongo persists permanent failures and indexes while legacy due records remain deliverable beyond 50 failures", async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 51 }, (_, index) => record(index));
  const historical = record(52);
  delete historical.notificationState;
  // Raw inserts exercise actual legacy documents with no retry fields/defaults.
  await f.Appointment.collection.insertMany([...records, historical]);
  const newest = records.at(-1);
  f.setReject(message => message.to === newest.email ? false : Object.assign(new Error("private provider error"), { command: "RCPT TO", responseCode: 550 }));
  const service = await f.create();
  await service.processPending();
  await service.stop();
  const restarted = await f.create();
  await restarted.processPending();
  await restarted.stop();
  assert.deepEqual(f.accepted, [newest.email]);
  assert.equal(f.attempts.length, 51);
  assert.equal(await f.Appointment.countDocuments({ "notificationState.requestCustomer": "failed" }), 50);
  const failed = await f.Appointment.findById(records[0]._id).select("+notificationRetry").lean();
  assert.equal(failed.notificationRetry.requestCustomer.lastFailureCode, "recipient-rejected");
  assert.equal(failed.notificationRetry.requestCustomer.history[0].permanent, true);
  assert.equal(failed.notificationRetry.requestCustomer.nextAttemptAt, null);
  assert.equal((await f.Appointment.findById(records[0]._id).lean()).notificationRetry, undefined);
  const untouched = await f.Appointment.collection.findOne({ _id: historical._id });
  assert.equal(untouched.notificationState, undefined);
  assert.equal(untouched.notificationRetry, undefined);
  const indexes = await f.Appointment.collection.indexes();
  for (const kind of EMAIL_KINDS) {
    assert.ok(indexes.some(({ key }) => key[`notificationState.${kind}`] === 1
      && key[`notificationRetry.${kind}.nextAttemptAt`] === 1 && key.createdAt === 1));
  }
});

test("Mongo casts persisted retry deadlines and allows newer mail before 50 transient recipients are due", async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 51 }, (_, index) => record(index));
  await f.Appointment.collection.insertMany(records);
  const newest = records.at(-1);
  f.setReject(message => message.to === newest.email ? false : new Error("private temporary SMTP failure"));
  const service = await f.create();
  await service.processPending();
  await service.stop();
  const persisted = await f.Appointment.findById(records[0]._id).select("+notificationRetry").lean();
  assert.equal(persisted.notificationState.requestCustomer, "pending");
  assert.equal(+persisted.notificationRetry.requestCustomer.nextAttemptAt, START + 60_000);
  assert.equal(persisted.notificationRetry.requestCustomer.failureCount, 1);
  const restarted = await f.create();
  await restarted.processPending();
  assert.deepEqual(f.accepted, [newest.email]);
  assert.equal(f.attempts.length, 51);
  f.setReject(() => false);
  f.setClock(START + 59_999);
  await restarted.processPending();
  assert.equal(f.attempts.length, 51);
  f.setClock(START + 60_000);
  await restarted.processPending();
  await restarted.stop();
  assert.equal(f.accepted.length, 51);
  assert.equal(await f.Appointment.countDocuments({ "notificationState.requestCustomer": "sent" }), 51);
  const delivered = await f.Appointment.findById(records[0]._id).select("+notificationRetry").lean();
  assert.equal(delivered.notificationRetry.requestCustomer.failureCount, 1, "success preserves the failure audit");
});
