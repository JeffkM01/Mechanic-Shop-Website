import test from "node:test";
import assert from "node:assert/strict";
import { prepareAppointment } from "./appointmentInput.js";

const now = new Date(2026, 10, 3, 9, 0);
const good = {
  name: "  Demo Customer  ", email: " customer@example.com ",
  phone: "(555) 555-1234", vehicle: "2018 Honda Civic",
  service: "Brake Repairs", date: "2026-11-04", time: "10:30", notes: "Brake noise",
};

const requiredServices = [
  "Oil Change",
  "Tire Rotation",
  "Cabin Air Filter Replacement",
  "Engine Air Filter Replacement",
  "Wiper Blade Replacement",
  "Brake Repairs",
  "AC & Heating Repair",
  "Engine Diagnostics",
  "Other / Not Sure",
];

test("accepts a valid request and trims text", () => {
  const result = prepareAppointment(good, now);
  assert.equal(result.error, undefined);
  assert.equal(result.value.name, "Demo Customer");
  assert.equal(result.value.email, "customer@example.com");
});

for (const service of requiredServices) {
  test(`accepts and preserves the appointment service ${service}`, () => {
    const result = prepareAppointment({ ...good, service }, now);
    assert.equal(result.error, undefined);
    assert.equal(result.value.service, service);
  });
}

test("accepts legacy Air Filter Change without rewriting existing service names", () => {
  const result = prepareAppointment({ ...good, service: "Air Filter Change" }, now);
  assert.equal(result.error, undefined);
  assert.equal(result.value.service, "Air Filter Change");
});

test("trims new maintenance service names before validation", () => {
  const result = prepareAppointment({ ...good, service: "  Tire Rotation  " }, now);
  assert.equal(result.error, undefined);
  assert.equal(result.value.service, "Tire Rotation");
});

test("rejects unknown or malformed service selections without producing data", () => {
  for (const service of ["Custom Admin Service", "Air Filter Replacement", "Oil change", "__proto__", "", " ", null, undefined, 42, true, {}, [], ["Oil Change"]]) {
    const result = prepareAppointment({ ...good, service }, now);
    assert.match(result.error, /service/i);
    assert.equal(result.value, undefined);
  }
});

test("prevents a client from setting status or appointment ID", () => {
  const result = prepareAppointment({ ...good, status: "confirmed", _id: "bad" }, now);
  assert.equal(result.value.status, undefined);
  assert.equal(result.value._id, undefined);
});

test("rejects missing or malformed contact information", () => {
  assert.match(prepareAppointment({ ...good, email: "bad" }, now).error, /email/i);
  assert.match(prepareAppointment({ ...good, phone: "123" }, now).error, /phone/i);
  assert.match(prepareAppointment({ ...good, name: null }, now).error, /name/i);
});

test("rejects Sunday and invalid services", () => {
  assert.match(prepareAppointment({ ...good, date: "2026-11-08" }, now).error, /Sunday/i);
  assert.match(prepareAppointment({ ...good, service: "Custom Admin Service" }, now).error, /service/i);
});

test("rejects oversized fields and invalid request bodies", () => {
  assert.match(prepareAppointment({ ...good, notes: "a".repeat(1001) }, now).error, /1000/);
  assert.ok(prepareAppointment(null, now).error);
  assert.ok(prepareAppointment([], now).error);
});

test("optional notes default to empty", () => {
  const withoutNotes = { ...good };
  delete withoutNotes.notes;
  const result = prepareAppointment(withoutNotes, now);
  assert.equal(result.value.notes, "");
});

test("server input accepts supported U.S. phone formats without rewriting the stored number", () => {
  for (const phone of ["6365551234", "636-555-1234", "(636) 555-1234", "636 555 1234", "+1 636-555-1234", "16365551234"]) {
    const result = prepareAppointment({ ...good, phone: ` ${phone} ` }, now);
    assert.equal(result.error, undefined, phone);
    assert.equal(result.value.phone, phone, phone);
  }
});

test("server rejects malformed phone input even if removing characters would leave valid digits", () => {
  for (const phone of ["636ABC5551234", "636A5551234", "636-55A-1234", "636-555-123", "63655512345", "+44 6365551234", "636.555.1234", "6365551234\n", "6365551234+1"]) {
    const result = prepareAppointment({ ...good, phone }, now, { schedulingAuthoritative: true });
    assert.ok(result.fields.phone, phone);
    assert.equal(result.error, result.fields.phone, phone);
    assert.equal(result.value, undefined, phone);
  }
});

test("server provides all field corrections without returning or mutating customer data", () => {
  const body = { ...good, name: "", email: "bad", phone: "636ABC5551234", vehicle: "", notes: "Please keep my note" };
  const before = structuredClone(body);
  const result = prepareAppointment(body, now, { schedulingAuthoritative: true });
  assert.deepEqual(Object.keys(result.fields), ["name", "email", "phone", "vehicle"]);
  assert.match(result.fields.phone, /Letters are not allowed/);
  assert.equal(result.value, undefined);
  assert.equal(JSON.stringify(result).includes(body.notes), false);
  assert.deepEqual(body, before);
});

test("server keeps unknown decision, scheduling, and status fields outside prepared customer data", () => {
  const result = prepareAppointment({ ...good, status: "declined", decline: { category: "other", explanation: "Forged decision" }, scheduling: { durationMinutes: 1 }, notificationState: { decisionCustomer: "sent" } }, now);
  assert.equal(result.error, undefined);
  assert.deepEqual(Object.keys(result.value), ["name", "email", "phone", "vehicle", "service", "date", "time", "notes"]);
});

test("server accepts one bare plus-addressed mailbox and preserves its entered text", () => {
  const email = "Customer+oil@auto-shop.example.invalid";
  const body = { ...good, email: ` ${email} ` };
  const before = structuredClone(body);
  const result = prepareAppointment(body, now);
  assert.equal(result.error, undefined);
  assert.equal(result.value.email, email);
  assert.deepEqual(body, before);
});

test("server rejects recipient-list or display-name syntax and malformed email even without browser validation", () => {
  for (const email of [
    "name<person@example.com>", "first,last@example.com", "person@example.com,second", "person@example.com;second",
    "person..name@example.com", ".person@example.com", "person@example-.com", "person@bad_domain.example",
    '"person"@example.com', "person@例え.テスト", "person@example.com\n", "person@example.com\r\nBcc: victim@example.com",
  ]) {
    const result = prepareAppointment({ ...good, email }, now, { schedulingAuthoritative: true });
    assert.equal(result.fields.email, "Please enter a valid email address.", email);
    assert.equal(result.value, undefined, email);
  }
});
