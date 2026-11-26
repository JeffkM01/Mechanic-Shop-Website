import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MOBILE_BOOKING_POLICY, prepareMobileLocation, prepareMobileReview, validateMobileBookingPolicy } from "./mobileBooking.js";

test("mobile policy preserves explicit manual review and rejects malformed or automatic overrides", () => {
  assert.equal(validateMobileBookingPolicy(), null);
  assert.deepEqual(validateMobileBookingPolicy(DEFAULT_MOBILE_BOOKING_POLICY), { travelBufferMinutes: 75, requiresMechanicApproval: true });
  assert.equal(Object.isFrozen(validateMobileBookingPolicy(DEFAULT_MOBILE_BOOKING_POLICY)), true);
  for (const value of [[], {}, true, { ...DEFAULT_MOBILE_BOOKING_POLICY, requiresMechanicApproval: false },
    { ...DEFAULT_MOBILE_BOOKING_POLICY, travelBufferMinutes: "75" }, { ...DEFAULT_MOBILE_BOOKING_POLICY, travelBufferMinutes: -1 },
    { ...DEFAULT_MOBILE_BOOKING_POLICY, travelBufferMinutes: 121 }, { ...DEFAULT_MOBILE_BOOKING_POLICY, travelBufferMinutes: 75.5 },
    { ...DEFAULT_MOBILE_BOOKING_POLICY, secret: "not-public" }]) assert.throws(() => validateMobileBookingPolicy(value));
});

test("mobile location normalizes only city/state/ZIP and never treats format as geographic verification", () => {
  const source = { city: "  Synthetic Town ", state: " il ", postalCode: " 01234-5678 ", mobileVisit: { reviewedAt: "forged" }, streetAddress: "not-copied" };
  assert.deepEqual(prepareMobileLocation(source), { value: { city: "Synthetic Town", state: "IL", postalCode: "01234-5678" } });
  assert.equal(source.city, "  Synthetic Town ");
  assert.deepEqual(prepareMobileLocation({ city: "Unknown city", state: "MO", postalCode: "12345" }).value,
    { city: "Unknown city", state: "MO", postalCode: "12345" });
});

test("mobile input reports bounded field corrections and rejects control injection and malformed ZIP/state", () => {
  assert.deepEqual(Object.keys(prepareMobileLocation({}).fields).sort(), ["city", "postalCode", "state"]);
  for (const [key, values] of Object.entries({ city: [null, [], "", "x".repeat(81), "Town\nInjected"],
    state: [null, "CA", "Missouri", "MO\r\n"], postalCode: [null, 12345, "1234", "123456", "12345-678", "12345\n"] })) {
    for (const value of values) {
      const result = prepareMobileLocation({ city: "Synthetic Town", state: "MO", postalCode: "12345", [key]: value });
      assert.equal(typeof result.fields?.[key], "string", key);
      assert.equal(result.value, undefined);
    }
  }
});

test("mobile approval requires explicit acknowledgments and cannot shrink a committed travel snapshot", () => {
  const input = { locationConfirmed: true, travelConfirmed: true, travelBufferMinutes: 90 };
  assert.deepEqual(prepareMobileReview(input, 75), { value: input });
  assert.deepEqual(prepareMobileReview({ ...input, travelBufferMinutes: 120 }, 120).value.travelBufferMinutes, 120);
  for (const value of [undefined, null, [], { ...input, reviewedAt: "forged" }, { ...input, locationConfirmed: "true" },
    { ...input, travelConfirmed: false }, { ...input, travelBufferMinutes: 74 }, { ...input, travelBufferMinutes: 121 },
    { ...input, travelBufferMinutes: "90" }, { ...input, travelBufferMinutes: 90.5 }]) assert.equal(typeof prepareMobileReview(value, 75).error, "string");
  for (const minimum of [undefined, NaN, "75", -1, 121]) assert.equal(typeof prepareMobileReview(input, minimum).fields.travelBufferMinutes, "string");
});
