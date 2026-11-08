// Shared wall-clock resolver for the browser and scheduling backend. This uses
// the shop's IANA timezone, never the machine/browser timezone. Gaps and folds
// are rejected so a staff-entered blocked period cannot guess a UTC offset.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const formatters = new Map();

export class ShopTimeError extends Error {
  constructor(message, code = "INVALID_SCHEDULING_INPUT") {
    super(message);
    this.name = "ShopTimeError";
    this.code = code;
  }
}

function invalid(message, code) { throw new ShopTimeError(message, code); }

function utcDay(year, month, day) {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function shopTimezoneFormatter(timezone) {
  if (typeof timezone !== "string" || timezone.length > 100) invalid("Timezone is invalid.");
  if (!formatters.has(timezone)) {
    try {
      formatters.set(timezone, new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        calendar: "iso8601",
        numberingSystem: "latn",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }));
    } catch {
      invalid("Timezone must be a supported IANA timezone.", "INVALID_TIMEZONE");
    }
  }
  return formatters.get(timezone);
}

function zonedParts(date, timezone) {
  const result = {};
  for (const { type, value } of shopTimezoneFormatter(timezone).formatToParts(date)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(type)) result[type] = Number(value);
  }
  return result;
}

export function resolveShopLocalTime(date, time, timezone) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    invalid("Date must use YYYY-MM-DD.", "INVALID_DATE");
  }
  const [year, month, day] = date.split("-").map(Number);
  const calendarDay = utcDay(year, month, day);
  if (year < 1 || calendarDay.getUTCFullYear() !== year
    || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) {
    invalid("Date is not a valid calendar date.", "INVALID_DATE");
  }
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    invalid("Time must use 24-hour HH:MM.", "INVALID_TIME");
  }
  const [hour, minute] = time.split(":").map(Number);
  const minutes = hour * 60 + minute;
  shopTimezoneFormatter(timezone);
  const wall = calendarDay.getTime() + minutes * MINUTE;
  const offsets = new Set();
  for (let delta = -48 * HOUR; delta <= 48 * HOUR; delta += 6 * HOUR) {
    const sample = new Date(wall + delta);
    const parts = zonedParts(sample, timezone);
    const local = utcDay(parts.year, parts.month, parts.day).getTime()
      + (parts.hour * 60 + parts.minute) * MINUTE + parts.second * 1000;
    offsets.add(local - sample.getTime());
  }
  const matches = [...offsets].map((offset) => new Date(wall - offset)).filter((candidate) => {
    const parts = zonedParts(candidate, timezone);
    return parts.year === calendarDay.getUTCFullYear()
      && parts.month === calendarDay.getUTCMonth() + 1
      && parts.day === calendarDay.getUTCDate()
      && parts.hour * 60 + parts.minute === minutes && parts.second === 0;
  });
  if (matches.length !== 1) {
    invalid("This local time is missing or ambiguous because the timezone clock changes. Choose another time.", "LOCAL_TIME_UNAVAILABLE");
  }
  return matches[0];
}
