import test from "node:test";
import assert from "node:assert/strict";
import { createManagementAccess, parseManagementLink, prepareManagementLink } from "./managementLink.js";

const id = "0123456789abcdef01234567";
const token = "a".repeat(43);

test("management links accept scoped fragment credentials but not query bearers", () => {
  assert.deepEqual(parseManagementLink(`https://shop.example/manage-appointment#id=${id}&token=${token}`), { appointmentId: id, token, invalid: false });
  assert.equal(parseManagementLink(`https://shop.example/manage-appointment?appointment=${id}&token=${token}`).invalid, true);
  assert.equal(parseManagementLink(`https://shop.example/manage-appointment?appointment=${id}`).token, "");
  assert.equal(parseManagementLink(`https://shop.example/manage-appointment?appointment=${id}`).invalid, false);
});

test("malformed, duplicate, and missing credentials cannot become reference lookups", () => {
  for (const suffix of ["", `#id=${id}`, `#id=${id}&token=short`, `#id=${id}&token=${token}&token=${token}`, `#id=${id}&token=${token}&other=value`, `?appointment=${id}&appointment=${id}`, `?access_token=${token}#id=${id}&token=${token}`]) {
    assert.deepEqual(parseManagementLink(`https://shop.example/manage-appointment${suffix}`), { appointmentId: "", token: "", invalid: true });
  }
});

test("bootstrap scrubs the complete fragment before handing off access", () => {
  const location = new URL(`https://shop.example/manage-appointment?utm_source=email#id=${id}&token=${token}`);
  const history = { state: { source: "test" }, replaceState(state, _, value) { this.value = value; this.saved = state; location.href = new URL(value, location).href; } };
  const access = prepareManagementLink(location, history);
  assert.equal(history.value, `/manage-appointment?appointment=${id}`);
  assert.deepEqual(history.saved, { source: "test" });
  assert.equal(JSON.stringify(access).includes(token), false);
  assert.equal(prepareManagementLink(location, history), access);
});

test("StrictMode consumers share only the in-flight exchange and then use the scoped session", async () => {
  const access = createManagementAccess({ appointmentId: id, token, invalid: false });
  let finish;
  const calls = [];
  const request = (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const first = access.requestAccess(request);
  const second = access.requestAccess(request);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [id, { method: "POST", body: { token }, exchange: true }]);
  finish({ appointment: { id } });
  await first;
  access.requestAccess(request);
  assert.deepEqual(calls[1], [id]);
});

test("a failed exchange never retries the raw bearer", async () => {
  const access = createManagementAccess({ appointmentId: id, token, invalid: false });
  await assert.rejects(access.requestAccess(() => Promise.reject(new Error("offline"))));
  let options;
  await access.requestAccess((_, value) => { options = value; return Promise.resolve({}); });
  assert.equal(options, undefined);
});

test("bootstrap removes malformed and query credentials without attempting an exchange", async () => {
  for (const suffix of [`?token=${token}&appointment=${id}`, `#id=${id}&token=invalid`, `?credential=${token}`]) {
    const location = new URL(`https://shop.example/manage-appointment${suffix}`);
    const history = { state: null, replaceState(_, _title, value) { location.href = new URL(value, location).href; } };
    const access = prepareManagementLink(location, history);
    assert.equal(location.href, "https://shop.example/manage-appointment");
    assert.equal(access.invalid, true);
    assert.equal(access.appointmentId, "");
    assert.equal(JSON.stringify(access).includes(token), false);
  }
});

test("bootstrap leaves customer navigation untouched and canonicalizes scoped references", () => {
  const unrelated = new URL("https://shop.example/services#basic-maintenance");
  assert.equal(prepareManagementLink(unrelated, { replaceState() { assert.fail("Unrelated URLs must remain intact"); } }), null);
  const location = new URL(`https://shop.example/manage-appointment?appointment=${id.toUpperCase()}&utm_source=email`);
  const history = { state: null, replaceState(_, _title, value) { location.href = new URL(value, location).href; } };
  const access = prepareManagementLink(location, history);
  assert.equal(access.appointmentId, id);
  assert.equal(access.invalid, false);
  assert.equal(location.search, `?appointment=${id}`);
});
