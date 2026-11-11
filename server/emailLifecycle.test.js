import test from "node:test";
import assert from "node:assert/strict";
import { createEmailNotifications } from "./emailNotifications.js";

const env = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user", SMTP_PASS: "synthetic-password", MAIL_FROM: "shop@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ sendMail, beforeRead, beforeAcknowledge } = {}) {
  const record = {
    _id: "0123456789abcdef01234567", name: "Synthetic Lifecycle Customer", email: "customer@example.invalid", phone: "555-555-0167",
    vehicle: "2019 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", notes: "Synthetic lifecycle test.", status: "pending",
    notificationState: { requestCustomer: "pending", requestMechanic: "pending", decisionCustomer: "not-applicable" },
  };
  const state = { reads: 0, batches: 0, messages: [], logs: [] };
  const Appointment = {
    find() {
      state.batches++;
      return { sort() { return this; }, limit() { return this; }, async lean() { return Object.values(record.notificationState).includes("pending") ? [structuredClone(record)] : []; } };
    },
    findById() {
      return { select() { return this; }, async lean() {
        state.reads++;
        await beforeRead?.();
        return structuredClone(record);
      } };
    },
    async updateOne(query, change) {
      await beforeAcknowledge?.(query);
      const get = path => path.split(".").reduce((value, key) => value?.[key], record);
      if (!Object.entries(query).every(([key, value]) => get(key) === value)) return { modifiedCount: 0 };
      for (const [path, value] of Object.entries(change.$set)) record.notificationState[path.split(".").at(-1)] = value;
      return { modifiedCount: 1 };
    },
  };
  return {
    record, state,
    create: () => createEmailNotifications({ Appointment, env,
      transport: { async sendMail(message) { state.messages.push(message.to); await sendMail?.(message); } },
      logger: { error(message) { state.logs.push(message); } },
    }),
  };
}

test("disabled notifications expose a harmless start/stop lifecycle without reading a queue", async () => {
  const service = await createEmailNotifications({ Appointment: { find() { throw new Error("must not read"); } }, env: {} });
  assert.equal(service.enabled, false);
  const cleanup = service.start();
  assert.equal(cleanup, service.stop);
  await cleanup(); await service.stop(); service.kick(); await service.processPending();
});

test("starting twice owns only one retry interval and stopping cancels scheduled queue work", async t => {
  const intervals = [];
  const cleared = [];
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    intervals.push(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearInterval", handle => { cleared.push(handle); });
  const f = fixture();
  const service = await f.create();
  service.start(); service.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 60_000);
  await service.stop();
  await tick();
  assert.equal(f.state.batches, 0);
  assert.deepEqual(cleared, intervals);
  service.kick(); await tick(); await service.processPending();
  assert.equal(f.state.batches, 0);
  assert.deepEqual(f.state.messages, []);
});

test("shutdown waits for an in-flight delivery and its database acknowledgement while leaving unsent kinds queued", async () => {
  const sending = deferred(); const accept = deferred();
  const acknowledging = deferred(); const acknowledge = deferred();
  const f = fixture({
    sendMail: async () => { sending.resolve(); await accept.promise; },
    beforeAcknowledge: async query => { if (query["notificationState.requestCustomer"]) { acknowledging.resolve(); await acknowledge.promise; } },
  });
  const service = await f.create();
  const processing = service.processPending();
  await sending.promise;
  let drained = false;
  const stopped = service.stop().then(() => { drained = true; });
  try {
    await Promise.resolve();
    assert.equal(drained, false);
    assert.equal(f.record.notificationState.requestCustomer, "pending");
    accept.resolve();
    await acknowledging.promise;
    assert.equal(drained, false);
    acknowledge.resolve();
    await stopped; await processing;
    assert.equal(f.record.notificationState.requestCustomer, "sent");
    assert.equal(f.record.notificationState.requestMechanic, "pending");
    assert.deepEqual(f.state.messages, ["customer@example.invalid"]);
    service.kick(); await tick();
    assert.deepEqual(f.state.messages, ["customer@example.invalid"]);
  } finally { accept.resolve(); acknowledge.resolve(); await service.stop(); }
});

test("stopping during a fresh queue read never starts another transport send or changes its pending intent", async () => {
  const reading = deferred(); const allowRead = deferred();
  const f = fixture({ beforeRead: async () => { reading.resolve(); await allowRead.promise; } });
  const service = await f.create();
  const processing = service.processPending();
  await reading.promise;
  const stopped = service.stop();
  allowRead.resolve();
  await stopped; await processing;
  assert.deepEqual(f.state.messages, []);
  assert.equal(f.record.notificationState.requestCustomer, "pending");
  assert.equal(f.record.notificationState.requestMechanic, "pending");
});

test("transport failure during a drain remains retryable without leaking its error or altering appointment status", async () => {
  const sending = deferred(); const finish = deferred();
  const f = fixture({ sendMail: async () => { sending.resolve(); await finish.promise; throw new Error("private SMTP credential and customer contents"); } });
  const service = await f.create();
  const processing = service.processPending();
  await sending.promise;
  const stopped = service.stop();
  finish.resolve();
  await stopped; await processing;
  assert.equal(f.record.status, "pending");
  assert.equal(f.record.notificationState.requestCustomer, "pending");
  assert.equal(f.record.notificationState.requestMechanic, "pending");
  assert.equal(f.state.logs.length, 1);
  assert.doesNotMatch(f.state.logs.join(" "), /private SMTP|customer contents/);
});

test("an explicitly restarted dispatcher resumes remaining intent without replaying an acknowledged message", async t => {
  const intervals = [];
  t.mock.method(globalThis, "setInterval", callback => { const handle = { callback, unref() {} }; intervals.push(handle); return handle; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const f = fixture();
  const service = await f.create();
  await service.processPending();
  assert.deepEqual(f.state.messages, ["customer@example.invalid", "mechanic@example.invalid"]);
  await service.stop();
  f.record.notificationState.cancellationCustomer = "pending";
  f.record.status = "cancelled";
  f.record.cancellation = { by: "customer", category: "prefer_not_to_say", cancelledAt: new Date("2030-01-08T12:00:00Z"), originalDate: "2030-01-09", originalTime: "08:00", timezone: "America/Chicago" };
  service.start(); service.start();
  try {
    await tick();
    assert.equal(intervals.length, 1);
    assert.equal(f.record.notificationState.cancellationCustomer, "sent");
    assert.deepEqual(f.state.messages, ["customer@example.invalid", "mechanic@example.invalid", "customer@example.invalid"]);
    intervals[0].callback(); await tick();
    assert.equal(f.state.messages.length, 3);
  } finally { await service.stop(); }
});
