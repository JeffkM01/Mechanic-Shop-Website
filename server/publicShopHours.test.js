import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createApp } from "./app.js";

async function fixture(t) {
  const dbName = `eds_public_hours_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", { dbName, serverSelectionTimeoutMS: 5000 });
  let server;
  try { await connection.asPromise(); }
  catch (error) { await connection.close(); throw new Error("Public-hours tests require local MongoDB; only isolated synthetic databases are used.", { cause: error }); }
  t.after(async () => {
    try {
      if (server) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally {
      try {
        assert.equal(connection.name, dbName);
        assert.match(connection.name, /^eds_public_hours_test_[a-f\d]{32}$/);
        await connection.dropDatabase();
      } finally { await connection.close(); }
    }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const scheduling = createSchedulingService({ Appointment, SchedulingState, now: () => new Date("2030-01-07T12:00:00Z") });
  await scheduling.getSettings();
  const app = createApp({ Appointment, scheduling, auth: createMechanicAuth("isolated-public-hours-password-2030"), notifications: { enabled: false, kick() {} } });
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  async function read() {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/shop-hours`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    return response.json();
  }
  return { Appointment, SchedulingState, scheduling, read };
}

test("public hours withhold unverified placeholders instead of advertising any weekday as open or closed", async t => {
  const f = await fixture(t);
  const before = await f.scheduling.getSettings();
  const hours = await f.read();
  assert.deepEqual(hours, { verified: false, timezone: "America/Chicago", weeklyHours: null, breaks: [], closedDates: [] });
  assert.deepEqual(await f.scheduling.getSettings(), before);
  assert.equal(await f.Appointment.countDocuments(), 0);
});

test("verified public hours use the saved calendar and never expose customers or private blocked periods", async t => {
  const f = await fixture(t);
  await f.scheduling.createAppointment({ name: "Private Hours Test Customer", email: "hours-private@example.invalid", phone: "555-555-0167", vehicle: "2020 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", notes: "Private vehicle concern." });
  await f.scheduling.addBlockedPeriod({ startAt: "2030-01-09T20:00:00Z", endAt: "2030-01-09T21:00:00Z", reason: "Private internal block reason." });
  const saved = await f.scheduling.updateSettings({ weeklyHours: { "0": [{ start: "10:00", end: "14:00" }] }, closedDates: ["2030-01-21"], businessHoursVerified: true });
  const hours = await f.read();
  assert.deepEqual(Object.keys(hours).sort(), ["breaks", "closedDates", "timezone", "verified", "weeklyHours"]);
  assert.equal(hours.verified, true);
  assert.deepEqual(hours.weeklyHours, saved.settings.weeklyHours);
  assert.deepEqual(hours.weeklyHours["0"], [{ start: "10:00", end: "14:00" }]);
  assert.deepEqual(hours.breaks, saved.settings.breaks);
  assert.deepEqual(hours.closedDates, ["2030-01-21"]);
  const body = JSON.stringify(hours);
  for (const value of ["Private Hours", "hours-private", "555-555", "Private vehicle", "Private internal", "blockedPeriods", "reservations", "serviceCatalog", "capacity", "management"]) assert.equal(body.includes(value), false, value);
  assert.deepEqual(await f.scheduling.getSettings(), saved);
});

test("editing a verified schedule hides it again until the mechanic explicitly verifies the revised hours", async t => {
  const f = await fixture(t);
  await f.scheduling.updateSettings({ businessHoursVerified: true });
  assert.equal((await f.read()).verified, true);
  await f.scheduling.updateSettings({ weeklyHours: { "1": [{ start: "09:00", end: "17:00" }] } });
  assert.equal((await f.read()).weeklyHours, null);
  const saved = await f.scheduling.updateSettings({ businessHoursVerified: true });
  const hours = await f.read();
  assert.equal(hours.verified, true);
  assert.deepEqual(hours.weeklyHours["1"], saved.settings.weeklyHours["1"]);
  assert.equal(saved.settings.automaticBookingEnabled, false);
});
