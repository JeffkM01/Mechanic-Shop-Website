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
