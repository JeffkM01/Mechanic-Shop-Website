import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, validateSettings } from "../../server/schedulingRules.js";
import { SERVICES, requiresMechanicApproval } from "../../shared/services.js";
import { rebaseSettings, settingsChanges, settingsPatch, validateSettingsDraft } from "./schedulingSettings.js";

const clone = value => structuredClone(value);
const suspension = {
  name: "Suspension Repair", category: "repairs", icon: "wrench",
  description: "Inspection and repair of suspension concerns after mechanic review.",
  active: true, provisional: false, appointmentOnly: false, legacyNames: [],
};

function addService(settings, service = suspension, durationMinutes = 120) {
  settings.serviceCatalog.push(clone(service));
  settings.serviceRules[service.name] = { durationMinutes, requiresApproval: true };
  return settings;
}

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
  draft.serviceRules["Wiper Blade Replacement"].requiresApproval = true;
  const changes = settingsChanges(saved, draft);
  assert.deepEqual(changes.map(change => change.path), ["closedDates", "weeklyHours.0", "serviceRules.Wiper Blade Replacement.requiresApproval"]);
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

test("only confirmed wiper replacement may disable mechanic approval in a settings draft", () => {
  for (const service of SERVICES) {
    const settings = defaultSettings();
    settings.serviceRules[service.name].requiresApproval = false;
    if (requiresMechanicApproval(service)) {
      assert.match(validateSettingsDraft(settings), /always requires mechanic approval/);
      assert.throws(() => validateSettings(settings));
    } else {
      assert.equal(validateSettingsDraft(settings), "");
      assert.doesNotThrow(() => validateSettings(settings));
    }
    settings.serviceRules[service.name].durationMinutes = 721;
    assert.notEqual(validateSettingsDraft(settings), "");
  }
});

test("new service drafts produce an explicit catalog review and only the new scheduling rule", () => {
  const saved = defaultSettings();
  const draft = addService(clone(saved));
  const patch = settingsPatch(saved, draft);
  assert.deepEqual(Object.keys(patch), ["serviceCatalog", "serviceRules"]);
  assert.deepEqual(patch.serviceCatalog, draft.serviceCatalog);
  assert.deepEqual(patch.serviceRules, { "Suspension Repair": { durationMinutes: 120, requiresApproval: true } });
  assert.equal(validateSettingsDraft(draft, saved), "");
  assert.doesNotThrow(() => validateSettings(draft));
  const review = settingsChanges(saved, draft);
  assert.deepEqual(review.map(change => change.path), [
    "serviceCatalog.Suspension Repair", "serviceRules.Suspension Repair.durationMinutes", "serviceRules.Suspension Repair.requiresApproval",
  ]);
  assert.equal(review[0].beforeDisplay, "Not set");
  assert.match(review[0].afterDisplay, /Active · Repairs & Diagnostics.*suspension concerns/);
  assert.equal(review[1].afterDisplay, "120 minutes");
  assert.equal(review[2].afterDisplay, "Required");
  assert.equal(saved.serviceCatalog.some(service => service.name === suspension.name), false);
  assert.equal(patch.automaticBookingEnabled, undefined);
  assert.equal(draft.automaticBookingEnabled, false);
});

test("deactivation and reactivation retain service rules and aliases in the reviewed draft", () => {
  const saved = defaultSettings();
  const draft = clone(saved);
  draft.serviceCatalog.find(service => service.name === "Engine Air Filter Replacement").active = false;
  const patch = settingsPatch(saved, draft);
  assert.deepEqual(Object.keys(patch), ["serviceCatalog"]);
  const inactive = patch.serviceCatalog.find(service => service.name === "Engine Air Filter Replacement");
  assert.deepEqual(inactive.legacyNames, ["Air Filter Change"]);
  assert.equal(inactive.active, false);
  assert.deepEqual(draft.serviceRules, saved.serviceRules);
  const review = settingsChanges(saved, draft);
  assert.equal(review.length, 1);
  assert.match(review[0].beforeDisplay, /^Active/);
  assert.match(review[0].afterDisplay, /^Inactive/);
  assert.equal(validateSettingsDraft(draft, saved), "");
  const reactivated = clone(draft);
  reactivated.serviceCatalog.find(service => service.name === inactive.name).active = true;
  assert.match(settingsChanges(draft, reactivated)[0].afterDisplay, /^Active/);
  assert.deepEqual(settingsPatch(saved, reactivated), {});
});

test("catalog rebase keeps unrelated latest additions and rules while applying a local deactivation", () => {
  const original = defaultSettings();
  const draft = clone(original);
  draft.serviceCatalog.find(service => service.name === "Oil Change").active = false;
  const latest = addService(clone(original));
  latest.serviceRules["Engine Diagnostics"].durationMinutes = 105;
  latest.closedDates.push("2030-01-15");
  const result = rebaseSettings(original, draft, latest);
  assert.equal(result.draft.serviceCatalog.find(service => service.name === "Oil Change").active, false);
  assert.deepEqual(result.draft.serviceCatalog.find(service => service.name === suspension.name), suspension);
  assert.deepEqual(result.draft.serviceRules[suspension.name], latest.serviceRules[suspension.name]);
  assert.equal(result.draft.serviceRules["Engine Diagnostics"].durationMinutes, 105);
  assert.deepEqual(result.draft.closedDates, ["2030-01-15"]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(validateSettingsDraft(result.draft, latest), "");
  assert.deepEqual(Object.keys(settingsPatch(latest, result.draft)), ["serviceCatalog"]);
  assert.equal(latest.serviceCatalog.find(service => service.name === "Oil Change").active, true);
});

test("catalog rebase preserves independently added services and their separate manual estimates", () => {
  const original = defaultSettings();
  const draft = addService(clone(original));
  const battery = { ...suspension, name: "Battery Inspection", category: "maintenance", description: "Inspect the battery and discuss next steps with the customer." };
  const latest = addService(clone(original), battery, 30);
  const result = rebaseSettings(original, draft, latest);
  assert.deepEqual(result.draft.serviceCatalog.slice(-2).map(service => service.name), [battery.name, suspension.name]);
  assert.deepEqual(result.draft.serviceRules[battery.name], { durationMinutes: 30, requiresApproval: true });
  assert.deepEqual(result.draft.serviceRules[suspension.name], { durationMinutes: 120, requiresApproval: true });
  assert.deepEqual(result.conflicts, []);
  assert.equal(validateSettingsDraft(result.draft, latest), "");
  assert.deepEqual(settingsPatch(latest, result.draft).serviceRules, { [suspension.name]: { durationMinutes: 120, requiresApproval: true } });
});

test("competing edits to one catalog entry require review and retain the local proposal", () => {
  const original = defaultSettings();
  const draft = clone(original);
  const latest = clone(original);
  draft.serviceCatalog.find(service => service.name === "Oil Change").description = "Local proposed description for oil and filter care.";
  latest.serviceCatalog.find(service => service.name === "Oil Change").description = "Another mechanic's saved description for oil care.";
  const result = rebaseSettings(original, draft, latest);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, "serviceCatalog.Oil Change");
  assert.match(result.conflicts[0].latestDisplay, /Another mechanic's saved description/);
  assert.match(result.conflicts[0].afterDisplay, /Local proposed description/);
  assert.equal(result.draft.serviceCatalog[0].description, draft.serviceCatalog[0].description);
  assert.equal(latest.serviceCatalog[0].description, "Another mechanic's saved description for oil care.");
});

test("catalog draft validation rejects destructive identities, alias collisions and unsafe names", () => {
  const saved = defaultSettings();
  const removed = clone(saved);
  removed.serviceCatalog.shift();
  delete removed.serviceRules["Oil Change"];
  assert.match(validateSettingsDraft(removed, saved), /Keep existing service names/);
  const renamed = clone(saved);
  renamed.serviceCatalog[0].name = "Renamed Oil Change";
  assert.match(validateSettingsDraft(renamed, saved), /Keep existing service names/);
  const lostAlias = clone(saved);
  lostAlias.serviceCatalog.find(service => service.legacyNames.length).legacyNames = [];
  assert.match(validateSettingsDraft(lostAlias, saved), /historical aliases/);
  for (const name of ["oil change", "Air Filter Change", "toString", "constructor", "Service.Path", "$operator"]) {
    const unsafe = addService(clone(saved), { ...suspension, name });
    assert.notEqual(validateSettingsDraft(unsafe, saved), "", name);
  }
});

test("custom services remain manual and require complete bounded scheduling rules", () => {
  const saved = defaultSettings();
  const draft = addService(clone(saved));
  for (const name of ["Oil Change", "Cabin Air Filter Replacement", suspension.name]) {
    const bypass = clone(draft);
    bypass.serviceRules[name].requiresApproval = false;
    assert.match(validateSettingsDraft(bypass, saved), /always requires mechanic approval/, name);
    assert.throws(() => validateSettings(bypass));
  }
  for (const patch of [{ durationMinutes: 4 }, { durationMinutes: 721 }, { requiresApproval: "true" }]) {
    const malformed = clone(draft);
    malformed.serviceRules[suspension.name] = { ...malformed.serviceRules[suspension.name], ...patch };
    assert.notEqual(validateSettingsDraft(malformed, saved), "");
  }
  delete draft.serviceRules[suspension.name];
  assert.match(validateSettingsDraft(draft, saved), /booking estimate/);
});

test("legacy drafts can load the default catalog without manufacturing catalog edits", () => {
  const legacy = defaultSettings();
  delete legacy.serviceCatalog;
  assert.equal(validateSettingsDraft(legacy), "");
  const normalized = defaultSettings();
  assert.deepEqual(settingsPatch(legacy, normalized), {});
  assert.deepEqual(settingsChanges(legacy, normalized), []);
});

test("server-normalized object key order does not manufacture catalog edits or revision conflicts", () => {
  const original = defaultSettings();
  const reordered = clone(original);
  reordered.serviceCatalog = original.serviceCatalog.map(service => Object.fromEntries(Object.entries(service).reverse()));
  reordered.serviceRules = Object.fromEntries(Object.entries(original.serviceRules).reverse().map(([name, rule]) => [name, Object.fromEntries(Object.entries(rule).reverse())]));
  reordered.weeklyHours[1] = original.weeklyHours[1].map(interval => Object.fromEntries(Object.entries(interval).reverse()));
  assert.deepEqual(settingsChanges(original, reordered), []);
  assert.deepEqual(settingsPatch(original, reordered), {});

  const draft = clone(original);
  draft.minimumNoticeHours = 48;
  const latest = clone(reordered);
  latest.capacity = 2;
  const result = rebaseSettings(original, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.draft.capacity, 2);
  assert.equal(result.draft.minimumNoticeHours, 48);
  assert.deepEqual(settingsPatch(latest, result.draft), { minimumNoticeHours: 48 });
});
