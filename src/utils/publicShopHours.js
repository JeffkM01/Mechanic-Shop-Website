import { formatBookingTime, isBookingDate } from "./bookingDates.js";

function intervals(value) {
  if (!Array.isArray(value) || value.length > 24) throw new Error("Shop hours could not be verified.");
  let previousEnd = -1;
  return value.map(interval => {
    if (!interval || typeof interval !== "object" || Array.isArray(interval) || Object.keys(interval).some(key => !["start", "end"].includes(key))) throw new Error("Shop hours could not be verified.");
    const minute = (time, closing) => {
      if (closing && time === "24:00") return 1440;
      if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Shop hours could not be verified.");
      const [hour, minutes] = time.split(":").map(Number);
      return hour * 60 + minutes;
    };
    const start = minute(interval.start, false), end = minute(interval.end, true);
    if (start >= end || start < previousEnd) throw new Error("Shop hours could not be verified.");
    previousEnd = end;
    return { start: interval.start, end: interval.end };
  });
}

export function parsePublicShopHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.verified !== "boolean" || typeof value.timezone !== "string" || !value.timezone.length || value.timezone.length > 100) throw new Error("Shop hours could not be verified.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); }
  catch { throw new Error("Shop hours could not be verified."); }
  if (!value.verified) return { verified: false, timezone: value.timezone, weeklyHours: null, breaks: [], closedDates: [] };
  if (!value.weeklyHours || typeof value.weeklyHours !== "object" || Array.isArray(value.weeklyHours)
    || Object.keys(value.weeklyHours).length !== 7 || Object.keys(value.weeklyHours).some(day => !/^[0-6]$/.test(day))) throw new Error("Shop hours could not be verified.");
  const weeklyHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), intervals(value.weeklyHours[day])]));
  const breaks = intervals(value.breaks);
  if (!Array.isArray(value.closedDates) || value.closedDates.length > 1000 || value.closedDates.some(date => !isBookingDate(date)) || new Set(value.closedDates).size !== value.closedDates.length) throw new Error("Shop hours could not be verified.");
  return { verified: true, timezone: value.timezone, weeklyHours, breaks, closedDates: [...value.closedDates] };
}

// Closing at 24:00 means midnight at the end of this shop day. Keep the saved
// local wall times and distinguish it from opening at midnight (00:00).
export function formatPublicHoursInterval(interval) {
  const end = interval.end === "24:00" ? `${formatBookingTime("00:00")} (end of day)` : formatBookingTime(interval.end);
  return `${formatBookingTime(interval.start)}–${end}`;
}
