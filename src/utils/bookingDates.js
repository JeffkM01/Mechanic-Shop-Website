import { resolveShopLocalTime } from "../../shared/shopTime.js";

// Booking dates are shop-calendar dates, not instants in the customer's timezone.
// UTC is used only for Gregorian arithmetic and formatting date-only values.
function dateParts(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function dateString(date) {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isBookingDate(value) {
  return dateParts(value) !== null;
}

export function dateWeekday(value) {
  return dateParts(value)?.getUTCDay() ?? null;
}

export function addDays(value, amount) {
  const date = dateParts(value);
  if (!date || !Number.isSafeInteger(amount)) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return Number.isFinite(date.getTime()) ? dateString(date) : null;
}

export function addMonths(month, amount) {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month) || !dateParts(`${month}-01`) || !Number.isSafeInteger(amount)) return null;
  const [year, number] = month.split("-").map(Number);
  const total = (year - 1) * 12 + number - 1 + amount;
  if (!Number.isSafeInteger(total) || total < 0 || total >= 9999 * 12) return null;
  return `${String(Math.floor(total / 12) + 1).padStart(4, "0")}-${String(total % 12 + 1).padStart(2, "0")}`;
}

// Always six Sunday-first rows; blank cells never imply bookable dates.
export function monthDays(month) {
  if (!addMonths(month, 0)) return [];
  const first = `${month}-01`;
  const offset = dateWeekday(first);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(first, index - offset);
    return date?.startsWith(`${month}-`) ? date : null;
  });
}

export function monthLabel(month) {
  if (!addMonths(month, 0)) return "";
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(dateParts(`${month}-01`));
}

export function formatBookingDate(value) {
  const date = dateParts(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    calendar: "iso8601", numberingSystem: "latn",
    month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC",
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get("month")}/${get("day")}/${get("year").padStart(4, "0")}`;
}

export function formatBookingTime(value) {
  if (value === "24:00") return "12:00 AM (next day)";
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return "";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function dateInTimezone(instant, timeZone) {
  if (!(instant instanceof Date) && typeof instant !== "number" && typeof instant !== "string") return null;
  // A date-only value has no instant or offset, so it cannot identify "today".
  if (typeof instant === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/i.test(instant)) return null;
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()) || typeof timeZone !== "string" || !timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const value = `${get("year")?.padStart(4, "0")}-${get("month")}-${get("day")}`;
    return isBookingDate(value) ? value : null;
  } catch {
    return null;
  }
}


// Explicit display fields avoid native date/time inputs whose presentation
// follows the visitor's OS locale. Only canonical ISO/HH:MM values reach APIs.
export function parseDisplayDate(value) {
  if (typeof value !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return "";
  const [month, day, year] = value.split("/");
  const date = `${year}-${month}-${day}`;
  return isBookingDate(date) ? date : "";
}

export function parseDisplayTime(value, allowEnd = false) {
  if (allowEnd && value === "12:00 AM (next day)") return "24:00";
  if (typeof value !== "string") return "";
  const match = /^(0?[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/i.exec(value.trim());
  if (!match) return "";
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function formatShopTimestamp(instant, timeZone) {
  if (!dateInTimezone(instant, timeZone)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get("month")}/${get("day")}/${get("year").padStart(4, "0")} at ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

export function shopLocalToUtc(date, time, timezone) {
  return resolveShopLocalTime(date, time, timezone).toISOString();
}
