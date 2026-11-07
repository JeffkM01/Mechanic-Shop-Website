import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  addDays, addMonths, dateInTimezone, dateWeekday, formatBookingDate,
  formatBookingTime, isBookingDate, monthDays, monthLabel,
} from "./bookingDates.js";

test("calendar aligns dates with Sunday-first weekday headings", () => {
  const november = monthDays("2026-11");
  assert.equal(november.length, 42);
  assert.equal(november[0], "2026-11-01");
  assert.equal(november[29], "2026-11-30");
  assert.equal(november[30], null);
  const august = monthDays("2026-08");
  assert.deepEqual(august.slice(0, 6), Array(6).fill(null));
  assert.equal(august[6], "2026-08-01");
  assert.equal(august[36], "2026-08-31");
  assert.equal(dateWeekday("2026-08-01"), 6);
});

test("strict Gregorian dates reject normalization and accept leap years", () => {
  for (const value of ["2026-02-29", "1900-02-29", "2024-04-31", "2026-13-01", "2026-00-10", "0000-01-01", "2026-1-01", "2026-11-01T00:00:00Z", null, 42]) {
    assert.equal(isBookingDate(value), false, String(value));
    assert.equal(addDays(value, 1), null);
  }
  assert.equal(isBookingDate("2000-02-29"), true);
  assert.equal(monthDays("2024-02").filter(Boolean).length, 29);
  assert.equal(monthDays("2026-02").filter(Boolean).length, 28);
  assert.deepEqual(monthDays("2026-13"), []);
});

test("day arithmetic handles month, leap-day, and year boundaries", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("0099-12-31", 1), "0100-01-01");
  assert.equal(addDays("0001-01-01", -1), null);
  assert.equal(addDays("9999-12-31", 1), null);
  assert.equal(addDays("2026-11-01", 0.5), null);
});

test("month navigation is strict and handles year boundaries", () => {
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2027-01", -1), "2026-12");
  assert.equal(addMonths("2026-01", 14), "2027-03");
  assert.equal(addMonths("0001-01", -1), null);
  assert.equal(addMonths("9999-12", 1), null);
  assert.equal(addMonths("2026-13", 1), null);
  assert.equal(addMonths("2026-1", 1), null);
});

test("date labels stay on the selected shop date in non-UTC customer timezones", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      assert.equal(formatBookingDate("2026-11-01"), "Sunday, November 1, 2026");
      assert.equal(monthLabel("2026-11"), "November 2026");
      assert.equal(addDays("2026-11-01", 1), "2026-11-02");
      assert.equal(dateInTimezone("2026-11-01T02:30:00Z", "America/Chicago"), "2026-10-31");
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("shop dates use the configured timezone across both daylight-saving transitions", () => {
  for (const instant of ["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z"]) {
    assert.equal(dateInTimezone(instant, "America/Chicago"), "2026-03-08");
  }
  for (const instant of ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"]) {
    assert.equal(dateInTimezone(new Date(instant), "America/Chicago"), "2026-11-01");
  }
  assert.equal(dateInTimezone("2026-03-09T04:30:00Z", "America/Chicago"), "2026-03-08");
  assert.equal(dateInTimezone("2026-11-02T05:30:00Z", "America/Chicago"), "2026-11-01");
  assert.equal(dateInTimezone("2026-11-01T05:30:00Z", "America/Los_Angeles"), "2026-10-31");
  assert.equal(dateInTimezone("2026-11-01T05:30:00Z", "Asia/Tokyo"), "2026-11-01");
});

test("time labels use twelve-hour notation and reject malformed input", () => {
  assert.equal(formatBookingTime("00:00"), "12:00 AM");
  assert.equal(formatBookingTime("08:30"), "8:30 AM");
  assert.equal(formatBookingTime("12:00"), "12:00 PM");
  assert.equal(formatBookingTime("14:30"), "2:30 PM");
  assert.equal(formatBookingTime("23:59"), "11:59 PM");
  for (const value of ["24:00", "13:60", "1:30", "", null]) assert.equal(formatBookingTime(value), "");
  assert.equal(formatBookingDate("2026-02-30"), "");
  assert.equal(monthLabel("2026-00"), "");
});

test("shop date conversion rejects values without a valid instant or timezone", () => {
  for (const instant of ["invalid", "2026-11-01", "2026-11-01T08:00:00", new Date(NaN), null, {}, undefined]) {
    assert.equal(dateInTimezone(instant, "America/Chicago"), null);
  }
  assert.equal(dateInTimezone("2026-11-01T08:00:00Z", "invalid/timezone"), null);
  assert.equal(dateInTimezone("2026-11-01T08:00:00Z", undefined), null);
});
