import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { appointmentSchema } from "./Appointment.js";
import { schedulingStateSchema } from "./SchedulingState.js";
import { createSchedulingService } from "./schedulingService.js";
import { createCustomerManagement, isCustomerManagementConfigured } from "./customerManagement.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { createApp } from "./app.js";
import {
  APPOINTMENT_EMAIL_TEST_FIELD, OWNED_EMAIL_TEST_FROM, OWNED_EMAIL_TEST_RECIPIENT,
  appointmentMatchesEmailScope,
} from "./appointmentEmailScope.js";

// These tests never use the application's database or a real email transport.
// Every connected database has an independently generated, guarded test name.
const mongoUri = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
const initialTime = "2030-01-07T12:00:00.000Z";
const appointmentDate = "2030-01-09";
const origin = "http://127.0.0.1:5174";
const unauthorized = error => error.status === 401 && error.code === "MANAGEMENT_UNAUTHORIZED";
const scopeFor = (runId = randomUUID()) => ({ runId, recipient: OWNED_EMAIL_TEST_RECIPIENT });
const fakeEnv = overrides => ({
  NODE_ENV: "test",
  EMAIL_TRANSPORT: "brevo_api",
  BREVO_API_KEY: "synthetic-key-never-sent-to-a-provider",
  MAIL_FROM: OWNED_EMAIL_TEST_FROM,
  MECHANIC_NOTIFICATION_EMAIL: OWNED_EMAIL_TEST_RECIPIENT,
  PUBLIC_WEBSITE_ORIGIN: origin,
  APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 47).toString("base64url"),
  ...overrides,
});

function request(overrides = {}) {
  return {
    name: "Synthetic Email Workflow Customer",
    email: OWNED_EMAIL_TEST_RECIPIENT,
    phone: "555-555-0134",
    vehicle: "2020 Honda Civic",
    service: "Oil Change",
    date: appointmentDate,
    time: "08:00",
    notes: "Synthetic appointment email test only.",
    ...overrides,
  };
}

async function fixture(t) {
  const dbName = `eds_email_workflow_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(mongoUri, { dbName, serverSelectionTimeoutMS: 5000 });
  try {
    await connection.asPromise();
  } catch (error) {
    await connection.close();
    throw new Error("Appointment email workflow tests require local MongoDB or TEST_MONGODB_URI.", { cause: error });
  }
  t.after(async () => {
    try {
      assert.match(connection.name, /^eds_email_workflow_test_[a-f\d]{32}$/);
      assert.equal(connection.name, dbName);
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });
  const Appointment = connection.model("Appointment", appointmentSchema.clone());
  const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const now = () => new Date(initialTime);
  function services(deliveryScope = null) {
    const management = createCustomerManagement({ Appointment, env: fakeEnv(), now, deliveryScope });
    const scheduling = createSchedulingService({ Appointment, SchedulingState, management, now, deliveryScope });
    return { management, scheduling };
  }
  async function queue(deliveryScope = null, management = services(deliveryScope).management) {
    const sent = [];
    const errors = [];
    const notifications = await createEmailNotifications({
      Appointment, management, now, deliveryScope,
      env: fakeEnv(deliveryScope ? { DEPLOYMENT_STAGE: "staging" } : {}),
      transport: { async sendMail(message) { sent.push(message); return { messageId: `synthetic-${sent.length}` }; } },
      logger: { error(message) { errors.push(message); } },
    });
    t.after(() => notifications.stop());
    assert.equal(notifications.enabled, true);
    return { notifications, sent, errors };
  }
  async function withPrivateFields(id) {
    return Appointment.findById(id).select(`+management +${APPOINTMENT_EMAIL_TEST_FIELD}`).lean();
  }
  async function legacy(overrides = {}) {
    const id = new mongoose.Types.ObjectId();
    return Appointment.create({
      ...request(), _id: id,
      management: services().management.createGrant(String(id), now()),
      ...overrides,
    });
  }
  return { Appointment, SchedulingState, services, queue, withPrivateFields, legacy };
}

function linkToken(link) {
  assert.equal(new URL(link).origin, origin);
  assert.equal(new URL(link).pathname, "/manage-appointment");
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  return { id: fragment.get("id"), token: fragment.get("token") };
}

function sessionRequest(id, cookie, headers = {}) {
  return { ip: "127.0.0.1", headers: { cookie: `appointment_manage_${id}=${cookie}`, origin, ...headers } };
}

function assertTestMessages(messages, appointmentId) {
  assert.ok(messages.length > 0);
  for (const message of messages) {
    assert.equal(message.from, OWNED_EMAIL_TEST_FROM);
    assert.equal(message.to, OWNED_EMAIL_TEST_RECIPIENT);
    assert.equal(message.replyTo, OWNED_EMAIL_TEST_RECIPIENT);
    assert.match(message.subject, /^\[TEST ONLY\] /);
    assert.match(message.text, /^PRIVATE APPOINTMENT EMAIL TEST/);
    if (appointmentId) assert.ok(message.text.includes(String(appointmentId)));
  }
}

test("management configuration preflight uses explicit fixtures and needs no database or transport", () => {
  assert.equal(isCustomerManagementConfigured(fakeEnv()), true);
  assert.equal(isCustomerManagementConfigured({}), false);
  assert.equal(isCustomerManagementConfigured(fakeEnv({ PUBLIC_WEBSITE_ORIGIN: "https://example.invalid/path" })), false);
  assert.equal(isCustomerManagementConfigured(fakeEnv({ APPOINTMENT_MANAGEMENT_SECRET: "too-short" })), false);
  assert.equal(isCustomerManagementConfigured(fakeEnv({ BREVO_API_KEY: "" })), false);
});

test("invalid delivery scopes fail before storage or email transport can be used", async () => {
  const invalidScopes = [
    { runId: "not-a-uuid", recipient: OWNED_EMAIL_TEST_RECIPIENT },
    { runId: randomUUID(), recipient: "other@example.invalid" },
    { ...scopeFor(), additionalRecipient: "other@example.invalid" },
  ];
  for (const deliveryScope of invalidScopes) {
    const options = { Appointment: {}, SchedulingState: {}, env: fakeEnv(), deliveryScope };
    assert.throws(() => createSchedulingService(options), /valid fixed-inbox/);
    assert.throws(() => createCustomerManagement(options), /valid fixed-inbox/);
    await assert.rejects(createEmailNotifications({
      ...options,
      transport: { sendMail() { assert.fail("invalid scope reached the transport"); } },
    }), /valid fixed-inbox/);
  }
});

test("scoped creation rejects other recipients before any reservation or appointment is written", async t => {
  const { Appointment, SchedulingState, services } = await fixture(t);
  const scope = scopeFor();
  const { scheduling } = services(scope);
  for (const email of ["other@example.invalid", "contact@edsautoshop.com,other@example.invalid", ""]) {
    await assert.rejects(scheduling.createAppointment(request({ email })), error => error.status === 400);
    assert.equal(await Appointment.countDocuments(), 0);
    assert.equal(await SchedulingState.countDocuments(), 0);
  }
  const created = await scheduling.createAppointment(request({ email: " CONTACT@EDSAUTOSHOP.COM " }));
  assert.equal(created.email, OWNED_EMAIL_TEST_RECIPIENT);
  assert.equal(created[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  assert.equal(created.status, "pending");
  assert.equal((await scheduling.getSettings()).settings.automaticBookingEnabled, false);
});

test("the immutable private marker is assigned only to new scoped requests and ignores forged input", async t => {
  const { Appointment, services, withPrivateFields } = await fixture(t);
  const scope = scopeFor();
  const forged = randomUUID();
  const normal = await services().scheduling.createAppointment(request({ [APPOINTMENT_EMAIL_TEST_FIELD]: forged }));
  assert.equal(normal[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  assert.equal((await withPrivateFields(normal.id))[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  const tagged = await services(scope).scheduling.createAppointment(request({
    time: "10:00", [APPOINTMENT_EMAIL_TEST_FIELD]: forged,
  }));
  assert.equal(tagged[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  const hidden = await Appointment.findById(tagged.id).lean();
  assert.equal(Object.hasOwn(hidden, APPOINTMENT_EMAIL_TEST_FIELD), false);
  assert.equal((await withPrivateFields(tagged.id))[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  assert.equal(appointmentSchema.path(APPOINTMENT_EMAIL_TEST_FIELD).options.select, false);
  assert.equal(appointmentSchema.path(APPOINTMENT_EMAIL_TEST_FIELD).options.immutable, true);
  const editable = await Appointment.findById(tagged.id).select(`+${APPOINTMENT_EMAIL_TEST_FIELD}`);
  editable[APPOINTMENT_EMAIL_TEST_FIELD] = forged;
  await editable.save();
  assert.equal((await withPrivateFields(tagged.id))[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  await assert.rejects(Appointment.create(request({
    time: "15:00", [APPOINTMENT_EMAIL_TEST_FIELD]: "not-a-uuid",
  })), error => error.name === "ValidationError");
});

test("reviewing and cancelling old off-grid appointments never backfills a test marker", async t => {
  const { legacy, services, withPrivateFields } = await fixture(t);
  const { scheduling, management } = services(scopeFor());
  const older = await legacy({ time: "08:15", email: "legacy-owner@example.invalid" });
  const approved = await scheduling.reviewAppointment(older.id, "confirmed");
  assert.equal(approved.time, "08:15");
  assert.equal(approved.status, "confirmed");
  assert.equal(approved[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  assert.equal((await withPrivateFields(older.id))[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  assert.equal(management.emailLink(await withPrivateFields(older.id)), null);
  const cancelled = await scheduling.cancelAppointment(older.id, "mechanic", { category: "mechanic_unavailable" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  assert.equal((await withPrivateFields(older.id))[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  const oldDecline = await legacy({ time: "10:15" });
  const declined = await scheduling.reviewAppointment(oldDecline.id, "declined", { decline: { category: "unable_to_accommodate" } });
  assert.equal(declined.status, "declined");
  assert.equal((await withPrivateFields(oldDecline.id))[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
});

test("management links and sessions stay confined to the current run and owned inbox", async t => {
  const { services, legacy, withPrivateFields } = await fixture(t);
  const scope = scopeFor();
  const active = services(scope);
  const other = services(scopeFor());
  const ordinary = services();
  const old = await legacy();
  const oldLink = linkToken(ordinary.management.emailLink(await withPrivateFields(old.id)));
  assert.equal(active.management.emailLink(await withPrivateFields(old.id)), null);
  await assert.rejects(active.management.exchange(oldLink.id, oldLink.token), unauthorized);
  const oldSession = await ordinary.management.exchange(oldLink.id, oldLink.token);
  await ordinary.management.authorize(sessionRequest(old.id, oldSession.cookie), old.id);
  await assert.rejects(active.management.authorize(sessionRequest(old.id, oldSession.cookie), old.id), unauthorized);

  const current = await active.scheduling.createAppointment(request({ time: "10:00" }));
  const currentDocument = await withPrivateFields(current.id);
  const currentLink = linkToken(active.management.emailLink(currentDocument));
  assert.equal(ordinary.management.emailLink(currentDocument), null);
  assert.equal(other.management.emailLink(currentDocument), null);
  await assert.rejects(ordinary.management.exchange(currentLink.id, currentLink.token), unauthorized);
  await assert.rejects(other.management.exchange(currentLink.id, currentLink.token), unauthorized);
  const currentSession = await active.management.exchange(currentLink.id, currentLink.token);
  const req = sessionRequest(current.id, currentSession.cookie, { "x-appointment-csrf": currentSession.csrfToken });
  const authorized = await active.management.authorize(req, current.id);
  assert.equal(String(authorized.appointment._id), current.id);
  active.management.requireOrigin(req);
  active.management.requireCsrf(req, authorized);
  assert.throws(() => active.management.requireCsrf(sessionRequest(current.id, currentSession.cookie), authorized), error => error.code === "CSRF_INVALID");
  await assert.rejects(ordinary.management.authorize(req, current.id), unauthorized);
  await assert.rejects(other.management.authorize(req, current.id), unauthorized);
  await active.management.logout(authorized);
  await assert.rejects(active.management.authorize(req, current.id), unauthorized);

  const mismatched = await legacy({ email: "different-owner@example.invalid", [APPOINTMENT_EMAIL_TEST_FIELD]: scope.runId });
  const mismatchedDocument = await withPrivateFields(mismatched.id);
  assert.equal(active.management.emailLink(mismatchedDocument), null);
  assert.equal(ordinary.management.emailLink(mismatchedDocument), null);
  // A valid cryptographic bearer created before a recipient was changed must
  // still fail the database-backed scope check during exchange.
  const syntheticLink = linkToken(active.management.emailLink({ ...mismatchedDocument, email: OWNED_EMAIL_TEST_RECIPIENT }));
  await assert.rejects(active.management.exchange(syntheticLink.id, syntheticLink.token), unauthorized);
});

test("scoped fake delivery covers pending, manual confirmation and customer cancellation without replaying old requests", async t => {
  const { Appointment, services, queue, legacy, withPrivateFields } = await fixture(t);
  const scope = scopeFor();
  const { scheduling, management } = services(scope);
  const oldOwned = await legacy({ time: "15:00" });
  const priorRun = await legacy({ time: "15:00", [APPOINTMENT_EMAIL_TEST_FIELD]: randomUUID() });
  const current = await scheduling.createAppointment(request());
  const { notifications, sent, errors } = await queue(scope, management);
  assert.equal(notifications.isEnabledFor(await withPrivateFields(oldOwned.id)), false);
  assert.equal(notifications.isEnabledFor(await withPrivateFields(priorRun.id)), false);
  assert.equal(notifications.isEnabledFor(await withPrivateFields(current.id)), true);
  await notifications.processPending();
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /appointment request received/);
  assert.match(sent[0].text, /PENDING/);
  const link = /Manage this appointment securely: (\S+)/.exec(sent[0].text)?.[1];
  assert.ok(link, "the pending receipt includes an active scoped management link");
  const bearer = linkToken(link);
  const session = await management.exchange(bearer.id, bearer.token);
  await management.authorize(sessionRequest(bearer.id, session.cookie), bearer.id);
  const confirmed = await scheduling.reviewAppointment(current.id, "confirmed");
  assert.equal(confirmed[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  await notifications.processPending();
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /appointment confirmed/);
  assert.match(sent[2].text, /has been CONFIRMED/);
  const cancelled = await scheduling.cancelAppointment(current.id, "customer", { category: "plans_changed" });
  assert.equal(cancelled[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  await notifications.processPending();
  assert.equal(sent.length, 5);
  assert.match(sent[3].subject, /Appointment Cancelled/);
  assert.match(sent[4].subject, /Customer Cancelled Appointment/);
  assertTestMessages(sent, current.id);
  await notifications.processPending();
  assert.equal(sent.length, 5, "acknowledged notifications are not resent in a normal retry pass");
  assert.deepEqual(errors, []);
  const saved = await Appointment.findById(current.id).lean();
  assert.equal(saved.status, "cancelled");
  for (const kind of ["requestCustomer", "requestMechanic", "decisionCustomer", "cancellationCustomer", "cancellationMechanic"]) {
    assert.equal(saved.notificationState[kind], "sent");
  }
  for (const previous of [oldOwned, priorRun]) {
    const preserved = await withPrivateFields(previous.id);
    assert.equal(preserved.status, "pending");
    assert.equal(preserved.notificationState.requestCustomer, "pending");
    assert.equal(preserved.notificationState.requestMechanic, "pending");
  }
});

test("declines and mechanic cancellations retain their notification flows within the scoped run", async t => {
  const { Appointment, services, queue } = await fixture(t);
  const scope = scopeFor();
  const { scheduling, management } = services(scope);
  const { notifications, sent, errors } = await queue(scope, management);
  const declined = await scheduling.createAppointment(request());
  await notifications.processPending();
  const reviewed = await scheduling.reviewAppointment(declined.id, "declined", { decline: { category: "unable_to_accommodate" } });
  assert.equal(reviewed[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
  await notifications.processPending();
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /has been declined/);
  assert.match(sent[2].text, /Reason:/);
  const cancelled = await scheduling.createAppointment(request({ time: "10:00" }));
  await notifications.processPending();
  assert.equal(sent.length, 5);
  await scheduling.cancelAppointment(cancelled.id, "mechanic", { category: "mechanic_unavailable" });
  await notifications.processPending();
  assert.equal(sent.length, 6);
  assert.match(sent[5].subject, /Appointment Cancelled/);
  assert.match(sent[5].text, /Cancelled by: Mechanic/);
  assertTestMessages(sent);
  assert.deepEqual(errors, []);
  assert.equal((await Appointment.findById(declined.id).lean()).status, "declined");
  const saved = await Appointment.findById(cancelled.id).lean();
  assert.equal(saved.notificationState.cancellationCustomer, "sent");
  assert.equal(saved.notificationState.cancellationMechanic, "not-applicable");
});

test("changing a run never replays old test mail, and ordinary delivery excludes every tagged record", async t => {
  const { services, queue, legacy, withPrivateFields } = await fixture(t);
  const previousScope = scopeFor();
  const currentScope = scopeFor();
  const previous = await services(previousScope).scheduling.createAppointment(request());
  const activeQueue = await queue(currentScope);
  await activeQueue.notifications.processPending();
  assert.deepEqual(activeQueue.sent, []);
  const current = await services(currentScope).scheduling.createAppointment(request({ time: "10:00" }));
  await activeQueue.notifications.processPending();
  assert.equal(activeQueue.sent.length, 2);
  assertTestMessages(activeQueue.sent, current.id);
  const old = await legacy({ time: "15:00", email: "legacy-customer@example.invalid" });
  const ordinaryQueue = await queue();
  assert.equal(ordinaryQueue.notifications.isEnabledFor(await withPrivateFields(previous.id)), false);
  await ordinaryQueue.notifications.processPending();
  assert.equal(ordinaryQueue.sent.length, 2);
  assert.ok(ordinaryQueue.sent.every(message => message.text.includes(old.id)));
  assert.ok(ordinaryQueue.sent.every(message => !message.subject.startsWith("[TEST ONLY]")));
  assert.equal((await withPrivateFields(previous.id)).notificationState.requestCustomer, "pending");
  assert.equal((await withPrivateFields(previous.id))[APPOINTMENT_EMAIL_TEST_FIELD], previousScope.runId);
  assert.deepEqual(activeQueue.errors, []);
  assert.deepEqual(ordinaryQueue.errors, []);
});

test("HTTP status and appointment DTOs hide run metadata and report old decisions as email-disabled", async t => {
  const { services, Appointment, legacy, withPrivateFields } = await fixture(t);
  const scope = scopeFor();
  const { scheduling, management } = services(scope);
  const old = await legacy({ time: "13:15" });
  const oldBearer = linkToken(services().management.emailLink(await withPrivateFields(old.id)));
  // Test-only authentication keeps this integration focused on DTO projection;
  // the real session/CSRF implementation has its own dedicated regression suite.
  const auth = {
    requireAuth(req, res, next) {
      if (req.headers.authorization === "Bearer synthetic-staff") return next();
      return res.status(401).json({ error: "Synthetic staff authentication required." });
    },
    requireCsrf(req, res, next) {
      if (req.headers["x-mechanic-csrf"] === "synthetic-staff-csrf") return next();
      return res.status(403).json({ error: "Synthetic staff CSRF required." });
    },
    login(_req, res) { res.status(501).end(); },
    session(_req, res) { res.status(501).end(); },
    activity(_req, res) { res.status(501).end(); },
    logout(_req, res) { res.status(501).end(); },
  };
  const notifications = {
    enabled: true,
    isEnabledFor: appointment => appointmentMatchesEmailScope(appointment, scope),
    kick() {},
  };
  const app = createApp({
    Appointment, scheduling, management, notifications, auth,
    appointmentEmailTest: { enabled: true, runId: scope.runId, notificationEnv: fakeEnv() },
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const staffHeaders = { Authorization: "Bearer synthetic-staff", "X-Mechanic-CSRF": "synthetic-staff-csrf" };
  async function api(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    const serialized = JSON.stringify(result);
    for (const privateValue of [scope.runId, APPOINTMENT_EMAIL_TEST_FIELD, "notificationEnv", fakeEnv().BREVO_API_KEY, fakeEnv().APPOINTMENT_MANAGEMENT_SECRET]) {
      assert.equal(serialized.includes(privateValue), false, "HTTP response contains private email-test configuration");
    }
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, result, response };
  }
  const publicStatus = await api("/api/appointment-email-test");
  assert.deepEqual(publicStatus.result, { enabled: true, recipient: OWNED_EMAIL_TEST_RECIPIENT });
  assert.equal((await api("/api/mechanic/appointment-email-test")).status, 401);
  const staffStatus = await api("/api/mechanic/appointment-email-test", { headers: staffHeaders });
  assert.deepEqual(staffStatus.result, publicStatus.result);

  const created = await api("/api/appointments", { method: "POST", body: request() });
  assert.equal(created.status, 201);
  assert.equal(created.result.emailNotification, "queued");
  assert.equal(created.result.managementAccess, true);
  const id = created.result.id;
  const list = await api("/api/mechanic/appointments?status=all", { headers: staffHeaders });
  assert.equal(list.status, 200);
  assert.equal(list.result.appointments.find(appointment => appointment._id === old.id).emailTestEligible, false);
  assert.equal(list.result.appointments.find(appointment => appointment._id === id).emailTestEligible, true);

  const oldDecision = await api(`/api/mechanic/appointments/${old.id}`, {
    method: "PATCH", headers: staffHeaders, body: { status: "confirmed" },
  });
  assert.equal(oldDecision.status, 200);
  assert.equal(oldDecision.result.emailNotification, "disabled");
  assert.equal((await withPrivateFields(old.id))[APPOINTMENT_EMAIL_TEST_FIELD], undefined);
  const currentDecision = await api(`/api/mechanic/appointments/${id}`, {
    method: "PATCH", headers: staffHeaders, body: { status: "confirmed" },
  });
  assert.equal(currentDecision.status, 200);
  assert.equal(currentDecision.result.emailNotification, "queued");
  const rejectedOldLink = await api(`/api/customer/appointments/${oldBearer.id}/exchange`, {
    method: "POST", headers: { Origin: origin }, body: { token: oldBearer.token },
  });
  assert.equal(rejectedOldLink.status, 401);

  const bearer = linkToken(management.emailLink(await withPrivateFields(id)));
  const exchanged = await api(`/api/customer/appointments/${id}/exchange`, {
    method: "POST", headers: { Origin: origin }, body: { token: bearer.token },
  });
  assert.equal(exchanged.status, 200);
  for (const field of ["name", "email", "phone", "notes", "management", "scheduling", APPOINTMENT_EMAIL_TEST_FIELD]) {
    assert.equal(Object.hasOwn(exchanged.result.appointment, field), false);
  }
  const cookie = exchanged.response.headers.get("set-cookie").split(";")[0];
  const cancelled = await api(`/api/customer/appointments/${id}/cancel`, {
    method: "POST", body: { category: "plans_changed" },
    headers: { Origin: origin, Cookie: cookie, "X-Appointment-CSRF": exchanged.result.csrfToken },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.result.appointment.status, "cancelled");
  assert.deepEqual(cancelled.result.notifications, { customer: "queued", mechanic: "queued" });
  assert.equal((await withPrivateFields(id))[APPOINTMENT_EMAIL_TEST_FIELD], scope.runId);
});
