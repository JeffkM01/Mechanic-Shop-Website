import test from "node:test";
import assert from "node:assert/strict";
import { createEmailNotifications } from "./emailNotifications.js";
import Appointment, { appointmentSchema } from "./Appointment.js";
import { EMAIL_KINDS } from "./emailTemplates.js";
import { customerAppointmentPayload } from "./customerRoutes.js";

// This queue model implements the Mongo predicates and updates used by the
// dispatcher. Tests never load runtime configuration, MongoDB, or SMTP.
const env = {
  SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user",
  SMTP_PASS: "synthetic-password", MAIL_FROM: "shop@example.invalid",
  MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid",
};
const START = Date.parse("2030-01-01T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PRIVATE_ERROR = "private SMTP password and appointment-management bearer";
const get = (record, path) => path.split(".").reduce((value, key) => value?.[key], record);

function set(record, path, value) {
  const keys = path.split(".");
  let target = record;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = structuredClone(value);
}

function matches(record, query) {
  return Object.entries(query).every(([path, expected]) => {
    if (path === "$or") return expected.some(branch => matches(record, branch));
    if (path === "$and") return expected.every(branch => matches(record, branch));
    const actual = get(record, path);
    if (expected === null) return actual === undefined || actual === null;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === "$exists") return (actual !== undefined) === operand;
        if (operator === "$lte") return actual !== undefined && actual !== null && +actual <= +operand;
        if (operator === "$lt") return actual !== undefined && actual !== null && +actual < +operand;
        if (operator === "$gte") return actual !== undefined && actual !== null && +actual >= +operand;
        if (operator === "$gt") return actual !== undefined && actual !== null && +actual > +operand;
        if (operator === "$in") return operand.includes(actual);
        if (operator === "$ne") return actual !== operand;
        throw new Error(`Unsupported synthetic predicate: ${operator}`);
      });
    }
    return actual instanceof Date || expected instanceof Date ? +actual === +expected : actual === expected;
  });
}

function appointment(index, changes = {}) {
  return {
    _id: String(index + 1).padStart(24, "0"),
    name: "Synthetic Retry Customer", email: `synthetic-${index}@example.invalid`,
    phone: "555-555-0167", vehicle: "2019 Honda Civic", service: "Oil Change",
    date: "2030-01-09", time: "08:00", notes: "Synthetic retry test.", status: "pending",
    createdAt: new Date(START - MINUTE + index),
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "not-applicable" },
    ...changes,
  };
}

function fixture(records, sendMail) {
  let clock = START;
  const state = { attempts: [], accepted: [], logs: [], queries: [] };
  const Appointment = {
    find(query) {
      state.queries.push(structuredClone(query));
      return {
        order: {}, maximum: Infinity,
        sort(order) { this.order = order; return this; },
        limit(maximum) { this.maximum = maximum; return this; },
        async lean() {
          return records.filter(record => matches(record, query)).sort((left, right) => {
            for (const [path, direction] of Object.entries(this.order)) {
              const a = get(left, path); const b = get(right, path);
              if (a < b) return -direction;
              if (a > b) return direction;
            }
            return 0;
          }).slice(0, this.maximum).map(record => structuredClone(record));
        },
      };
    },
    findById(id) {
      return { select() { return this; }, async lean() {
        return structuredClone(records.find(record => record._id === String(id)) ?? null);
      } };
    },
    async updateOne(query, change) {
      const record = records.find(value => matches(value, query));
      if (!record) return { modifiedCount: 0 };
      for (const [path, value] of Object.entries(change.$set ?? {})) set(record, path, value);
      for (const path of Object.keys(change.$unset ?? {})) {
        const keys = path.split(".");
        const target = get(record, keys.slice(0, -1).join("."));
        if (target) delete target[keys.at(-1)];
      }
      for (const [path, value] of Object.entries(change.$inc ?? {})) set(record, path, (get(record, path) ?? 0) + value);
      for (const [path, value] of Object.entries(change.$min ?? {})) {
        if (get(record, path) === undefined || get(record, path) > value) set(record, path, value);
      }
      for (const [path, value] of Object.entries(change.$push ?? {})) {
        let values = [...(get(record, path) ?? []), ...(value.$each ?? [value])];
        if (value.$slice !== undefined) values = value.$slice < 0 ? values.slice(value.$slice) : values.slice(0, value.$slice);
        set(record, path, values);
      }
      return { modifiedCount: 1 };
    },
  };
  return {
    records, state, get clock() { return clock; }, setClock(value) { clock = +value; },
    async create() {
      return createEmailNotifications({ Appointment, env, now: () => new Date(clock),
        logger: { error(message) { state.logs.push(message); } },
        transport: { async sendMail(message) {
          state.attempts.push(message.to);
          await sendMail?.(message);
          state.accepted.push(message.to);
        } },
      });
    },
  };
}

function rejection(command = "RCPT TO", responseCode = 550) {
  return Object.assign(new Error(PRIVATE_ERROR), { command, responseCode, code: PRIVATE_ERROR });
}

test("50 permanently rejected old recipients do not starve a newer deliverable appointment after restart", async () => {
  const records = Array.from({ length: 51 }, (_, index) => appointment(index));
  const newest = records.at(-1);
  const f = fixture(records, message => { if (message.to !== newest.email) throw rejection(); });
  const service = await f.create();
  await service.processPending();
  assert.equal(f.state.attempts.length, 50);
  for (const record of records.slice(0, 50)) {
    assert.equal(record.notificationState.requestCustomer, "failed");
    assert.equal(record.notificationRetry.requestCustomer.failureCount, 1);
    assert.equal(record.notificationRetry.requestCustomer.lastFailureCode, "recipient-rejected");
    assert.equal(record.notificationRetry.requestCustomer.history[0].permanent, true);
    assert.equal(record.status, "pending", "notification failure cannot undo the booking");
  }
  await service.stop();
  const restarted = await f.create();
  await restarted.processPending();
  await restarted.processPending();
  assert.deepEqual(f.state.accepted, [newest.email]);
  assert.equal(f.state.attempts.length, 51, "terminal failures must not be handed to SMTP again");
  assert.equal(newest.notificationState.requestCustomer, "sent");
  assert.doesNotMatch(JSON.stringify(records) + f.state.logs.join(" "), /private SMTP|management bearer/);
  await restarted.stop();
});

test("50 transient old failures back off durably so a new appointment sends before their retry deadline", async () => {
  const records = Array.from({ length: 51 }, (_, index) => appointment(index));
  const newest = records.at(-1);
  let recovered = false;
  const f = fixture(records, message => { if (!recovered && message.to !== newest.email) throw new Error(PRIVATE_ERROR); });
  const service = await f.create();
  await service.processPending();
  assert.equal(f.state.attempts.length, 50);
  for (const record of records.slice(0, 50)) {
    assert.equal(record.notificationState.requestCustomer, "pending");
    const retry = record.notificationRetry.requestCustomer;
    assert.equal(retry.failureCount, 1);
    assert.equal(+retry.nextAttemptAt, START + MINUTE);
    assert.equal(+retry.firstFailureAt, START);
    assert.equal(+retry.lastFailureAt, START);
    assert.equal(retry.lastFailureCode, "transport-error");
    assert.equal(retry.history[0].permanent, false);
  }
  await service.stop();
  const restarted = await f.create();
  await restarted.processPending();
  assert.deepEqual(f.state.accepted, [newest.email]);
  assert.equal(f.state.attempts.length, 51, "a process restart must preserve retry eligibility");
  recovered = true;
  f.setClock(START + MINUTE - 1);
  await restarted.processPending();
  assert.equal(f.state.attempts.length, 51);
  f.setClock(START + MINUTE);
  await restarted.processPending();
  await restarted.processPending();
  assert.equal(f.state.accepted.length, 51);
  assert.equal(new Set(f.state.accepted).size, 51);
  assert.ok(records.every(record => record.notificationState.requestCustomer === "sent"));
  assert.ok(records.slice(0, 50).every(record => record.notificationRetry.requestCustomer.failureCount === 1), "successful delivery retains the failure audit");
  assert.doesNotMatch(JSON.stringify(records) + f.state.logs.join(" "), /private SMTP|management bearer/);
  await restarted.stop();
});

test("retry eligibility is checked per notification kind after selecting a candidate appointment", async () => {
  const record = appointment(0, {
    status: "confirmed",
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "pending" },
    notificationRetry: { requestCustomer: { failureCount: 1, nextAttemptAt: new Date(START + MINUTE) } },
  });
  const f = fixture([record]);
  const service = await f.create();
  await service.processPending();
  assert.equal(record.notificationState.requestCustomer, "pending");
  assert.equal(record.notificationState.decisionCustomer, "sent");
  assert.equal(f.state.accepted.length, 1, "one due decision must not bypass another kind's backoff");
  await service.stop();
});

test("transient retries use bounded exponential backoff and retain only five redacted failure entries", async () => {
  const record = appointment(0);
  const f = fixture([record], () => { throw new Error(PRIVATE_ERROR); });
  const service = await f.create();
  for (let failure = 1; failure <= 14; failure++) {
    const failedAt = f.clock;
    await service.processPending();
    const retry = record.notificationRetry.requestCustomer;
    assert.equal(retry.failureCount, failure);
    assert.equal(+retry.nextAttemptAt - failedAt, Math.min(MINUTE * 2 ** (failure - 1), DAY));
    assert.equal(retry.history.length, Math.min(failure, 5));
    assert.equal(+retry.firstFailureAt, START);
    assert.equal(+retry.lastFailureAt, failedAt);
    assert.ok(retry.history.every(entry => entry.code === "transport-error" && entry.permanent === false));
    f.setClock(retry.nextAttemptAt);
  }
  assert.equal(f.state.attempts.length, 14);
  assert.doesNotMatch(JSON.stringify(record.notificationRetry) + f.state.logs.join(" "), /private SMTP|management bearer/);
  await service.stop();
});

test("authentication and sender 5xx failures remain retryable instead of permanently failing customer mail", async () => {
  for (const [command, responseCode] of [["AUTH PLAIN", 535], ["MAIL FROM", 550], ["RCPT TO", 450]]) {
    const record = appointment(0);
    const f = fixture([record], () => { throw rejection(command, responseCode); });
    const service = await f.create();
    await service.processPending();
    assert.equal(record.notificationState.requestCustomer, "pending", command);
    assert.equal(record.notificationRetry.requestCustomer.lastFailureCode, "transport-error");
    assert.equal(record.notificationRetry.requestCustomer.history[0].permanent, false);
    assert.equal(+record.notificationRetry.requestCustomer.nextAttemptAt, START + MINUTE);
    await service.stop();
  }
});

test("legacy pending records without retry metadata remain immediately eligible, while records without queue intent stay untouched", async () => {
  const pending = appointment(0);
  const historical = appointment(1, { notificationState: undefined });
  const f = fixture([pending, historical]);
  const service = await f.create();
  await service.processPending();
  assert.deepEqual(f.state.accepted, [pending.email]);
  assert.equal(pending.notificationState.requestCustomer, "sent");
  assert.equal(historical.notificationState, undefined);
  assert.equal(historical.notificationRetry, undefined);
  await service.stop();
});

function failureMetadata(changes = {}) {
  return {
    failureCount: 1,
    firstFailureAt: new Date(START), lastFailureAt: new Date(START),
    lastFailureCode: "recipient-rejected", nextAttemptAt: null,
    history: [{ at: new Date(START), code: "recipient-rejected", permanent: true }],
    ...changes,
  };
}

test("appointment schema accepts failed notification states and keeps bounded retry metadata private by default", async () => {
  const stored = new Appointment(appointment(0, {
    notificationState: Object.fromEntries(EMAIL_KINDS.map(kind => [kind, "failed"])),
    notificationRetry: Object.fromEntries(EMAIL_KINDS.map(kind => [kind, failureMetadata()])),
  }));
  await stored.validate();
  assert.equal(appointmentSchema.path("notificationRetry").options.select, false);
  assert.equal(new Appointment(appointment(1)).notificationRetry, undefined, "new schema must not manufacture failure metadata for old records");
  for (const changes of [
    { failureCount: 0 },
    { failureCount: 1.5 },
    { failureCount: 1_000_001 },
    { lastFailureCode: PRIVATE_ERROR },
    { history: Array.from({ length: 6 }, () => ({ at: new Date(START), code: "transport-error", permanent: false })) },
    { history: [{ at: new Date(START), code: PRIVATE_ERROR, permanent: false }] },
  ]) {
    const invalid = new Appointment(appointment(0, { notificationRetry: { requestCustomer: failureMetadata(changes) } }));
    await assert.rejects(invalid.validate(), { name: "ValidationError" }, "unbounded counts, history, and arbitrary provider codes must fail schema validation");
  }
});

test("each notification kind has a compound queue index covering status, retry deadline, and creation time", () => {
  const indexes = appointmentSchema.indexes().map(([keys]) => keys);
  for (const kind of EMAIL_KINDS) {
    assert.ok(indexes.some(keys =>
      keys[`notificationState.${kind}`] === 1
      && keys[`notificationRetry.${kind}.nextAttemptAt`] === 1
      && keys.createdAt === 1), `missing due-queue index for ${kind}`);
  }
});

test("customer cancellation payload reports terminal mail failure without exposing retry metadata", () => {
  const saved = appointment(0, {
    status: "cancelled",
    cancellation: {
      by: "customer", category: "plans_changed", cancelledAt: new Date(START),
      originalDate: "2030-01-09", originalTime: "08:00", timezone: "America/Chicago",
    },
    notificationState: { cancellationCustomer: "failed", cancellationMechanic: "pending" },
    notificationRetry: { cancellationCustomer: failureMetadata() },
  });
  const context = { appointment: saved, csrfToken: "synthetic-csrf-token", sessionExpiresAt: new Date(START + MINUTE) };
  const scheduling = { getCancellationEligibility: () => ({ canCancel: false, message: "This appointment has already been cancelled." }) };
  const payload = customerAppointmentPayload(context, scheduling, { enabled: true });
  assert.deepEqual(payload.notifications, { customer: "failed", mechanic: "queued" });
  assert.equal(payload.appointment.status, "cancelled");
  assert.doesNotMatch(JSON.stringify(payload), /notificationRetry|failureCount|FailureAt|FailureCode|recipient-rejected|nextAttemptAt|history/);
  assert.deepEqual(customerAppointmentPayload(context, scheduling, { enabled: false }).notifications,
    { customer: "disabled", mechanic: "disabled" });
});
