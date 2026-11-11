import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES } from "../shared/services.js";
import {
  SchedulingError, defaultSettings, validateSettings, mergeSettings,
  localDateTimeToUtc, dateInZone, buildCandidate, calculateSlots,
  canFit, legacyOccurrence,
} from "./schedulingRules.js";

const NOW = new Date("2026-11-07T00:00:00Z");
const MONDAY = "2026-11-09";
const errorCode = (code, status) => (error) => error instanceof SchedulingError
  && error.code === code && (status === undefined || error.status === status);
const occupancy = (start, end, bufferMinutes = 0) => ({ startAt: new Date(start), endAt: new Date(end), bufferMinutes });

test("defaults are independent, complete, and safe for unverified business settings", () => {
  const settings = validateSettings(defaultSettings());
  assert.equal(settings.automaticBookingEnabled, false);
  assert.equal(settings.businessHoursVerified, false);
  assert.equal(settings.capacityVerified, false);
  assert.equal(settings.timezone, "America/Chicago");
  assert.equal(settings.pendingHoldHours, 24);
  assert.equal(settings.serviceRules["Brake Repairs"].requiresApproval, true);
  const other = defaultSettings();
  settings.weeklyHours[1][0].start = "09:00";
  settings.serviceRules["Oil Change"].durationMinutes = 90;
  assert.equal(other.weeklyHours[1][0].start, "08:00");
  assert.equal(other.serviceRules["Oil Change"].durationMinutes, 60);
});

test("settings updates merge individual days and service rules without changing unrelated values", () => {
  const settings = mergeSettings(defaultSettings(), {
    weeklyHours: { 6: [{ start: "09:00", end: "12:00" }] },
    serviceRules: { "Oil Change": { durationMinutes: 90 } },
    blockedPeriods: [{ id: "training", startAt: "2026-11-09T15:00Z", endAt: "2026-11-09T16:00Z", reason: "Private staff event" }],
  });
  assert.equal(settings.weeklyHours[1][0].start, "08:00");
  assert.equal(settings.weeklyHours[6][0].start, "09:00");
  assert.deepEqual(settings.serviceRules["Oil Change"], { durationMinutes: 90, requiresApproval: true });
  assert.equal(settings.blockedPeriods[0].startAt, "2026-11-09T15:00:00.000Z");
});

test("only Wiper Blade Replacement can opt out of mechanic approval in defaults and settings updates", () => {
  for (const { name } of SERVICES) {
    const settings = defaultSettings();
    assert.equal(settings.serviceRules[name].requiresApproval, name !== "Wiper Blade Replacement", name);
    if (name !== "Wiper Blade Replacement") {
      settings.serviceRules[name].requiresApproval = false;
      assert.throws(() => validateSettings(settings), /requires mechanic approval/, name);
      assert.throws(() => mergeSettings(defaultSettings(), {
        automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true,
        serviceRules: { [name]: { requiresApproval: false } },
      }), /requires mechanic approval/, name);
      assert.equal(buildCandidate(defaultSettings(), name, MONDAY, "08:00", NOW).requiresApproval, true, name);
    } else {
      const updated = mergeSettings(settings, { serviceRules: { [name]: { requiresApproval: false } } });
      assert.equal(updated.serviceRules[name].requiresApproval, false, name);
    }
  }
});

test("strict settings validation rejects unknown keys and malformed nested configuration", () => {
  for (const patch of [
    { surprise: true }, { timezone: "Mars/Chicago" }, { capacity: 0 },
    { capacity: "1" }, { automaticBookingEnabled: "false" }, { bufferMinutes: -1 },
    { startIncrementMinutes: 17 }, { pendingHoldHours: 0 },
    { closedDates: ["2026-02-29"] }, { closedDates: [MONDAY, MONDAY] },
    { weeklyHours: { 8: [] } },
    { weeklyHours: { 1: [{ start: "17:00", end: "08:00" }] } },
    { weeklyHours: { 1: [{ start: "08:00", end: "12:00" }, { start: "11:30", end: "17:00" }] } },
    { breaks: [{ start: "12:00", end: "13:00", secret: true }] },
    { serviceRules: { "Air Filter Change": { durationMinutes: 30 } } },
    { serviceRules: { "Oil Change": { durationMinutes: 0 } } },
    { serviceRules: { "Oil Change": { invented: true } } },
    { blockedPeriods: [{ id: "x", startAt: "2026-11-09T12:00:00-06:00", endAt: "2026-11-09T19:00:00Z" }] },
    { blockedPeriods: [{ id: "x", startAt: "2026-02-30T12:00:00Z", endAt: "2026-03-01T19:00:00Z" }] },
    { blockedPeriods: [{ id: "x", startAt: "2026-11-09T19:00:00Z", endAt: "2026-11-09T18:00:00Z" }] },
  ]) assert.throws(() => mergeSettings(defaultSettings(), patch), (error) => error instanceof SchedulingError && error.status === 400, JSON.stringify(patch));
  assert.throws(() => validateSettings({ timezone: "UTC" }), /incomplete/);
  assert.throws(() => mergeSettings(defaultSettings(), JSON.parse('{"__proto__":{"capacity":99}}')), /unknown/);
});

test("calendar input is strict and leap dates round trip without JavaScript normalization", () => {
  assert.equal(localDateTimeToUtc("2028-02-29", "08:30", "America/Chicago").toISOString(), "2028-02-29T14:30:00.000Z");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-1-09", "not a date"]) {
    assert.throws(() => localDateTimeToUtc(date, "08:00", "America/Chicago"), errorCode("INVALID_DATE", 400));
  }
  for (const time of ["8:00", "24:00", "08:60", "12:30:00", "-1:00"]) {
    assert.throws(() => localDateTimeToUtc(MONDAY, time, "America/Chicago"), errorCode("INVALID_TIME", 400));
  }
  assert.throws(() => localDateTimeToUtc(MONDAY, "08:00", "invalid/zone"), errorCode("INVALID_TIMEZONE", 400));
});

test("timezone conversion uses local shop dates and handles fractional offsets", () => {
  assert.equal(dateInZone(new Date("2026-11-09T03:00:00Z"), "America/Chicago"), "2026-11-08");
  assert.equal(localDateTimeToUtc(MONDAY, "08:00", "America/Chicago").toISOString(), "2026-11-09T14:00:00.000Z");
  assert.equal(localDateTimeToUtc(MONDAY, "08:00", "Asia/Kathmandu").toISOString(), "2026-11-09T02:15:00.000Z");
});

test("spring gaps and fall folds are rejected in Chicago and another DST timezone", () => {
  for (const [date, time, timezone] of [
    ["2027-03-14", "02:30", "America/Chicago"],
    ["2026-11-01", "01:30", "America/Chicago"],
    ["2027-03-28", "02:30", "Europe/Berlin"],
    ["2026-10-25", "02:30", "Europe/Berlin"],
    ["2026-10-04", "02:15", "Australia/Lord_Howe"],
    ["2027-04-04", "01:45", "Australia/Lord_Howe"],
  ]) assert.throws(() => localDateTimeToUtc(date, time, timezone), errorCode("LOCAL_TIME_UNAVAILABLE", 400));
  assert.equal(localDateTimeToUtc("2027-03-14", "03:00", "America/Chicago").toISOString(), "2027-03-14T08:00:00.000Z");
  assert.equal(localDateTimeToUtc("2026-11-01", "02:00", "America/Chicago").toISOString(), "2026-11-01T08:00:00.000Z");
});

test("candidate snapshots canonical and legacy service durations with conservative approval flags", () => {
  const settings = defaultSettings();
  const candidate = buildCandidate(settings, "Oil Change", MONDAY, "08:00", NOW);
  assert.equal(candidate.startAt.toISOString(), "2026-11-09T14:00:00.000Z");
  assert.equal(candidate.endAt.toISOString(), "2026-11-09T15:00:00.000Z");
  assert.equal(candidate.occupiedUntil.toISOString(), "2026-11-09T15:15:00.000Z");
  assert.equal(candidate.requiresApproval, true);
  assert.equal(buildCandidate(settings, "Wiper Blade Replacement", MONDAY, "08:00", NOW).requiresApproval, false);
  assert.equal(candidate.timezone, "America/Chicago");
  const legacy = buildCandidate(settings, "Air Filter Change", MONDAY, "08:00", NOW);
  assert.equal(legacy.durationMinutes, 30);
  const provisional = buildCandidate(settings, "Tire Rotation", MONDAY, "08:00", NOW);
  assert.equal(provisional.requiresApproval, true);
  assert.equal(provisional.provisional, true);
  assert.equal(buildCandidate(settings, "Brake Repairs", MONDAY, "08:00", NOW).requiresApproval, true);
  assert.throws(() => buildCandidate(settings, "Invented Repair", MONDAY, "08:00", NOW), errorCode("INVALID_SERVICE", 400));
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:15", NOW), errorCode("INVALID_TIME_INCREMENT", 400));
});

test("duration and buffer fit inside opening hours and avoid the full lunch interval", () => {
  const settings = defaultSettings();
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", MONDAY, "10:30", NOW));
  for (const time of ["11:00", "11:30", "12:00", "12:30"]) {
    assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, time, NOW), errorCode("SHOP_BREAK", 409));
  }
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", MONDAY, "13:00", NOW));
  for (const time of ["07:30", "16:00", "16:30", "17:00"]) {
    assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, time, NOW), errorCode("OUTSIDE_HOURS", 409));
  }
  const noBuffer = mergeSettings(settings, { bufferMinutes: 0 });
  assert.doesNotThrow(() => buildCandidate(noBuffer, "Oil Change", MONDAY, "11:00", NOW));
  assert.doesNotThrow(() => buildCandidate(noBuffer, "Oil Change", MONDAY, "16:00", NOW));
});

test("weekends, holidays, and manual blocks are enforced independently of approval", () => {
  const settings = mergeSettings(defaultSettings(), {
    closedDates: ["2026-11-10"],
    blockedPeriods: [{ id: "private", startAt: "2026-11-09T15:00:00Z", endAt: "2026-11-09T16:00:00Z", reason: "Private information" }],
  });
  assert.throws(() => buildCandidate(settings, "Oil Change", "2026-11-08", "08:00", NOW), errorCode("CLOSED_DAY", 409));
  assert.throws(() => buildCandidate(settings, "Oil Change", "2026-11-10", "08:00", NOW), errorCode("CLOSED_DATE", 409));
  // The appointment itself ends at the block start, but its buffer overlaps.
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", NOW), errorCode("BLOCKED_PERIOD", 409));
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", MONDAY, "10:00", NOW));
  assert.throws(() => buildCandidate(settings, "Oil Change", "2026-11-10", "08:00", NOW, { approval: true }), errorCode("CLOSED_DATE", 409));
});

test("minimum notice is an exact duration and the horizon uses inclusive local dates", () => {
  const settings = defaultSettings();
  const exact = new Date("2026-11-08T14:00:00Z");
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", exact));
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", new Date(exact.getTime() + 1)), errorCode("MINIMUM_NOTICE", 409));
  const localSunday = new Date("2026-11-09T03:00:00Z");
  const twoDays = mergeSettings(settings, { bookingHorizonDays: 2 });
  assert.doesNotThrow(() => buildCandidate(twoDays, "Oil Change", "2026-11-10", "13:00", localSunday));
  assert.throws(() => buildCandidate(twoDays, "Oil Change", "2026-11-11", "13:00", localSunday), errorCode("BOOKING_HORIZON", 409));
});

test("approval allows already held times inside notice and beyond a changed horizon, but never past starts", () => {
  const settings = mergeSettings(defaultSettings(), { bookingHorizonDays: 1 });
  const nearVisit = new Date("2026-11-09T13:50:00Z");
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", nearVisit, { approval: true }));
  assert.doesNotThrow(() => buildCandidate(settings, "Oil Change", "2026-11-12", "08:00", nearVisit, { approval: true }));
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", new Date("2026-11-09T14:00:00Z"), { approval: true }), errorCode("PAST_APPOINTMENT", 409));
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", nearVisit, { approval: true, durationMinutes: -1 }), (error) => error.status === 400);
});

test("manual approval preserves legacy minutes while new bookings enforce configured increments", () => {
  const settings = defaultSettings();
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:15", NOW), errorCode("INVALID_TIME_INCREMENT", 400));
  const candidate = buildCandidate(settings, "Oil Change", MONDAY, "08:15", NOW, { approval: true });
  assert.equal(candidate.time, "08:15");
  assert.equal(candidate.startAt.toISOString(), "2026-11-09T14:15:00.000Z");
  assert.equal(candidate.endAt.toISOString(), "2026-11-09T15:15:00.000Z");
  assert.equal(candidate.occupiedUntil.toISOString(), "2026-11-09T15:30:00.000Z");
  assert.equal(canFit(candidate, [occupancy("2026-11-09T15:00Z", "2026-11-09T16:00Z")], 1), false);
  assert.equal(canFit(candidate, [occupancy("2026-11-09T15:30Z", "2026-11-09T16:00Z")], 1), true);
  const hourly = mergeSettings(settings, { startIncrementMinutes: 60 });
  assert.throws(() => buildCandidate(hourly, "Oil Change", MONDAY, "08:30", NOW), errorCode("INVALID_TIME_INCREMENT", 400));
  assert.doesNotThrow(() => buildCandidate(hourly, "Oil Change", MONDAY, "08:30", NOW, { approval: true }));
});

test("legacy minute approval still enforces dates, times, shop hours, breaks, blocks, and future starts", () => {
  const settings = mergeSettings(defaultSettings(), {
    closedDates: ["2026-11-10"],
    blockedPeriods: [{ id: "staff", startAt: "2026-11-09T16:00:00Z", endAt: "2026-11-09T17:00:00Z" }],
  });
  for (const [date, time, code, status] of [
    ["2026-02-30", "08:15", "INVALID_DATE", 400],
    [MONDAY, "08:75", "INVALID_TIME", 400],
    ["2026-11-08", "08:15", "CLOSED_DAY", 409],
    ["2026-11-10", "08:15", "CLOSED_DATE", 409],
    [MONDAY, "07:45", "OUTSIDE_HOURS", 409],
    [MONDAY, "15:55", "OUTSIDE_HOURS", 409],
    [MONDAY, "11:15", "SHOP_BREAK", 409],
    [MONDAY, "12:15", "SHOP_BREAK", 409],
    [MONDAY, "09:15", "BLOCKED_PERIOD", 409],
  ]) {
    assert.throws(() => buildCandidate(settings, "Oil Change", date, time, NOW, { approval: true }), errorCode(code, status), `${date} ${time}`);
  }
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:15", new Date("2026-11-09T14:15:00Z"), { approval: true }), errorCode("PAST_APPOINTMENT", 409));
});

test("availability returns only public slot fields and excludes occupied durations plus buffers", () => {
  const settings = defaultSettings();
  const occupied = { ...buildCandidate(settings, "Engine Diagnostics", MONDAY, "08:00", NOW), customerEmail: "private@example.com" };
  const slots = calculateSlots(settings, "Oil Change", MONDAY, [occupied], NOW);
  assert.equal(slots[0].time, "10:00");
  assert.ok(!slots.some(({ time }) => ["08:00", "08:30", "09:00", "09:30", "11:00", "12:00", "16:00"].includes(time)));
  assert.deepEqual(Object.keys(slots[0]).sort(), ["durationMinutes", "endAt", "startAt", "time"]);
  assert.ok(!JSON.stringify(slots).includes("private"));
  assert.deepEqual(calculateSlots(settings, "Oil Change", "2026-11-08", [], NOW), []);
  assert.deepEqual(calculateSlots(settings, "Oil Change", "2026-12-01", [], NOW), []);
  assert.throws(() => calculateSlots(settings, "Oil Change", "2026-02-30", [], NOW), errorCode("INVALID_DATE", 400));
  assert.throws(() => calculateSlots(settings, "Unknown", MONDAY, [], NOW), errorCode("INVALID_SERVICE", 400));
});

test("interval capacity counts simultaneous overlap, not all appointments that intersect a long visit", () => {
  const candidate = occupancy("2026-11-09T14:00Z", "2026-11-09T16:00Z");
  const consecutive = [
    occupancy("2026-11-09T14:00Z", "2026-11-09T15:00Z"),
    occupancy("2026-11-09T15:00Z", "2026-11-09T16:00Z"),
  ];
  assert.equal(canFit(candidate, consecutive, 2), true);
  assert.equal(canFit(candidate, consecutive, 1), false);
  assert.equal(canFit(candidate, [...consecutive, occupancy("2026-11-09T14:30Z", "2026-11-09T15:30Z")], 2), false);
  assert.equal(canFit(candidate, [occupancy("2026-11-09T12:00Z", "2026-11-09T14:00Z"), occupancy("2026-11-09T16:00Z", "2026-11-09T17:00Z")], 1), true);
  assert.equal(canFit(candidate, [occupancy("2026-11-09T13:00Z", "2026-11-09T14:00Z", 15)], 1), false);
  assert.equal(canFit({ ...candidate, bufferMinutes: 15 }, [occupancy("2026-11-09T16:00Z", "2026-11-09T17:00Z")], 1), false);
  assert.throws(() => canFit(candidate, [occupancy("invalid", "2026-11-09T17:00Z")], 1), (error) => error.status === 400);
});

test("availability uses configured capacity with differing service durations", () => {
  const settings = mergeSettings(defaultSettings(), { capacity: 2 });
  const long = buildCandidate(settings, "Engine Diagnostics", MONDAY, "08:00", NOW);
  assert.ok(calculateSlots(settings, "Oil Change", MONDAY, [long], NOW).some(({ time }) => time === "08:00"));
  const short = buildCandidate(settings, "Cabin Air Filter Replacement", MONDAY, "09:00", NOW);
  assert.ok(!calculateSlots(settings, "Oil Change", MONDAY, [long, short], NOW).some(({ time }) => time === "08:30"));
});

test("availability handles DST days by elapsed duration and skips unresolvable starts", () => {
  const settings = mergeSettings(defaultSettings(), {
    weeklyHours: { 0: [{ start: "00:00", end: "05:00" }] }, breaks: [], minimumNoticeHours: 0,
  });
  const spring = calculateSlots(settings, "Engine Diagnostics", "2027-03-14", [], new Date("2027-03-13T12:00:00Z"));
  assert.ok(!spring.some(({ time }) => time.startsWith("02:")));
  const beforeGap = spring.find(({ time }) => time === "01:30");
  assert.equal(beforeGap.startAt, "2027-03-14T07:30:00.000Z");
  assert.equal(beforeGap.endAt, "2027-03-14T09:00:00.000Z");
  const fall = calculateSlots(settings, "Oil Change", "2026-11-01", [], new Date("2026-10-31T12:00:00Z"));
  assert.ok(!fall.some(({ time }) => time.startsWith("01:")));
  assert.equal(fall.find(({ time }) => time === "02:00").startAt, "2026-11-01T08:00:00.000Z");
});

test("split shifts and midnight closing remain local-date based", () => {
  const settings = mergeSettings(defaultSettings(), {
    weeklyHours: { 1: [{ start: "08:00", end: "10:00" }, { start: "22:00", end: "24:00" }] }, breaks: [],
  });
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "09:00", NOW), errorCode("OUTSIDE_HOURS", 409));
  const candidate = buildCandidate(settings, "Oil Change", MONDAY, "22:30", NOW);
  assert.equal(candidate.occupiedUntil.toISOString(), "2026-11-10T05:45:00.000Z");
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "23:00", NOW), errorCode("OUTSIDE_HOURS", 409));
});

test("legacy appointments resolve the historical service alias and preserve scheduling snapshots", () => {
  const settings = defaultSettings();
  const old = { _id: "legacy", service: "Air Filter Change", date: MONDAY, time: "08:00", status: "confirmed" };
  const interval = legacyOccurrence(old, settings, NOW);
  assert.equal(interval.endAt.toISOString(), "2026-11-09T14:30:00.000Z");
  assert.equal(interval.occupiedUntil.toISOString(), "2026-11-09T14:45:00.000Z");
  const snapshot = legacyOccurrence({ ...old, scheduling: {
    startAt: "2026-11-09T16:00:00Z", endAt: "2026-11-09T17:30:00Z", durationMinutes: 90, bufferMinutes: 0, timezone: "America/New_York",
  } }, settings, NOW);
  assert.equal(snapshot.startAt.toISOString(), "2026-11-09T16:00:00.000Z");
  assert.equal(snapshot.occupiedUntil.toISOString(), "2026-11-09T17:30:00.000Z");
  assert.equal(legacyOccurrence({ ...old, service: "Historical repair" }, settings, NOW).endAt.toISOString(), "2026-11-09T16:00:00.000Z");
});

test("pending holds expire without deleting requests, confirmed records never expire, and declined records release", () => {
  const settings = defaultSettings();
  const old = { service: "Oil Change", date: MONDAY, time: "08:00", status: "pending", createdAt: "2026-11-06T00:00:00Z" };
  assert.equal(legacyOccurrence(old, settings, NOW), null);
  assert.ok(legacyOccurrence({ ...old, createdAt: "2026-11-06T00:00:00.001Z" }, settings, NOW));
  assert.ok(legacyOccurrence({ ...old, status: "confirmed" }, settings, NOW));
  assert.equal(legacyOccurrence({ ...old, status: "declined" }, settings, NOW), null);
  assert.ok(legacyOccurrence({ ...old, createdAt: undefined }, settings, NOW));
  assert.ok(legacyOccurrence({ ...old, createdAt: "corrupt" }, settings, NOW));
  assert.ok(legacyOccurrence({ ...old, scheduling: { holdExpiresAt: "2026-11-08T00:00:00Z" } }, settings, NOW));
  assert.equal(legacyOccurrence({ ...old, scheduling: { holdExpiresAt: NOW } }, settings, NOW), null);
  assert.ok(legacyOccurrence({ ...old, scheduling: { holdExpiresAt: "corrupt" } }, settings, NOW));
  assert.equal(old.status, "pending");
});

test("active records with unusable scheduling information fail closed for mechanic review", () => {
  const settings = defaultSettings();
  const old = { service: "Oil Change", date: MONDAY, time: "08:00", status: "confirmed" };
  for (const patch of [
    { date: "2026-02-30" }, { time: undefined },
    { date: "2026-11-01", time: "01:30" },
    { scheduling: { startAt: "invalid" } },
    { scheduling: { startAt: "2026-11-09T16:00Z", endAt: "2026-11-09T15:00Z" } },
    { scheduling: { durationMinutes: -5 } }, { scheduling: { bufferMinutes: -1 } },
  ]) assert.throws(() => legacyOccurrence({ ...old, ...patch }, settings, NOW), errorCode("LEGACY_SCHEDULE_INVALID", 409));
  assert.equal(legacyOccurrence({ ...old, status: "declined", time: undefined }, settings, NOW), null);
});

test("approval can preserve a booked buffer even after the configured default changes", () => {
  const settings = defaultSettings();
  // This request was held with no buffer before a later settings edit.
  assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "16:00", NOW, { approval: true }), errorCode("OUTSIDE_HOURS", 409));
  const candidate = buildCandidate(settings, "Oil Change", MONDAY, "16:00", NOW, { approval: true, bufferMinutes: 0 });
  assert.equal(candidate.bufferMinutes, 0);
  assert.equal(candidate.occupiedUntil.toISOString(), "2026-11-09T23:00:00.000Z");
  const shorterDefault = mergeSettings(settings, { bufferMinutes: 0 });
  const preserved = buildCandidate(shorterDefault, "Oil Change", MONDAY, "08:00", NOW, { approval: true, bufferMinutes: 30 });
  assert.equal(preserved.occupiedUntil.toISOString(), "2026-11-09T15:30:00.000Z");
  for (const bufferMinutes of [-1, 121, 1.5, null, "15"]) {
    assert.throws(() => buildCandidate(settings, "Oil Change", MONDAY, "08:00", NOW, { approval: true, bufferMinutes }), (error) => error.status === 400);
  }
});

test("partial legacy snapshots preserve occupiedUntil and infer a missing buffer independently of current defaults", () => {
  const old = {
    service: "Oil Change", date: MONDAY, time: "08:00", status: "confirmed",
    scheduling: { startAt: "2026-11-09T14:00:00Z", endAt: "2026-11-09T15:00:00Z", occupiedUntil: "2026-11-09T15:30:00Z" },
  };
  const shorterDefault = mergeSettings(defaultSettings(), { bufferMinutes: 0 });
  const interval = legacyOccurrence(old, shorterDefault, NOW);
  assert.equal(interval.bufferMinutes, 30);
  assert.equal(interval.occupiedUntil.toISOString(), "2026-11-09T15:30:00.000Z");
  const noBuffer = legacyOccurrence({ ...old, scheduling: { ...old.scheduling, occupiedUntil: old.scheduling.endAt } }, defaultSettings(), NOW);
  assert.equal(noBuffer.bufferMinutes, 0);
  assert.equal(noBuffer.occupiedUntil.toISOString(), "2026-11-09T15:00:00.000Z");
  const mismatched = legacyOccurrence({ ...old, scheduling: { ...old.scheduling, bufferMinutes: 0 } }, shorterDefault, NOW);
  assert.equal(mismatched.occupiedUntil.toISOString(), "2026-11-09T15:30:00.000Z");
  for (const occupiedUntil of ["invalid", "2026-11-09T14:30:00Z"]) {
    assert.throws(() => legacyOccurrence({ ...old, scheduling: { ...old.scheduling, occupiedUntil } }, defaultSettings(), NOW), errorCode("LEGACY_SCHEDULE_INVALID", 409));
  }
});

test("changing business hours or capacity does not inherit stale verification", () => {
  const verified = mergeSettings(defaultSettings(), { automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  assert.equal(mergeSettings(verified, { weeklyHours: { 1: [{ start: "09:00", end: "17:00" }] } }).businessHoursVerified, false);
  assert.equal(mergeSettings(verified, { capacity: 2 }).capacityVerified, false);
  assert.equal(mergeSettings(verified, { capacity: 2, capacityVerified: true }).capacityVerified, true);
  assert.equal(mergeSettings(verified, { bookingHorizonDays: 10 }).businessHoursVerified, true);
});
