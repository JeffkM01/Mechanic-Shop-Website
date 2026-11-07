import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { defaultSettings } from "./schedulingRules.js";
import { createApp } from "./app.js";
import { createMechanicAuth } from "./mechanicAuth.js";

// These are integration tests against a real, standalone MongoDB instance. Each
// test owns a random database; the application's configured database is not used.
const mongoUri = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
const initialTime = "2026-11-09T12:00:00.000Z";
const appointmentDate = "2026-11-11";
const password = "an-example-unique-password-999";
const HOUR = 60 * 60 * 1000;

function request(overrides = {}) {
  return {
    name: "Private Integration Customer",
    email: "private-scheduling@example.invalid",
    phone: "555-555-0134",
    vehicle: "2018 Honda Civic",
    service: "Oil Change",
    date: appointmentDate,
    time: "08:00",
    notes: "Private customer appointment notes",
    ...overrides,
  };
}

function conflict(error) {
  return (error.status || error.statusCode) === 409;
}

function invalid(error) {
  return (error.status || error.statusCode) === 400;
}

function times(availability) {
  return availability.slots.map((slot) => slot.time);
}

async function fixture(t, start = initialTime) {
  const dbName = `eds_scheduling_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(mongoUri, { dbName, serverSelectionTimeoutMS: 5000 });
  try {
    await connection.asPromise();
  } catch (error) {
    await connection.close();
    throw new Error("Scheduling integration tests require a real local MongoDB (or TEST_MONGODB_URI).", { cause: error });
  }
  t.after(async () => {
    try {
      assert.match(connection.name, /^eds_scheduling_test_[a-f\d]{32}$/);
      assert.equal(connection.name, dbName);
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  let clock = Date.parse(start);
  const options = { Appointment, SchedulingState, now: () => new Date(clock) };
  const scheduling = createSchedulingService(options);
  // A separate coordinator instance ensures concurrency tests cannot pass merely
  // because a mutex in one JavaScript object serializes requests.
  const otherScheduling = createSchedulingService(options);
  return {
    Appointment, SchedulingState, scheduling, otherScheduling,
    setTime(value) { clock = typeof value === "number" ? value : Date.parse(value); },
    advance(milliseconds) { clock += milliseconds; },
  };
}

async function httpFixture(t) {
  const context = await fixture(t);
  const auth = createMechanicAuth(password);
  const app = createApp({
    Appointment: context.Appointment,
    scheduling: context.scheduling,
    auth,
    notifications: { enabled: false, kick() {} },
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, status: response.status, body: await response.json() };
  }
  const login = await api("/api/mechanic/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  return {
    ...context,
    api,
    cookieHeaders: { Cookie: cookie },
    authorizedHeaders: { Cookie: cookie, "X-Mechanic-CSRF": login.body.csrfToken },
  };
}

test("scheduling defaults persist in MongoDB with automatic booking disabled", async (t) => {
  const { scheduling, otherScheduling, SchedulingState } = await fixture(t);
  const first = await scheduling.getSettings();
  assert.equal(first.settings.timezone, "America/Chicago");
  assert.equal(first.settings.automaticBookingEnabled, false);
  assert.equal(first.settings.businessHoursVerified, false);
  assert.equal(first.settings.capacityVerified, false);
  assert.equal(first.settings.capacity, 1);
  assert.equal(first.settings.pendingHoldHours, 24);
  assert.equal(defaultSettings().automaticBookingEnabled, false);
  assert.deepEqual(await otherScheduling.getSettings(), first);
  assert.equal(await SchedulingState.countDocuments(), 1);
  const updated = await scheduling.updateSettings({ capacity: 2 }, { expectedRevision: first.revision });
  assert.equal(updated.settings.capacity, 2);
  assert.equal((await otherScheduling.getSettings()).settings.capacity, 2);
  await assert.rejects(
    otherScheduling.updateSettings({ capacity: 3 }, { expectedRevision: first.revision }), conflict,
  );
  assert.equal((await scheduling.getSettings()).settings.capacity, 2);
});

test("availability honors duration, lunch, closed dates, weekends, and manual blocks", async (t) => {
  const { scheduling, otherScheduling } = await fixture(t);
  const before = times(await scheduling.getAvailability("Oil Change", appointmentDate));
  assert.ok(before.includes("08:00"));
  assert.ok(before.includes("10:30"));
  assert.ok(!before.includes("11:00"), "the service plus buffer must not run into lunch");
  assert.ok(!before.includes("12:00"));
  assert.ok(before.includes("13:00"));
  assert.deepEqual(times(await scheduling.getAvailability("Oil Change", "2026-11-14")), []);
  assert.deepEqual(times(await scheduling.getAvailability("Oil Change", "2026-11-15")), []);
  await scheduling.updateSettings({ closedDates: ["2026-11-12"] });
  assert.deepEqual(times(await otherScheduling.getAvailability("Oil Change", "2026-11-12")), []);
  const block = await scheduling.addBlockedPeriod({
    startAt: "2026-11-11T14:00:00.000Z", endAt: "2026-11-11T16:00:00.000Z", reason: "Private shop task",
  });
  assert.ok(block.id);
  const blocked = times(await otherScheduling.getAvailability("Oil Change", appointmentDate));
  assert.ok(!blocked.includes("08:00"));
  assert.ok(!blocked.includes("09:30"));
  assert.ok(blocked.includes("10:00"));
  await otherScheduling.removeBlockedPeriod(block.id);
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
});

test("pending appointments reserve their complete duration and buffer; declining releases the slot", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  const booked = await scheduling.createAppointment(request());
  assert.equal(booked.status, "pending");
  const available = times(await scheduling.getAvailability("Oil Change", appointmentDate));
  for (const time of ["08:00", "08:30", "09:00"]) assert.ok(!available.includes(time));
  assert.ok(available.includes("09:30"));
  await assert.rejects(scheduling.createAppointment(request({ service: "Tire Rotation", time: "08:30" })), conflict);
  await assert.rejects(scheduling.createAppointment(request({ service: "Engine Air Filter Replacement", time: "09:00" })), conflict);
  await scheduling.reviewAppointment(booked.id, "declined");
  assert.equal((await Appointment.findById(booked.id)).status, "declined");
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  assert.equal((await scheduling.createAppointment(request())).status, "pending");
});

test("parallel overlapping requests across independent coordinators create exactly one appointment", async (t) => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? scheduling : otherScheduling).createAppointment(request({
      service: index % 3 ? "Oil Change" : "Engine Diagnostics",
      time: index % 2 ? "08:30" : "08:00",
    }))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected")) assert.ok(conflict(result.reason));
  assert.equal(await Appointment.countDocuments(), 1);
});

test("MongoDB capacity protection permits exactly two simultaneous reservations at capacity two", async (t) => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  await scheduling.updateSettings({ capacity: 2 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    (index % 2 ? scheduling : otherScheduling).createAppointment(request())));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(await Appointment.countDocuments(), 2);
  for (const result of results.filter((entry) => entry.status === "rejected")) assert.ok(conflict(result.reason));
  await assert.rejects(scheduling.createAppointment(request({ time: "09:00" })), conflict);
  assert.equal((await scheduling.createAppointment(request({ time: "09:30" }))).status, "pending");
});

test("a concurrent blocked-period write and booking cannot occupy the same interval", async (t) => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const attempts = await Promise.allSettled([
    scheduling.createAppointment(request()),
    otherScheduling.addBlockedPeriod({ startAt: "2026-11-11T14:00:00.000Z", endAt: "2026-11-11T16:00:00.000Z" }),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.ok(conflict(attempts.find((entry) => entry.status === "rejected").reason));
  const settings = await scheduling.getSettings();
  assert.equal(await Appointment.countDocuments() + settings.settings.blockedPeriods.length, 1);
});

test("expired pending holds retain requests and require fresh conflict checks before approval", async (t) => {
  const { scheduling, Appointment, advance } = await fixture(t);
  const original = await scheduling.createAppointment(request());
  advance(24 * HOUR + 1000);
  assert.equal((await Appointment.findById(original.id)).status, "pending");
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  const replacement = await scheduling.createAppointment(request());
  await assert.rejects(scheduling.reviewAppointment(original.id, "confirmed"), conflict);
  assert.equal((await Appointment.findById(original.id)).status, "pending");
  assert.equal((await Appointment.findById(replacement.id)).status, "pending");
  await scheduling.reviewAppointment(replacement.id, "declined");
  assert.equal((await scheduling.reviewAppointment(original.id, "confirmed")).status, "confirmed");
});

test("an appointment write failure leaves a conservative reservation until its pending hold expires", async (t) => {
  const { scheduling, otherScheduling, Appointment, SchedulingState, advance } = await fixture(t);
  const failure = new Error("Injected appointment persistence failure after reservation");
  const originalSave = Appointment.prototype.save;
  Appointment.prototype.save = async function failAppointmentSave() { throw failure; };
  try {
    await assert.rejects(scheduling.createAppointment(request()), (error) => error === failure);
  } finally {
    Appointment.prototype.save = originalSave;
  }
  assert.equal(await Appointment.countDocuments(), 0);
  const state = await SchedulingState.findById("shop").lean();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].state, "pending");
  assert.ok(!times(await otherScheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  await assert.rejects(otherScheduling.createAppointment(request()), conflict);
  advance(24 * HOUR + 1000);
  assert.ok(times(await otherScheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  assert.equal(await Appointment.countDocuments({ status: "confirmed" }), 0);
  assert.equal((await otherScheduling.createAppointment(request())).status, "pending");
  assert.equal(await Appointment.countDocuments(), 1);
});

test("an approval write failure keeps its committed reservation occupied past pending expiry and permits a safe retry", async (t) => {
  const { scheduling, otherScheduling, Appointment, SchedulingState, advance } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const failure = new Error("Injected approval persistence failure after reservation promotion");
  const originalUpdate = Appointment.findOneAndUpdate;
  Appointment.findOneAndUpdate = async function failApprovalWrite() { throw failure; };
  try {
    await assert.rejects(scheduling.reviewAppointment(appointment.id, "confirmed"), (error) => error === failure);
  } finally {
    Appointment.findOneAndUpdate = originalUpdate;
  }
  assert.equal((await Appointment.findById(appointment.id)).status, "pending");
  const state = await SchedulingState.findById("shop").lean();
  const reservation = state.reservations.find((entry) => String(entry.appointmentId) === appointment.id);
  assert.equal(reservation.state, "confirmed");
  assert.equal(reservation.holdExpiresAt, undefined);
  advance(24 * HOUR + 1000);
  assert.ok(!times(await otherScheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  await assert.rejects(otherScheduling.createAppointment(request()), conflict);
  const retried = await otherScheduling.reviewAppointment(appointment.id, "confirmed");
  assert.equal(retried.status, "confirmed");
  assert.equal(await Appointment.countDocuments({ status: "confirmed" }), 1);
  assert.ok(!times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
});

test("legacy requests with missing status and age metadata stay held and can be explicitly reviewed", async (t) => {
  const { scheduling, Appointment, advance } = await fixture(t);
  const inserted = await Appointment.collection.insertMany([
    request(),
    request({ time: "09:30" }),
  ]);
  const [approveId, declineId] = Object.values(inserted.insertedIds).map(String);
  const raw = await Appointment.collection.findOne({ _id: inserted.insertedIds[0] });
  assert.equal(raw.status, undefined);
  assert.equal(raw.createdAt, undefined);
  advance(24 * HOUR + 1000);
  const available = times(await scheduling.getAvailability("Oil Change", appointmentDate));
  assert.ok(!available.includes("08:00"));
  assert.ok(!available.includes("09:30"));
  assert.equal((await scheduling.reviewAppointment(approveId, "confirmed")).status, "confirmed");
  assert.equal((await scheduling.reviewAppointment(declineId, "declined")).status, "declined");
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("09:30"));
});

test("unusable legacy times block their future date conservatively without disabling unrelated dates", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  await Appointment.collection.insertOne({
    ...request({ date: "2026-11-05", time: "unknown" }), status: "confirmed",
  });
  assert.ok(times(await scheduling.getAvailability("Oil Change", appointmentDate)).includes("08:00"));
  await Appointment.collection.insertOne({ ...request({ time: "unknown" }), status: "confirmed" });
  assert.deepEqual(times(await scheduling.getAvailability("Oil Change", appointmentDate)), []);
  assert.ok(times(await scheduling.getAvailability("Oil Change", "2026-11-13")).includes("08:00"));
});

test("an expired request cannot be confirmed in a changed timezone or silently move its original instant", async (t) => {
  const { scheduling, Appointment, advance } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const originalStart = appointment.scheduling.startAt.toISOString();
  advance(24 * HOUR + 1000);
  const settings = await scheduling.updateSettings({ timezone: "America/New_York" });
  assert.equal(settings.settings.timezone, "America/New_York");
  await assert.rejects(scheduling.reviewAppointment(appointment.id, "confirmed"),
    (error) => conflict(error) && error.code === "TIMEZONE_CHANGED");
  const stored = await Appointment.findById(appointment.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.scheduling.timezone, "America/Chicago");
  assert.equal(stored.scheduling.startAt.toISOString(), originalStart);
});

test("approving an existing request preserves its original buffer after scheduling settings change", async (t) => {
  const { scheduling } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const originalEnd = appointment.scheduling.occupiedUntil.toISOString();
  assert.equal(appointment.scheduling.bufferMinutes, 15);
  await scheduling.updateSettings({ bufferMinutes: 0 });
  const confirmed = await scheduling.reviewAppointment(appointment.id, "confirmed");
  assert.equal(confirmed.scheduling.bufferMinutes, 15);
  assert.equal(confirmed.scheduling.occupiedUntil.toISOString(), originalEnd);
  assert.ok(!times(await scheduling.getAvailability("Engine Air Filter Replacement", appointmentDate)).includes("09:00"));
  await assert.rejects(scheduling.createAppointment(request({ service: "Engine Air Filter Replacement", time: "09:00" })), conflict);
});

test("calendar changes reject conflicts with held appointments and allow unrelated edits during confirmed work", async (t) => {
  const { scheduling, setTime } = await fixture(t);
  const appointment = await scheduling.createAppointment(request());
  const { settings } = await scheduling.getSettings();
  await assert.rejects(scheduling.updateSettings({ closedDates: [appointmentDate] }), conflict);
  await assert.rejects(scheduling.updateSettings({
    weeklyHours: { ...settings.weeklyHours, "3": [{ start: "09:00", end: "17:00" }] },
  }), conflict);
  await assert.rejects(scheduling.updateSettings({ breaks: [{ start: "08:30", end: "09:30" }] }), conflict);
  const edited = await scheduling.updateSettings({ closedDates: ["2026-11-12"] });
  assert.deepEqual(edited.settings.closedDates, ["2026-11-12"]);
  assert.equal((await scheduling.reviewAppointment(appointment.id, "confirmed")).status, "confirmed");
  setTime("2026-11-11T14:30:00.000Z");
  const ongoing = await scheduling.updateSettings({ closedDates: ["2026-11-13"] });
  assert.deepEqual(ongoing.settings.closedDates, ["2026-11-13"]);
});

test("confirming a partial legacy snapshot retains its exact service end and occupied interval", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  const startAt = new Date("2026-11-11T14:00:00.000Z");
  const endAt = new Date("2026-11-11T15:30:00.000Z");
  const occupiedUntil = new Date("2026-11-11T15:50:00.000Z");
  const { insertedId } = await Appointment.collection.insertOne({
    ...request(), status: "pending", createdAt: new Date(initialTime),
    scheduling: { startAt, endAt, occupiedUntil, timezone: "America/Chicago" },
  });
  const confirmed = await scheduling.reviewAppointment(String(insertedId), "confirmed");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.scheduling.startAt.toISOString(), startAt.toISOString());
  assert.equal(confirmed.scheduling.endAt.toISOString(), endAt.toISOString());
  assert.equal(confirmed.scheduling.occupiedUntil.toISOString(), occupiedUntil.toISOString());
  assert.equal(confirmed.scheduling.durationMinutes, 90);
  assert.equal(confirmed.scheduling.bufferMinutes, 20);
  const available = times(await scheduling.getAvailability("Engine Air Filter Replacement", appointmentDate));
  assert.ok(!available.includes("09:30"));
  assert.ok(available.includes("10:00"));
});

test("concurrent mechanic approvals cannot confirm conflicting expired legacy requests", async (t) => {
  const { scheduling, otherScheduling, Appointment } = await fixture(t);
  const old = new Date(Date.parse(initialTime) - 25 * HOUR);
  const result = await Appointment.collection.insertMany([
    { ...request(), status: "pending", createdAt: old, updatedAt: old },
    { ...request(), status: "pending", createdAt: old, updatedAt: old },
  ]);
  const ids = Object.values(result.insertedIds);
  const attempts = await Promise.allSettled([
    scheduling.reviewAppointment(ids[0].toString(), "confirmed"),
    otherScheduling.reviewAppointment(ids[1].toString(), "confirmed"),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.ok(conflict(attempts.find((entry) => entry.status === "rejected").reason));
  assert.equal(await Appointment.countDocuments({ status: "confirmed" }), 1);
  assert.equal(await Appointment.countDocuments({ status: "pending" }), 1);
});

test("legacy service names and records lacking scheduling metadata remain protected", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  await Appointment.collection.insertMany([
    { ...request({ service: "Air Filter Change" }), status: "confirmed" },
    { ...request({ time: "10:00" }), status: "pending" },
    { ...request({ time: "13:00" }), status: "pending", createdAt: new Date(Date.parse(initialTime) - 25 * HOUR) },
  ]);
  const available = times(await scheduling.getAvailability("Engine Air Filter Replacement", appointmentDate));
  assert.ok(!available.includes("08:00"));
  assert.ok(!available.includes("08:30"));
  assert.ok(available.includes("09:00"));
  assert.ok(!available.includes("10:00"), "a pending legacy record without createdAt must not silently expire");
  assert.ok(available.includes("13:00"), "an old timestamped pending request has an expired hold");
  const legacy = await Appointment.findOne({ service: "Air Filter Change" });
  assert.equal(legacy.service, "Air Filter Change");
  const accepted = await scheduling.createAppointment(request({ service: "Air Filter Change", time: "13:00" }));
  assert.equal(accepted.service, "Air Filter Change");
});

test("automatic confirmation requires explicit verified settings and excludes provisional services", async (t) => {
  const { scheduling } = await fixture(t);
  assert.equal((await scheduling.createAppointment(request())).status, "pending");
  await scheduling.updateSettings({ automaticBookingEnabled: true });
  assert.equal((await scheduling.createAppointment(request({ time: "09:30" }))).status, "pending");
  await scheduling.updateSettings({ businessHoursVerified: true, capacityVerified: true });
  assert.equal((await scheduling.createAppointment(request({ service: "Tire Rotation", time: "13:00" }))).status, "pending");
  assert.equal((await scheduling.createAppointment(request({ service: "Brake Repairs", date: "2026-11-12" }))).status, "pending");
});

test("concurrent automatic confirmations enforce the daily limit and leave additional requests pending", async (t) => {
  const { scheduling, otherScheduling } = await fixture(t);
  await scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  const appointments = await Promise.all(["08:00", "09:30", "13:00", "14:30"].map((time, index) =>
    (index % 2 ? scheduling : otherScheduling).createAppointment(request({ time }))));
  assert.equal(appointments.filter((appointment) => appointment.status === "confirmed").length, 3);
  assert.equal(appointments.filter((appointment) => appointment.status === "pending").length, 1);
});

test("shop-local start times use the correct UTC offsets across both daylight-saving changes", async (t) => {
  const { scheduling, setTime } = await fixture(t, "2027-03-08T12:00:00.000Z");
  let availability = await scheduling.getAvailability("Oil Change", "2027-03-12");
  assert.equal(new Date(availability.slots.find((slot) => slot.time === "08:00").startAt).toISOString(), "2027-03-12T14:00:00.000Z");
  availability = await scheduling.getAvailability("Oil Change", "2027-03-15");
  assert.equal(new Date(availability.slots.find((slot) => slot.time === "08:00").startAt).toISOString(), "2027-03-15T13:00:00.000Z");
  assert.deepEqual(times(await scheduling.getAvailability("Oil Change", "2027-03-14")), []);
  setTime("2027-11-01T11:00:00.000Z");
  availability = await scheduling.getAvailability("Oil Change", "2027-11-05");
  assert.equal(new Date(availability.slots.find((slot) => slot.time === "08:00").startAt).toISOString(), "2027-11-05T13:00:00.000Z");
  availability = await scheduling.getAvailability("Oil Change", "2027-11-08");
  assert.equal(new Date(availability.slots.find((slot) => slot.time === "08:00").startAt).toISOString(), "2027-11-08T14:00:00.000Z");
});

test("invalid scheduling input and out-of-window bookings are rejected on the backend", async (t) => {
  const { scheduling } = await fixture(t);
  for (const date of ["2026-02-30", "not-a-date", "2026-11-11T08:00:00Z"]) {
    await assert.rejects(scheduling.getAvailability("Oil Change", date), invalid);
  }
  await assert.rejects(scheduling.getAvailability("Unlisted Service", appointmentDate), invalid);
  await assert.rejects(scheduling.createAppointment(request({ time: "08:15" })), invalid);
  await assert.rejects(scheduling.createAppointment(request({ date: "2026-11-09" })), (error) => invalid(error) || conflict(error));
  await assert.rejects(scheduling.createAppointment(request({ date: "2026-12-01" })), (error) => invalid(error) || conflict(error));
  await assert.rejects(scheduling.updateSettings({ capacity: 0 }), invalid);
  await assert.rejects(scheduling.addBlockedPeriod({ startAt: "invalid", endAt: "invalid" }), invalid);
});

test("public API validates bookings and returns availability without private customer or block details", async (t) => {
  const { api, scheduling } = await httpFixture(t);
  const booked = await api("/api/appointments", { method: "POST", body: request() });
  assert.equal(booked.status, 201);
  const privateReason = "Private blocked period reason for Edward";
  await scheduling.addBlockedPeriod({
    startAt: "2026-11-11T19:00:00.000Z", endAt: "2026-11-11T20:00:00.000Z", reason: privateReason,
  });
  const availability = await api(`/api/availability?${new URLSearchParams({ service: "Oil Change", date: appointmentDate })}`);
  assert.equal(availability.status, 200);
  const publicJson = JSON.stringify(availability.body);
  for (const privateValue of [request().name, request().email, request().phone, request().notes, privateReason]) {
    assert.ok(!publicJson.includes(privateValue));
  }
  assert.ok(!times(availability.body).includes("08:00"));
  assert.equal((await api("/api/availability?service=Unknown&date=2026-11-11")).status, 400);
  assert.equal((await api("/api/availability?service=Oil+Change&date=2026-02-30")).status, 400);
  assert.equal((await api("/api/appointments", { method: "POST", body: request({ service: "Unknown" }) })).status, 400);
  assert.equal((await api("/api/appointments", { method: "POST", body: request({ time: "08:15" }) })).status, 400);
  assert.equal((await api("/api/appointments", { method: "POST", body: request() })).status, 409);
});

test("the mechanic HTTP confirmation endpoint rejects a conflicting expired request without changing its status", async (t) => {
  const { api, scheduling, Appointment, authorizedHeaders, advance } = await httpFixture(t);
  const expired = await scheduling.createAppointment(request());
  advance(24 * HOUR + 1000);
  const replacement = await scheduling.createAppointment(request());
  const rejected = await api(`/api/mechanic/appointments/${expired.id}`, {
    method: "PATCH", headers: authorizedHeaders, body: { status: "confirmed" },
  });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /available|conflict/i);
  assert.equal((await Appointment.findById(expired.id)).status, "pending");
  const accepted = await api(`/api/mechanic/appointments/${replacement.id}`, {
    method: "PATCH", headers: authorizedHeaders, body: { status: "confirmed" },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await Appointment.findById(replacement.id)).status, "confirmed");
});

test("settings, blocked periods, and appointment decisions retain mechanic authentication and CSRF protection", async (t) => {
  const { api, scheduling, authorizedHeaders, cookieHeaders } = await httpFixture(t);
  const appointment = await scheduling.createAppointment(request());
  const settingsPath = "/api/mechanic/scheduling/settings";
  const blockPath = "/api/mechanic/scheduling/blocks";
  const decisionPath = `/api/mechanic/appointments/${appointment.id}`;
  assert.equal((await api(settingsPath)).status, 401);
  assert.equal((await api(settingsPath, { method: "PATCH", body: { settings: { capacity: 2 } } })).status, 401);
  assert.equal((await api(blockPath, { method: "POST", body: {} })).status, 401);
  assert.equal((await api(decisionPath, { method: "PATCH", body: { status: "confirmed" } })).status, 401);
  const settings = await api(settingsPath, { headers: cookieHeaders });
  assert.equal(settings.status, 200);
  for (const [path, method, body] of [
    [settingsPath, "PATCH", { revision: settings.body.revision, settings: { capacity: 2 } }],
    [blockPath, "POST", { startAt: "2026-11-12T14:00:00.000Z", endAt: "2026-11-12T15:00:00.000Z" }],
    [decisionPath, "PATCH", { status: "confirmed" }],
  ]) {
    assert.equal((await api(path, { method, body, headers: cookieHeaders })).status, 403);
  }
  assert.equal((await api(settingsPath, {
    method: "PATCH", headers: { ...cookieHeaders, "X-Mechanic-CSRF": "invalid-token" },
    body: { revision: settings.body.revision, settings: { capacity: 2 } },
  })).status, 403);
  const changed = await api(settingsPath, {
    method: "PATCH", headers: authorizedHeaders, body: { revision: settings.body.revision, settings: { capacity: 2 } },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.settings.capacity, 2);
  assert.equal((await api(settingsPath, {
    method: "PATCH", headers: authorizedHeaders, body: { revision: settings.body.revision, settings: { capacity: 3 } },
  })).status, 409);
  const block = await api(blockPath, {
    method: "POST", headers: authorizedHeaders,
    body: { startAt: "2026-11-12T14:00:00.000Z", endAt: "2026-11-12T15:00:00.000Z", reason: "Private shop task" },
  });
  assert.equal(block.status, 201);
  const id = block.body.id || block.body.block?.id;
  assert.ok(id);
  assert.equal((await api(`${blockPath}/${id}`, { method: "DELETE", headers: cookieHeaders })).status, 403);
  assert.equal((await api(`${blockPath}/${id}`, { method: "DELETE", headers: authorizedHeaders })).status, 200);
  assert.equal((await api(decisionPath, { method: "PATCH", headers: authorizedHeaders, body: { status: "confirmed" } })).status, 200);
});
