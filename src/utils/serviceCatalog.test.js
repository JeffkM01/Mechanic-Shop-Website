import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES, getService, getServiceSelection, getAppointmentLink, isValidServiceName, requiresMechanicApproval } from "../../shared/services.js";
import { getServiceCatalog, validateServiceCatalog, SERVICE_CATALOG_MAX, SERVICE_DESCRIPTION_MAX } from "../../shared/serviceCatalog.js";

const copy = () => structuredClone(SERVICES);
const custom = (name = "Suspension Repair") => ({ name, category: "repairs", icon: "wrench", description: "Inspection and repair of suspension concerns after mechanic review.", active: true, provisional: false, appointmentOnly: false, legacyNames: [] });

test("default catalog keeps every current service without adding or removing owner examples", () => {
  const catalog = validateServiceCatalog(copy());
  assert.deepEqual(catalog, SERVICES);
  assert.equal(catalog.some(service => service.name === "Oil Change" && service.active), true);
  assert.equal(catalog.some(service => service.name === "Suspension Repair"), false);
  assert.equal(getServiceCatalog({}), SERVICES);
  assert.equal(getServiceCatalog({ serviceCatalog: catalog }), catalog);
  assert.equal(getServiceCatalog({ serviceCatalog: null }), null);
  assert.throws(() => validateServiceCatalog(getServiceCatalog({ serviceCatalog: null })), /between 1/);
});

test("staff-added services preselect and encode through the same catalog used for validation", () => {
  const catalog = validateServiceCatalog([...copy(), custom()], SERVICES);
  assert.equal(isValidServiceName("Suspension Repair", catalog), true);
  const url = new URL(getAppointmentLink("Suspension Repair", catalog), "https://example.invalid");
  assert.equal(getServiceSelection(url.search, catalog), "Suspension Repair");
  assert.equal(isValidServiceName("Suspension Repair"), false);
});

test("deactivation removes new booking choices without losing original definitions or historical aliases", () => {
  const catalog = copy().map(service => ["Oil Change", "Engine Air Filter Replacement"].includes(service.name) ? { ...service, active: false } : service);
  validateServiceCatalog(catalog, SERVICES);
  assert.equal(isValidServiceName("Oil Change", catalog), false);
  assert.equal(getServiceSelection("?service=Oil+Change", catalog), "");
  assert.equal(getAppointmentLink("Oil Change", catalog), "/appointment");
  assert.equal(isValidServiceName("Air Filter Change", catalog), false);
  assert.equal(getService("Air Filter Change", catalog).name, "Engine Air Filter Replacement");
  assert.equal(getService("Oil Change", SERVICES).active, true);
});

test("hard deletion, renaming, alias theft and case-folded duplicates are rejected even for inactive services", () => {
  assert.throws(() => validateServiceCatalog(copy().slice(1), SERVICES), /Keep existing/);
  const renamed = copy(); renamed[0].name = "Renamed Oil Service";
  assert.throws(() => validateServiceCatalog(renamed, SERVICES), /Keep existing/);
  const changedAlias = copy(); changedAlias.find(service => service.legacyNames.length).legacyNames = [];
  assert.throws(() => validateServiceCatalog(changedAlias, SERVICES), /historical aliases/);
  for (const name of ["oil change", "Air Filter Change"]) assert.throws(() => validateServiceCatalog([...copy(), custom(name)], SERVICES), /unique/);
  const stolen = custom(); stolen.legacyNames = ["Unclaimed Historical Service"];
  assert.throws(() => validateServiceCatalog([...copy(), stolen], SERVICES), /cannot claim/);
});

test("unsafe names cannot become Mongo paths, prototype properties or unbounded appointment fields", () => {
  for (const name of ["Oil.Change", "$operator", "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "Service\nName", " Leading", "Trailing ", "A".repeat(51)]) {
    assert.throws(() => validateServiceCatalog([...copy(), custom(name)], SERVICES), /Service names/);
  }
  const withExtra = custom(); withExtra.price = 100;
  assert.throws(() => validateServiceCatalog([...copy(), withExtra]), /listed service fields/);
});

test("catalog size, category, icon, booleans and readable descriptions are bounded", () => {
  const atLimit = [...copy(), ...Array.from({ length: SERVICE_CATALOG_MAX - SERVICES.length }, (_, index) => custom(`Custom Service ${index}`))];
  assert.equal(validateServiceCatalog(atLimit, SERVICES).length, SERVICE_CATALOG_MAX);
  assert.throws(() => validateServiceCatalog([...atLimit, custom("One More")], SERVICES), /between 1/);
  assert.throws(() => validateServiceCatalog([]), /between 1/);
  for (const patch of [{ category: "unknown" }, { icon: "javascript:alert" }, { active: "true" }, { description: "" }, { description: "a".repeat(SERVICE_DESCRIPTION_MAX + 1) }, { description: "header\r\ninjection" }]) {
    assert.throws(() => validateServiceCatalog([...copy(), { ...custom(), ...patch }], SERVICES));
  }
});

test("only the explicitly approved wiper service can be eligible for automatic confirmation", () => {
  for (const service of [...SERVICES, custom()]) assert.equal(requiresMechanicApproval(service), service.name !== "Wiper Blade Replacement", service.name);
  const wiper = getService("Wiper Blade Replacement");
  assert.equal(requiresMechanicApproval({ ...wiper, provisional: true }), true);
  assert.equal(requiresMechanicApproval({ ...wiper, category: "repairs" }), true);
  assert.equal(requiresMechanicApproval(undefined), true);
  assert.equal(requiresMechanicApproval(custom("Cabin Air Filter Replacement")), true);
});
