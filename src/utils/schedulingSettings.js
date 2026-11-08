import { SERVICES } from "../../shared/services.js";
import { formatBookingDate, formatBookingTime, isBookingDate } from "./bookingDates.js";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fields = {
  timezone: "Shop timezone",
  breaks: "Recurring breaks",
  closedDates: "Closed dates",
  capacity: "Simultaneous appointment capacity",
  maxAutomaticPerDay: "Maximum automatic confirmations per day",
  minimumNoticeHours: "Minimum advance notice",
  bookingHorizonDays: "Booking horizon",
  startIncrementMinutes: "Appointment start increment",
  bufferMinutes: "Appointment buffer",
  pendingHoldHours: "Pending request hold duration",
  automaticBookingEnabled: "Automatic booking",
  businessHoursVerified: "Business hours verification",
  capacityVerified: "Capacity verification",
};
const numericLimits = {
  capacity: [1, 20], maxAutomaticPerDay: [0, 100], minimumNoticeHours: [0, 720],
  bookingHorizonDays: [1, 365], startIncrementMinutes: [5, 120], bufferMinutes: [0, 120],
  pendingHoldHours: [1, 168], legacyUnknownDurationMinutes: [5, 720],
};
const allowedKeys = [...Object.keys(fields), "weeklyHours", "serviceRules", "blockedPeriods", "legacyUnknownDurationMinutes"];
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const copy = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

function leafChanges(saved, draft) {
  const changes = [];
  function add(path, label, before, after) {
    if (!same(before, after)) changes.push({ path, label, before: copy(before), after: copy(after) });
  }
  for (const [key, label] of Object.entries(fields)) add(key, label, saved?.[key], draft?.[key]);
  weekdays.forEach((day, index) => add(`weeklyHours.${index}`, `${day} business hours`, saved?.weeklyHours?.[index], draft?.weeklyHours?.[index]));
  for (const service of SERVICES) {
    for (const key of ["durationMinutes", "requiresApproval"]) {
      add(`serviceRules.${service.name}.${key}`, `${service.name}: ${key === "durationMinutes" ? "booking estimate" : "mechanic approval"}`, saved?.serviceRules?.[service.name]?.[key], draft?.serviceRules?.[service.name]?.[key]);
    }
  }
  return changes;
}

function display(path, value) {
  if (value === undefined || value === null) return "Not set";
  if (path.startsWith("weeklyHours.") || path === "breaks") {
    if (!Array.isArray(value)) return "Invalid intervals";
    return value.length ? value.map(interval => `${formatBookingTime(interval.start) || "Invalid start"}–${formatBookingTime(interval.end) || "Invalid end"}`).join(", ") : path === "breaks" ? "No breaks" : "Closed";
  }
  if (path === "closedDates") return Array.isArray(value) && value.length ? value.map(formatBookingDate).join(", ") : "No closed dates";
  if (typeof value === "boolean") {
    if (path.endsWith("requiresApproval")) {
      const provisional = SERVICES.find(service => service.name === path.split(".")[1])?.provisional;
      return value ? "Required" : provisional ? "Always manual (provisional service)" : "Eligible when verified";
    }
    if (path.endsWith("Verified")) return value ? "Verified" : "Not verified";
    return value ? "Enabled" : "Disabled";
  }
  if (path.endsWith("durationMinutes") || ["startIncrementMinutes", "bufferMinutes"].includes(path)) return `${value} minutes`;
  if (["minimumNoticeHours", "pendingHoldHours"].includes(path)) return `${value} hours`;
  if (path === "bookingHorizonDays") return `${value} days`;
  return String(value);
}

/** Only editable settings are included; dedicated block endpoints own blocks. */
export function settingsPatch(saved, draft) {
  const patch = {};
  for (const change of leafChanges(saved, draft)) {
    const [first, second, third] = change.path.split(".");
    if (first === "weeklyHours") (patch.weeklyHours ||= {})[second] = copy(change.after);
    else if (first === "serviceRules") ((patch.serviceRules ||= {})[second] ||= {})[third] = copy(change.after);
    else patch[first] = copy(change.after);
  }
  return patch;
}

export function settingsChanges(saved, draft) {
  return leafChanges(saved, draft).map(change => ({
    ...change,
    beforeDisplay: display(change.path, change.before),
    afterDisplay: display(change.path, change.after),
  }));
}

function readLeaf(settings, path) {
  return path.split(".").reduce((value, key) => value?.[key], settings);
}

function writeLeaf(settings, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => (current[key] ||= {}), settings);
  target[last] = copy(value);
}

/** Three-way rebase for explicit review only; no value is persisted here. */
export function rebaseSettings(original, draft, latest) {
  const merged = copy(latest);
  const conflicts = [];
  for (const change of settingsChanges(original, draft)) {
    const newest = readLeaf(latest, change.path);
    if (!same(newest, change.before) && !same(newest, change.after)) {
      conflicts.push({ ...change, latest: copy(newest), latestDisplay: display(change.path, newest) });
    }
    writeLeaf(merged, change.path, change.after);
  }
  const verificationReset = [];
  const hoursChanged = ["timezone", "weeklyHours", "breaks"].some(key => !same(original[key], latest[key]) || !same(original[key], merged[key]));
  const capacityChanged = original.capacity !== latest.capacity || original.capacity !== merged.capacity;
  for (const [key, changed] of [["businessHoursVerified", hoursChanged], ["capacityVerified", capacityChanged]]) {
    if (changed) {
      merged[key] = false;
      verificationReset.push(key);
    }
  }
  return { draft: merged, conflicts, verificationReset };
}

function minutes(value, allowEnd = false) {
  if (allowEnd && value === "24:00") return 1440;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function intervalError(intervals, label) {
  if (!Array.isArray(intervals) || intervals.length > 24) return `${label} may contain at most 24 intervals.`;
  const sorted = [];
  for (const interval of intervals) {
    if (!hasOnly(interval, ["start", "end"])) return `${label} contains an invalid interval.`;
    const start = minutes(interval.start);
    const end = minutes(interval.end, true);
    if (start === null || end === null) return `Enter valid opening and closing times for ${label.toLowerCase()}.`;
    if (start >= end) return `${label} must end after they start, within the same shop day.`;
    sorted.push({ start, end });
  }
  sorted.sort((a, b) => a.start - b.start);
  if (sorted.some((interval, index) => index > 0 && interval.start < sorted[index - 1].end)) return `${label} must not overlap.`;
  return "";
}

function validUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?Z$/.test(value)
    && isBookingDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

/** Fast client feedback; every save is still validated atomically by the API. */
export function validateSettingsDraft(draft) {
  if (!hasOnly(draft, allowedKeys) || allowedKeys.some(key => !Object.hasOwn(draft, key))) return "Scheduling settings could not be verified. Reload the saved settings.";
  if (typeof draft.timezone !== "string" || !draft.timezone || draft.timezone.length > 100) return "Enter a supported shop timezone, such as America/Chicago.";
  try { new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone }); }
  catch { return "Enter a supported shop timezone, such as America/Chicago."; }
  if (!hasOnly(draft.weeklyHours, weekdays.map((_, index) => String(index)))) return "Review the weekly business hours.";
  for (const [index, day] of weekdays.entries()) {
    const error = intervalError(draft.weeklyHours[index], `${day} working intervals`);
    if (error) return error;
  }
  const breaksError = intervalError(draft.breaks, "Recurring breaks");
  if (breaksError) return breaksError;
  if (!Array.isArray(draft.closedDates) || draft.closedDates.length > 1000 || draft.closedDates.some(date => !isBookingDate(date))) return "Closed dates must be valid calendar dates, with at most 1,000 entries.";
  if (new Set(draft.closedDates).size !== draft.closedDates.length) return "A closed date is listed more than once. Remove the duplicate.";
  if (!Array.isArray(draft.blockedPeriods) || draft.blockedPeriods.length > 1000) return "Reload the saved blocked periods before continuing.";
  const blockIds = new Set();
  for (const block of draft.blockedPeriods) {
    if (!hasOnly(block, ["id", "startAt", "endAt", "reason"]) || typeof block.id !== "string" || !block.id.trim() || block.id.length > 100 || blockIds.has(block.id)
      || !validUtcTimestamp(block.startAt) || !validUtcTimestamp(block.endAt) || Date.parse(block.startAt) >= Date.parse(block.endAt)
      || (block.reason !== undefined && (typeof block.reason !== "string" || block.reason.length > 200))) return "Reload the saved blocked periods before continuing.";
    blockIds.add(block.id);
  }
  for (const [key, [minimum, maximum]] of Object.entries(numericLimits)) {
    if (!Number.isInteger(draft[key]) || draft[key] < minimum || draft[key] > maximum) return `${fields[key] || "Legacy booking estimate"} must be a whole number from ${minimum} to ${maximum}.`;
  }
  if (1440 % draft.startIncrementMinutes !== 0) return "Appointment start increments must divide evenly into a day (for example, 15, 30, or 60 minutes).";
  if (!hasOnly(draft.serviceRules, SERVICES.map(service => service.name))) return "Review the service booking estimates.";
  for (const service of SERVICES) {
    const rule = draft.serviceRules[service.name];
    if (!hasOnly(rule, ["durationMinutes", "requiresApproval"]) || !Number.isInteger(rule.durationMinutes) || rule.durationMinutes < 5 || rule.durationMinutes > 720) return `${service.name} needs a whole-minute booking estimate from 5 to 720 minutes.`;
    if (typeof rule.requiresApproval !== "boolean") return `Review the approval requirement for ${service.name}.`;
    if (service.category === "repairs" && !rule.requiresApproval) return `${service.name} always requires mechanic approval.`;
  }
  for (const key of ["automaticBookingEnabled", "businessHoursVerified", "capacityVerified"]) {
    if (typeof draft[key] !== "boolean") return "Review the automatic-booking and verification acknowledgments.";
  }
  return "";
}
