import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { createApp } from "./app.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createCustomerManagement, MANAGEMENT_LINK_LIFETIME_MS, MANAGEMENT_SESSION_LIFETIME_MS } from "./customerManagement.js";

const initialTime = Date.parse("2030-01-07T12:00:00.000Z");
const publicOrigin = "https://appointments.example.invalid";
const password = "isolated-management-test-password-430";
const settings = (overrides = {}) => ({
  NODE_ENV: "test", PUBLIC_WEBSITE_ORIGIN: publicOrigin,
  APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 82).toString("base64"),
  SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "test-user", SMTP_PASS: "test-password",
  MAIL_FROM: "shop@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid", ...overrides,
});
const request = (overrides = {}) => ({
  name: "Private Management Customer", email: "private-management@example.invalid", phone: "555-555-0134",
  vehicle: "2018 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00",
  notes: "Private staff-only notes", ...overrides,
});
const digest = value => createHash("sha256").update(value).digest("hex");
const cookieFor = (id, raw) => `appointment_manage_${String(id).toLowerCase()}=${raw}`;
const headersFor = context => ({ Cookie: context.cookie, "X-Appointment-CSRF": context.body.csrfToken });

async function fixture(t, { env = settings(), notificationsEnabled = false } = {}) {
  const dbName = `eds_management_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", { dbName, serverSelectionTimeoutMS: 5000 });
  try { await connection.asPromise(); }
  catch (error) { await connection.close(); throw new Error("Management tests require local MongoDB or TEST_MONGODB_URI.", { cause: error }); }
  t.after(async () => {
    try {
      assert.equal(connection.name, dbName);
      assert.match(connection.name, /^eds_management_test_[a-f\d]{32}$/);
      await connection.dropDatabase();
    } finally { await connection.close(); }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  let clock = initialTime;
  const now = () => new Date(clock);
  const management = createCustomerManagement({ Appointment, env, now });
  const scheduling = createSchedulingService({ Appointment, SchedulingState, management, now });
  let kicks = 0;
  const app = createApp({ Appointment, SchedulingState, management, scheduling,
    auth: createMechanicAuth(password), notifications: { enabled: notificationsEnabled, kick() { kicks++; } } });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { method = "GET", body, rawBody, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { Origin: publicOrigin, ...(body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined || rawBody !== undefined ? { body: rawBody ?? JSON.stringify(body) } : {}),
    });
    return { status: response.status, response, body: response.status === 204 ? null : await response.json() };
  }
  async function tokenFor(appointment) {
    const saved = await Appointment.findById(appointment._id).select("+management").lean();
    const link = management.emailLink(saved);
    assert.equal(typeof link, "string");
    return new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  }
  async function exchange(appointment) {
    const result = await api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token: await tokenFor(appointment) } });
    assert.equal(result.status, 200);
    return { ...result, cookie: result.response.headers.get("set-cookie").split(";")[0] };
  }
  return { Appointment, SchedulingState, scheduling, management, api, exchange, tokenFor, now, env,
    create: overrides => scheduling.createAppointment(request(overrides)),
    advance: value => { clock += value; }, setTime: value => { clock = value; }, kicks: () => kicks };
}

test("management remains disabled without explicit safe origin, random key and every SMTP field", () => {
  const bad = [
    { PUBLIC_WEBSITE_ORIGIN: "" }, { PUBLIC_WEBSITE_ORIGIN: "http://example.invalid" },
    { PUBLIC_WEBSITE_ORIGIN: "https://user:password@example.invalid" }, { PUBLIC_WEBSITE_ORIGIN: "https://example.invalid/path" },
    { PUBLIC_WEBSITE_ORIGIN: "https://example.invalid?query=1" }, { PUBLIC_WEBSITE_ORIGIN: "https://example.invalid/#secret" },
    { NODE_ENV: "production", PUBLIC_WEBSITE_ORIGIN: "http://localhost:5173" },
    { NODE_ENV: "production", PUBLIC_WEBSITE_ORIGIN: "https://127.0.0.1" },
    { NODE_ENV: "", PUBLIC_WEBSITE_ORIGIN: "http://localhost:5173" },
    { APPOINTMENT_MANAGEMENT_SECRET: "" }, { APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(31).toString("base64") },
    { APPOINTMENT_MANAGEMENT_SECRET: "this-is-not-a-base64-random-key" }, { SMTP_PORT: "not-a-port" },
    ...["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"].map(key => ({ [key]: "" })),
  ];
  for (const value of bad) {
    const manager = createCustomerManagement({ Appointment: {}, env: settings(value) });
    assert.equal(manager.enabled, false, JSON.stringify(Object.keys(value)));
    assert.equal(manager.createGrant(new mongoose.Types.ObjectId()), undefined);
    assert.equal(manager.emailLink({}), null);
  }
  assert.equal(createCustomerManagement({ Appointment: {}, env: settings() }).enabled, true);
  assert.equal(createCustomerManagement({ Appointment: {}, env: settings({ NODE_ENV: "development", PUBLIC_WEBSITE_ORIGIN: "http://localhost:5173" }) }).enabled, true);
});

test("new appointments persist random hashed grants privately and email only HTTPS fragment credentials", async t => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create({ time: "10:00" });
  const a = await f.Appointment.findById(first.id).select("+management").lean();
  const b = await f.Appointment.findById(second.id).select("+management").lean();
  const token = await f.tokenFor(first);
  assert.equal(a.management.tokenHash, digest(token));
  assert.notEqual(a.management.nonce, token);
  assert.notEqual(a.management.nonce, b.management.nonce);
  assert.notEqual(a.management.tokenHash, b.management.tokenHash);
  assert.equal(JSON.stringify(a).includes(token), false);
  assert.equal((await f.Appointment.findById(first.id).lean()).management, undefined);
  const url = new URL(f.management.emailLink(a));
  assert.equal(url.origin, publicOrigin);
  assert.equal(url.pathname, "/manage-appointment");
  assert.equal(url.search, "");
  assert.match(url.hash, /#id=[a-f\d]{24}&token=[A-Za-z\d_-]{43}$/);
  assert.equal(+a.management.expiresAt - +a.management.issuedAt, MANAGEMENT_LINK_LIFETIME_MS);
});

test("exchange returns only limited authorized details and sets one scoped HttpOnly Secure session", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const result = await f.exchange(appointment);
  const cookie = result.response.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^appointment_manage_${appointment.id}=`));
  for (const attribute of [`Path=/api/customer/appointments/${appointment.id}`, "HttpOnly", "Secure", "SameSite=Strict"]) assert.ok(cookie.includes(attribute));
  assert.equal(result.body.appointment.id, appointment.id);
  assert.equal(result.body.appointment.service, "Oil Change");
  assert.equal(result.body.appointment.canCancel, true);
  assert.equal(result.body.appointment.timezone, "America/Chicago");
  assert.match(result.body.csrfToken, /^[A-Za-z\d_-]{43}$/);
  assert.equal(+new Date(result.body.sessionExpiresAt), initialTime + MANAGEMENT_SESSION_LIFETIME_MS);
  for (const secret of [appointment.name, appointment.email, appointment.phone, appointment.notes, "tokenHash", "nonce", "settingsRevision", "reservation", "management"]) assert.ok(!JSON.stringify(result.body).includes(secret), secret);
  const stored = await f.Appointment.findById(appointment.id).select("+management").lean();
  const raw = result.cookie.split("=")[1];
  assert.equal(stored.management.sessions[0].tokenHash, digest(raw));
  assert.equal(JSON.stringify(stored).includes(raw), false);
  const retrieved = await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(result) });
  assert.deepEqual(retrieved.body.appointment, result.body.appointment);
});

test("invalid credentials, unknown references and cross-appointment credentials all fail without enumeration", async t => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create({ time: "10:00" });
  const token = await f.tokenFor(first);
  const cases = [[first.id, randomBytes(32).toString("base64url")], [second.id, token], [String(new mongoose.Types.ObjectId()), token], ["not-an-id", token], [first.id, "malformed"]];
  let denied;
  for (const [id, value] of cases) {
    const result = await f.api(`/api/customer/appointments/${id}/exchange`, { method: "POST", body: { token: value } });
    assert.equal(result.status, 401);
    denied ||= result.body;
    assert.deepEqual(result.body, denied);
  }
  const access = await f.exchange(first);
  const raw = access.cookie.split("=")[1];
  assert.equal((await f.api(`/api/customer/appointments/${second.id}`, { headers: { Cookie: access.cookie } })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${second.id}`, { headers: { Cookie: cookieFor(second.id, raw) } })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${first.id}`, { headers: { Cookie: `${access.cookie}; ${access.cookie}` } })).status, 401);
});

test("reference IDs alone and historical appointments never authorize lookup or receive backfilled credentials", async t => {
  const f = await fixture(t);
  const old = await f.Appointment.create(request({ time: "08:15" }));
  const before = await f.Appointment.collection.findOne({ _id: old._id });
  for (const suffix of ["", `?email=${encodeURIComponent(old.email)}`, "?token=reference-is-not-authentication"]) assert.equal((await f.api(`/api/customer/appointments/${old.id}${suffix}`)).status, 401);
  const response = await f.api(`/api/customer/appointments/${old.id}/exchange`, { method: "POST", body: { token: randomBytes(32).toString("base64url") } });
  assert.equal(response.status, 401);
  assert.equal(f.management.emailLink({ ...before }), null);
  assert.deepEqual(await f.Appointment.collection.findOne({ _id: old._id }), before);
});

test("customer session lifetime is enforced server-side at exactly 20 minutes without activity extensions", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  f.advance(MANAGEMENT_SESSION_LIFETIME_MS - 1);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(access) })).status, 200);
  f.advance(1);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(access) })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", body: {}, headers: headersFor(access) })).status, 401);
  assert.equal((await f.Appointment.findById(appointment.id)).status, "pending");
});

test("grant expiration bounds sessions and rejects expired emailed credentials", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const token = await f.tokenFor(appointment);
  f.advance(MANAGEMENT_LINK_LIFETIME_MS - 1000);
  const access = await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token } });
  assert.equal(access.status, 200);
  assert.equal(+new Date(access.body.sessionExpiresAt), initialTime + MANAGEMENT_LINK_LIFETIME_MS);
  const cookie = access.response.headers.get("set-cookie").split(";")[0];
  f.advance(1000);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token } })).status, 401);
});

test("server-side revocation and key rotation invalidate old links and existing sessions", async t => {
  const f = await fixture(t);
  const first = await f.create();
  const access = await f.exchange(first);
  const token = await f.tokenFor(first);
  const rotated = createCustomerManagement({ Appointment: f.Appointment, env: settings({ APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 83).toString("base64") }), now: f.now });
  await assert.rejects(rotated.authorize({ headers: { cookie: access.cookie }, ip: "test" }, first.id), error => error.status === 401);
  await assert.rejects(rotated.exchange(first.id, token), error => error.status === 401);
  assert.equal(await f.management.revoke(first.id), true);
  assert.equal(await f.management.revoke(first.id), true);
  assert.equal((await f.api(`/api/customer/appointments/${first.id}`, { headers: headersFor(access) })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${first.id}/exchange`, { method: "POST", body: { token } })).status, 401);
  assert.equal((await f.Appointment.findById(first.id).select("+management").lean()).management.sessions.length, 0);
});

test("inconsistent grant timestamps and changed verifier hashes fail closed", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const token = await f.tokenFor(appointment);
  const saved = await f.Appointment.findById(appointment.id).select("+management").lean();
  for (const mutation of [
    { issuedAt: new Date(initialTime + 1) },
    { expiresAt: new Date(initialTime + MANAGEMENT_LINK_LIFETIME_MS + 1) },
    { tokenHash: digest("wrong-verifier") },
    { keyId: "0".repeat(32) },
  ]) {
    await f.Appointment.updateOne({ _id: appointment.id }, { $set: { management: { ...saved.management, ...mutation } } });
    const result = await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token } });
    assert.equal(result.status, 401);
    assert.equal(f.management.emailLink({ ...saved, management: { ...saved.management, ...mutation } }), null);
  }
});

test("at most five scoped sessions are retained and closing one access revokes only that session", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const sessions = [];
  for (let i = 0; i < 6; i++) sessions.push(await f.exchange(appointment));
  assert.equal((await f.Appointment.findById(appointment.id).select("+management").lean()).management.sessions.length, 5);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(sessions[0]) })).status, 401);
  const close = await f.api(`/api/customer/appointments/${appointment.id}/logout`, { method: "POST", headers: headersFor(sessions[1]) });
  assert.equal(close.status, 204);
  assert.match(close.response.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(sessions[1]) })).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(sessions[2]) })).status, 200);
});

test("customer cancellation saves once, retains optional reason and returns truthful notification state", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  const response = await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", headers: headersFor(access), body: { category: "plans_changed", message: "My schedule changed." } });
  assert.equal(response.status, 200);
  assert.equal(response.body.appointment.status, "cancelled");
  assert.equal(response.body.appointment.canCancel, false);
  assert.equal(response.body.appointment.cancellation.by, "customer");
  assert.equal(response.body.appointment.cancellation.message, "My schedule changed.");
  assert.deepEqual(response.body.notifications, { customer: "disabled", mechanic: "disabled" });
  await f.Appointment.updateOne({ _id: appointment.id }, { $set: { "notificationState.cancellationCustomer": "sent", "notificationState.cancellationMechanic": "sent" } });
  const repeat = await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", headers: headersFor(access), body: {} });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body.appointment.cancellation, response.body.appointment.cancellation);
  const stored = await f.Appointment.findById(appointment.id).lean();
  assert.equal(stored.notificationState.cancellationCustomer, "sent");
  assert.equal(stored.notificationState.cancellationMechanic, "sent");
  assert.equal(await f.Appointment.countDocuments({ _id: appointment.id }), 1);
});

test("customer cancellation requires scoped authentication, correct Origin and CSRF", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const token = await f.tokenFor(appointment);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", headers: { Origin: "https://attacker.example.invalid" }, body: { token } })).status, 403);
  const access = await f.exchange(appointment);
  for (const headers of [{}, { Cookie: access.cookie }, { ...headersFor(access), "X-Appointment-CSRF": randomBytes(32).toString("base64url") }, { ...headersFor(access), Origin: "null" }, { ...headersFor(access), Origin: "" }]) {
    const response = await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", body: {}, headers });
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal((await f.Appointment.findById(appointment.id)).status, "pending");
  const logout = await f.api(`/api/customer/appointments/${appointment.id}/logout`, { method: "POST", headers: { Cookie: access.cookie } });
  assert.equal(logout.status, 403);
});

test("authenticated cancellation validates strict body fields while preserving the pending record", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  const primitive = await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", body: null, headers: headersFor(access) });
  assert.equal(primitive.status, 400); // Express rejects non-object JSON first.
  for (const body of [[], { category: "unknown" }, { message: "x".repeat(1001) }, { message: "Control\u0000character" }, { status: "cancelled" }, { category: { $ne: null } }]) {
    const response = await f.api(`/api/customer/appointments/${appointment.id}/cancel`, { method: "POST", body, headers: headersFor(access) });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_CANCELLATION_REASON");
  }
  assert.equal((await f.Appointment.findById(appointment.id)).status, "pending");
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token: await f.tokenFor(appointment), email: appointment.email } })).status, 400);
});

test("all customer management success and error responses prohibit caching and referrer disclosure", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  const cases = [access,
    await f.api(`/api/customer/appointments/${appointment.id}`),
    await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(access) }),
    await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", rawBody: "{" }),
    await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token: "x".repeat(33_000) } }),
    await f.api("/api/customer/appointments/unavailable/unsupported"),
  ];
  assert.equal(cases[3].status, 400);
  assert.equal(cases[4].status, 413);
  for (const item of cases) {
    assert.equal(item.response.headers.get("cache-control"), "no-store");
    assert.equal(item.response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(item.response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("management verification throttles credential guesses with a bounded retry interval", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  for (let i = 0; i < 10; i++) assert.equal((await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token: randomBytes(32).toString("base64url") } })).status, 401);
  const limited = await f.api(`/api/customer/appointments/${appointment.id}/exchange`, { method: "POST", body: { token: await f.tokenFor(appointment) } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "MANAGEMENT_RATE_LIMITED");
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  f.advance(15 * 60 * 1000);
  assert.equal((await f.exchange(appointment)).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`)).status, 401);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`)).status, 429);
});

test("mechanic management revocation preserves authentication and CSRF protection and hides verifiers", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  const path = `/api/mechanic/appointments/${appointment.id}/management/revoke`;
  assert.equal((await f.api(path, { method: "POST" })).status, 401);
  const login = await f.api("/api/mechanic/login", { method: "POST", body: { password } });
  const Cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.api(path, { method: "POST", headers: { Cookie } })).status, 403);
  const staff = { Cookie, "X-Mechanic-CSRF": login.body.csrfToken };
  const list = await f.api("/api/mechanic/appointments?status=all", { headers: staff });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes("tokenHash"));
  assert.ok(list.body.appointments.every(item => !Object.hasOwn(item, "management")));
  assert.equal((await f.api(path, { method: "POST", headers: staff })).status, 200);
  assert.equal((await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(access) })).status, 401);
});

test("unexpected customer storage failures return a generic retryable error without internal details", async t => {
  const f = await fixture(t);
  const appointment = await f.create();
  const access = await f.exchange(appointment);
  t.mock.method(f.Appointment, "findById", () => { throw new Error("mongodb://private-db:27017 credential-is-secret"); });
  const response = await f.api(`/api/customer/appointments/${appointment.id}`, { headers: headersFor(access) });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "MANAGEMENT_UNAVAILABLE");
  assert.ok(!JSON.stringify(response.body).includes("private-db"));
  assert.ok(!JSON.stringify(response.body).includes("credential-is-secret"));
});
