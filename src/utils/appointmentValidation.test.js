import test from "node:test";
import assert from "node:assert/strict";
import { localDateString, validateAppointment } from "./appointmentValidation.js";

const now = new Date(2026, 10, 3, 9, 0); // Tuesday, November 3, 2026 at 9am
const request = {
  name: "Demo Customer", email: "customer@example.com", phone: "(555) 555-1234",
  vehicle: "2018 Honda Civic", service: "Brake Repairs", date: "2026-11-04",
  time: "10:30", notes: "Brake noise",
};

// Keep this contract explicit: deriving it from the catalog would miss a service
// accidentally removed from both the dropdown and its validation.
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

test("formats local dates without a UTC offset", () => {
  assert.equal(localDateString(now), "2026-11-03");
});

test("accepts a valid appointment request", () => {
  assert.equal(validateAppointment(request, now), null);
});

for (const service of requiredServices) {
  test(`accepts the appointment service ${service}`, () => {
    assert.equal(validateAppointment({ ...request, service }, now), null);
  });
}

test("accepts the legacy Air Filter Change service", () => {
  assert.equal(validateAppointment({ ...request, service: "Air Filter Change" }, now), null);
});

test("rejects unknown and incorrectly cased service names", () => {
  for (const service of ["Custom Admin Service", "Air Filter Replacement", "Oil change", "__proto__"]) {
    assert.match(validateAppointment({ ...request, service }, now), /service/i);
  }
});

test("rejects missing or non-string service selections", () => {
  for (const service of ["", " ", null, undefined, 42, true, {}, [], ["Oil Change"]]) {
    assert.match(validateAppointment({ ...request, service }, now), /service/i);
  }
});

test("requires contact information", () => {
  assert.match(validateAppointment({ ...request, phone: "" }, now), /phone number/);
});

test("rejects invalid email and phone", () => {
  assert.match(validateAppointment({ ...request, email: "invalid" }, now), /email/);
  assert.match(validateAppointment({ ...request, phone: "123" }, now), /phone/);
});

test("rejects Sundays", () => {
  assert.match(validateAppointment({ ...request, date: "2026-11-08" }, now), /Sundays/);
});

test("rejects past dates and times", () => {
  assert.match(validateAppointment({ ...request, date: "2026-11-02" }, now), /future date/);
  assert.match(validateAppointment({ ...request, date: "2026-11-03", time: "08:30" }, now), /future time/);
});

test("rejects malformed date and time", () => {
  assert.match(validateAppointment({ ...request, date: "2026-02-30" }, now), /valid date/);
  assert.match(validateAppointment({ ...request, time: "99:99" }, now), /valid time/);
});
