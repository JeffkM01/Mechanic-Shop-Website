import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createApp } from "./app.js";
import { SERVICES, requiresMechanicApproval } from "../shared/services.js";

const clock = new Date("2030-01-07T12:00:00.000Z");
const password = "isolated-catalog-testing-password-52";
const customer = { name: "Private Catalog Test Customer", email: "catalog@example.invalid", phone: "555-555-0167", vehicle: "2019 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", notes: "Synthetic private note." };
const suspension = { name: "Suspension Repair", category: "repairs", icon: "wrench", description: "Inspection and repair of suspension concerns after mechanic review.", active: true, provisional: false, appointmentOnly: false, legacyNames: [] };
const clone = value => structuredClone(value);

async function fixture(t) {
  const dbName = `eds_catalog_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", { dbName, serverSelectionTimeoutMS: 5000 });
  try { await connection.asPromise(); }
  catch (error) { await connection.close(); throw new Error("Catalog tests require local MongoDB or TEST_MONGODB_URI; the shop database is never used.", { cause: error }); }
  t.after(async () => {
    try { assert.equal(connection.name, dbName); assert.match(connection.name, /^eds_catalog_test_[a-f\d]{32}$/); await connection.dropDatabase(); }
    finally { await connection.close(); }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const options = { Appointment, SchedulingState, now: () => new Date(clock) };
  const scheduling = createSchedulingService(options);
  const otherScheduling = createSchedulingService(options);
  await scheduling.getSettings();
  return { Appointment, SchedulingState, scheduling, otherScheduling };
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
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, status: response.status, body: await response.json() };
  }
  const login = await api("/api/mechanic/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  return { ...f, api, cookieHeaders: { Cookie: cookie }, staff: { Cookie: cookie, "X-Mechanic-CSRF": login.body.csrfToken } };
}

async function addSuspension(f) {
  const saved = await f.scheduling.getSettings();
  return f.scheduling.updateSettings({ serviceCatalog: [...saved.settings.serviceCatalog, clone(suspension)], serviceRules: { [suspension.name]: { durationMinutes: 90, requiresApproval: true } } }, { expectedRevision: saved.revision });
}

async function deactivate(f, names) {
  const saved = await f.scheduling.getSettings();
  return f.scheduling.updateSettings({ serviceCatalog: saved.settings.serviceCatalog.map(service => names.includes(service.name) ? { ...service, active: false } : service) }, { expectedRevision: saved.revision });
}

test("new persisted catalog keeps all current offerings and only wipers are eligible while global automation remains off", async t => {
  const f = await fixture(t);
  const saved = await f.scheduling.getSettings();
  assert.deepEqual(saved.settings.serviceCatalog, SERVICES);
  assert.equal(saved.settings.serviceCatalog.some(service => service.name === suspension.name), false);
  assert.equal(saved.settings.serviceCatalog.find(service => service.name === "Oil Change").active, true);
  assert.equal(saved.settings.automaticBookingEnabled, false);
  assert.equal(saved.settings.businessHoursVerified, false);
  assert.equal(saved.settings.capacityVerified, false);
  for (const service of SERVICES) assert.equal(saved.settings.serviceRules[service.name].requiresApproval, requiresMechanicApproval(service));
  assert.equal((await f.scheduling.createAppointment({ ...customer, service: "Wiper Blade Replacement" })).status, "pending");
});

test("legacy settings seed the catalog once and normalize manual rules without changing business settings or historical records", async t => {
  const f = await fixture(t);
  const original = await f.scheduling.getSettings();
  const settings = clone(original.settings);
  delete settings.serviceCatalog;
  settings.bufferMinutes = 20;
  settings.minimumNoticeHours = 6;
  settings.capacity = 2;
  settings.businessHoursVerified = true;
  for (const service of SERVICES) settings.serviceRules[service.name].requiresApproval = false;
  await f.SchedulingState.updateOne({ _id: "shop" }, { $set: { settings, settingsRevision: 9 } });
  const record = await f.Appointment.create({ ...customer, service: "Air Filter Change", time: "08:15" });
  const before = await f.Appointment.findById(record.id).lean();
  const next = await f.scheduling.getSettings();
  assert.equal(next.revision, 10);
  assert.equal(next.settings.bufferMinutes, 20);
  assert.equal(next.settings.minimumNoticeHours, 6);
  assert.equal(next.settings.capacity, 2);
  assert.equal(next.settings.businessHoursVerified, true);
  assert.equal(next.settings.automaticBookingEnabled, false);
  for (const service of SERVICES) assert.equal(next.settings.serviceRules[service.name].requiresApproval, requiresMechanicApproval(service));
  assert.equal((await f.scheduling.getSettings()).revision, 10);
  assert.deepEqual(await f.Appointment.findById(record.id).lean(), before);
});

test("authenticated staff can add a service that public catalog, availability and appointment validation use immediately", async t => {
  const f = await httpFixture(t);
  const saved = await f.scheduling.getSettings();
  const added = await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.staff, body: { revision: saved.revision, settings: { serviceCatalog: [...saved.settings.serviceCatalog, suspension], serviceRules: { [suspension.name]: { durationMinutes: 90, requiresApproval: true } } } } });
  assert.equal(added.status, 200);
  const catalog = await f.api("/api/services");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(catalog.body.services.find(service => service.name === suspension.name), suspension);
  const availability = await f.api(`/api/availability?${new URLSearchParams({ service: suspension.name, date: customer.date })}`);
  assert.equal(availability.status, 200);
  assert.equal(availability.body.durationMinutes, 90);
  const booked = await f.api("/api/appointments", { method: "POST", body: { ...customer, service: suspension.name } });
  assert.equal(booked.status, 201);
  assert.equal(booked.body.status, "pending");
  const record = await f.Appointment.findById(booked.body.id).lean();
  assert.equal(record.service, suspension.name);
  assert.equal(record.scheduling.durationMinutes, 90);
});

test("public catalog is an active metadata allowlist with no customer, reservation, settings or private reason data", async t => {
  const f = await httpFixture(t);
  await f.scheduling.createAppointment(customer);
  await f.scheduling.addBlockedPeriod({ startAt: "2030-01-10T14:00:00Z", endAt: "2030-01-10T15:00:00Z", reason: "Private staffing reason" });
  await deactivate(f, ["Oil Change"]);
  const result = await f.api("/api/services");
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["revision", "services"]);
  assert.equal(result.body.services.some(service => service.name === "Oil Change"), false);
  for (const service of result.body.services) assert.deepEqual(Object.keys(service).sort(), ["active", "appointmentOnly", "category", "description", "icon", "legacyNames", "name", "provisional"]);
  const serialized = JSON.stringify(result.body);
  for (const privateValue of [customer.name, customer.email, customer.phone, customer.notes, "Private staffing reason", "reservations", "serviceRules", "management", "capacity"]) assert.equal(serialized.includes(privateValue), false, privateValue);
});

test("deactivated services and aliases reject new public bookings without creating records or reservations", async t => {
  const f = await httpFixture(t);
  await deactivate(f, ["Oil Change", "Engine Air Filter Replacement"]);
  const before = await f.SchedulingState.findById("shop").lean();
  for (const service of ["Oil Change", "Air Filter Change", "Unknown Service"]) {
    const booked = await f.api("/api/appointments", { method: "POST", body: { ...customer, service } });
    assert.equal(booked.status, 400);
    assert.equal(booked.body.code, service === "Unknown Service" ? "INVALID_SERVICE" : "SERVICE_UNAVAILABLE");
    assert.match(booked.body.fields.service, /service/i);
    for (const route of ["/api/availability", "/api/availability/calendar"]) {
      const result = await f.api(`${route}?${new URLSearchParams({ service, date: customer.date })}`);
      assert.equal(result.status, 400);
    }
  }
  assert.equal(await f.Appointment.countDocuments(), 0);
  const after = await f.SchedulingState.findById("shop").lean();
  assert.deepEqual(after.reservations, before.reservations);
});

test("deactivation preserves pending snapshots and manual review, including historical off-grid aliases", async t => {
  const f = await fixture(t);
  const current = await f.scheduling.createAppointment(customer);
  const legacy = await f.Appointment.create({ ...customer, service: "Air Filter Change", time: "10:15", createdAt: new Date("2030-01-01T12:00:00Z") });
  const snapshot = clone(current.scheduling.toObject ? current.scheduling.toObject() : current.scheduling);
  const saved = await deactivate(f, ["Oil Change", "Engine Air Filter Replacement"]);
  await f.scheduling.updateSettings({ serviceRules: { "Oil Change": { durationMinutes: 120 } } }, { expectedRevision: saved.revision });
  const approved = await f.scheduling.reviewAppointment(current.id, "confirmed");
  assert.equal(approved.status, "confirmed");
  assert.equal(approved.service, "Oil Change");
  assert.equal(approved.scheduling.durationMinutes, snapshot.durationMinutes);
  const historical = await f.scheduling.reviewAppointment(legacy.id, "confirmed");
  assert.equal(historical.service, "Air Filter Change");
  assert.equal(historical.time, "10:15");
  assert.equal(historical.status, "confirmed");
  const cancelled = await f.scheduling.cancelAppointment(current.id, "mechanic", { category: "mechanic_unavailable" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellation.originalDate, customer.date);
});

test("reactivating a retained service restores new booking without rewriting its previous requests", async t => {
  const f = await fixture(t);
  const existing = await f.scheduling.createAppointment(customer);
  const original = await f.Appointment.findById(existing.id).lean();
  const inactive = await deactivate(f, ["Oil Change"]);
  const active = await f.scheduling.updateSettings({ serviceCatalog: inactive.settings.serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: true } : service) }, { expectedRevision: inactive.revision });
  assert.equal(active.settings.serviceCatalog.find(service => service.name === "Oil Change").active, true);
  const another = await f.scheduling.createAppointment({ ...customer, time: "10:00" });
  assert.equal(another.status, "pending");
  assert.deepEqual(await f.Appointment.findById(existing.id).lean(), original);
});

test("catalog edits require staff session, CSRF and the current settings revision", async t => {
  const f = await httpFixture(t);
  const saved = await f.scheduling.getSettings();
  const settings = { serviceCatalog: saved.settings.serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: false } : service) };
  const body = { revision: saved.revision, settings };
  assert.equal((await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", body })).status, 401);
  assert.equal((await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.cookieHeaders, body })).status, 403);
  assert.equal((await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: { ...f.staff, "X-Mechanic-CSRF": "wrong" }, body })).status, 403);
  assert.equal((await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.staff, body: { settings } })).status, 400);
  const newer = await addSuspension(f);
  const stale = await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.staff, body });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "SETTINGS_CHANGED");
  assert.deepEqual(await f.scheduling.getSettings(), newer);
});

test("forged catalog names, deleted identities and manual-only approval overrides fail atomically", async t => {
  const f = await httpFixture(t);
  const original = await addSuspension(f);
  const invalidCatalogs = [
    original.settings.serviceCatalog.filter(service => service.name !== "Oil Change"),
    [...original.settings.serviceCatalog, { ...suspension, name: "toString" }],
    [...original.settings.serviceCatalog, { ...suspension, name: "Oil.Change" }],
    [...original.settings.serviceCatalog, { ...suspension, name: "$operator" }],
    [...original.settings.serviceCatalog, { ...suspension, name: "Air Filter Change" }],
  ];
  for (const serviceCatalog of invalidCatalogs) {
    const result = await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.staff, body: { revision: original.revision, settings: { serviceCatalog } } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_SERVICE_CATALOG");
  }
  for (const name of ["Oil Change", "Cabin Air Filter Replacement", suspension.name]) {
    const result = await f.api("/api/mechanic/scheduling/settings", { method: "PATCH", headers: f.staff, body: { revision: original.revision, settings: { serviceRules: { [name]: { requiresApproval: false } } } } });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /requires mechanic approval/);
  }
  assert.deepEqual(await f.scheduling.getSettings(), original);
});

test("only wipers automatically confirm after explicit enablement with verified hours and capacity", async t => {
  const f = await fixture(t);
  await addSuspension(f);
  await f.scheduling.updateSettings({ capacity: 20, maxAutomaticPerDay: 20, automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  for (const service of [...SERVICES, suspension]) {
    const booked = await f.scheduling.createAppointment({ ...customer, service: service.name });
    assert.equal(booked.status, service.name === "Wiper Blade Replacement" ? "confirmed" : "pending", service.name);
  }
  const state = await f.SchedulingState.findById("shop").lean();
  assert.equal(state.automaticCounts.reduce((total, item) => total + item.count, 0), 1);
});

test("a booking losing the Mongo scheduling CAS to deactivation cannot reserve the inactive service", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const saved = await f.scheduling.getSettings();
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  let release;
  const waitForDeactivation = new Promise(resolve => { release = resolve; });
  const original = f.SchedulingState.updateOne.bind(f.SchedulingState);
  let delayed = false;
  t.mock.method(f.SchedulingState, "updateOne", async (filter, update, options) => {
    if (!delayed && update.$set?.reservations?.length) { delayed = true; signalEntered(); await waitForDeactivation; }
    return original(filter, update, options);
  });
  const booking = f.scheduling.createAppointment(customer).then(value => ({ value }), error => ({ error }));
  try {
    await entered;
    await f.otherScheduling.updateSettings({ serviceCatalog: saved.settings.serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: false } : service) }, { expectedRevision: saved.revision });
  } finally { release(); }
  const outcome = await booking;
  assert.equal(outcome.error?.code, "SERVICE_UNAVAILABLE");
  assert.equal(await f.Appointment.countDocuments(), 0);
  assert.equal((await f.SchedulingState.findById("shop").lean()).reservations.length, 0);
});

test("a catalog update losing its CAS to a valid booking preserves the accepted request and reservation", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const saved = await f.scheduling.getSettings();
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  let release;
  const waitForBooking = new Promise(resolve => { release = resolve; });
  const original = f.SchedulingState.updateOne.bind(f.SchedulingState);
  let delayed = false;
  t.mock.method(f.SchedulingState, "updateOne", async (filter, update, options) => {
    if (!delayed && update.$set?.settings?.serviceCatalog?.some(service => service.name === "Oil Change" && !service.active)) { delayed = true; signalEntered(); await waitForBooking; }
    return original(filter, update, options);
  });
  const changing = f.scheduling.updateSettings({ serviceCatalog: saved.settings.serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: false } : service) }, { expectedRevision: saved.revision });
  let appointment;
  try { await entered; appointment = await f.otherScheduling.createAppointment(customer); }
  finally { release(); }
  await changing;
  assert.equal((await f.Appointment.findById(appointment.id).lean()).status, "pending");
  assert.equal((await f.SchedulingState.findById("shop").lean()).reservations.some(item => String(item.appointmentId) === appointment.id), true);
  assert.equal((await f.scheduling.reviewAppointment(appointment.id, "confirmed")).status, "confirmed");
});

test("wiper deactivation between reservation and automatic decision leaves the accepted request pending", async t => {
  const f = await fixture(t);
  await f.scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  const original = f.Appointment.prototype.save;
  let deactivated = false;
  t.mock.method(f.Appointment.prototype, "save", async function (...args) {
    if (!deactivated && this.service === "Wiper Blade Replacement") { deactivated = true; await deactivate(f, ["Wiper Blade Replacement"]); }
    return original.apply(this, args);
  });
  const appointment = await f.scheduling.createAppointment({ ...customer, service: "Wiper Blade Replacement" });
  assert.equal(appointment.status, "pending");
  assert.equal(appointment.scheduling.confirmationSource, undefined);
  assert.equal((await f.SchedulingState.findById("shop").lean()).automaticCounts.length, 0);
});

test("malformed stored catalogs fail closed before policy repair can construct Mongo field paths", async t => {
  const f = await httpFixture(t);
  const before = await f.SchedulingState.findById("shop").lean();
  await f.SchedulingState.updateOne({ _id: "shop" }, { $set: { "settings.serviceCatalog": [{ ...suspension, name: "constructor" }] } });
  const result = await f.api("/api/services");
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "INVALID_STORED_SERVICE_CATALOG");
  assert.equal(JSON.stringify(result.body).includes("constructor"), false);
  const after = await f.SchedulingState.findById("shop").lean();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.settings.serviceRules, before.settings.serviceRules);
});
