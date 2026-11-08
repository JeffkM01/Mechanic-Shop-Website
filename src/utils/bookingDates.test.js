import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  addDays, addMonths, dateInTimezone, dateWeekday, formatBookingDate,
  formatBookingTime, formatShopTimestamp, isBookingDate, monthDays, monthLabel,
  parseDisplayDate, parseDisplayTime, shopLocalToUtc,
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
      assert.equal(formatBookingDate("2026-11-01"), "11/01/2026");
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
  assert.equal(formatBookingTime("24:00"), "12:00 AM (next day)");
  for (const value of ["13:60", "1:30", "", null]) assert.equal(formatBookingTime(value), "");
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


test("American date fields round-trip strict display values without changing stored ISO dates", () => {
  for (const [display, iso] of [
    ["11/09/2026", "2026-11-09"], ["12/25/2026", "2026-12-25"],
    ["01/05/2027", "2027-01-05"], ["02/29/2000", "2000-02-29"],
    ["01/01/0001", "0001-01-01"], ["11/09/0099", "0099-11-09"],
  ]) {
    assert.equal(parseDisplayDate(display), iso);
    assert.equal(formatBookingDate(iso), display);
  }
  for (const value of ["2/03/2026", "02/3/2026", "02/29/2026", "02/29/1900", "04/31/2026", "13/01/2026", "00/01/2026", "01/00/2026", "01/01/0000", "2026-11-09", "11/09/26", " 11/09/2026", null, 123]) {
    assert.equal(parseDisplayDate(value), "", String(value));
  }
});

test("American time fields convert AM/PM strictly and preserve historical minutes", () => {
  for (const [display, api] of [
    ["12:00 AM", "00:00"], ["12:00 PM", "12:00"], ["8:15 AM", "08:15"],
    ["08:16 AM", "08:16"], ["2:30 PM", "14:30"], ["11:59 pm", "23:59"],
  ]) assert.equal(parseDisplayTime(display), api);
  for (const value of ["08:00", "0:00 AM", "13:00 PM", "1:60 AM", "1:5 PM", "8:00", "8:00 XM", "8:00 AM extra", null]) {
    assert.equal(parseDisplayTime(value), "", String(value));
  }
  assert.equal(parseDisplayTime("12:00 AM (next day)"), "");
  assert.equal(parseDisplayTime(formatBookingTime("24:00"), true), "24:00");
});

test("actual timestamps display U.S. dates and AM/PM in the persisted shop timezone", () => {
  assert.equal(formatShopTimestamp("2026-11-09T01:30:00.000Z", "America/Chicago"), "11/08/2026 at 7:30 PM");
  assert.equal(formatShopTimestamp("2026-03-08T07:59:00.000Z", "America/Chicago"), "03/08/2026 at 1:59 AM");
  assert.equal(formatShopTimestamp("2026-03-08T08:00:00.000Z", "America/Chicago"), "03/08/2026 at 3:00 AM");
  assert.equal(formatShopTimestamp("2026-11-01T06:30:00.000Z", "America/Chicago"), "11/01/2026 at 1:30 AM");
  assert.equal(formatShopTimestamp("2026-11-01T07:30:00.000Z", "America/Chicago"), "11/01/2026 at 1:30 AM");
  assert.equal(formatShopTimestamp("2026-11-09T01:30:00Z", "Asia/Tokyo"), "11/09/2026 at 10:30 AM");
  for (const value of ["2026-11-09", "2026-11-09T01:30:00", "invalid", null]) assert.equal(formatShopTimestamp(value, "America/Chicago"), "");
  assert.equal(formatShopTimestamp("2026-11-09T01:30:00Z", "bad-zone"), "");
});

test("blocked-time conversion uses the shop timezone in every browser timezone", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      assert.equal(shopLocalToUtc("2026-11-12", "13:00", "America/Chicago"), "2026-11-12T19:00:00.000Z");
      assert.equal(shopLocalToUtc("2026-07-12", "13:00", "America/Chicago"), "2026-07-12T18:00:00.000Z");
      assert.equal(shopLocalToUtc("2026-11-12", "00:15", "Asia/Kathmandu"), "2026-11-11T18:30:00.000Z");
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("blocked-time conversion rejects invalid dates and both DST gaps and repeated times", () => {
  for (const [date, time, timezone, code] of [
    ["2026-03-08", "02:30", "America/Chicago", "LOCAL_TIME_UNAVAILABLE"],
    ["2026-11-01", "01:30", "America/Chicago", "LOCAL_TIME_UNAVAILABLE"],
    ["2026-10-04", "02:15", "Australia/Lord_Howe", "LOCAL_TIME_UNAVAILABLE"],
    ["2026-04-05", "01:45", "Australia/Lord_Howe", "LOCAL_TIME_UNAVAILABLE"],
    ["2026-02-29", "08:00", "America/Chicago", "INVALID_DATE"],
    ["11/12/2026", "08:00", "America/Chicago", "INVALID_DATE"],
    ["2026-11-12", "8:00 AM", "America/Chicago", "INVALID_TIME"],
    ["2026-11-12", "24:00", "America/Chicago", "INVALID_TIME"],
    ["2026-11-12", "08:00", "invalid-zone", "INVALID_TIMEZONE"],
  ]) assert.throws(() => shopLocalToUtc(date, time, timezone), error => error.code === code);
});
