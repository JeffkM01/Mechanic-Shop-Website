import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicShopHours, formatPublicHoursInterval } from "./publicShopHours.js";

function verifiedHours() {
  return {
    verified: true, timezone: "America/Chicago",
    weeklyHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), day === 0 ? [] : [{ start: "08:00", end: "17:00" }]])),
    breaks: [{ start: "12:00", end: "13:00" }], closedDates: ["2028-02-29"],
  };
}

test("unverified public hours discard all purported opening and closing claims", () => {
  const parsed = parsePublicShopHours({ ...verifiedHours(), verified: false, privateReason: "Must not be rendered", closedDates: ["invalid"] });
  assert.deepEqual(parsed, { verified: false, timezone: "America/Chicago", weeklyHours: null, breaks: [], closedDates: [] });
  assert.equal(JSON.stringify(parsed).includes("Must not be rendered"), false);
});

test("verified public hours preserve split days, midnight closing and valid leap dates without transport aliases", () => {
  const supplied = verifiedHours();
  supplied.weeklyHours["0"] = [{ start: "00:00", end: "04:00" }, { start: "18:30", end: "24:00" }];
  supplied.capacity = 3;
  const parsed = parsePublicShopHours(supplied);
  assert.deepEqual(parsed.weeklyHours["0"], supplied.weeklyHours["0"]);
  assert.deepEqual(parsed.closedDates, ["2028-02-29"]);
  assert.equal(Object.hasOwn(parsed, "capacity"), false);
  parsed.weeklyHours["0"][0].start = "01:00";
  parsed.breaks[0].end = "12:30";
  parsed.closedDates.push("2028-03-01");
  assert.equal(supplied.weeklyHours["0"][0].start, "00:00");
  assert.equal(supplied.breaks[0].end, "13:00");
  assert.deepEqual(supplied.closedDates, ["2028-02-29"]);
});

test("missing, malformed and incomplete public-hour metadata cannot become confirmed hours", () => {
  for (const value of [undefined, null, [], {}, { ...verifiedHours(), verified: "true" }, { ...verifiedHours(), timezone: "Unknown/Nowhere" }, { ...verifiedHours(), timezone: "" }, { ...verifiedHours(), timezone: "A".repeat(101) }, { ...verifiedHours(), weeklyHours: [] }]) assert.throws(() => parsePublicShopHours(value), /could not be verified/);
  const missingDay = verifiedHours(); delete missingDay.weeklyHours["0"];
  assert.throws(() => parsePublicShopHours(missingDay), /could not be verified/);
  const extraDay = verifiedHours(); extraDay.weeklyHours["7"] = [];
  assert.throws(() => parsePublicShopHours(extraDay), /could not be verified/);
});

test("invalid, overlapping and unbounded intervals are rejected independently for hours and breaks", () => {
  for (const intervals of [null, {}, [{ start: "17:00", end: "08:00" }], [{ start: "24:00", end: "24:00" }], [{ start: "08:15", end: "08:15" }], [{ start: "08:00", end: "12:00" }, { start: "11:30", end: "14:00" }], [{ start: "13:00", end: "14:00" }, { start: "08:00", end: "09:00" }], [{ start: "8:00", end: "17:00" }], [{ start: "08:00", end: "17:00", privateNote: "Unrecognized" }], Array.from({ length: 25 }, () => ({ start: "08:00", end: "09:00" }))]) {
    const hours = verifiedHours(); hours.weeklyHours["1"] = intervals;
    assert.throws(() => parsePublicShopHours(hours), /could not be verified/);
    assert.throws(() => parsePublicShopHours({ ...verifiedHours(), breaks: intervals }), /could not be verified/);
  }
});

test("closed dates require unique strict Gregorian dates within the public bound", () => {
  for (const closedDates of [null, ["2030-02-29"], ["2028-02-30"], ["01/09/2030"], ["2030-01-01", "2030-01-01"], Array(1001).fill("2030-01-01")]) assert.throws(() => parsePublicShopHours({ ...verifiedHours(), closedDates }), /could not be verified/);
  assert.deepEqual(parsePublicShopHours({ ...verifiedHours(), closedDates: [] }).closedDates, []);
});

test("public-hour labels use local AM/PM and explain midnight at the end of a shop day", () => {
  assert.equal(formatPublicHoursInterval({ start: "08:15", end: "17:00" }), "8:15 AM–5:00 PM");
  assert.equal(formatPublicHoursInterval({ start: "12:00", end: "13:00" }), "12:00 PM–1:00 PM");
  assert.equal(formatPublicHoursInterval({ start: "18:30", end: "24:00" }), "6:30 PM–12:00 AM (end of day)");
  assert.equal(formatPublicHoursInterval({ start: "00:00", end: "04:00" }), "12:00 AM–4:00 AM");
});
