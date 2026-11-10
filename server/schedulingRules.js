import { SERVICES, getService } from "../shared/services.js";
import { resolveShopLocalTime, shopTimezoneFormatter, ShopTimeError } from "../shared/shopTime.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const canonicalNames = SERVICES.map(({ name }) => name);
const approvalOnlyServices = SERVICES.filter(({ category }) => category === "repairs").map(({ name }) => name);
const settingsKeys = [
  "timezone", "weeklyHours", "breaks", "closedDates", "blockedPeriods",
  "capacity", "maxAutomaticPerDay", "minimumNoticeHours", "bookingHorizonDays",
  "startIncrementMinutes", "bufferMinutes", "pendingHoldHours",
  "automaticBookingEnabled", "businessHoursVerified", "capacityVerified",
  "serviceRules", "legacyUnknownDurationMinutes",
];

export class SchedulingError extends Error {
  constructor(status, message, code = "SCHEDULING_ERROR") {
    super(message);
    this.name = "SchedulingError";
    this.status = status;
    this.code = code;
  }
}

function invalid(message, code = "INVALID_SCHEDULING_INPUT") {
  throw new SchedulingError(400, message, code);
}

function unavailable(message, code) {
  throw new SchedulingError(409, message, code);
}

function plainObject(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checkKeys(value, allowed, label) {
  if (!plainObject(value)) invalid(`${label} must be an object.`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(`${label} contains an unknown setting.`);
  }
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function utcDay(year, month, day) {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function parseDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    invalid("Date must use YYYY-MM-DD.", "INVALID_DATE");
  }
  const [year, month, day] = date.split("-").map(Number);
  const result = utcDay(year, month, day);
  if (year < 1 || result.getUTCFullYear() !== year
    || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) {
    invalid("Date is not a valid calendar date.", "INVALID_DATE");
  }
  return result;
}

function parseTime(time, allowEnd = false) {
  if (allowEnd && time === "24:00") return 1440;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    invalid("Time must use 24-hour HH:MM.", "INVALID_TIME");
  }
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function timeString(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function addDays(date, days) {
  const result = parseDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function formatter(timezone) {
  try { return shopTimezoneFormatter(timezone); }
  catch (error) {
    if (error instanceof ShopTimeError) invalid(error.message, error.code);
    throw error;
  }
}

function zonedParts(date, timezone) {
  const result = {};
  for (const { type, value } of formatter(timezone).formatToParts(date)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(type)) result[type] = Number(value);
  }
  return result;
}

function instant(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? NaN);
  if (!Number.isFinite(date.getTime())) invalid(`${label} must be a valid timestamp.`);
  return date;
}

export function dateInZone(date, timezone) {
  const parts = zonedParts(instant(date, "Current time"), timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// The customer/staff UI and backend share the exact offset resolver. Preserve
// the public SchedulingError status/code contract at the server boundary.
export function localDateTimeToUtc(date, time, timezone) {
  try { return resolveShopLocalTime(date, time, timezone); }
  catch (error) {
    if (error instanceof ShopTimeError) invalid(error.message, error.code);
    throw error;
  }
}

function boundary(date, time, timezone) {
  return time === "24:00"
    ? localDateTimeToUtc(addDays(date, 1), "00:00", timezone)
    : localDateTimeToUtc(date, time, timezone);
}

export function defaultSettings() {
  const shortServices = ["Cabin Air Filter Replacement", "Engine Air Filter Replacement", "Wiper Blade Replacement"];
  const hourServices = ["Tire Rotation", "Oil Change"];
  return {
    timezone: "America/Chicago",
    weeklyHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
      String(day), day >= 1 && day <= 5 ? [{ start: "08:00", end: "17:00" }] : [],
    ])),
    breaks: [{ start: "12:00", end: "13:00" }],
    closedDates: [],
    blockedPeriods: [],
    capacity: 1,
    maxAutomaticPerDay: 3,
    minimumNoticeHours: 24,
    bookingHorizonDays: 14,
    startIncrementMinutes: 30,
    bufferMinutes: 15,
    pendingHoldHours: 24,
    automaticBookingEnabled: false,
    businessHoursVerified: false,
    capacityVerified: false,
    serviceRules: Object.fromEntries(SERVICES.map(({ name }) => [name, {
      durationMinutes: shortServices.includes(name) ? 30 : hourServices.includes(name) ? 60 : name === "Engine Diagnostics" ? 90 : 120,
      requiresApproval: approvalOnlyServices.includes(name),
    }])),
    legacyUnknownDurationMinutes: 120,
  };
}

function validateIntervals(intervals, label) {
  if (!Array.isArray(intervals) || intervals.length > 24) invalid(`${label} must be an array of up to 24 intervals.`);
  const normalized = intervals.map((interval) => {
    checkKeys(interval, ["start", "end"], label);
    const start = parseTime(interval.start);
    const end = parseTime(interval.end, true);
    if (start >= end) invalid(`${label} intervals must end after they start, within the same local day.`);
    return { start: interval.start, end: interval.end };
  }).sort((a, b) => parseTime(a.start) - parseTime(b.start));
  for (let index = 1; index < normalized.length; index += 1) {
    if (parseTime(normalized[index].start) < parseTime(normalized[index - 1].end, true)) invalid(`${label} intervals must not overlap.`);
  }
  return normalized;
}

function utcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?Z$/.test(value)) {
    invalid("Blocked periods must use ISO UTC timestamps ending in Z.");
  }
  parseDate(value.slice(0, 10));
  return instant(value, "Blocked period").toISOString();
}

export function validateSettings(settings) {
  checkKeys(settings, settingsKeys, "Scheduling settings");
  if (settingsKeys.some((key) => !Object.hasOwn(settings, key))) invalid("Scheduling settings are incomplete.");
  formatter(settings.timezone);
  checkKeys(settings.weeklyHours, ["0", "1", "2", "3", "4", "5", "6"], "Weekly hours");
  const weeklyHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), validateIntervals(settings.weeklyHours[day], "Weekly hours")]));
  const breaks = validateIntervals(settings.breaks, "Breaks");
  if (!Array.isArray(settings.closedDates) || settings.closedDates.length > 1000) invalid("Closed dates must be an array of up to 1000 dates.");
  const closedDates = settings.closedDates.map((date) => { parseDate(date); return date; });
  if (new Set(closedDates).size !== closedDates.length) invalid("Closed dates must be unique.");
  if (!Array.isArray(settings.blockedPeriods) || settings.blockedPeriods.length > 1000) invalid("Blocked periods must be an array of up to 1000 intervals.");
  const blockedPeriods = settings.blockedPeriods.map((period) => {
    checkKeys(period, ["id", "startAt", "endAt", "reason"], "Blocked period");
    if (typeof period.id !== "string" || !period.id.trim() || period.id.length > 100) invalid("Each blocked period must have an id of up to 100 characters.");
    const startAt = utcTimestamp(period.startAt);
    const endAt = utcTimestamp(period.endAt);
    if (startAt >= endAt) invalid("Blocked periods must end after they start.");
    if (period.reason !== undefined && (typeof period.reason !== "string" || period.reason.length > 200)) invalid("Blocked period reasons must be at most 200 characters.");
    return { id: period.id, startAt, endAt, ...(period.reason !== undefined ? { reason: period.reason } : {}) };
  });
  if (new Set(blockedPeriods.map(({ id }) => id)).size !== blockedPeriods.length) invalid("Blocked period ids must be unique.");
  checkKeys(settings.serviceRules, canonicalNames, "Service rules");
  const serviceRules = Object.fromEntries(canonicalNames.map((name) => {
    const rule = settings.serviceRules[name];
    checkKeys(rule, ["durationMinutes", "requiresApproval"], `Rule for ${name}`);
    integer(rule.durationMinutes, 5, 720, "Service duration");
    if (typeof rule.requiresApproval !== "boolean") invalid("Service approval requirements must be boolean.");
    if (approvalOnlyServices.includes(name) && !rule.requiresApproval) invalid(`${name} requires mechanic approval.`);
    return [name, { durationMinutes: rule.durationMinutes, requiresApproval: rule.requiresApproval }];
  }));
  const result = { ...settings, weeklyHours, breaks, closedDates, blockedPeriods, serviceRules };
  for (const [key, min, max] of [
    ["capacity", 1, 20], ["maxAutomaticPerDay", 0, 100], ["minimumNoticeHours", 0, 720],
    ["bookingHorizonDays", 1, 365], ["startIncrementMinutes", 5, 120], ["bufferMinutes", 0, 120],
    ["pendingHoldHours", 1, 168], ["legacyUnknownDurationMinutes", 5, 720],
  ]) integer(result[key], min, max, key);
  if (1440 % result.startIncrementMinutes !== 0) invalid("Start increments must divide evenly into a day.");
  for (const key of ["automaticBookingEnabled", "businessHoursVerified", "capacityVerified"]) {
    if (typeof result[key] !== "boolean") invalid(`${key} must be boolean.`);
  }
  return result;
}

export function mergeSettings(current, patch) {
  const base = validateSettings(current);
  checkKeys(patch, settingsKeys, "Scheduling settings patch");
  const merged = { ...base, ...patch };
  if (Object.hasOwn(patch, "weeklyHours")) {
    checkKeys(patch.weeklyHours, ["0", "1", "2", "3", "4", "5", "6"], "Weekly hours patch");
    merged.weeklyHours = { ...base.weeklyHours, ...patch.weeklyHours };
  }
  if (Object.hasOwn(patch, "serviceRules")) {
    checkKeys(patch.serviceRules, canonicalNames, "Service rules patch");
    merged.serviceRules = { ...base.serviceRules };
    for (const [name, rule] of Object.entries(patch.serviceRules)) {
      checkKeys(rule, ["durationMinutes", "requiresApproval"], `Rule patch for ${name}`);
      merged.serviceRules[name] = { ...base.serviceRules[name], ...rule };
    }
  }
  // Verification belongs to the actual saved business configuration. Editing
  // hours/timezone or capacity must not inherit a stale verification flag.
  const hoursChanged = ["timezone", "weeklyHours", "breaks"].some(key => JSON.stringify(base[key]) !== JSON.stringify(merged[key]));
  if (hoursChanged && !Object.hasOwn(patch, "businessHoursVerified")) merged.businessHoursVerified = false;
  if (base.capacity !== merged.capacity && !Object.hasOwn(patch, "capacityVerified")) merged.capacityVerified = false;
  return validateSettings(merged);
}

function serviceRule(settings, name) {
  const service = getService(name);
  if (!service) invalid("Select a valid service.", "INVALID_SERVICE");
  const rule = settings.serviceRules[service.name];
  if (!rule) invalid("The service has no scheduling rule.");
  return { service, rule };
}

function overlaps(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

export function buildCandidate(settings, serviceName, date, time, nowDate, { approval = false, durationMinutes, bufferMinutes: bufferOverride } = {}) {
  const { service, rule } = serviceRule(settings, serviceName);
  const calendarDay = parseDate(date);
  const minutes = parseTime(time);
  const now = instant(nowDate, "Current time");
  // Historical requests may predate the booking grid. Approval preserves their
  // requested minute while retaining the current calendar checks below.
  if (!approval && minutes % settings.startIncrementMinutes !== 0) invalid("Select a time on the configured booking increment.", "INVALID_TIME_INCREMENT");
  const startAt = localDateTimeToUtc(date, time, settings.timezone);
  if (startAt <= now) unavailable("Appointments must start in the future.", "PAST_APPOINTMENT");
  // Approval can happen after the original notice window or after the horizon
  // changes, but still enforces the current working calendar and conflicts.
  if (!approval) {
    if (startAt.getTime() < now.getTime() + settings.minimumNoticeHours * HOUR) unavailable("This time does not meet the minimum advance notice.", "MINIMUM_NOTICE");
    if (date > addDays(dateInZone(now, settings.timezone), settings.bookingHorizonDays)) unavailable("This date is beyond the booking horizon.", "BOOKING_HORIZON");
  }
  if (settings.closedDates.includes(date)) unavailable("The shop is closed on this date.", "CLOSED_DATE");
  const intervals = settings.weeklyHours[calendarDay.getUTCDay()];
  if (!intervals?.length) unavailable("The shop is closed on this day.", "CLOSED_DAY");
  const duration = durationMinutes === undefined ? rule.durationMinutes : integer(durationMinutes, 5, 720, "Service duration");
  const bufferMinutes = bufferOverride === undefined ? settings.bufferMinutes : integer(bufferOverride, 0, 120, "Appointment buffer");
  const endAt = new Date(startAt.getTime() + duration * MINUTE);
  const occupiedUntil = new Date(endAt.getTime() + bufferMinutes * MINUTE);
  const fitsHours = intervals.some(({ start, end }) => startAt >= boundary(date, start, settings.timezone)
    && occupiedUntil <= boundary(date, end, settings.timezone));
  if (!fitsHours) unavailable("The appointment and its buffer must fit within shop hours.", "OUTSIDE_HOURS");
  if (settings.breaks.some(({ start, end }) => overlaps(startAt, occupiedUntil,
    boundary(date, start, settings.timezone), boundary(date, end, settings.timezone)))) {
    unavailable("This appointment overlaps a shop break.", "SHOP_BREAK");
  }
  if (settings.blockedPeriods.some(({ startAt: start, endAt: end }) => overlaps(startAt, occupiedUntil, new Date(start), new Date(end)))) {
    unavailable("This time is blocked by the shop.", "BLOCKED_PERIOD");
  }
  return {
    startAt, endAt, occupiedUntil, durationMinutes: duration,
    bufferMinutes, timezone: settings.timezone, date, time,
    requiresApproval: rule.requiresApproval || service.provisional,
    provisional: service.provisional,
  };
}

function occupiedInterval(occupancy) {
  const start = instant(occupancy.startAt, "Occupied start").getTime();
  const end = occupancy.occupiedUntil !== undefined
    ? instant(occupancy.occupiedUntil, "Occupied end").getTime()
    : instant(occupancy.endAt, "Occupied end").getTime()
      + integer(occupancy.bufferMinutes ?? 0, 0, 120, "Occupied buffer") * MINUTE;
  if (end <= start) invalid("An occupied interval must end after it starts.");
  return { start, end };
}

export function canFit(candidate, occupancies, capacity) {
  integer(capacity, 1, 20, "Capacity");
  const { start, end } = occupiedInterval(candidate);
  const events = [];
  for (const occupancy of occupancies) {
    const interval = occupiedInterval(occupancy);
    if (overlaps(start, end, interval.start, interval.end)) {
      events.push({ at: Math.max(start, interval.start), change: 1 }, { at: Math.min(end, interval.end), change: -1 });
    }
  }
  events.sort((a, b) => a.at - b.at || a.change - b.change);
  let used = 1;
  for (const event of events) {
    used += event.change;
    if (used > capacity) return false;
  }
  return true;
}

export function calculateSlots(settings, serviceName, date, occupancies, nowDate) {
  serviceRule(settings, serviceName);
  const calendarDay = parseDate(date);
  const now = instant(nowDate, "Current time");
  const slots = [];
  for (const { start, end } of settings.weeklyHours[calendarDay.getUTCDay()] ?? []) {
    const first = Math.ceil(parseTime(start) / settings.startIncrementMinutes) * settings.startIncrementMinutes;
    for (let minutes = first; minutes < parseTime(end, true); minutes += settings.startIncrementMinutes) {
      let candidate;
      try {
        candidate = buildCandidate(settings, serviceName, date, timeString(minutes), now);
      } catch (error) {
        if (error instanceof SchedulingError && (error.status === 409 || error.code === "LOCAL_TIME_UNAVAILABLE")) continue;
        throw error;
      }
      if (canFit(candidate, occupancies, settings.capacity)) {
        slots.push({ time: candidate.time, startAt: candidate.startAt.toISOString(), endAt: candidate.endAt.toISOString(), durationMinutes: candidate.durationMinutes });
      }
    }
  }
  return slots;
}

// Pending requests keep their record after a hold expires. Confirming one later
// must acquire a fresh reservation. Missing age metadata stays occupied until a
// mechanic reviews it; confirmed appointments never expire automatically.
export function legacyOccurrence(appointment, settings, nowDate) {
  if (["declined", "cancelled"].includes(appointment.status)) return null;
  const now = instant(nowDate, "Current time");
  const scheduling = appointment.scheduling ?? {};
  if (appointment.status === "pending" || !appointment.status) {
    if (scheduling.holdExpiresAt !== undefined && scheduling.holdExpiresAt !== null) {
      const expiresAt = new Date(scheduling.holdExpiresAt);
      if (Number.isFinite(expiresAt.getTime()) && expiresAt <= now) return null;
    } else if (appointment.createdAt !== undefined && appointment.createdAt !== null) {
      const createdAt = new Date(appointment.createdAt);
      if (Number.isFinite(createdAt.getTime()) && createdAt.getTime() + settings.pendingHoldHours * HOUR <= now.getTime()) return null;
    }
  }
  try {
    const service = getService(appointment.service);
    const duration = scheduling.durationMinutes ?? (service ? settings.serviceRules[service.name].durationMinutes : settings.legacyUnknownDurationMinutes);
    integer(duration, 5, 720, "Legacy service duration");
    const startAt = scheduling.startAt !== undefined && scheduling.startAt !== null
      ? instant(scheduling.startAt, "Legacy start")
      : localDateTimeToUtc(appointment.date, appointment.time, scheduling.timezone ?? settings.timezone);
    const endAt = scheduling.endAt !== undefined && scheduling.endAt !== null
      ? instant(scheduling.endAt, "Legacy end")
      : new Date(startAt.getTime() + duration * MINUTE);
    if (endAt <= startAt) invalid("Legacy appointment ends before it starts.");
    const storedOccupiedUntil = scheduling.occupiedUntil !== undefined && scheduling.occupiedUntil !== null
      ? instant(scheduling.occupiedUntil, "Legacy occupied end") : null;
    // A partial snapshot can retain its exact buffer through endAt and
    // occupiedUntil even when the explicit buffer field was not stored.
    const inferredBuffer = storedOccupiedUntil && scheduling.endAt != null
      ? (storedOccupiedUntil.getTime() - endAt.getTime()) / MINUTE : settings.bufferMinutes;
    const bufferMinutes = scheduling.bufferMinutes ?? inferredBuffer;
    integer(bufferMinutes, 0, 120, "Legacy buffer");
    const occupiedUntil = new Date(Math.max(endAt.getTime() + bufferMinutes * MINUTE, storedOccupiedUntil?.getTime() ?? 0));
    if (storedOccupiedUntil && storedOccupiedUntil < endAt) invalid("Legacy occupied end is before its appointment end.");
    return {
      id: String(appointment._id ?? appointment.id ?? ""), startAt, endAt,
      bufferMinutes, occupiedUntil,
    };
  } catch {
    unavailable("An existing appointment has incomplete scheduling information and needs mechanic review.", "LEGACY_SCHEDULE_INVALID");
  }
}
