import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { defaultSettings, legacyOccurrence } from "./schedulingRules.js";

const initialTime = "2026-11-09T12:00:00.000Z";
const request = (overrides = {}) => ({
  name: "Cancellation Test Customer", email: "cancel@example.invalid", phone: "555-555-0134",
  vehicle: "2018 Honda Civic", service: "Oil Change", date: "2026-11-11", time: "08:00", notes: "",
  ...overrides,
});
const conflict = error => error.status === 409;
const times = value => value.slots.map(slot => slot.time);

async function fixture(t) {
  const dbName = `eds_cancellation_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", { dbName, serverSelectionTimeoutMS: 5000 });
  try { await connection.asPromise(); }
  catch (error) {
    await connection.close();
    throw new Error("Cancellation tests require local MongoDB or TEST_MONGODB_URI.", { cause: error });
  }
  t.after(async () => {
    try {
      assert.match(connection.name, /^eds_cancellation_test_[a-f\d]{32}$/);
      assert.equal(connection.name, dbName);
      await connection.dropDatabase();
    } finally { await connection.close(); }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  let clock = Date.parse(initialTime);
  const options = { Appointment, SchedulingState, now: () => new Date(clock) };
  return {
    Appointment, SchedulingState,
    scheduling: createSchedulingService(options), otherScheduling: createSchedulingService(options),
    setTime(value) { clock = Date.parse(value); },
  };
}

test("cancellation eligibility uses recorded server-time policy, including DST and invalid legacy times", () => {
  const scheduling = createSchedulingService({ now: () => new Date(initialTime) });
  const future = request();
  assert.equal(scheduling.getCancellationEligibility(future).canCancel, true);
  assert.equal(scheduling.getCancellationEligibility({ ...future, status: "declined" }).canCancel, false);
  assert.equal(scheduling.getCancellationEligibility({ ...future, status: "cancelled" }).code, "ALREADY_CANCELLED");
  for (const value of [{ date: "2026-02-30" }, { time: "invalid" }, { scheduling: { startAt: "bad" } }, { scheduling: { timezone: "Invalid/Zone" } }, { scheduling: { startAt: "2026-11-11T15:00:00Z", timezone: "America/Chicago" } }]) {
    assert.equal(scheduling.getCancellationEligibility({ ...future, ...value }).code, "SCHEDULE_UNAVAILABLE");
  }
  const spring = createSchedulingService({ now: () => new Date("2026-03-01T00:00:00Z") });
  assert.equal(spring.getCancellationEligibility(request({ date: "2026-03-08", time: "02:30" })).canCancel, false);
  const fall = createSchedulingService({ now: () => new Date("2026-10-30T00:00:00Z") });
  const folded = request({ date: "2026-11-01", time: "01:30" });
  assert.equal(fall.getCancellationEligibility(folded).canCancel, false);
  assert.equal(fall.getCancellationEligibility({ ...folded, scheduling: { startAt: new Date("2026-11-01T06:30:00Z"), timezone: "America/Chicago" } }).canCancel, true);
  assert.equal(legacyOccurrence({ ...future, status: "cancelled", time: "invalid" }, defaultSettings(), new Date(initialTime)), null);
});

test("cancellation eligibility permits last-minute changes and follows the recorded timezone until the exact start", () => {
  const appointment = request({
    status: "confirmed", date: "2026-11-11", time: "08:15",
    scheduling: { timezone: "America/New_York", startAt: new Date("2026-11-11T13:15:00Z") },
  });
  const scheduling = createSchedulingService({ now: () => new Date("2026-11-11T13:14:59.999Z") });
  assert.deepEqual(scheduling.getCancellationEligibility(appointment), {
    canCancel: true, code: "CANCELLATION_ALLOWED",
    message: "You can cancel this appointment until its scheduled start.",
    startAt: "2026-11-11T13:15:00.000Z", timezone: "America/New_York",
  });
  assert.equal(scheduling.getCancellationEligibility(appointment, new Date("2026-11-11T13:15:00Z")).code, "APPOINTMENT_STARTED");
  assert.equal(scheduling.getCancellationEligibility(appointment, new Date("2026-11-11T13:15:00.001Z")).canCancel, false);
});

test("a customer can cancel a future pending request without a reason and restore its slot", async t => {
  const { scheduling, Appointment, SchedulingState } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const id = String(appointment._id);
  assert.ok(!times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
  const saved = await scheduling.cancelAppointment(id, "customer");
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.cancellation.by, "customer");
  assert.equal(saved.cancellation.category, "prefer_not_to_say");
  assert.equal(saved.cancellation.originalDate, appointment.date);
  assert.equal(saved.cancellation.originalTime, appointment.time);
  assert.equal(saved.cancellation.timezone, "America/Chicago");
  assert.equal(saved.cancellation.cancelledAt.toISOString(), initialTime);
  assert.equal(saved.notificationState.requestCustomer, "suppressed");
  assert.equal(saved.notificationState.requestMechanic, "pending");
  assert.equal(saved.notificationState.cancellationCustomer, "pending");
  assert.equal(saved.notificationState.cancellationMechanic, "pending");
  assert.equal(await Appointment.countDocuments({ _id: appointment._id }), 1);
  assert.equal((await SchedulingState.findById("shop").lean()).reservations.length, 0);
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
});

test("a customer can cancel a confirmed appointment with an optional reason and message", async t => {
  const { scheduling } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  await scheduling.reviewAppointment(String(appointment._id), "confirmed");
  const saved = await scheduling.cancelAppointment(String(appointment._id), "customer", { category: "other", message: "Transportation changed." });
  assert.equal(saved.cancellation.message, "Transportation changed.");
  assert.equal(saved.notificationState.decisionCustomer, "suppressed");
  assert.equal(saved.scheduling.confirmationSource, "manual");
  await assert.rejects(scheduling.reviewAppointment(String(appointment._id), "confirmed"), conflict);
});

test("mechanic cancellation requires a valid explanation and queues only the customer cancellation", async t => {
  const { scheduling, Appointment } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const id = String(appointment._id);
  for (const input of [{}, { category: "unknown" }, { category: "other", explanation: "short" }, { category: "shop_closed", explanation: "x".repeat(1001) }]) {
    await assert.rejects(scheduling.cancelAppointment(id, "mechanic", input), error => error.status === 400 && error.code === "INVALID_CANCELLATION_REASON");
  }
  assert.equal((await Appointment.findById(id)).status, "pending");
  const saved = await scheduling.cancelAppointment(id, "mechanic", { category: "supplies_unavailable", explanation: "The required oil is currently unavailable." });
  assert.equal(saved.cancellation.by, "mechanic");
  assert.match(saved.cancellation.explanation, /required parts or supplies are unavailable/);
  assert.match(saved.cancellation.explanation, /required oil is currently unavailable/);
  assert.equal(saved.notificationState.cancellationCustomer, "pending");
  assert.equal(saved.notificationState.cancellationMechanic, "not-applicable");
});

test("expired provisional holds still allow cancellation until the start, but declined or started requests do not", async t => {
  const { scheduling, setTime, Appointment } = await fixture(t);
  const expired = await scheduling.createAppointment(request());
  await Appointment.updateOne({ _id: expired._id }, { $set: { "scheduling.holdExpiresAt": new Date(initialTime) } });
  assert.equal((await scheduling.cancelAppointment(String(expired._id), "customer")).status, "cancelled");
  const declined = await scheduling.createAppointment(request());
  await scheduling.reviewAppointment(String(declined._id), "declined", { decline: { category: "unable_to_accommodate" } });
  await assert.rejects(scheduling.cancelAppointment(String(declined._id), "customer"), conflict);
  const started = await scheduling.createAppointment(request());
  setTime(started.scheduling.startAt.toISOString());
  for (const actor of ["customer", "mechanic"]) {
    await assert.rejects(scheduling.cancelAppointment(String(started._id), actor, { category: actor === "customer" ? "other" : "shop_closed" }), error => error.status === 409 && error.code === "APPOINTMENT_STARTED");
  }
  assert.equal((await Appointment.findById(started._id)).status, "pending");
});

test("repeated cancellation preserves metadata and sent events without requeuing", async t => {
  const { scheduling, Appointment, setTime } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const id = String(appointment._id);
  const first = await scheduling.cancelAppointment(id, "customer", { category: "plans_changed", message: "I cannot attend." });
  await Appointment.updateOne({ _id: id }, { $set: { "notificationState.cancellationCustomer": "sent", "notificationState.cancellationMechanic": "sent" } });
  setTime("2026-11-11T17:00:00Z");
  const repeat = await scheduling.cancelAppointment(id, "mechanic", { category: "other", explanation: "This must not replace customer history." });
  assert.deepEqual(repeat.cancellation.toObject(), first.cancellation.toObject());
  assert.equal(repeat.notificationState.cancellationCustomer, "sent");
  assert.equal(repeat.notificationState.cancellationMechanic, "sent");
});

test("simultaneous cancellation requests share one durable decision and preserve its original reason", async t => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const id = String(appointment._id);
  const results = await Promise.all([
    scheduling.cancelAppointment(id, "customer", { category: "plans_changed", message: "First possible reason." }),
    otherScheduling.cancelAppointment(id, "mechanic", { category: "other", explanation: "Second possible explanation." }),
  ]);
  const saved = await Appointment.findById(id);
  for (const result of results) {
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.cancellation.toObject(), saved.cancellation.toObject());
  }
  assert.equal(await Appointment.countDocuments({ _id: id }), 1);
  assert.equal(saved.notificationState.cancellationCustomer, "pending");
  assert.equal(saved.notificationState.cancellationMechanic, saved.cancellation.by === "customer" ? "pending" : "not-applicable");
  assert.equal(Boolean(saved.cancellation.message), saved.cancellation.by === "customer");
  assert.equal(Boolean(saved.cancellation.explanation), saved.cancellation.by === "mechanic");
});

test("cancelling a historical quarter-hour request uses its original timezone and tolerates absent queue flags", async t => {
  const { scheduling, Appointment } = await fixture(t);
  const id = new mongoose.Types.ObjectId();
  await Appointment.collection.insertOne({ ...request({ time: "08:15" }), _id: id });
  assert.equal(scheduling.getCancellationEligibility(await Appointment.findById(id).lean()).canCancel, true);
  const saved = await scheduling.cancelAppointment(String(id), "customer");
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.cancellation.originalTime, "08:15");
  assert.equal(saved.cancellation.timezone, "America/Chicago");
  assert.equal((await Appointment.findById(id).lean()).notificationState.requestCustomer, undefined);
  const malformed = new mongoose.Types.ObjectId();
  await Appointment.collection.insertOne({ ...request({ time: "invalid" }), _id: malformed });
  await assert.rejects(scheduling.cancelAppointment(String(malformed), "customer"), error => error.status === 409 && error.code === "SCHEDULE_UNAVAILABLE");
});

test("cancellation releases only its own reservation", async t => {
  const { scheduling, SchedulingState } = await fixture(t);
  const first = await scheduling.createAppointment(request());
  const second = await scheduling.createAppointment(request({ time: "10:00" }));
  await scheduling.cancelAppointment(String(first._id), "customer");
  const state = await SchedulingState.findById("shop").lean();
  assert.deepEqual(state.reservations.map(item => String(item.appointmentId)), [String(second._id)]);
  const slots = times(await scheduling.getAvailability("Oil Change", first.date));
  assert.ok(slots.includes("08:00"));
  assert.ok(!slots.includes("10:00"));
});

test("failed durable cancellation does not release its reservation or queue events", async t => {
  const { scheduling, Appointment, SchedulingState } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  t.mock.method(Appointment, "findOneAndUpdate", () => { throw new Error("simulated durable write failure"); });
  await assert.rejects(scheduling.cancelAppointment(String(appointment._id), "customer"), /durable write failure/);
  const saved = await Appointment.findById(appointment._id);
  assert.equal(saved.status, "pending");
  assert.equal(saved.cancellation, undefined);
  assert.equal(saved.notificationState.cancellationCustomer, "not-applicable");
  assert.equal((await SchedulingState.findById("shop").lean()).reservations.length, 1);
  assert.ok(!times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
});

test("failed reservation cleanup leaves durable history and availability reconciles terminal status", async t => {
  const { scheduling, Appointment, SchedulingState } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const original = SchedulingState.updateOne.bind(SchedulingState);
  let fail = true;
  t.mock.method(SchedulingState, "updateOne", (...args) => {
    if (fail) { fail = false; throw new Error("simulated cleanup failure"); }
    return original(...args);
  });
  await assert.rejects(scheduling.cancelAppointment(String(appointment._id), "customer"), /cleanup failure/);
  const saved = await Appointment.findById(appointment._id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.notificationState.cancellationCustomer, "pending");
  assert.equal((await SchedulingState.findById("shop").lean()).reservations.length, 1);
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
  const repeat = await scheduling.cancelAppointment(String(appointment._id), "customer");
  assert.equal(+repeat.cancellation.cancelledAt, +saved.cancellation.cancelledAt);
  const replacement = await scheduling.createAppointment(request());
  const state = await SchedulingState.findById("shop").lean();
  assert.deepEqual(state.reservations.map(item => String(item.appointmentId)), [String(replacement._id)]);
});

test("notification delivery racing cancellation preserves sent history with a bounded retry", async t => {
  const { scheduling, Appointment } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  await scheduling.reviewAppointment(String(appointment._id), "confirmed");
  const original = Appointment.findOneAndUpdate.bind(Appointment);
  let raced = false;
  t.mock.method(Appointment, "findOneAndUpdate", async (...args) => {
    if (!raced && args[1]?.$set?.status === "cancelled") {
      raced = true;
      await Appointment.updateOne({ _id: appointment._id }, { $set: { "notificationState.requestCustomer": "sent", "notificationState.decisionCustomer": "sent" } });
    }
    return original(...args);
  });
  const saved = await scheduling.cancelAppointment(String(appointment._id), "customer");
  assert.equal(raced, true);
  assert.equal(saved.notificationState.requestCustomer, "sent");
  assert.equal(saved.notificationState.decisionCustomer, "sent");
  assert.equal(saved.notificationState.requestMechanic, "pending");
  assert.equal(saved.notificationState.cancellationCustomer, "pending");
});

test("a concurrent late approval cannot resurrect a cancelled record", async t => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const original = Appointment.findOneAndUpdate.bind(Appointment);
  let signal;
  const reached = new Promise(resolve => { signal = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.mock.method(Appointment, "findOneAndUpdate", async (...args) => {
    if (args[1]?.$set?.status === "confirmed") { signal(); await blocked; }
    return original(...args);
  });
  const approval = scheduling.reviewAppointment(String(appointment._id), "confirmed");
  await reached;
  const saved = await otherScheduling.cancelAppointment(String(appointment._id), "customer");
  release();
  await assert.rejects(approval, conflict);
  assert.equal(saved.status, "cancelled");
  assert.equal((await Appointment.findById(appointment._id)).status, "cancelled");
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
});

test("an approval losing the scheduling CAS to cancellation cannot take a replacement booking's capacity", async t => {
  const { scheduling, otherScheduling, Appointment, SchedulingState } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const original = SchedulingState.updateOne.bind(SchedulingState);
  let signal;
  const reached = new Promise(resolve => { signal = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let paused = false;
  t.mock.method(SchedulingState, "updateOne", async (...args) => {
    const reservations = args[1]?.$set?.reservations;
    if (!paused && reservations?.some(item => String(item.appointmentId) === String(appointment._id) && item.state === "confirmed")) {
      paused = true;
      signal();
      await blocked;
    }
    return original(...args);
  });
  const approval = scheduling.reviewAppointment(String(appointment._id), "confirmed");
  // Observe the rejection before releasing the delayed operation, avoiding an
  // unhandled promise if the schedule changes immediately after the barrier.
  const rejectedApproval = assert.rejects(approval, conflict);
  await reached;
  await otherScheduling.cancelAppointment(String(appointment._id), "customer");
  const replacement = await otherScheduling.createAppointment(request());
  release();
  await rejectedApproval;
  assert.equal((await Appointment.findById(appointment._id)).status, "cancelled");
  assert.equal((await Appointment.findById(replacement._id)).status, "pending");
  const state = await SchedulingState.findById("shop").lean();
  assert.deepEqual(state.reservations.map(item => String(item.appointmentId)), [String(replacement._id)]);
  assert.ok(!times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
});

test("concurrent decline and cancellation produce one terminal decision without cross-written metadata", async t => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const results = await Promise.allSettled([
    scheduling.reviewAppointment(String(appointment._id), "declined", { decline: { category: "unable_to_accommodate" } }),
    otherScheduling.cancelAppointment(String(appointment._id), "customer"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  const saved = await Appointment.findById(appointment._id);
  assert.ok(["cancelled", "declined"].includes(saved.status));
  assert.equal(Boolean(saved.cancellation), saved.status === "cancelled");
  assert.equal(Boolean(saved.decline), saved.status === "declined");
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointment.date)).includes("08:00"));
});

test("cancellation rejects invalid identifiers, actors and absent appointments", async t => {
  const { scheduling } = await fixture(t);
  await assert.rejects(scheduling.cancelAppointment("bad", "customer"), error => error.status === 400);
  await assert.rejects(scheduling.cancelAppointment(String(new mongoose.Types.ObjectId()), "admin"), error => error.status === 400);
  await assert.rejects(scheduling.cancelAppointment(String(new mongoose.Types.ObjectId()), "customer"), error => error.status === 404);
});
