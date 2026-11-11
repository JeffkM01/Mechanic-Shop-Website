import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES } from "../../shared/services.js";
import { parsePublicServiceCatalog } from "./publicServiceCatalog.js";

const response = () => ({ revision: 7, services: structuredClone(SERVICES) });
const suspension = {
  name: "Suspension Repair", category: "repairs", icon: "wrench",
  description: "Describe ride or suspension concerns for mechanic review.",
  active: true, provisional: false, appointmentOnly: false, legacyNames: [],
};

test("public catalog accepts current metadata and custom services without retaining mutable transport objects", () => {
  const input = response();
  input.services.push(suspension);
  const parsed = parsePublicServiceCatalog(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.services, input.services);
  assert.notEqual(parsed.services[0], input.services[0]);
  parsed.services[0].active = false;
  assert.equal(input.services[0].active, true);
  assert.equal(parsed.services.at(-1).name, "Suspension Repair");
});

test("an intentionally empty current catalog stays empty rather than restoring static booking choices", () => {
  assert.deepEqual(parsePublicServiceCatalog({ revision: 8, services: [] }), { revision: 8, services: [] });
});

test("missing, malformed and unsafe catalog revisions fail verification", () => {
  for (const invalid of [null, undefined, [], {}, "services", { services: SERVICES }, { revision: 1, services: null }, { revision: 1, services: {} }]) {
    assert.throws(() => parsePublicServiceCatalog(invalid), /could not be verified/);
  }
  for (const revision of [-1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePublicServiceCatalog({ revision, services: SERVICES }), /could not be verified/);
  }
});

test("public responses cannot reintroduce inactive services as available choices", () => {
  const input = response();
  input.services[0].active = false;
  assert.throws(() => parsePublicServiceCatalog(input), /could not be verified/);
});

test("malformed or duplicate service metadata cannot become selectable public offerings", () => {
  const duplicate = response();
  duplicate.services.push({ ...suspension, name: "oil change" });
  assert.throws(() => parsePublicServiceCatalog(duplicate), /unique/);
  for (const patch of [{ icon: "unknown" }, { name: "constructor" }, { name: "$unsafe" }, { category: "unknown" }, { description: "" }, { privateNotes: "Never render private metadata." }]) {
    assert.throws(() => parsePublicServiceCatalog({ revision: 1, services: [{ ...suspension, ...patch }] }));
  }
});
