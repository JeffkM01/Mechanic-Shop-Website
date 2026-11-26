import test from "node:test";
import assert from "node:assert/strict";
import { buildEmail, EMAIL_KINDS } from "./emailTemplates.js";

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

test("pending receipts separate timing, customer, mobile review, reservation and next steps", () => {
  const appointment = mobile();
  appointment.scheduling.holdExpiresAt = "2030-01-07T18:00:00.000Z";
  for (const kind of ["requestCustomer", "requestMechanic"]) {
    const { text } = buildEmail(kind, appointment, options);
    assert.match(text, /\n\nAppointment details\nReference: [^\n]+\nService: [^\n]+\nRequested time: /);
    assert.match(text, /Estimated booking duration: 30 minutes\n\(not a guaranteed repair completion time\)\./);
    assert.match(text, /\n\nCustomer and vehicle\nCustomer: Synthetic Customer\nVehicle: 2020 Example Vehicle/);
    assert.match(text, /\n\nMobile visit\nMobile service location: Synthetic City, MO 63301/);
    assert.match(text, /75 minutes\n\(a scheduling estimate, not a price or guaranteed arrival time\)\.\n\nThis mobile request requires mechanic review/);
    assert.match(text, /\n\nProvisional reservation\nThe provisional time reservation expires at /);
    assert.match(text, /request remains on file after expiry, but availability must be checked again before approval\.\n\nNext steps\n/);
    if (kind === "requestMechanic") {
      assert.match(text, /Vehicle: 2020 Example Vehicle\nEmail: customer@example.invalid\nPhone: 555-555-0148\nNotes: Synthetic appointment only\.\n\nMobile visit/);
      assert.match(text, /Next steps\nThis request has NOT been approved yet\./);
    } else {
      assert.match(text, /Next steps\nWe will contact you after the request is reviewed\.\n\nManage appointment\n/);
    }
  }
});

test("all message kinds and delayed states keep readable sections, headers and final newlines", () => {
  const cancellation = {
    by: "customer", category: "plans_changed", message: "Synthetic plans changed.",
    cancelledAt: "2030-01-07T14:00:00.000Z", originalDate: sample.date, originalTime: sample.time, timezone: "America/Chicago",
  };
  const cases = [
    { kind: "requestCustomer", status: "pending", state: /It is PENDING until the mechanic approves it/ },
    { kind: "requestMechanic", status: "pending", state: /This request has NOT been approved yet/ },
    { kind: "requestCustomer", status: "confirmed", state: /already reviewed.*separate appointment decision email/ },
    { kind: "requestMechanic", status: "confirmed", state: /already been CONFIRMED by the mechanic/ },
    { kind: "decisionCustomer", status: "confirmed", state: /has been CONFIRMED/ },
    { kind: "requestMechanic", status: "declined", state: /already been declined by the mechanic/ },
    { kind: "decisionCustomer", status: "declined", state: /This request has been declined/ },
    { kind: "requestMechanic", status: "cancelled", state: /already been CANCELLED/ },
    { kind: "cancellationCustomer", status: "cancelled", state: /has been cancelled as you requested/ },
    { kind: "cancellationMechanic", status: "cancelled", state: /It is no longer an active appointment/ },
    { kind: "cancellationCustomer", status: "cancelled", by: "mechanic", state: /shop has cancelled your/ },
  ];
  assert.deepEqual(new Set(cases.map(item => item.kind)), new Set(EMAIL_KINDS));
  for (const item of cases) {
    for (const withMobile of [false, true]) {
      const appointment = { ...(withMobile ? mobile() : sample), status: item.status,
        decline: { explanation: "Synthetic coverage cannot be accommodated." },
        cancellation: item.by === "mechanic"
          ? { ...cancellation, by: "mechanic", category: "equipment_unavailable", explanation: "Synthetic equipment is unavailable." }
          : cancellation,
      };
      const message = buildEmail(item.kind, appointment, options);
      const staff = item.kind === "requestMechanic" || item.kind === "cancellationMechanic";
      assert.equal(message.from, options.from);
      assert.equal(message.to, staff ? options.mechanicEmail : sample.email);
      assert.equal(message.replyTo, staff ? sample.email : options.mechanicEmail);
      assert.equal(Object.hasOwn(message, "html"), false);
      assert.match(message.text, item.state, `${item.kind}/${item.status}`);
      assert.match(message.text, /\n\nAppointment details\nReference: /);
      assert.match(message.text, /\n\nCustomer and vehicle\nCustomer: Synthetic Customer\nVehicle: 2020 Example Vehicle/);
      assert.match(message.text, /[^\n]\n$/, "every message ends with one newline");
      assert.doesNotMatch(message.text, /\n{3,}/, "optional sections leave no empty blocks");
      if (withMobile) assert.match(message.text, /\n\nMobile visit\n/);
      else assert.doesNotMatch(message.text, /Mobile visit|Mobile service location|travel planning allowance/);
      assert.doesNotMatch(message.text, /Provisional reservation/, "missing hold metadata does not invent a reservation");
      if (item.status === "declined") {
        assert.match(message.text, /\n\nDecision details\n(?:Customer-facing decline reason|Reason): Synthetic coverage cannot be accommodated\./);
        assert.doesNotMatch(message.text, /PENDING|has been CONFIRMED|requires mechanic review/);
      }
      if (item.kind.startsWith("cancellation")) {
        assert.match(message.text, /\n\nCancellation details\nCancelled at: [^\n]+\nCancelled by: /);
        assert.match(message.text, /\n\nNext steps\n/);
        assert.match(message.text, item.by === "mechanic"
          ? /\n\nReason category: Equipment unavailable\nReason: Synthetic equipment is unavailable\./
          : /\n\nCustomer reason: My plans changed\nCustomer message: Synthetic plans changed\./);
        assert.doesNotMatch(message.text, /PENDING|has been CONFIRMED|requires mechanic review/);
      }
    }
  }
});

test("management sections preserve the private fragment link exactly and retain the contact fallback", () => {
  const managementLink = "https://shop.example.invalid/manage-appointment#token=synthetic-fragment%2B%2F%3D";
  const cancelled = { ...sample, status: "cancelled", cancellation: { by: "customer", category: "plans_changed" } };
  for (const [kind, appointment] of [
    ["requestCustomer", sample],
    ["decisionCustomer", { ...sample, status: "confirmed" }],
    ["cancellationCustomer", cancelled],
  ]) {
    const linked = buildEmail(kind, appointment, { ...options, managementLink });
    assert.ok(linked.text.includes(`\n\nManage appointment\nManage this appointment securely: ${managementLink}\n\nKeep this private link to yourself. It authorizes access to this appointment.\n\n`));
    assert.equal(linked.text.split("\n").filter(line => line.includes("https://")).length, 1);
    const fallback = buildEmail(kind, appointment, options);
    assert.match(fallback.text, /\n\nManage appointment\nTo manage this appointment, please contact the shop by replying to this email\./);
    assert.doesNotMatch(fallback.text, /manage-appointment|token=/);
  }
  for (const [kind, appointment] of [
    ["requestMechanic", sample],
    ["decisionCustomer", { ...sample, status: "declined" }],
    ["cancellationMechanic", cancelled],
  ]) {
    const { text } = buildEmail(kind, appointment, { ...options, managementLink });
    assert.doesNotMatch(text, /Manage appointment|manage-appointment|token=/, "formatting does not add private links to additional message kinds");
  }
});
