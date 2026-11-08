import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, validateSettings } from "../../server/schedulingRules.js";
import { SERVICES } from "../../shared/services.js";
import { rebaseSettings, settingsChanges, settingsPatch, validateSettingsDraft } from "./schedulingSettings.js";

const clone = value => structuredClone(value);

function edited(patch) {
  return { ...defaultSettings(), ...patch };
}

test("settings patches contain only explicit edited leaves and never block or legacy state", () => {
  const saved = defaultSettings();
  const draft = clone(saved);
  draft.weeklyHours[1][0].start = "08:15";
  draft.serviceRules["Oil Change"].durationMinutes = 75;
  draft.capacity = 2;
  draft.blockedPeriods.push({ id: "do-not-patch", startAt: "2030-01-01T08:00Z", endAt: "2030-01-01T09:00Z" });
  draft.legacyUnknownDurationMinutes = 240;
  assert.deepEqual(settingsPatch(saved, draft), {
    capacity: 2,
    weeklyHours: { 1: [{ start: "08:15", end: "17:00" }] },
    serviceRules: { "Oil Change": { durationMinutes: 75 } },
  });
  assert.deepEqual(settingsPatch(saved, clone(saved)), {});
  assert.equal(saved.weeklyHours[1][0].start, "08:00");
});

test("change summaries use readable U.S. dates, AM/PM intervals, units, and approval labels", () => {
  const saved = defaultSettings();
  const draft = clone(saved);
  draft.weeklyHours[0] = [{ start: "08:15", end: "24:00" }];
  draft.closedDates = ["2028-02-29"];
  draft.serviceRules["Oil Change"].requiresApproval = true;
  const changes = settingsChanges(saved, draft);
  assert.deepEqual(changes.map(change => change.path), ["closedDates", "weeklyHours.0", "serviceRules.Oil Change.requiresApproval"]);
  const sunday = changes.find(change => change.path === "weeklyHours.0");
  assert.equal(sunday.beforeDisplay, "Closed");
  assert.equal(sunday.afterDisplay, "8:15 AM–12:00 AM (next day)");
  assert.equal(changes[0].afterDisplay, "02/29/2028");
  assert.equal(changes[2].afterDisplay, "Required");
  sunday.after[0].start = "09:00";
  assert.equal(draft.weeklyHours[0][0].start, "08:15", "summary values are independent snapshots");
});

test("three-way review keeps latest unrelated edits, blocks, and nested service changes", () => {
  const original = defaultSettings();
  const draft = clone(original);
  const latest = clone(original);
  draft.minimumNoticeHours = 48;
  draft.serviceRules["Oil Change"].durationMinutes = 75;
  latest.bookingHorizonDays = 30;
  latest.serviceRules["Engine Diagnostics"].durationMinutes = 120;
  latest.blockedPeriods.push({ id: "latest-only", startAt: "2030-01-01T08:00Z", endAt: "2030-01-01T09:00Z" });
  const result = rebaseSettings(original, draft, latest);
  assert.equal(result.draft.minimumNoticeHours, 48);
  assert.equal(result.draft.bookingHorizonDays, 30);
  assert.equal(result.draft.serviceRules["Oil Change"].durationMinutes, 75);
  assert.equal(result.draft.serviceRules["Engine Diagnostics"].durationMinutes, 120);
  assert.deepEqual(result.draft.blockedPeriods, latest.blockedPeriods);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.verificationReset, []);
  assert.equal(original.minimumNoticeHours, 24);
  assert.equal(draft.bookingHorizonDays, 14);
  assert.equal(latest.serviceRules["Oil Change"].durationMinutes, 60);
});

test("three-way review reports only overlapping edits and retains local edits for explicit review", () => {
  const original = defaultSettings();
  const draft = clone(original);
  const latest = clone(original);
  draft.bufferMinutes = 30;
  latest.bufferMinutes = 45;
  draft.serviceRules["Oil Change"].durationMinutes = 90;
  latest.serviceRules["Oil Change"].durationMinutes = 90;
  const result = rebaseSettings(original, draft, latest);
  assert.equal(result.draft.bufferMinutes, 30);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    path: "bufferMinutes", label: "Appointment buffer", before: 15, after: 30,
    beforeDisplay: "15 minutes", afterDisplay: "30 minutes", latest: 45, latestDisplay: "45 minutes",
  });
});

test("rebase clears verification after hours or capacity drift and requires new acknowledgment", () => {
  const original = edited({ businessHoursVerified: true, capacityVerified: true });
  const draft = clone(original);
  const latest = clone(original);
  draft.weeklyHours[1] = [{ start: "09:00", end: "17:00" }];
  latest.capacity = 2;
  latest.capacityVerified = true;
  const result = rebaseSettings(original, draft, latest);
  assert.equal(result.draft.businessHoursVerified, false);
  assert.equal(result.draft.capacityVerified, false);
  assert.deepEqual(result.verificationReset, ["businessHoursVerified", "capacityVerified"]);
  assert.equal(result.draft.capacity, 2);
  assert.equal(result.draft.automaticBookingEnabled, false);
  const unrelated = rebaseSettings(original, edited({ ...original, bookingHorizonDays: 30 }), { ...original, bufferMinutes: 30 });
  assert.equal(unrelated.draft.businessHoursVerified, true);
  assert.equal(unrelated.draft.capacityVerified, true);
});

test("saved defaults and all valid policy limits agree with authoritative backend validation", () => {
  const defaults = defaultSettings();
  assert.equal(validateSettingsDraft(defaults), "");
  for (const [key, values] of Object.entries({
    capacity: [1, 20], maxAutomaticPerDay: [0, 100], minimumNoticeHours: [0, 720],
    bookingHorizonDays: [1, 365], startIncrementMinutes: [5, 120], bufferMinutes: [0, 120],
    pendingHoldHours: [1, 168], legacyUnknownDurationMinutes: [5, 720],
  })) {
    for (const value of values) {
      const settings = edited({ [key]: value });
      assert.equal(validateSettingsDraft(settings), "", `${key}=${value}`);
      assert.doesNotThrow(() => validateSettings(settings));
    }
  }
  const sameDayMidnight = clone(defaults);
  sameDayMidnight.weeklyHours[1] = [{ start: "08:00", end: "24:00" }];
  assert.equal(validateSettingsDraft(sameDayMidnight), "");
  assert.doesNotThrow(() => validateSettings(sameDayMidnight));
});

test("invalid numbers, increments, timezones, and missing settings are rejected before save", () => {
  for (const patch of [
    { capacity: 0 }, { capacity: 21 }, { capacity: "2" }, { capacity: 1.5 },
    { maxAutomaticPerDay: 101 }, { minimumNoticeHours: -1 }, { bookingHorizonDays: 0 },
    { startIncrementMinutes: 7 }, { startIncrementMinutes: 121 }, { bufferMinutes: -1 },
    { pendingHoldHours: 169 }, { legacyUnknownDurationMinutes: 721 }, { timezone: "Not/AZone" },
    { timezone: "" }, { automaticBookingEnabled: 1 }, { businessHoursVerified: "true" },
  ]) {
    assert.notEqual(validateSettingsDraft(edited(patch)), "", JSON.stringify(patch));
    assert.throws(() => validateSettings(edited(patch)));
  }
  const missing = defaultSettings();
  delete missing.capacity;
  assert.match(validateSettingsDraft(missing), /reload/i);
  assert.match(validateSettingsDraft({ ...defaultSettings(), unknownSetting: true }), /reload/i);
});

test("weekly hours and recurring breaks reject inverted or overlapping intervals and allow split days", () => {
  const split = defaultSettings();
  split.weeklyHours[1] = [{ start: "13:00", end: "17:00" }, { start: "08:00", end: "12:00" }];
  assert.equal(validateSettingsDraft(split), "");
  for (const intervals of [
    [{ start: "17:00", end: "08:00" }], [{ start: "08:00", end: "08:00" }],
    [{ start: "08:00", end: "12:00" }, { start: "11:59", end: "17:00" }],
    [{ start: "24:00", end: "24:00" }], [{ start: "08:00", end: "25:00" }],
  ]) {
    for (const field of ["weeklyHours", "breaks"]) {
      const settings = defaultSettings();
      if (field === "weeklyHours") settings.weeklyHours[1] = intervals;
      else settings.breaks = intervals;
      assert.notEqual(validateSettingsDraft(settings), "", `${field}: ${JSON.stringify(intervals)}`);
      assert.throws(() => validateSettings(settings));
    }
  }
});

test("closures are strict ISO calendar dates with no duplicates, and saved blocks remain validated", () => {
  for (const closedDates of [["2027-02-29"], ["2028-04-31"], ["02/29/2028"], ["2028-02-29", "2028-02-29"]]) {
    const settings = edited({ closedDates });
    assert.notEqual(validateSettingsDraft(settings), "");
    assert.throws(() => validateSettings(settings));
  }
  assert.equal(validateSettingsDraft(edited({ closedDates: ["2028-02-29"] })), "");
  for (const block of [
    { id: "a", startAt: "2030-01-01T08:00:00-06:00", endAt: "2030-01-01T09:00:00Z" },
    { id: "a", startAt: "2030-02-30T08:00Z", endAt: "2030-03-01T09:00Z" },
    { id: "a", startAt: "2030-01-01T09:00Z", endAt: "2030-01-01T08:00Z" },
  ]) assert.notEqual(validateSettingsDraft(edited({ blockedPeriods: [block] })), "");
});

test("all repair-category services require manual approval and provisional rules cannot bypass catalog policy", () => {
  for (const service of SERVICES) {
    const settings = defaultSettings();
    settings.serviceRules[service.name].requiresApproval = false;
    if (service.category === "repairs") {
      assert.match(validateSettingsDraft(settings), /always requires mechanic approval/);
      assert.throws(() => validateSettings(settings));
    } else {
      // Provisional eligibility is a catalog rule enforced by the backend; the
      // stored requiresApproval flag alone cannot make a provisional service automatic.
      assert.equal(validateSettingsDraft(settings), "");
      assert.doesNotThrow(() => validateSettings(settings));
    }
    settings.serviceRules[service.name].durationMinutes = 721;
    assert.notEqual(validateSettingsDraft(settings), "");
  }
});
