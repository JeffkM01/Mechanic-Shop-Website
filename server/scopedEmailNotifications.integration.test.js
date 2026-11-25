import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { OWNED_EMAIL_TEST_FROM, OWNED_EMAIL_TEST_RECIPIENT } from "./appointmentEmailScope.js";

const START = Date.parse("2030-01-01T12:00:00Z");
const scope = { runId: "c6311069-f235-4acf-9123-a98cb177aa60", recipient: OWNED_EMAIL_TEST_RECIPIENT };
const otherRun = "16b06747-92e3-4dbb-a899-f8142087c251";
const scopedEnv = { DEPLOYMENT_STAGE: "staging", EMAIL_TRANSPORT: "brevo_api", BREVO_API_KEY: "synthetic-scoped-api-key-no-real-network",
  MAIL_FROM: OWNED_EMAIL_TEST_FROM, MECHANIC_NOTIFICATION_EMAIL: OWNED_EMAIL_TEST_RECIPIENT };
const ordinaryEnv = { EMAIL_TRANSPORT: "brevo_api", BREVO_API_KEY: "synthetic-ordinary-api-key-no-real-network",
  MAIL_FROM: OWNED_EMAIL_TEST_FROM, MECHANIC_NOTIFICATION_EMAIL: OWNED_EMAIL_TEST_RECIPIENT };

// A fresh random database in the disposable local test server; never load .env,
// use a normal application database, construct live mail, or contact Brevo.
async function fixture(t) {
  const dbName = `eds_scoped_email_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(dbName, /^eds_scoped_email_test_[a-f\d]{32}$/);
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", { dbName, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    try {
      if (connection.readyState === 1) {
        assert.equal(connection.name, dbName);
        assert.match(connection.name, /^eds_scoped_email_test_[a-f\d]{32}$/);
        await connection.dropDatabase();
      }
    } finally { await connection.close(); }
  });
  await connection.asPromise();
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  await Appointment.init();
  let clock = START;
  const messages = [];
  const attempts = [];
  return { Appointment, messages, attempts,
    setClock(value) { clock = +value; },
    create({ deliveryScope = scope, ordinary = false, sendMail, management = null } = {}) {
      return createEmailNotifications({ Appointment, env: ordinary ? ordinaryEnv : scopedEnv,
        deliveryScope: ordinary ? null : deliveryScope, management, now: () => new Date(clock), logger: { error() {} },
        transport: { async sendMail(message) {
          attempts.push(message);
          await sendMail?.(message);
          messages.push(message);
        } },
      });
    },
  };
}

function record(index, changes = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), name: `Synthetic Scoped Customer ${index}`, email: OWNED_EMAIL_TEST_RECIPIENT,
    phone: "555-555-0167", vehicle: "2019 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", status: "pending",
    createdAt: new Date(START - 60_000 + index),
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "not-applicable" },
    ...changes,
  };
}

test("Mongo scopes the batch before its limit so 50 old requests cannot block a new active-run message", async t => {
  const f = await fixture(t);
  const older = Array.from({ length: 50 }, (_, index) => record(index));
  const other = record(51, { notificationTestRunId: otherRun });
  const wrongEmail = record(52, { notificationTestRunId: scope.runId, email: "not-owned@example.invalid" });
  const active = record(53, { notificationTestRunId: scope.runId });
  await f.Appointment.collection.insertMany([...older, other, wrongEmail, active]);
  const untouchedBefore = await f.Appointment.collection.find({ _id: { $ne: active._id } }).sort({ _id: 1 }).toArray();
  let grantReads = 0;
  const service = await f.create({ management: { emailLink(appointment) {
    grantReads++;
    assert.equal(String(appointment._id), String(active._id));
    return null;
  } } });
  await service.processPending(); await service.processPending(); await service.stop();
  assert.equal(f.messages.length, 1);
  assert.equal(grantReads, 1);
  const message = f.messages[0];
  assert.equal(message.to, scope.recipient);
  assert.equal(message.replyTo, scope.recipient);
  assert.equal(message.from, OWNED_EMAIL_TEST_FROM);
  assert.match(message.subject, /^\[TEST ONLY\]/);
  assert.match(message.text, /^PRIVATE APPOINTMENT EMAIL TEST/);
  assert.ok(message.text.includes(active.name));
  assert.ok(!message.text.includes(older[0].name));
  assert.deepEqual(await f.Appointment.collection.find({ _id: { $ne: active._id } }).sort({ _id: 1 }).toArray(), untouchedBefore);
  const saved = await f.Appointment.findById(active._id).select("+notificationTestRunId").lean();
  assert.equal(saved.notificationState.requestCustomer, "sent");
  assert.equal(saved.notificationTestRunId, scope.runId);
  assert.equal((await f.Appointment.findById(active._id).lean()).notificationTestRunId, undefined, "the delivery marker stays private by default");
});

test("a scoped restart honors persisted backoff and a new run cannot replay the prior run's pending message", async t => {
  const f = await fixture(t);
  const active = record(1, { notificationTestRunId: scope.runId });
  await f.Appointment.collection.insertOne(active);
  const failed = await f.create({ sendMail: async () => { throw new Error("Synthetic outage; never a real provider"); } });
  await failed.processPending(); await failed.stop();
  let saved = await f.Appointment.findById(active._id).select("+notificationRetry +notificationTestRunId").lean();
  assert.equal(saved.notificationState.requestCustomer, "pending");
  assert.equal(saved.notificationRetry.requestCustomer.failureCount, 1);
  assert.equal(+saved.notificationRetry.requestCustomer.nextAttemptAt, START + 60_000);
  const retry = await f.create();
  await retry.processPending();
  assert.equal(f.attempts.length, 1);
  await retry.stop();
  f.setClock(START + 60_000);
  const next = record(2, { notificationTestRunId: otherRun });
  await f.Appointment.collection.insertOne(next);
  const nextRun = await f.create({ deliveryScope: { ...scope, runId: otherRun } });
  await nextRun.processPending(); await nextRun.stop();
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].text.includes(next.name));
  saved = await f.Appointment.findById(active._id).select("+notificationRetry").lean();
  assert.equal(saved.notificationState.requestCustomer, "pending");
  assert.equal(saved.notificationRetry.requestCustomer.failureCount, 1);
  const resumed = await f.create();
  await resumed.processPending(); await resumed.stop();
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages[1].text.includes(active.name));
  saved = await f.Appointment.findById(active._id).select("+notificationRetry").lean();
  assert.equal(saved.notificationState.requestCustomer, "sent");
  assert.equal(saved.notificationRetry.requestCustomer.failureCount, 1, "delivery retains the failure audit");
});

test("ordinary Mongo delivery excludes every tagged test request even after the test mode ends", async t => {
  const f = await fixture(t);
  const ordinary = record(1, { email: "ordinary@example.invalid" });
  const testRequests = [scope.runId, otherRun, null, ""].map((tag, index) => record(index + 2, { notificationTestRunId: tag }));
  await f.Appointment.collection.insertMany([ordinary, ...testRequests]);
  const before = await f.Appointment.collection.find({ notificationTestRunId: { $exists: true } }).sort({ _id: 1 }).toArray();
  const service = await f.create({ ordinary: true });
  await service.processPending(); await service.stop();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].to, ordinary.email);
  assert.doesNotMatch(f.messages[0].subject, /TEST ONLY/);
  assert.equal((await f.Appointment.findById(ordinary._id).lean()).notificationState.requestCustomer, "sent");
  assert.deepEqual(await f.Appointment.collection.find({ notificationTestRunId: { $exists: true } }).sort({ _id: 1 }).toArray(), before);
});

test("Mongo scope preconditions retain the original flags and retry metadata if identity changes during an admitted send", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t);
    const active = record(1, { notificationTestRunId: scope.runId });
    await f.Appointment.collection.insertOne(active);
    const original = await f.Appointment.collection.findOne({ _id: active._id });
    const service = await f.create({ sendMail: async () => {
      // A direct synthetic storage change exercises the worst-case stale read;
      // the application itself never exposes a run-marker mutation route.
      await f.Appointment.collection.updateOne({ _id: active._id }, { $set: { notificationTestRunId: otherRun } });
      if (fail) throw new Error("Synthetic admitted transport failure");
    } });
    await service.processPending(); await service.processPending(); await service.stop();
    const saved = await f.Appointment.collection.findOne({ _id: active._id });
    assert.equal(f.attempts.length, 1);
    assert.deepEqual(saved.notificationState, original.notificationState);
    assert.equal(saved.notificationRetry, undefined);
    assert.equal(saved.notificationTestRunId, otherRun);
  }
});
