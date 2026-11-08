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
import { createEmailNotifications } from "./emailNotifications.js";
import { SERVICES } from "../shared/services.js";

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

async function notificationQueue(Appointment) {
  const sent = [];
  const errors = [];
  const mechanicEmail = "mechanic-notifications@example.invalid";
  const notifications = await createEmailNotifications({
    Appointment,
    env: {
      SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587",
      SMTP_USER: "test-user", SMTP_PASS: "test-password",
      MAIL_FROM: "appointments@example.invalid", MECHANIC_NOTIFICATION_EMAIL: mechanicEmail,
    },
    transport: { async sendMail(message) { sent.push(message); } },
    logger: { error(message) { errors.push(message); } },
  });
  assert.equal(notifications.enabled, true);
  return { notifications, sent, errors, mechanicEmail };
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

test("the mechanic HTTP endpoint approves legacy off-grid requests while new bookings still require configured increments", async (t) => {
  const { api, Appointment, authorizedHeaders } = await httpFixture(t);
  const rejected = await api("/api/appointments", { method: "POST", body: request({ time: "08:15" }) });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "INVALID_TIME_INCREMENT");
  assert.equal(await Appointment.countDocuments(), 0);
  const { insertedId } = await Appointment.collection.insertOne({ ...request({ time: "08:15" }), status: "pending" });
  const approved = await api(`/api/mechanic/appointments/${insertedId}`, {
    method: "PATCH", headers: authorizedHeaders, body: { status: "confirmed" },
  });
  assert.equal(approved.status, 200);
  const stored = await Appointment.findById(insertedId);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.time, "08:15");
  assert.equal(stored.scheduling.startAt.toISOString(), "2026-11-11T14:15:00.000Z");
  assert.equal(stored.scheduling.endAt.toISOString(), "2026-11-11T15:15:00.000Z");
  assert.equal(stored.scheduling.occupiedUntil.toISOString(), "2026-11-11T15:30:00.000Z");
  assert.equal(stored.scheduling.confirmationSource, "manual");
});

test("legacy off-grid approval still enforces capacity, working hours, lunch, and manual blocks", async (t) => {
  const cases = [
    { label: "occupied capacity", time: "08:15", code: "SLOT_UNAVAILABLE", occupied: true },
    { label: "service overlaps lunch", time: "11:15", code: "SHOP_BREAK" },
    { label: "service exceeds closing time", time: "16:15", code: "OUTSIDE_HOURS" },
    { label: "manually blocked period", time: "09:15", code: "BLOCKED_PERIOD", blocked: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const { api, Appointment, scheduling, authorizedHeaders } = await httpFixture(t);
      if (scenario.occupied) await scheduling.createAppointment(request());
      if (scenario.blocked) await scheduling.addBlockedPeriod({
        startAt: "2026-11-11T15:00:00.000Z", endAt: "2026-11-11T17:00:00.000Z",
      });
      const { insertedId } = await Appointment.collection.insertOne({
        ...request({ time: scenario.time }), status: "pending",
      });
      const rejected = await api(`/api/mechanic/appointments/${insertedId}`, {
        method: "PATCH", headers: authorizedHeaders, body: { status: "confirmed" },
      });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.code, scenario.code);
      const stored = await Appointment.collection.findOne({ _id: insertedId });
      assert.equal(stored.status, "pending");
      assert.equal(stored.scheduling, undefined, "a rejected approval must not rewrite the historical request");
    });
  }
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

test("every Repairs & Diagnostics service requires approval even with verified automatic booking enabled", async (t) => {
  const { scheduling } = await fixture(t);
  await scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  for (const { name } of SERVICES.filter(({ category }) => category === "repairs")) {
    const appointment = await scheduling.createAppointment(request({ service: name }));
    assert.equal(appointment.status, "pending", `${name} must never be automatically confirmed`);
    await assert.rejects(scheduling.reviewAppointment(appointment.id, "confirmed", { automatic: true }),
      (error) => conflict(error) && error.code === "MANUAL_APPROVAL_REQUIRED");
    await scheduling.reviewAppointment(appointment.id, "declined");
  }
  assert.equal((await scheduling.createAppointment(request({ time: "13:00" }))).status, "confirmed",
    "verified basic maintenance remains eligible for explicitly enabled automatic booking");
});

test("the authenticated settings API cannot disable approval for any repair or diagnostics service", async (t) => {
  const { api, authorizedHeaders, scheduling } = await httpFixture(t);
  const before = await scheduling.getSettings();
  for (const { name } of SERVICES.filter(({ category }) => category === "repairs")) {
    const rejected = await api("/api/mechanic/scheduling/settings", {
      method: "PATCH", headers: authorizedHeaders,
      body: { revision: before.revision, settings: { serviceRules: {
        [name]: { ...before.settings.serviceRules[name], requiresApproval: false },
      } } },
    });
    assert.equal(rejected.status, 400, name);
    assert.match(rejected.body.error, /approval/i);
  }
  assert.deepEqual(await scheduling.getSettings(), before, "rejected policy changes must not persist");
});

test("legacy persisted repair settings are corrected atomically without losing verified settings or blocking later edits", async (t) => {
  const { api, authorizedHeaders, scheduling, otherScheduling, SchedulingState } = await httpFixture(t);
  await scheduling.getSettings();
  const before = await SchedulingState.findById("shop").lean();
  const legacySettings = structuredClone(before.settings);
  Object.assign(legacySettings, {
    automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true,
    capacity: 2, maxAutomaticPerDay: 4, bufferMinutes: 20, closedDates: ["2026-11-12"],
  });
  legacySettings.serviceRules["Engine Diagnostics"].durationMinutes = 105;
  const expectedSettings = structuredClone(legacySettings);
  for (const { name } of SERVICES.filter(({ category }) => category === "repairs")) {
    legacySettings.serviceRules[name].requiresApproval = false;
    expectedSettings.serviceRules[name].requiresApproval = true;
  }
  // Bypass current validation to represent data written by the earlier PR revision.
  await SchedulingState.collection.updateOne({ _id: "shop" }, { $set: { settings: legacySettings } });
  const [first, second] = await Promise.all([scheduling.getSettings(), otherScheduling.getSettings()]);
  assert.deepEqual(first.settings, expectedSettings);
  assert.deepEqual(second, first);
  assert.equal(first.revision, before.settingsRevision + 1);
  const repaired = await SchedulingState.findById("shop").lean();
  assert.equal(repaired.revision, before.revision + 1, "concurrent readers must apply one policy migration");
  assert.equal(repaired.settingsRevision, before.settingsRevision + 1);
  const changed = await api("/api/mechanic/scheduling/settings", {
    method: "PATCH", headers: authorizedHeaders,
    body: { revision: first.revision, settings: { maxAutomaticPerDay: 5 } },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.settings.maxAutomaticPerDay, 5);
  assert.equal(changed.body.settings.serviceRules["Engine Diagnostics"].requiresApproval, true);
  assert.equal(changed.body.settings.automaticBookingEnabled, true);
});

test("automatic bookings queue one customer confirmation and one mechanic notice across repeated dispatcher sweeps", async (t) => {
  for (const legacyQueue of [false, true]) {
    await t.test(legacyQueue ? "previously persisted duplicate queue" : "new automatic booking", async (t) => {
      const { scheduling, Appointment } = await fixture(t);
      const { notifications, sent, errors, mechanicEmail } = await notificationQueue(Appointment);
      await scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
      const appointment = await scheduling.createAppointment(request());
      assert.equal(appointment.status, "confirmed");
      assert.equal(appointment.notificationState.requestCustomer, "suppressed");
      assert.equal(appointment.notificationState.decisionCustomer, "pending");
      if (legacyQueue) {
        await Appointment.collection.updateOne({ _id: appointment._id }, {
          $set: { "notificationState.requestCustomer": "pending" },
        });
      }
      await notifications.processPending();
      await notifications.processPending();
      assert.deepEqual(errors, []);
      const customerMessages = sent.filter(({ to }) => to === request().email);
      assert.equal(customerMessages.length, 1);
      assert.match(customerMessages[0].subject, /appointment confirmed$/);
      assert.match(customerMessages[0].text, /CONFIRMED/);
      assert.equal(sent.filter(({ to }) => to === mechanicEmail).length, 1);
      const stored = await Appointment.findById(appointment.id);
      assert.equal(stored.notificationState.requestCustomer, "suppressed");
      assert.equal(stored.notificationState.requestMechanic, "sent");
      assert.equal(stored.notificationState.decisionCustomer, "sent");
    });
  }
});

test("automatic approval preserves a request receipt sent before approval and sends only one final confirmation", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  const { notifications, sent, errors, mechanicEmail } = await notificationQueue(Appointment);
  await scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  const originalSave = Appointment.prototype.save;
  Appointment.prototype.save = async function dispatchBeforeAutomaticApproval(...args) {
    const saved = await originalSave.apply(this, args);
    await notifications.processPending();
    return saved;
  };
  let appointment;
  try {
    appointment = await scheduling.createAppointment(request());
  } finally {
    Appointment.prototype.save = originalSave;
  }
  assert.equal(appointment.status, "confirmed");
  assert.equal(appointment.notificationState.requestCustomer, "sent", "preserve the actual receipt delivery audit");
  assert.equal(appointment.notificationState.decisionCustomer, "pending");
  await notifications.processPending();
  await notifications.processPending();
  assert.deepEqual(errors, []);
  const customerMessages = sent.filter(({ to }) => to === request().email);
  assert.equal(customerMessages.length, 2);
  assert.equal(customerMessages.filter(({ subject }) => /request received$/.test(subject)).length, 1);
  assert.equal(customerMessages.filter(({ subject }) => /appointment confirmed$/.test(subject)).length, 1);
  assert.equal(sent.filter(({ to }) => to === mechanicEmail).length, 1);
  const stored = await Appointment.findById(appointment.id);
  assert.equal(stored.notificationState.requestCustomer, "sent");
  assert.equal(stored.notificationState.decisionCustomer, "sent");
});

test("manual approval retains the pending receipt followed by one customer decision notification", async (t) => {
  const { scheduling, Appointment } = await fixture(t);
  const { notifications, sent, errors, mechanicEmail } = await notificationQueue(Appointment);
  const appointment = await scheduling.createAppointment(request());
  assert.equal(appointment.status, "pending");
  await notifications.processPending();
  assert.equal(sent.length, 2);
  assert.match(sent.find(({ to }) => to === request().email).text, /PENDING/);
  const confirmed = await scheduling.reviewAppointment(appointment.id, "confirmed");
  assert.equal(confirmed.notificationState.requestCustomer, "sent");
  assert.equal(confirmed.notificationState.decisionCustomer, "pending");
  await notifications.processPending();
  await notifications.processPending();
  assert.deepEqual(errors, []);
  assert.equal(sent.filter(({ to }) => to === request().email).length, 2);
  assert.equal(sent.filter(({ to, subject }) => to === request().email && /appointment confirmed$/.test(subject)).length, 1);
  assert.equal(sent.filter(({ to }) => to === mechanicEmail).length, 1);
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

test("calendar availability uses one snapshot and occupancy read and agrees with daily availability", async (t) => {
  const { scheduling, Appointment, SchedulingState } = await fixture(t);
  await scheduling.updateSettings({ closedDates: ["2026-11-12"] });
  await scheduling.addBlockedPeriod({
    startAt: "2026-11-13T14:00:00.000Z", endAt: "2026-11-13T23:00:00.000Z", reason: "Private full-day block",
  });
  // A historical confirmed repair can occupy the whole working day, including
  // today's lunch policy. The summary must respect that existing occupancy.
  await Appointment.create(request({
    status: "confirmed", scheduling: { durationMinutes: 540, bufferMinutes: 0, timezone: "America/Chicago" },
  }));
  const before = await SchedulingState.findById("shop").lean();
  const findAppointments = Appointment.find;
  const findState = SchedulingState.findById;
  let appointmentReads = 0;
  let stateReads = 0;
  Appointment.find = function (...args) { appointmentReads++; return findAppointments.apply(this, args); };
  SchedulingState.findById = function (...args) { stateReads++; return findState.apply(this, args); };
  let calendar;
  try { calendar = await scheduling.getCalendarAvailability("Oil Change", "2026-11"); }
  finally { Appointment.find = findAppointments; SchedulingState.findById = findState; }
  assert.equal(appointmentReads, 1);
  assert.equal(stateReads, 1);
  assert.equal(calendar.today, "2026-11-09");
  assert.equal(calendar.firstDate, "2026-11-09");
  assert.equal(calendar.lastDate, "2026-11-23");
  assert.equal(calendar.generatedAt, initialTime);
  assert.equal(calendar.days.length, 15, "the horizon's final calendar day is included");
  assert.equal(calendar.days.find(day => day.date === appointmentDate).available, false);
  assert.equal(calendar.days.find(day => day.date === "2026-11-12").available, false);
  assert.equal(calendar.days.find(day => day.date === "2026-11-13").available, false);
  assert.equal(calendar.days.find(day => day.date === "2026-11-14").available, false);
  assert.equal(calendar.days.find(day => day.date === "2026-11-16").available, true);
  for (const day of calendar.days) {
    const daily = await scheduling.getAvailability(calendar.service, day.date);
    assert.equal(day.available, daily.slots.length > 0, day.date);
    assert.deepEqual(calendar.policy, daily.policy);
    assert.equal(calendar.durationMinutes, daily.durationMinutes);
    assert.equal(calendar.settingsProvisional, daily.settingsProvisional);
  }
  assert.deepEqual(await SchedulingState.findById("shop").lean(), before, "reading the calendar cannot change settings or reservations");
});

test("calendar bounds follow saved horizons across leap dates and month boundaries with at most 31 days", async (t) => {
  const { scheduling } = await fixture(t, "2028-02-27T12:00:00.000Z");
  await scheduling.updateSettings({ bookingHorizonDays: 3 });
  const february = await scheduling.getCalendarAvailability("Air Filter Change");
  assert.equal(february.service, "Engine Air Filter Replacement");
  assert.equal(february.month, "2028-02");
  assert.equal(february.durationMinutes, 30);
  assert.equal(february.lastDate, "2028-03-01");
  assert.deepEqual(february.days.map(day => day.date), ["2028-02-27", "2028-02-28", "2028-02-29"]);
  assert.deepEqual((await scheduling.getCalendarAvailability("Oil Change", "2028-03")).days,
    [{ date: "2028-03-01", available: true }]);
  await scheduling.updateSettings({ bookingHorizonDays: 40 });
  const march = await scheduling.getCalendarAvailability("Oil Change", "2028-03");
  assert.equal(march.lastDate, "2028-04-07");
  assert.equal(march.days.length, 31);
  assert.equal(march.days[0].date, "2028-03-01");
  assert.equal(march.days.at(-1).date, "2028-03-31");
  const april = await scheduling.getCalendarAvailability("Oil Change", "2028-04");
  assert.equal(april.days.length, 7);
  assert.equal(april.days.at(-1).date, "2028-04-07");
  await assert.rejects(scheduling.getCalendarAvailability("Oil Change", "2028-05"), invalid);
});

test("calendar defaults to the server's shop-local month and keeps date bounds across daylight saving", async (t) => {
  const { scheduling, setTime } = await fixture(t, "2028-03-01T01:00:00.000Z");
  await scheduling.updateSettings({ bookingHorizonDays: 3 });
  const localFebruary = await scheduling.getCalendarAvailability("Oil Change");
  assert.equal(localFebruary.today, "2028-02-29", "UTC is already March but Chicago is still February");
  assert.equal(localFebruary.month, "2028-02");
  assert.equal(localFebruary.firstDate, "2028-02-29");
  assert.equal(localFebruary.lastDate, "2028-03-03");
  assert.deepEqual(localFebruary.days, [{ date: "2028-02-29", available: false }]);
  await scheduling.updateSettings({ bookingHorizonDays: 14 });
  for (const [clock, firstDate, lastDate, transitionDate, workingDate] of [
    ["2027-03-08T12:00:00.000Z", "2027-03-08", "2027-03-22", "2027-03-14", "2027-03-15"],
    ["2027-11-01T11:00:00.000Z", "2027-11-01", "2027-11-15", "2027-11-07", "2027-11-08"],
  ]) {
    setTime(clock);
    const calendar = await scheduling.getCalendarAvailability("Oil Change");
    assert.equal(calendar.firstDate, firstDate);
    assert.equal(calendar.lastDate, lastDate);
    assert.equal(calendar.days.length, 15);
    assert.equal(calendar.days.find(day => day.date === transitionDate).available, false);
    assert.equal(calendar.days.find(day => day.date === workingDate).available, true);
    for (const day of calendar.days) {
      assert.equal(day.available, (await scheduling.getAvailability("Oil Change", day.date)).slots.length > 0, day.date);
    }
  }
});

test("the public calendar endpoint validates input and exposes only bounded, sanitized metadata without authentication", async (t) => {
  const { api, scheduling, SchedulingState } = await httpFixture(t);
  const booked = await api("/api/appointments", { method: "POST", body: request() });
  assert.equal(booked.status, 201);
  const block = await scheduling.addBlockedPeriod({
    startAt: "2026-11-12T14:00:00.000Z", endAt: "2026-11-12T23:00:00.000Z", reason: "Private calendar block reason",
  });
  const before = await SchedulingState.findById("shop").lean();
  const calendar = await api("/api/availability/calendar?service=Air+Filter+Change");
  assert.equal(calendar.status, 200, "no mechanic cookie or CSRF token is required");
  assert.equal(calendar.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(calendar.body).sort(), [
    "service", "month", "timezone", "today", "firstDate", "lastDate", "durationMinutes", "policy", "settingsProvisional", "days", "generatedAt",
  ].sort());
  assert.equal(calendar.body.service, "Engine Air Filter Replacement");
  assert.equal(calendar.body.month, "2026-11");
  assert.equal(calendar.body.timezone, "America/Chicago");
  assert.equal(calendar.body.settingsProvisional, true);
  assert.equal(calendar.body.policy.automaticBookingEnabled, false);
  for (const day of calendar.body.days) {
    assert.deepEqual(Object.keys(day).sort(), ["available", "date"]);
    assert.equal(typeof day.available, "boolean");
  }
  const json = JSON.stringify(calendar.body);
  for (const privateValue of [request().name, request().email, request().phone, request().vehicle, request().notes, booked.body.id, block.id, block.reason]) {
    assert.ok(!json.includes(privateValue));
  }
  for (const query of [
    "", "month=2026-11", "service=Unknown", "service=Oil+Change&service=Tire+Rotation",
    "service=Oil+Change&month=", "service=Oil+Change&month=2026-00", "service=Oil+Change&month=2026-13",
    "service=Oil+Change&month=2026-1", "service=Oil+Change&month=2026-11-01", "service=Oil+Change&month=0000-01",
    "service=Oil+Change&month=2026-11&month=2026-11", "service=Oil+Change&month=2026-10", "service=Oil+Change&month=2026-12",
  ]) {
    const rejected = await api(`/api/availability/calendar?${query}`);
    assert.equal(rejected.status, 400, query);
    assert.equal(rejected.response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(await SchedulingState.findById("shop").lean(), before);
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
