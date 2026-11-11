import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES, SERVICE_CATEGORIES, ACCEPTED_SERVICE_NAMES, getAppointmentLink, getServiceSelection, getService, isValidServiceName } from "./services.js";

const maintenance = ["Oil Change", "Tire Rotation", "Cabin Air Filter Replacement", "Engine Air Filter Replacement", "Wiper Blade Replacement"];
const repairs = ["Brake Repairs", "AC & Heating Repair", "Engine Diagnostics"];

test("catalog separates five maintenance and three public repair services", () => {
  assert.deepEqual(SERVICE_CATEGORIES.map(category => category.label), ["Basic Maintenance", "Repairs & Diagnostics"]);
  assert.deepEqual(SERVICES.filter(service => service.category === "maintenance").map(service => service.name), maintenance);
  assert.deepEqual(SERVICES.filter(service => service.category === "repairs" && !service.appointmentOnly).map(service => service.name), repairs);
  assert.equal(getService("Other / Not Sure").appointmentOnly, true);
  assert.equal(new Set(ACCEPTED_SERVICE_NAMES).size, ACCEPTED_SERVICE_NAMES.length);
});

test("unconfirmed suggestions stay provisional while Edward's confirmed wiper service is available", () => {
  assert.deepEqual(SERVICES.filter(service => service.provisional).map(service => service.name), ["Tire Rotation", "Cabin Air Filter Replacement"]);
  assert.equal(getService("Wiper Blade Replacement").provisional, false);
  assert.equal(getService("Air Filter Change").name, "Engine Air Filter Replacement");
  assert.equal(isValidServiceName("Air Filter Change"), true);
});

test("all service booking links round-trip through encoded query preselection", () => {
  for (const name of [...maintenance, ...repairs, "Other / Not Sure"]) {
    const link = getAppointmentLink(name);
    const url = new URL(link, "https://example.invalid");
    assert.equal(url.pathname, "/appointment");
    assert.equal(url.searchParams.get("service"), name);
    assert.equal(getServiceSelection(url.search), name);
  }
  assert.match(getAppointmentLink("AC & Heating Repair"), /%26/);
});

test("old filter links preselect the modern name without rewriting saved records", () => {
  assert.equal(getServiceSelection("?service=Air%20Filter%20Change"), "Engine Air Filter Replacement");
  assert.equal(getServiceSelection(new URL(getAppointmentLink("Air Filter Change"), "https://example.invalid").search), "Engine Air Filter Replacement");
});

test("unknown and malformed service query values cannot become form choices", () => {
  for (const search of ["", "?service=", "?service=Custom+Admin+Service", "?service=oil+change", "?service=%3Cscript%3E", "?service=%E0%A4%A", "?other=Oil+Change", "?service=Unknown&service=Oil+Change"]) {
    assert.equal(getServiceSelection(search), "");
  }
  assert.equal(getAppointmentLink("unknown"), "/appointment");
});
