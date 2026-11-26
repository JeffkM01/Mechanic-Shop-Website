import test from "node:test";
import assert from "node:assert/strict";
import { buildEmail } from "./emailTemplates.js";

const options = { from: "shop@example.invalid", mechanicEmail: "mechanic@example.invalid" };
const sample = {
  _id: "0123456789abcdef01234567", name: "Synthetic Customer", email: "customer@example.invalid",
  phone: "555-555-0148", vehicle: "2020 Example Vehicle", service: "Wiper Blade Replacement",
  date: "2030-01-08", time: "09:00", status: "pending", notes: "Synthetic appointment only.",
};
const mobile = () => ({
  ...sample,
  scheduling: { timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: 75 },
  mobileVisit: { city: "Synthetic City", state: "MO", postalCode: "63301", travelBufferMinutes: 75 },
});

test("legacy appointment mail retains its existing receipt, headers and contact fallback", () => {
  const message = buildEmail("requestCustomer", sample, options);
  assert.equal(message.from, options.from);
  assert.equal(message.to, sample.email);
  assert.equal(message.replyTo, options.mechanicEmail);
  assert.equal(message.subject, "Ed's Auto Shop — appointment request received");
  assert.match(message.text, /It is PENDING until the mechanic approves it/);
  assert.match(message.text, /A secure online management link is not available in this message/);
  assert.doesNotMatch(message.text, /Mobile service location|travel planning|recorded a coverage/);
  assert.equal(Object.hasOwn(message, "html"), false);
});

test("mobile pending customer and mechanic mail explains coverage review and separate travel planning", () => {
  const appointment = mobile();
  appointment.mobileVisit.fullStreetAddress = "DO-NOT-SEND-PRIVATE-STREET";
  appointment.mobileVisit.internalReviewToken = "DO-NOT-SEND-PRIVATE-REVIEW-TOKEN";
  appointment.management = { nonce: "DO-NOT-SEND-MANAGEMENT-NONCE", tokenHash: "DO-NOT-SEND-HASH" };
  for (const kind of ["requestCustomer", "requestMechanic"]) {
    const message = buildEmail(kind, appointment, options);
    assert.match(message.text, /Mobile service location: Synthetic City, MO 63301/);
    assert.match(message.text, /Estimated booking duration: 30 minutes/);
    assert.match(message.text, /Recorded travel planning allowance after service: 75 minutes/);
    assert.match(message.text, /a scheduling estimate, not a price or guaranteed arrival time/);
    assert.match(message.text, /requires mechanic review of coverage, visit location, and travel before confirmation/);
    assert.match(message.text, /full service address is arranged privately/);
    assert.doesNotMatch(message.text, /DO-NOT-SEND|automatically|has been CONFIRMED/);
    assert.equal(Object.hasOwn(message, "html"), false);
  }
});

test("mobile confirmation describes a review only when the saved acknowledgments exist", () => {
  const appointment = { ...mobile(), status: "confirmed" };
  const unreviewed = buildEmail("decisionCustomer", appointment, options);
  assert.match(unreviewed.text, /Check the visit location and travel arrangements with the mechanic/);
  assert.doesNotMatch(unreviewed.text, /recorded a coverage and travel review/);
  appointment.mobileVisit.locationConfirmed = true;
  appointment.mobileVisit.travelConfirmed = true;
  appointment.mobileVisit.reviewedAt = new Date("2030-01-07T12:00:00.000Z");
  appointment.scheduling.bufferMinutes = 120;
  const reviewed = buildEmail("decisionCustomer", appointment, options);
  assert.match(reviewed.text, /has been CONFIRMED/);
  assert.match(reviewed.text, /recorded a coverage and travel review/);
  assert.match(reviewed.text, /travel planning allowance after service: 120 minutes/);
  assert.doesNotMatch(reviewed.text, /requires mechanic review|travel planning allowance after service: 75 minutes/);
});

test("terminal mobile notifications retain final reasons without presenting the visit as pending or occupied", () => {
  const declined = { ...mobile(), status: "declined", decline: { explanation: "Synthetic coverage cannot be accommodated." } };
  const declineMail = buildEmail("decisionCustomer", declined, options);
  assert.match(declineMail.text, /Synthetic coverage cannot be accommodated/);
  assert.match(declineMail.text, /Mobile service location: Synthetic City/);
  assert.doesNotMatch(declineMail.text, /requires mechanic review|has been CONFIRMED/);
  const cancelled = { ...mobile(), status: "cancelled", cancellation: {
    by: "customer", category: "plans_changed", cancelledAt: "2030-01-07T14:00:00.000Z",
    originalDate: sample.date, originalTime: sample.time, timezone: "America/Chicago",
  } };
  for (const kind of ["cancellationCustomer", "cancellationMechanic"]) {
    const message = buildEmail(kind, cancelled, options);
    assert.match(message.text, /cancelled/i);
    assert.match(message.text, /Mobile service location: Synthetic City, MO 63301/);
    assert.match(message.text, /Recorded travel planning allowance/);
    assert.doesNotMatch(message.text, /requires mechanic review|recorded a coverage and travel review|has been CONFIRMED/);
  }
});

test("invalid mobile details fail with fixed diagnostics and cannot inject recipients or headers", () => {
  for (const change of [{ city: "City\nBcc: hidden@example.invalid" }, { state: "NY" }, { postalCode: "63301\r\nInjected" }, { travelBufferMinutes: Infinity }]) {
    const appointment = mobile();
    Object.assign(appointment.mobileVisit, change);
    if (Object.hasOwn(change, "travelBufferMinutes")) appointment.scheduling.bufferMinutes = change.travelBufferMinutes;
    assert.throws(() => buildEmail("requestCustomer", appointment, options), error => {
      assert.equal(error.message, "Mobile notification details need review before email can be sent.");
      assert.doesNotMatch(error.message, /hidden@example|Injected|Infinity/);
      return true;
    });
  }
  const appointment = mobile();
  appointment.mobileVisit.city = "<b>Synthetic City</b>";
  const message = buildEmail("requestCustomer", appointment, options);
  assert.equal(message.to, sample.email);
  assert.equal(message.replyTo, options.mechanicEmail);
  assert.equal(message.subject, "Ed's Auto Shop — appointment request received");
  assert.match(message.text, /<b>Synthetic City<\/b>/);
  assert.equal(Object.hasOwn(message, "html"), false, "location values stay plain text rather than executable HTML");
});
