import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES } from "../../shared/services.js";
import {
  fieldLimits, isValidEmailAddress, isValidUsPhone, localDateString, validateAppointment,
  validateAppointmentFields, validateUsPhone,
} from "./appointmentValidation.js";

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

const customService = {
  name: "Suspension Repair", category: "repairs", icon: "wrench", description: "Suspension concerns for mechanic review.",
  active: true, provisional: false, appointmentOnly: false, legacyNames: [],
};

test("customer validation accepts only services in the current active catalog", () => {
  const serviceCatalog = [...structuredClone(SERVICES), customService];
  assert.deepEqual(validateAppointmentFields({ ...request, service: customService.name }, now, { serviceCatalog }), {});
  assert.equal(validateAppointmentFields({ ...request, service: customService.name }, now).service, "Please select a valid service.");
  const inactive = serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: false } : service);
  assert.equal(validateAppointmentFields({ ...request, service: "Oil Change" }, now, { serviceCatalog: inactive }).service, "Please select a valid service.");
});

test("dynamic catalog validation preserves accepted historical names without silently rewriting requests", () => {
  const legacy = { ...request, service: "Air Filter Change" };
  assert.deepEqual(validateAppointmentFields(legacy, now, { serviceCatalog: structuredClone(SERVICES) }), {});
  assert.equal(legacy.service, "Air Filter Change");
});

test("server-deferred catalog membership still enforces required strings and bounded fields", () => {
  const options = { schedulingAuthoritative: true, serviceCatalog: [], deferServiceValidation: true };
  assert.deepEqual(validateAppointmentFields({ ...request, service: customService.name }, now, options), {});
  for (const service of [null, {}, "", "a".repeat(fieldLimits.service + 1)]) {
    assert.ok(validateAppointmentFields({ ...request, service }, now, options).service);
  }
  assert.ok(validateAppointmentFields({ ...request, email: "bad address", service: customService.name }, now, options).email);
});

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

test("scheduling-authoritative validation leaves shop calendar decisions to the server", () => {
  assert.equal(validateAppointment({ ...request, date: "2026-11-08" }, now, { schedulingAuthoritative: true }), null);
  assert.equal(validateAppointment({ ...request, date: "2026-11-02" }, now, { schedulingAuthoritative: true }), null);
  assert.match(validateAppointment({ ...request, date: "2026-02-30" }, now, { schedulingAuthoritative: true }), /valid date/);
  assert.match(validateAppointment({ ...request, time: "25:00" }, now, { schedulingAuthoritative: true }), /valid time/);
});

test("accepts common U.S. phone formats and an optional leading U.S. country code", () => {
  for (const phone of [
    "6365551234", "636-555-1234", "(636) 555-1234", "636 555 1234", "+1 636-555-1234",
    "+16365551234", "16365551234", "1-636-555-1234", "+1 (636) 555-1234", "(636)5551234",
    " 636-555-1234 ",
  ]) {
    assert.equal(isValidUsPhone(phone), true, phone);
    assert.equal(validateUsPhone(phone), null, phone);
    assert.deepEqual(validateAppointmentFields({ ...request, phone }, now), {}, phone);
  }
});

test("rejects letters even when removing them would leave exactly ten phone digits", () => {
  for (const phone of ["636-55A-1234", "636ABC5551234", "123ABC4567", "636A5551234", "636-555-1234 ext9"]) {
    assert.equal(isValidUsPhone(phone), false, phone);
    assert.match(validateUsPhone(phone), /Letters are not allowed/, phone);
    assert.match(validateAppointmentFields({ ...request, phone }, now).phone, /Letters are not allowed/, phone);
  }
});

test("rejects unsupported punctuation, lengths, parentheses, and misplaced country prefixes", () => {
  for (const phone of [
    "636-555-123", "63655512345", "26365551234", "+44 6365551234", "+11 6365551234",
    "636+15551234", "6365551234+1", "++16365551234", "636.555.1234", "636/555/1234",
    "(6365551234", "636)5551234", "636-(555)-1234", "636--555-1234", "636_555_1234",
    "636\t5551234", "636\n5551234", "6365551234\n", "6365551234#", "", null, 6365551234, {},
  ]) {
    assert.equal(isValidUsPhone(phone), false, String(phone));
    assert.ok(validateAppointmentFields({ ...request, phone }, now).phone, String(phone));
  }
});

test("returns all relevant field errors in order and preserves the original customer entries", () => {
  const form = { ...request, name: " ", email: "not-an-email", phone: "636ABC5551234", vehicle: "", notes: "Keep this note" };
  const before = structuredClone(form);
  const errors = validateAppointmentFields(form, now);
  assert.deepEqual(Object.keys(errors), ["name", "email", "phone", "vehicle"]);
  assert.equal(errors.name, "Please enter your full name.");
  assert.equal(errors.email, "Please enter a valid email address.");
  assert.match(errors.phone, /Letters are not allowed/);
  assert.match(errors.vehicle, /year, make, and model/);
  assert.equal(validateAppointment(form, now), errors.name);
  assert.deepEqual(form, before);
  assert.deepEqual(validateAppointmentFields({ ...form, name: request.name, email: request.email, phone: request.phone, vehicle: request.vehicle }, now), {});
});

test("reports missing selections, non-text fields, and optional-note limits without throwing", () => {
  assert.deepEqual(Object.keys(validateAppointmentFields({}, now)), ["name", "email", "phone", "vehicle", "service", "date", "time"]);
  assert.deepEqual(Object.keys(validateAppointmentFields(null, now)), ["name", "email", "phone", "vehicle", "service", "date", "time"]);
  assert.match(validateAppointmentFields({ ...request, notes: {} }, now).notes, /notes as text/);
  for (const field of ["name", "email", "phone", "vehicle"]) {
    assert.ok(validateAppointmentFields({ ...request, [field]: {} }, now)[field]);
  }
  assert.deepEqual(validateAppointmentFields({ ...request, notes: "n".repeat(fieldLimits.notes) }, now), {});
  assert.match(validateAppointmentFields({ ...request, notes: "n".repeat(fieldLimits.notes + 1) }, now).notes, /1000/);
  assert.deepEqual(validateAppointmentFields({ ...request, notes: undefined }, now), {});
});

test("validates exact text boundaries and strict leap dates in scheduling-authoritative mode", () => {
  for (const field of ["name", "vehicle"]) {
    assert.equal(validateAppointmentFields({ ...request, [field]: "a".repeat(fieldLimits[field]) }, now)[field], undefined);
    assert.match(validateAppointmentFields({ ...request, [field]: "a".repeat(fieldLimits[field] + 1) }, now)[field], new RegExp(String(fieldLimits[field])));
  }
  assert.deepEqual(validateAppointmentFields({ ...request, date: "2028-02-29" }, now, { schedulingAuthoritative: true }), {});
  for (const date of ["2027-02-29", "2028-04-31", "0000-01-01", "11/04/2026"]) {
    assert.ok(validateAppointmentFields({ ...request, date }, now, { schedulingAuthoritative: true }).date, date);
  }
});

test("accepts a single conventional bare email address including plus addressing", () => {
  for (const email of [
    "customer@example.invalid", "customer+oil@example.com", "First.Last+car@auto-shop.example.com",
    "o'brien@example.com", "a".repeat(64) + "@example.com", " customer@example.com ",
    "customer@xn--bcher-kva.example",
  ]) {
    assert.equal(isValidEmailAddress(email), true, email);
    assert.equal(validateAppointmentFields({ ...request, email }, now).email, undefined, email);
  }
});

test("rejects email display names, recipient lists, controls, and invalid domain or dot syntax", () => {
  for (const email of [
    "name<person@example.com>", "first,last@example.com", "person@example.com,second", "person@example.com;second",
    ".person@example.com", "person.@example.com", "per..son@example.com", "person@foo..com",
    "person@-example.com", "person@example-.com", "person@bad_domain.example", "person@" + "a".repeat(64) + ".com",
    '"person"@example.com', '"first,last"@example.com', "üser@example.com", "person@例え.テスト",
    "person@[127.0.0.1]", "person@example.com\n", "\tperson@example.com", "person@example.com\r\nBcc: another@example.com",
    "a".repeat(65) + "@example.com", "person@@example.com", "person@example", "person@.example.com",
  ]) {
    assert.equal(isValidEmailAddress(email), false, email);
    assert.equal(validateAppointmentFields({ ...request, email }, now).email, "Please enter a valid email address.", email);
  }
  assert.equal(isValidEmailAddress(`a@${[63, 63, 63, 60].map(length => "x".repeat(length)).join(".")}`), true);
  assert.equal(isValidEmailAddress(`a@${[63, 63, 63, 61].map(length => "x".repeat(length)).join(".")}`), false);
});
