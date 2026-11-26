import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { createApp } from "./app.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { Buffer } from "node:buffer";
import { readAppointmentEmailTestConfiguration } from "./appointmentEmailTest.js";
import { createCustomerManagement } from "./customerManagement.js";
import { createEmailNotifications } from "./emailNotifications.js";

// Every case owns a random synthetic database. No application .env, normal
// database, external routing service, or email transport is loaded here.
const uri = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
const initialTime = "2030-01-07T12:00:00.000Z";
const date = "2030-01-09";
const mobileBookingPolicy = Object.freeze({ travelBufferMinutes: 75, requiresMechanicApproval: true });
const password = "synthetic-mobile-review-password-872";
const invalid = error => error.status === 400;
const conflict = error => error.status === 409;
const times = result => result.slots.map(slot => slot.time);
const request = (overrides = {}) => ({
  name: "Private Mobile Booking Customer", email: "mobile-booking@example.invalid",
  phone: "555-555-0136", vehicle: "2020 Honda Civic", service: "Wiper Blade Replacement",
  date, time: "08:00", notes: "Synthetic mobile appointment only.",
  city: "Fictional Mobile City", state: "MO", postalCode: "63301",
  ...overrides,
});
const review = (travelBufferMinutes = 75) => ({
  locationConfirmed: true, travelConfirmed: true, travelBufferMinutes,
});

test("mobile review and scoped owned-inbox delivery compose without replaying older requests", async t => {
  const f = await fixture(t);
  const recipient = "contact@edsautoshop.com";
  const old = await f.legacy.createAppointment(request({ date: "2030-01-10", email: recipient }));
  const configuration = readAppointmentEmailTestConfiguration({ staging: { enabled: true }, env: {
    NODE_ENV: "test", STAGING_APPOINTMENT_EMAIL_TEST_ENABLED: "true", STAGING_EMAIL_TEST_ENABLED: "false",
    STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID: randomUUID(), BREVO_API_KEY: "synthetic-mobile-workflow-key-935",
    PUBLIC_WEBSITE_ORIGIN: "https://staging.synthetic-shop.org", APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 91).toString("base64url"),
  } });
  const management = createCustomerManagement({ Appointment: f.Appointment, env: configuration.notificationEnv, deliveryScope: configuration.deliveryScope, now: () => new Date(initialTime) });
  const scheduling = createSchedulingService({ Appointment: f.Appointment, SchedulingState: f.SchedulingState,
    now: () => new Date(initialTime), management, deliveryScope: configuration.deliveryScope, mobileBookingPolicy });
  const sent = [];
  const notifications = await createEmailNotifications({ Appointment: f.Appointment, env: configuration.notificationEnv,
    deliveryScope: configuration.deliveryScope, management, transport: { sendMail: async message => { sent.push(message); } }, logger: { error() {} } });
  t.after(() => notifications.stop());
  const created = await scheduling.createAppointment(request({ email: recipient }));
  assert.equal(created.status, "pending");
  await notifications.processPending();
  assert.equal(sent.length, 2);
  assert.ok(sent.every(message => message.to === recipient && message.subject.startsWith("[TEST ONLY]")));
  assert.ok(sent.every(message => message.text.includes(request().city) && message.text.includes("75 minutes")));
  assert.ok(sent[0].text.includes("https://staging.synthetic-shop.org/manage-appointment#id="));
  await scheduling.reviewAppointment(created.id, "confirmed", { mobileReview: review() });
  await notifications.processPending();
  assert.equal(sent.length, 3);
  assert.ok(sent[2].subject.includes("appointment confirmed"));
  await scheduling.cancelAppointment(created.id, "customer", {});
  await notifications.processPending();
  assert.equal(sent.length, 5);
  assert.ok(sent.slice(3).every(message => message.text.includes("75 minutes")));
  const unchanged = await f.Appointment.findById(old.id).lean();
  assert.equal(unchanged.notificationState.requestCustomer, "pending");
  assert.equal(unchanged.status, "pending");
});

async function fixture(t) {
  const dbName = `eds_mobile_booking_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  try { await connection.asPromise(); }
  catch (error) {
    await connection.close();
    throw new Error("Mobile booking tests require isolated local MongoDB or TEST_MONGODB_URI.", { cause: error });
  }
  t.after(async () => {
    try {
      assert.equal(connection.name, dbName);
      assert.match(connection.name, /^eds_mobile_booking_test_[a-f\d]{32}$/);
      await connection.dropDatabase();
    } finally { await connection.close(); }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  let clock = +new Date(initialTime);
  const common = { Appointment, SchedulingState, now: () => new Date(clock) };
  const scheduling = createSchedulingService({ ...common, mobileBookingPolicy });
  const otherScheduling = createSchedulingService({ ...common, mobileBookingPolicy });
  const legacy = createSchedulingService(common);
  await scheduling.getSettings();
  await scheduling.updateSettings({ bufferMinutes: 0, startIncrementMinutes: 15 });
  return {
    Appointment, SchedulingState, scheduling, otherScheduling, legacy,
    advance(milliseconds) { clock += milliseconds; },
    privateRecord(id) { return Appointment.findById(id).select("+mobileVisit").lean(); },
  };
}

async function httpFixture(t) {
  const f = await fixture(t);
  const auth = createMechanicAuth(password);
  const app = createApp({ ...f, auth, notifications: { enabled: false, kick() {} } });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, status: response.status, body: await response.json() };
  }
  const login = await api("/api/mechanic/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200);
  const cookieHeaders = { Cookie: login.response.headers.get("set-cookie").split(";")[0] };
  return { ...f, api, cookieHeaders, staffHeaders: { ...cookieHeaders, "X-Mechanic-CSRF": login.body.csrfToken } };
}

test("mobile policy validation rejects forged automation or malformed configuration before storage access", () => {
  const never = new Proxy({}, { get() { throw new Error("Storage must not be reached"); } });
  for (const policy of [{}, [], { ...mobileBookingPolicy, requiresMechanicApproval: false },
    { ...mobileBookingPolicy, travelBufferMinutes: "75" }, { ...mobileBookingPolicy, travelBufferMinutes: 121 },
    { ...mobileBookingPolicy, extra: true }]) {
    assert.throws(() => createSchedulingService({ Appointment: never, SchedulingState: never, mobileBookingPolicy: policy }));
  }
});

test("mobile location validation rejects missing and malformed fields before any reservation or appointment write", async t => {
  const f = await fixture(t);
  const before = await f.SchedulingState.findById("shop").lean();
  for (const patch of [{ city: undefined, state: undefined, postalCode: undefined }, { city: "" },
    { city: "x".repeat(81) }, { city: "City\nInjected" }, { state: "CA" }, { postalCode: "not-a-zip" }]) {
    await assert.rejects(f.scheduling.createAppointment(request(patch)), invalid);
  }
  assert.equal(await f.Appointment.countDocuments({}), 0);
  const after = await f.SchedulingState.findById("shop").lean();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.reservations, before.reservations);
});

test("mobile bookings privately snapshot the minimum buffer and cannot accept forged review or location metadata", async t => {
  const f = await fixture(t);
  const created = await f.scheduling.createAppointment(request({
    mobileVisit: { city: "Forged city", travelBufferMinutes: 0, reviewedAt: new Date(), locationConfirmed: true, travelConfirmed: true },
  }));
  assert.equal(created.status, "pending");
  assert.equal(created.scheduling.bufferMinutes, 75);
  assert.equal(+created.scheduling.occupiedUntil - +created.scheduling.endAt, 75 * 60_000);
  const hidden = await f.Appointment.findById(created.id).lean();
  assert.equal(hidden.mobileVisit, undefined);
  const saved = await f.privateRecord(created.id);
  assert.equal(saved.mobileVisit.city, request().city);
  assert.equal(saved.mobileVisit.state, "MO");
  assert.equal(saved.mobileVisit.postalCode, "63301");
  assert.equal(saved.mobileVisit.travelBufferMinutes, 75);
  assert.equal(saved.mobileVisit.reviewedAt, undefined);
  assert.notEqual(saved.mobileVisit.locationConfirmed, true);
  assert.notEqual(saved.mobileVisit.travelConfirmed, true);
  assert.equal((await f.scheduling.getSettings()).settings.bufferMinutes, 0, "The existing saved buffer is not rewritten");
});

test("mobile availability includes travel occupancy, lunch, closing and closed days without leaking customer details", async t => {
  const f = await fixture(t);
  const initial = await f.scheduling.getAvailability(request().service, date);
  assert.ok(times(initial).includes("10:15"));
  assert.ok(!times(initial).includes("10:30"), "Service and travel must fit before lunch");
  assert.ok(times(initial).includes("15:15"));
  assert.ok(!times(initial).includes("15:30"), "Travel must fit before closing");
  await f.scheduling.createAppointment(request());
  const occupied = await f.scheduling.getAvailability(request().service, date);
  for (const time of ["08:00", "08:30", "09:30"]) assert.ok(!times(occupied).includes(time), time);
  assert.ok(times(occupied).includes("09:45"));
  assert.deepEqual(times(await f.scheduling.getAvailability(request().service, "2030-01-12")), []);
  const calendar = await f.scheduling.getCalendarAvailability(request().service, "2030-01");
  const catalog = await f.scheduling.getPublicServices();
  assert.deepEqual(catalog.mobileBooking, mobileBookingPolicy);
  assert.equal(occupied.policy.bufferMinutes, 75);
  for (const result of [occupied, calendar, catalog]) {
    const serialized = JSON.stringify(result);
    for (const privateValue of [request().name, request().email, request().city, request().postalCode, request().notes]) {
      assert.equal(serialized.includes(privateValue), false, "Public availability/catalog must not contain private visit details");
    }
  }
});

test("the monthly calendar uses the same mobile geometry as day availability", async t => {
  const f = await fixture(t);
  const weeklyHours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, day === 0 || day === 6 ? [] : [{ start: "08:00", end: "09:00" }]]));
  await f.scheduling.updateSettings({ weeklyHours });
  assert.deepEqual(times(await f.scheduling.getAvailability(request().service, date)), []);
  const mobileCalendar = await f.scheduling.getCalendarAvailability(request().service, "2030-01");
  assert.equal(mobileCalendar.days.find(day => day.date === date).available, false);
  const legacyCalendar = await f.legacy.getCalendarAvailability(request().service, "2030-01");
  assert.equal(legacyCalendar.days.find(day => day.date === date).available, true, "Legacy zero-buffer geometry remains independently compatible");
});

test("saved automation and wiper eligibility cannot automatically confirm a new mobile request", async t => {
  const f = await fixture(t);
  await f.scheduling.updateSettings({
    automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true,
    serviceRules: { "Wiper Blade Replacement": { durationMinutes: 30, requiresApproval: false } },
  });
  const created = await f.scheduling.createAppointment(request());
  assert.equal(created.status, "pending");
  assert.equal(created.scheduling.confirmationSource, undefined);
  assert.equal((await f.scheduling.getSettings()).settings.automaticBookingEnabled, true);
  assert.equal((await f.SchedulingState.findById("shop").lean()).automaticCounts.reduce((sum, item) => sum + item.count, 0), 0);
  await assert.rejects(f.scheduling.reviewAppointment(created.id, "confirmed", { automatic: true }), conflict);
  assert.equal((await f.privateRecord(created.id)).status, "pending");
});

test("legacy creation ignores forged mobile metadata and historical quarter-hour requests can still be approved", async t => {
  const f = await fixture(t);
  const created = await f.legacy.createAppointment(request({
    time: "08:15", mobileVisit: { city: "Forged private city", state: "MO", postalCode: "63301", travelBufferMinutes: 75 },
  }));
  assert.equal((await f.privateRecord(created.id)).mobileVisit, undefined);
  assert.equal(created.scheduling.bufferMinutes, 0);
  await f.scheduling.updateSettings({ startIncrementMinutes: 30 });
  const confirmed = await f.scheduling.reviewAppointment(created.id, "confirmed");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.time, "08:15");
  assert.equal(confirmed.scheduling.bufferMinutes, 0);
  assert.equal((await f.privateRecord(created.id)).mobileVisit, undefined);
});

test("mobile approval requires explicit location and travel checks and never shrinks the booked buffer", async t => {
  const f = await fixture(t);
  const created = await f.scheduling.createAppointment(request());
  const before = await f.SchedulingState.findById("shop").lean();
  for (const mobileReview of [undefined, {}, { ...review(), locationConfirmed: false },
    { ...review(), travelConfirmed: false }, review(74), review(121), { ...review(), travelBufferMinutes: "75" }]) {
    await assert.rejects(f.scheduling.reviewAppointment(created.id, "confirmed", { mobileReview }), invalid);
  }
  const after = await f.SchedulingState.findById("shop").lean();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.reservations, before.reservations);
  assert.equal((await f.privateRecord(created.id)).status, "pending");
  const confirmed = await f.scheduling.reviewAppointment(created.id, "confirmed", { mobileReview: review(120) });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.scheduling.bufferMinutes, 120);
  const saved = await f.privateRecord(created.id);
  assert.equal(saved.mobileVisit.locationConfirmed, true);
  assert.equal(saved.mobileVisit.travelConfirmed, true);
  assert.equal(+saved.mobileVisit.reviewedAt, +new Date(initialTime));
});

test("a saved buffer above the mobile minimum remains the required minimum during approval", async t => {
  const f = await fixture(t);
  const updated = await f.scheduling.updateSettings({ bufferMinutes: 100 });
  assert.deepEqual(updated.mobileBooking, mobileBookingPolicy, "Saving settings must retain the effective mobile policy for staff");
  const created = await f.scheduling.createAppointment(request());
  assert.equal(created.scheduling.bufferMinutes, 100);
  await assert.rejects(f.scheduling.reviewAppointment(created.id, "confirmed", { mobileReview: review(75) }), invalid);
  assert.equal((await f.privateRecord(created.id)).status, "pending");
  assert.equal((await f.scheduling.reviewAppointment(created.id, "confirmed", { mobileReview: review(100) })).status, "confirmed");
});

test("mobile review remains mandatory for tagged visits even if the current coordinator uses legacy policy", async t => {
  const f = await fixture(t);
  const created = await f.scheduling.createAppointment(request());
  await assert.rejects(f.legacy.reviewAppointment(created.id, "confirmed"), invalid);
  await assert.rejects(f.legacy.reviewAppointment(created.id, "confirmed", { automatic: true }), conflict);
  assert.equal((await f.legacy.reviewAppointment(created.id, "confirmed", { mobileReview: review() })).status, "confirmed");
});

test("a travel extension conflicting with another reservation is rejected without confirming or saving acknowledgments", async t => {
  const f = await fixture(t);
  const first = await f.scheduling.createAppointment(request());
  const second = await f.otherScheduling.createAppointment(request({ time: "09:45", name: "Second Synthetic Mobile Customer" }));
  await assert.rejects(f.scheduling.reviewAppointment(first.id, "confirmed", { mobileReview: review(120) }), conflict);
  const saved = await f.privateRecord(first.id);
  assert.equal(saved.status, "pending");
  assert.equal(saved.scheduling.bufferMinutes, 75);
  assert.equal(saved.mobileVisit.reviewedAt, undefined);
  const ledger = await f.SchedulingState.findById("shop").lean();
  assert.equal(ledger.reservations.find(item => String(item.appointmentId) === first.id).bufferMinutes, 75);
  assert.ok(ledger.reservations.some(item => String(item.appointmentId) === second.id));
});

test("concurrent mobile travel extension and booking serialize through MongoDB so only one can occupy the interval", async t => {
  const f = await fixture(t);
  const first = await f.scheduling.createAppointment(request());
  const results = await Promise.allSettled([
    f.scheduling.reviewAppointment(first.id, "confirmed", { mobileReview: review(120) }),
    f.otherScheduling.createAppointment(request({ time: "09:45", name: "Concurrent Synthetic Mobile Customer" })),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(conflict(rejected.reason), true);
  const firstSaved = await f.privateRecord(first.id);
  assert.equal(firstSaved.status, results[0].status === "fulfilled" ? "confirmed" : "pending");
  assert.equal(await f.Appointment.countDocuments({}), results[1].status === "fulfilled" ? 2 : 1);
  const { reservations } = await f.SchedulingState.findById("shop").lean();
  const sorted = reservations.toSorted((a, b) => +a.startAt - +b.startAt);
  for (let index = 1; index < sorted.length; index++) assert.ok(+sorted[index - 1].occupiedUntil <= +sorted[index].startAt);
});

test("an expired mobile hold retains its request and requires fresh availability before approval", async t => {
  const f = await fixture(t);
  const expired = await f.scheduling.createAppointment(request());
  f.advance(25 * 60 * 60_000);
  const replacement = await f.otherScheduling.createAppointment(request({ name: "Replacement Synthetic Mobile Customer" }));
  await assert.rejects(f.scheduling.reviewAppointment(expired.id, "confirmed", { mobileReview: review() }), conflict);
  assert.equal((await f.privateRecord(expired.id)).status, "pending");
  assert.equal((await f.privateRecord(expired.id)).mobileVisit.reviewedAt, undefined);
  assert.equal((await f.privateRecord(replacement.id)).status, "pending");
});

test("HTTP mobile intake and review preserve field validation, authentication, CSRF and private staff-only visit details", async t => {
  const f = await httpFixture(t);
  const bad = await f.api("/api/appointments", { method: "POST", body: request({ city: "", state: "", postalCode: "" }) });
  assert.equal(bad.status, 400);
  for (const field of ["city", "state", "postalCode"]) assert.ok(bad.body.fields[field]);
  assert.equal(await f.Appointment.countDocuments({}), 0);
  const created = await f.api("/api/appointments", { method: "POST", body: request() });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "pending");
  assert.equal(created.body.emailNotification, "disabled");
  assert.equal(created.body.mobileVisit, undefined);
  const id = created.body.id;
  assert.equal((await f.api("/api/mechanic/appointments?status=all")).status, 401);
  const list = await f.api("/api/mechanic/appointments?status=all", { headers: f.staffHeaders });
  assert.equal(list.status, 200);
  const visit = list.body.appointments.find(item => item._id === id).mobileVisit;
  assert.equal(visit.city, request().city);
  assert.equal(visit.postalCode, request().postalCode);
  assert.equal(visit.reviewedAt, undefined);
  const body = { status: "confirmed", mobileReview: review() };
  assert.equal((await f.api(`/api/mechanic/appointments/${id}`, { method: "PATCH", body })).status, 401);
  assert.equal((await f.api(`/api/mechanic/appointments/${id}`, { method: "PATCH", body, headers: f.cookieHeaders })).status, 403);
  const missingReview = await f.api(`/api/mechanic/appointments/${id}`, { method: "PATCH", body: { status: "confirmed" }, headers: f.staffHeaders });
  assert.equal(missingReview.status, 400);
  assert.equal((await f.privateRecord(id)).status, "pending");
  const declinedWithReview = await f.api(`/api/mechanic/appointments/${id}`, { method: "PATCH", body: { status: "declined", decline: { category: "unable_to_accommodate" }, mobileReview: review() }, headers: f.staffHeaders });
  assert.equal(declinedWithReview.status, 400);
  const confirmed = await f.api(`/api/mechanic/appointments/${id}`, { method: "PATCH", body, headers: f.staffHeaders });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, "confirmed");
  for (const path of ["/api/services", `/api/availability?service=${encodeURIComponent(request().service)}&date=${date}`, `/api/availability/calendar?service=${encodeURIComponent(request().service)}&month=2030-01`]) {
    const result = await f.api(path);
    assert.equal(result.status, 200);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    const serialized = JSON.stringify(result.body);
    for (const privateValue of [request().name, request().email, request().city, request().postalCode]) assert.equal(serialized.includes(privateValue), false);
  }
});
