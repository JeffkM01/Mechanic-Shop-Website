import test from "node:test";
import assert from "node:assert/strict";
import { buildEmail } from "./emailTemplates.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { DECLINE_NEXT_STEPS } from "../shared/declineReasons.js";

const config = {
  SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "test-user",
  SMTP_PASS: "test-password", MAIL_FROM: "shop@example.test",
  MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.test",
};

const sample = {
  _id: "0123456789abcdef01234567", name: "Sample Customer", email: "customer@example.test",
  phone: "555-0101", vehicle: "2016 Sedan", service: "Brake Repairs",
  date: "2026-11-06", time: "10:30", notes: "Noise at low speeds", status: "pending",
  notificationState: { requestCustomer: "pending", requestMechanic: "pending", decisionCustomer: "not-applicable" },
};

const emailOptions = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };

function cancelledRecord(by = "customer", changes = {}) {
  return {
    ...structuredClone(sample), status: "cancelled",
    cancellation: {
      by, category: by === "customer" ? "plans_changed" : "equipment_unavailable",
      ...(by === "customer" ? { message: "I will submit a new request later." } : { explanation: "The required equipment is unavailable. Please contact the shop about another visit." }),
      cancelledAt: "2026-11-05T20:30:00Z", originalDate: "2026-11-06", originalTime: "10:30", timezone: "America/Chicago",
    },
    notificationState: {
      requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "not-applicable",
      cancellationCustomer: "pending", cancellationMechanic: by === "customer" ? "pending" : "not-applicable",
    },
    ...changes,
  };
}

function fakeAppointmentModel(records, { afterBatch, beforeFreshRead, onSelect } = {}) {
  return {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() {
          const batch = records.filter((item) => Object.values(item.notificationState || {}).includes("pending")).map(item => {
            const copy = structuredClone(item);
            delete copy.management;
            return copy;
          });
          afterBatch?.();
          return batch;
        },
      };
    },
    findById(id) {
      let privateManagement = false;
      return {
        select(fields) { privateManagement = fields === "+management"; onSelect?.(fields); return this; },
        async lean() {
          beforeFreshRead?.(id);
          const record = records.find(item => item._id === id);
          if (!record) return null;
          const copy = structuredClone(record);
          if (!privateManagement) delete copy.management;
          return copy;
        },
      };
    },
    async updateOne(query, change) {
      const record = records.find((item) => item._id === query._id);
      const get = (field) => field.split(".").reduce((value, key) => value?.[key], record);
      if (!record || !Object.entries(query).every(([field, value]) => get(field) === value)) return { modifiedCount: 0 };
      for (const [field, value] of Object.entries(change.$set)) {
        const kind = field.split(".").at(-1);
        record.notificationState[kind] = value;
      }
      return { modifiedCount: 1 };
    },
  };
}

test("customer receipt says pending, not confirmed", () => {
  const email = buildEmail("requestCustomer", sample, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.to, sample.email);
  assert.match(email.text, /PENDING/);
  assert.doesNotMatch(email.text, /CONFIRMED/);
});

test("mechanic request includes contact and notes", () => {
  const email = buildEmail("requestMechanic", sample, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.to, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.match(email.text, /Noise at low speeds/);
  assert.equal(email.replyTo, sample.email);
});

test("decision email reflects approved and declined statuses", () => {
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  assert.match(buildEmail("decisionCustomer", { ...sample, status: "confirmed" }, options).text, /CONFIRMED/);
  assert.match(buildEmail("decisionCustomer", { ...sample, status: "declined" }, options).text, /declined/i);
  assert.throws(() => buildEmail("decisionCustomer", sample, options), /pending appointment/);
});

test("email service is disabled when credentials are absent", async () => {
  const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([]), env: {} });
  assert.equal(service.enabled, false);
  await service.processPending();
});

test("mailer failure leaves pending status and a later sweep retries", async () => {
  const records = [{ ...sample, notificationState: { ...sample.notificationState } }];
  const sent = [];
  let failOnce = true;
  const transport = {
    async sendMail(message) {
      if (failOnce) { failOnce = false; throw new Error("Simulated SMTP outage"); }
      sent.push(message);
    },
  };
  const logger = { error() {} };
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel(records), env: config, transport, logger,
  });
  await service.processPending();
  assert.equal(records[0].notificationState.requestCustomer, "pending");
  assert.equal(records[0].notificationState.requestMechanic, "sent");
  await service.processPending();
  assert.equal(records[0].notificationState.requestCustomer, "sent");
  assert.equal(sent.length, 2);
});

test("old appointments without queue flags are skipped", async () => {
  const records = [{ ...sample, notificationState: undefined }];
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel(records), env: config,
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  assert.equal(sent.length, 0);
});

test("pending scheduling receipts explain expiring holds without a false confirmation", () => {
  const email = buildEmail("requestCustomer", { ...sample, scheduling: { timezone: "America/Chicago", durationMinutes: 60, holdExpiresAt: "2026-11-08T12:00:00Z" } }, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.match(email.text, /PENDING/);
  assert.match(email.text, /request remains on file after expiry/);
  assert.match(email.text, /not a guaranteed repair completion time/);
  assert.doesNotMatch(email.text, /CONFIRMED/);
});

test("automatic customer confirmation uses the decision notification only", () => {
  const appointment = { ...sample, status: "confirmed", scheduling: { confirmationSource: "automatic", timezone: "America/Chicago" } };
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  assert.throws(() => buildEmail("requestCustomer", appointment, options), /decision notification/);
  for (const kind of ["requestMechanic", "decisionCustomer"]) {
    const email = buildEmail(kind, appointment, options);
    assert.match(email.text, /CONFIRMED/);
    assert.doesNotMatch(email.text, /PENDING|NOT been approved/);
  }
});

test("automatic bookings with both old customer flags queued send only one confirmation", async () => {
  const record = { ...sample, status: "confirmed", scheduling: { confirmationSource: "automatic" }, notificationState: { requestCustomer: "pending", requestMechanic: "pending", decisionCustomer: "pending" } };
  const sent = [];
  const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([record]), env: config, transport: { async sendMail(message) { sent.push(message); } } });
  await service.processPending();
  await service.processPending();
  const customer = sent.filter(message => message.to === sample.email);
  assert.equal(customer.length, 1);
  assert.match(customer[0].subject, /appointment confirmed/);
  assert.match(customer[0].text, /CONFIRMED/);
  assert.equal(sent.filter(message => message.to === config.MECHANIC_NOTIFICATION_EMAIL).length, 1);
  assert.equal(record.notificationState.requestCustomer, "suppressed");
  assert.equal(record.notificationState.decisionCustomer, "sent");
});

test("an old automatic receipt still queued after its decision was sent is suppressed", async () => {
  const record = { ...sample, status: "confirmed", scheduling: { confirmationSource: "automatic" }, notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "sent" } };
  const sent = [];
  const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([record]), env: config, transport: { async sendMail(message) { sent.push(message); } } });
  await service.processPending();
  assert.equal(sent.length, 0);
  assert.equal(record.notificationState.requestCustomer, "suppressed");
});

test("automatic decision retry keeps receipts suppressed and preserves the mechanic notice", async () => {
  const record = { ...sample, status: "confirmed", scheduling: { confirmationSource: "automatic" }, notificationState: { requestCustomer: "suppressed", requestMechanic: "pending", decisionCustomer: "pending" } };
  const sent = [];
  let failOnce = true;
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config, logger: { error() {} },
    transport: { async sendMail(message) {
      if (message.to === sample.email && failOnce) { failOnce = false; throw new Error("Temporary mail failure"); }
      sent.push(message);
    } },
  });
  await service.processPending();
  assert.equal(record.notificationState.decisionCustomer, "pending");
  await service.processPending();
  await service.processPending();
  assert.equal(sent.filter(message => message.to === sample.email).length, 1);
  assert.equal(sent.filter(message => message.to === config.MECHANIC_NOTIFICATION_EMAIL).length, 1);
  assert.equal(record.notificationState.requestCustomer, "suppressed");
  assert.equal(record.notificationState.decisionCustomer, "sent");
});

test("a pending receipt already in flight may finish, but automatic approval sends only one later confirmation", async () => {
  const record = { ...sample, notificationState: { ...sample.notificationState } };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) {
      sent.push(message);
      if (message.to === sample.email && /PENDING/.test(message.text)) {
        record.status = "confirmed";
        record.scheduling = { confirmationSource: "automatic" };
        record.notificationState.requestCustomer = "suppressed";
        record.notificationState.decisionCustomer = "pending";
      }
    } },
  });
  await service.processPending();
  await service.processPending();
  await service.processPending();
  const customer = sent.filter(message => message.to === sample.email);
  assert.equal(customer.length, 2);
  assert.match(customer[0].text, /PENDING/);
  assert.match(customer[1].text, /CONFIRMED/);
  assert.equal(record.notificationState.requestCustomer, "suppressed");
  assert.equal(record.notificationState.decisionCustomer, "sent");
});

test("every appointment email uses U.S. dates and AM/PM without changing stored scheduling values", () => {
  const source = {
    ...sample, time: "14:30",
    scheduling: { timezone: "America/Los_Angeles", durationMinutes: 90, holdExpiresAt: "2026-11-08T00:30:00Z" },
  };
  const before = structuredClone(source);
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  for (const kind of ["requestCustomer", "requestMechanic", "decisionCustomer"]) {
    const appointment = kind === "decisionCustomer" ? { ...source, status: "confirmed" } : source;
    const email = buildEmail(kind, appointment, options);
    assert.match(email.text, /Requested time: 11\/06\/2026 at 2:30 PM \(America\/Los_Angeles\)/);
    assert.doesNotMatch(email.text, /2026-11-06|14:30/);
    if (kind !== "decisionCustomer") {
      assert.match(email.text, /expires at 11\/07\/2026 at 4:30 PM \(America\/Los_Angeles\)/);
      assert.doesNotMatch(email.text, /2026-11-08T00:30/);
    }
  }
  assert.deepEqual(source, before);
});

test("decline email includes the saved explanation, service, shop-local date/time, and an actionable reply address", () => {
  const explanation = "We are unable to obtain the required wiper blades in time to perform the service.";
  const appointment = {
    ...sample, service: "Wiper Blade Replacement", date: "2026-11-12", time: "10:00", status: "declined",
    scheduling: { timezone: "America/Chicago" },
    decline: { category: "parts_unavailable", explanation, declinedAt: "2026-11-08T13:00:00Z", source: "mechanic" },
  };
  const email = buildEmail("decisionCustomer", appointment, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.subject, "Update on Your Appointment Request — Ed’s Auto Shop");
  assert.match(email.text, /Wiper Blade Replacement on 11\/12\/2026 at 10:00 AM \(America\/Chicago\)/);
  assert.ok(email.text.includes(`Reason: ${explanation}`));
  assert.ok(email.text.includes(DECLINE_NEXT_STEPS));
  assert.doesNotMatch(email.text, /another time has been|rescheduled|requested appointment time has been DECLINED|parts_unavailable|source:|INVALID_/i);
  assert.equal(email.to, sample.email);
  assert.equal(email.replyTo, config.MECHANIC_NOTIFICATION_EMAIL);
});

test("staff explanation stays in plain text and cannot become HTML or email headers", () => {
  const explanation = 'A specialist is required. <img src="x" onerror="alert(1)">\nBcc: unrelated@example.invalid';
  const email = buildEmail("decisionCustomer", {
    ...sample, status: "declined", decline: { category: "other", explanation },
  }, { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL });
  assert.equal(email.html, undefined);
  assert.ok(email.text.includes(explanation));
  assert.equal(email.to, sample.email);
  assert.equal(email.replyTo, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.equal(email.bcc, undefined);
  assert.equal(email.cc, undefined);
  assert.equal(email.subject.includes("Bcc"), false);
});

test("legacy declined emails never invent a reason from a missing or partial decline record", () => {
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  for (const decline of [undefined, {}, { category: "parts_unavailable" }, { explanation: "   " }]) {
    const email = buildEmail("decisionCustomer", { ...sample, status: "declined", decline }, options);
    assert.match(email.text, /reason was not recorded for this older declined request/);
    assert.doesNotMatch(email.text, /Reason:|parts are|parts unavailable|requested time is unavailable/i);
    assert.ok(email.text.includes(DECLINE_NEXT_STEPS));
  }
});

test("decline email failures preserve the saved decision and reason, retry the same flag, and do not replay after sent", async () => {
  const record = {
    ...sample, status: "declined",
    decline: { category: "outside_capabilities", explanation: "Your repair requires specialist equipment that our shop does not have.", declinedAt: "2026-11-05T14:00:00Z", source: "mechanic" },
    notificationState: { requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "pending" },
  };
  const originalDecision = structuredClone({ status: record.status, decline: record.decline });
  const attempts = [];
  const deliveries = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config, logger: { error() {} },
    transport: { async sendMail(message) {
      attempts.push(message);
      if (attempts.length === 1) throw new Error("Synthetic SMTP failure before acceptance");
      deliveries.push(message);
    } },
  });
  await service.processPending();
  assert.deepEqual({ status: record.status, decline: record.decline }, originalDecision);
  assert.equal(record.notificationState.decisionCustomer, "pending");
  await Promise.all([service.processPending(), service.processPending()]);
  await service.processPending();
  assert.equal(record.notificationState.decisionCustomer, "sent");
  assert.equal(attempts.length, 2);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(attempts[0], attempts[1], "a queue retry uses the same saved decline rather than creating another decision");
  assert.ok(deliveries[0].text.includes(record.decline.explanation));
  assert.deepEqual({ status: record.status, decline: record.decline }, originalDecision);
});

test("declined request receipts are refused rather than claiming a terminal request is pending", () => {
  assert.throws(() => buildEmail("requestCustomer", { ...sample, status: "declined" }, {
    from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL,
  }), /decision notification, not a pending request receipt/);
});

test("old declined queues suppress an unsent pending receipt but preserve the mechanic notice and one decision", async () => {
  const record = {
    ...sample, status: "declined",
    decline: { category: "service_not_offered", explanation: "The shop does not offer the requested specialist service." },
    notificationState: { requestCustomer: "pending", requestMechanic: "pending", decisionCustomer: "pending" },
  };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  await service.processPending();
  const customer = sent.filter(message => message.to === sample.email);
  const mechanic = sent.filter(message => message.to === config.MECHANIC_NOTIFICATION_EMAIL);
  assert.equal(customer.length, 1);
  assert.equal(mechanic.length, 1);
  assert.ok(customer[0].text.includes(record.decline.explanation));
  assert.doesNotMatch(customer[0].text, /PENDING/);
  assert.match(mechanic[0].text, /already been declined|already declined/);
  assert.doesNotMatch(mechanic[0].text, /NOT been approved|dashboard to approve or decline/);
  assert.ok(mechanic[0].text.includes(record.decline.explanation));
  assert.deepEqual(record.notificationState, { requestCustomer: "suppressed", requestMechanic: "sent", decisionCustomer: "sent" });
});

test("already sent request receipts survive decline reconciliation without being sent again", async () => {
  const record = {
    ...sample, status: "declined",
    decline: { category: "other", explanation: "The required equipment is unavailable for this repair." },
    notificationState: { requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "pending" },
  };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  await service.processPending();
  assert.equal(record.notificationState.requestCustomer, "sent");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(record.decline.explanation));
});

test("a receipt already in flight may finish before the saved decline decision is delivered once", async () => {
  const record = { ...sample, notificationState: { ...sample.notificationState } };
  const sent = [];
  const reason = "This vehicle requires specialist equipment the shop does not have.";
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) {
      sent.push(message);
      if (message.to === sample.email && /PENDING/.test(message.text)) {
        record.status = "declined";
        record.decline = { category: "outside_capabilities", explanation: reason };
        record.notificationState.requestCustomer = "suppressed";
        record.notificationState.decisionCustomer = "pending";
      }
    } },
  });
  await service.processPending();
  await service.processPending();
  await service.processPending();
  const customer = sent.filter(message => message.to === sample.email);
  assert.equal(customer.length, 2);
  assert.match(customer[0].text, /PENDING/);
  assert.ok(customer[1].text.includes(reason));
  assert.equal(record.notificationState.requestCustomer, "suppressed");
  assert.equal(record.notificationState.decisionCustomer, "sent");
});

test("a delayed mechanic request notice reflects manual confirmation instead of asking for another approval", () => {
  const email = buildEmail("requestMechanic", { ...sample, status: "confirmed", scheduling: { confirmationSource: "manual" } }, {
    from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL,
  });
  assert.match(email.text, /already been CONFIRMED by the mechanic/);
  assert.match(email.text, /already confirmed/);
  assert.doesNotMatch(email.text, /NOT been approved|dashboard to approve or decline|automatically/);
  assert.match(email.text, /Noise at low speeds/);
});

test("a delayed manual-approval receipt stays a receipt without falsely claiming pending or duplicating confirmation", () => {
  const email = buildEmail("requestCustomer", { ...sample, status: "confirmed", scheduling: { confirmationSource: "manual" } }, {
    from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL,
  });
  assert.match(email.subject, /request received/);
  assert.match(email.text, /already reviewed.*separate appointment decision email/);
  assert.doesNotMatch(email.text, /PENDING|CONFIRMED|after the request is reviewed/);
});

test("legacy customer addresses cannot be parsed as recipient lists, display names, or control-character headers", () => {
  const invalid = [
    "first@example.test,second@example.test", "first@example.test;second@example.test",
    "first,second@example.test", "Sample <customer@example.test>",
    "customer@example.test\r\nBcc: another@example.test", "customer@example.test\n", "customer@exam\tple.test",
    '"quoted local"@example.test', "cústomer@example.test", "customer@example..test", ".customer@example.test",
  ];
  const options = { from: config.MAIL_FROM, mechanicEmail: config.MECHANIC_NOTIFICATION_EMAIL };
  for (const email of invalid) {
    for (const kind of ["requestCustomer", "requestMechanic", "decisionCustomer"]) {
      const appointment = { ...sample, email, ...(kind === "decisionCustomer" ? { status: "declined" } : {}) };
      assert.throws(() => buildEmail(kind, appointment, options), {
        message: "Customer notification address needs review before email can be sent.",
      }, `${kind} must reject a malformed legacy address`);
    }
  }
  for (const email of ["customer@example.test", "customer+appointment@example.invalid", "  customer@example.test  "]) {
    const appointment = { ...sample, email };
    assert.equal(buildEmail("requestCustomer", appointment, options).to, email.trim());
    assert.equal(buildEmail("requestMechanic", appointment, options).replyTo, email.trim());
    assert.equal(appointment.email, email, "rendering must not rewrite a historical record");
  }
});

test("unsafe legacy recipients leave queues pending without sending private appointment contents or undoing the decision", async () => {
  const record = {
    ...sample, email: "customer@example.test,unrelated@example.test", status: "declined",
    decline: { category: "other", explanation: "The requested specialist service cannot be performed by the shop." },
    notificationState: { requestCustomer: "sent", requestMechanic: "pending", decisionCustomer: "pending" },
  };
  const before = structuredClone(record);
  const sent = [];
  const logs = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) { sent.push(message); } },
    logger: { error(message) { logs.push(message); } },
  });
  await service.processPending();
  await service.processPending();
  assert.deepEqual(record, before);
  assert.equal(sent.length, 0, "a malformed To or Reply-To value must never reach the transport");
  assert.equal(record.notificationState.decisionCustomer, "pending");
  assert.equal(record.status, "declined");
  assert.equal(logs.length, 4);
  assert.ok(logs.every(message => message.includes("delivery will be retried")));
  assert.ok(logs.every(message => !message.includes(record.email) && !message.includes(record.decline.explanation)));
});

test("customer cancellation acknowledgement and mechanic notice use saved original time, actor, and reason", () => {
  const record = cancelledRecord();
  // The immutable cancellation snapshot, rather than a mutable display field,
  // supplies the original appointment details.
  record.date = "2026-12-10";
  record.time = "08:00";
  record.scheduling = { timezone: "America/Los_Angeles" };
  const before = structuredClone(record);
  const customer = buildEmail("cancellationCustomer", record, emailOptions);
  const mechanic = buildEmail("cancellationMechanic", record, emailOptions);
  assert.equal(customer.subject, "Appointment Cancelled — Ed's Auto Shop");
  assert.equal(customer.to, sample.email);
  assert.equal(customer.replyTo, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.match(customer.text, /Brake Repairs appointment for 11\/06\/2026 at 10:30 AM \(America\/Chicago\) has been cancelled as you requested/);
  assert.match(customer.text, /Cancelled at: 11\/05\/2026 at 2:30 PM \(America\/Chicago\)/);
  assert.match(customer.text, /Cancelled by: Customer/);
  assert.match(customer.text, /My plans changed/);
  assert.ok(customer.text.includes(record.cancellation.message));
  assert.match(customer.text, /submit a new request through our website/);
  assert.match(customer.text, /No replacement appointment has been booked/);
  assert.equal(mechanic.to, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.equal(mechanic.replyTo, sample.email);
  assert.match(mechanic.subject, /Customer Cancelled/);
  assert.match(mechanic.text, /customer cancelled/i);
  assert.match(mechanic.text, /Do not confirm this cancelled appointment/);
  assert.doesNotMatch(customer.text + mechanic.text, /2026-11-06|10:30\s*\(America|2026-11-05T|12\/10\/2026|8:00 AM/);
  assert.deepEqual(record, before);
});

test("mechanic cancellation customer email contains final explanation and fixed safe headers", () => {
  const explanation = 'The lift is unavailable. <img src="x" onerror="alert(1)">\r\nBcc: unrelated@example.invalid';
  const record = cancelledRecord("mechanic");
  record.cancellation.explanation = explanation;
  const email = buildEmail("cancellationCustomer", record, emailOptions);
  assert.match(email.text, /shop has cancelled your Brake Repairs appointment/);
  assert.match(email.text, /Reason category: Equipment unavailable/);
  assert.ok(email.text.includes(`Reason: ${explanation}`));
  assert.match(email.text, /Cancelled by: Mechanic/);
  assert.match(email.text, /We apologize for the inconvenience/);
  assert.equal(email.html, undefined);
  assert.equal(email.bcc, undefined);
  assert.equal(email.cc, undefined);
  assert.equal(email.to, sample.email);
  assert.equal(email.replyTo, config.MECHANIC_NOTIFICATION_EMAIL);
  assert.equal(email.subject, "Appointment Cancelled — Ed's Auto Shop");
  assert.throws(() => buildEmail("cancellationMechanic", record, emailOptions), /Only customer cancellations/);
  assert.throws(() => buildEmail("cancellationCustomer", sample, emailOptions), /saved cancellation/);
  assert.throws(() => buildEmail("requestCustomer", record, emailOptions), /cancellation notification/);
  assert.throws(() => buildEmail("decisionCustomer", record, emailOptions), /Cannot send a decision/);
});

test("optional customer cancellation reason is not fabricated and unsafe legacy addresses remain rejected", () => {
  const record = cancelledRecord();
  delete record.cancellation.category;
  delete record.cancellation.message;
  assert.match(buildEmail("cancellationCustomer", record, emailOptions).text, /Customer reason: Not provided/);
  const mechanic = cancelledRecord("mechanic");
  delete mechanic.cancellation.explanation;
  assert.match(buildEmail("cancellationCustomer", mechanic, emailOptions).text, /explanation was not recorded/);
  for (const kind of ["cancellationCustomer", "cancellationMechanic"]) {
    assert.throws(() => buildEmail(kind, { ...record, email: "customer@example.test\r\nBcc: unrelated@example.test" }, emailOptions), /address needs review/);
  }
});

test("eligible customer emails include the private fragment link; legacy or expired grants use truthful contact fallback", () => {
  const managementLink = `https://shop.example.test/manage-appointment#id=${sample._id}&token=synthetic-bearer`;
  const cases = [
    ["requestCustomer", sample],
    ["decisionCustomer", { ...sample, status: "confirmed" }],
    ["cancellationCustomer", cancelledRecord()],
  ];
  for (const [kind, record] of cases) {
    const linked = buildEmail(kind, record, { ...emailOptions, managementLink });
    assert.ok(linked.text.includes(managementLink));
    assert.match(linked.text, /Keep this private link to yourself/);
    assert.doesNotMatch(linked.text, /localhost/);
    assert.equal(linked.html, undefined);
    for (const link of [undefined, null]) {
      const fallback = buildEmail(kind, record, { ...emailOptions, managementLink: link });
      assert.match(fallback.text, /contact the shop by replying to this email/);
      assert.match(fallback.text, /secure online management link is not available/);
      assert.doesNotMatch(fallback.text, /manage-appointment|token=|localhost|Reschedule/);
    }
  }
});

test("customer cancellation queues deliver once each, while mechanic cancellation sends only to the customer", async () => {
  for (const by of ["customer", "mechanic"]) {
    const record = cancelledRecord(by);
    const sent = [];
    const service = await createEmailNotifications({
      Appointment: fakeAppointmentModel([record]), env: config,
      transport: { async sendMail(message) { sent.push(message); } },
    });
    await service.processPending();
    await service.processPending();
    assert.equal(sent.filter(message => message.to === sample.email).length, 1);
    assert.equal(sent.filter(message => message.to === config.MECHANIC_NOTIFICATION_EMAIL).length, by === "customer" ? 1 : 0);
    assert.equal(record.notificationState.cancellationCustomer, "sent");
    assert.equal(record.notificationState.cancellationMechanic, by === "customer" ? "sent" : "not-applicable");
    assert.equal(record.status, "cancelled");
  }
});

test("failed cancellation delivery preserves durable cancellation and retries saved intent without new events", async () => {
  const record = cancelledRecord();
  const saved = structuredClone({ status: record.status, cancellation: record.cancellation });
  const attempts = [];
  const deliveries = [];
  let failCustomer = true;
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config, logger: { error() {} },
    transport: { async sendMail(message) {
      attempts.push(message);
      if (message.to === sample.email && failCustomer) { failCustomer = false; throw new Error("Synthetic cancellation SMTP outage"); }
      deliveries.push(message);
    } },
  });
  await service.processPending();
  assert.deepEqual({ status: record.status, cancellation: record.cancellation }, saved);
  assert.equal(record.notificationState.cancellationCustomer, "pending");
  assert.equal(record.notificationState.cancellationMechanic, "sent");
  await Promise.all([service.processPending(), service.processPending()]);
  await service.processPending();
  assert.equal(record.notificationState.cancellationCustomer, "sent");
  assert.equal(attempts.length, 3);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(attempts[0], attempts[2]);
  assert.deepEqual({ status: record.status, cancellation: record.cancellation }, saved);
});

test("a cancelled queue suppresses obsolete pending receipt and confirmation while preserving sent history", async () => {
  for (const receipt of ["pending", "sent"]) {
    const record = cancelledRecord("customer", {
      notificationState: {
        requestCustomer: receipt, requestMechanic: "pending", decisionCustomer: "pending",
        cancellationCustomer: "pending", cancellationMechanic: "pending",
      },
    });
    const sent = [];
    const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([record]), env: config, transport: { async sendMail(message) { sent.push(message); } } });
    await service.processPending();
    await service.processPending();
    assert.equal(record.notificationState.requestCustomer, receipt === "sent" ? "sent" : "suppressed");
    assert.equal(record.notificationState.decisionCustomer, "suppressed");
    assert.equal(sent.length, 3, "only the current-state mechanic notice and two cancellation messages are delivered");
    assert.ok(sent.every(message => !/PENDING|CONFIRMED|dashboard to approve or decline/.test(message.text)));
    const delayed = sent.find(message => /new appointment request/.test(message.subject));
    assert.match(delayed.text, /already been CANCELLED/);
    assert.match(delayed.text, /No approval action is available/);
  }
  const record = cancelledRecord("mechanic", { notificationState: { requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "sent", cancellationCustomer: "pending", cancellationMechanic: "not-applicable" } });
  const service = await createEmailNotifications({ Appointment: fakeAppointmentModel([record]), env: config, transport: { async sendMail() {} } });
  await service.processPending();
  assert.equal(record.notificationState.decisionCustomer, "sent");
});

test("a stale batch cannot dispatch an old confirmation after cancellation was durably saved", async () => {
  const record = { ...structuredClone(sample), status: "confirmed", notificationState: { requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "pending" } };
  const model = fakeAppointmentModel([record], { afterBatch() { Object.assign(record, cancelledRecord("mechanic")); } });
  const sent = [];
  const service = await createEmailNotifications({ Appointment: model, env: config, transport: { async sendMail(message) { sent.push(message); } } });
  await service.processPending();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Appointment Cancelled/);
  assert.equal(record.notificationState.decisionCustomer, "not-applicable");
});

test("each kind reads current status when cancellation occurs during a previous mechanic email", async () => {
  const record = { ...structuredClone(sample), status: "confirmed", notificationState: { requestCustomer: "sent", requestMechanic: "pending", decisionCustomer: "pending" } };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) {
      sent.push(message);
      if (message.to === config.MECHANIC_NOTIFICATION_EMAIL) {
        const cancellation = cancelledRecord("mechanic");
        record.status = "cancelled";
        record.cancellation = cancellation.cancellation;
        Object.assign(record.notificationState, { decisionCustomer: "suppressed", cancellationCustomer: "pending", cancellationMechanic: "not-applicable" });
      }
    } },
  });
  await service.processPending();
  assert.equal(sent.length, 2);
  assert.equal(sent.filter(message => /appointment confirmed/.test(message.subject)).length, 0);
  assert.match(sent[1].subject, /Appointment Cancelled/);
});

test("a confirmation already handed to transport may finish before the saved cancellation notice", async () => {
  const record = { ...structuredClone(sample), status: "confirmed", notificationState: { requestCustomer: "sent", requestMechanic: "sent", decisionCustomer: "pending" } };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record]), env: config,
    transport: { async sendMail(message) {
      sent.push(message);
      if (/appointment confirmed/.test(message.subject)) {
        record.status = "cancelled";
        record.cancellation = cancelledRecord("mechanic").cancellation;
        Object.assign(record.notificationState, { decisionCustomer: "suppressed", cancellationCustomer: "pending", cancellationMechanic: "not-applicable" });
      }
    } },
  });
  await service.processPending();
  await service.processPending();
  assert.equal(sent.length, 2, "an email already in flight cannot be recalled; cancellation follows it once");
  assert.match(sent[0].subject, /appointment confirmed/);
  assert.match(sent[1].subject, /Appointment Cancelled/);
  assert.equal(record.notificationState.decisionCustomer, "suppressed", "transport acknowledgement cannot overwrite cancellation suppression");
  assert.equal(record.status, "cancelled");
});

test("management links use private fresh metadata without persisting raw credentials or exposing them in errors", async () => {
  const bearer = "synthetic-private-bearer-DO-NOT-LOG";
  const managementLink = `https://shop.example.test/manage-appointment#id=${sample._id}&token=${bearer}`;
  const record = {
    ...structuredClone(sample), management: { nonce: "synthetic-nonce", tokenHash: "only-a-verifier", keyId: "test-key" },
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "not-applicable" },
  };
  const selections = [];
  const logs = [];
  const attempts = [];
  const before = structuredClone(record.management);
  let fail = true;
  const service = await createEmailNotifications({
    Appointment: fakeAppointmentModel([record], { onSelect(fields) { selections.push(fields); } }), env: config,
    management: { emailLink(appointment) { assert.deepEqual(appointment.management, before); return managementLink; } },
    transport: { async sendMail(message) {
      attempts.push(message);
      if (fail) {
        const error = new Error(`SMTP rejected body ${message.text}`);
        error.code = bearer;
        throw error;
      }
    } },
    logger: { error(message) { logs.push(message); } },
  });
  await service.processPending();
  assert.equal(record.notificationState.requestCustomer, "pending");
  assert.ok(attempts[0].text.includes(managementLink));
  assert.ok(selections.every(fields => fields === "+management"));
  assert.ok(logs.length > 0);
  assert.ok(logs.every(message => !message.includes(bearer) && !message.includes("manage-appointment") && !message.includes("Customer:")));
  assert.equal(JSON.stringify(record).includes(bearer), false);
  assert.deepEqual(record.management, before);
  fail = false;
  await service.processPending();
  assert.equal(record.notificationState.requestCustomer, "sent");
  assert.equal(new URL(managementLink).search, "");
  assert.match(new URL(managementLink).hash, /token=/);
});

test("provider acceptance followed by a failed cancellation acknowledgement retries the same durable intent", async () => {
  const record = cancelledRecord("mechanic");
  const before = structuredClone(record.cancellation);
  const model = fakeAppointmentModel([record]);
  const updateOne = model.updateOne.bind(model);
  let failAcknowledgement = true;
  model.updateOne = async (query, change) => {
    if (failAcknowledgement && change.$set?.["notificationState.cancellationCustomer"] === "sent") {
      failAcknowledgement = false;
      throw new Error("Synthetic acknowledgement failure after provider acceptance");
    }
    return updateOne(query, change);
  };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: model, env: config, logger: { error() {} },
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  assert.equal(record.notificationState.cancellationCustomer, "pending");
  assert.equal(sent.length, 1, "the provider accepted the first attempt");
  await service.processPending();
  await service.processPending();
  assert.equal(sent.length, 2, "at-least-once retries may duplicate external delivery after acknowledgement failure");
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(record.notificationState.cancellationCustomer, "sent");
  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.cancellation, before);
});

test("failed stale-message suppression never sends an obsolete pending receipt or confirmation", async () => {
  const record = cancelledRecord("mechanic", {
    notificationState: { requestCustomer: "pending", requestMechanic: "sent", decisionCustomer: "pending", cancellationCustomer: "pending", cancellationMechanic: "not-applicable" },
  });
  const model = fakeAppointmentModel([record]);
  const updateOne = model.updateOne.bind(model);
  let failSuppression = true;
  model.updateOne = async (query, change) => {
    if (failSuppression && Object.values(change.$set || {}).includes("suppressed")) {
      throw new Error("Synthetic stale-message suppression failure");
    }
    return updateOne(query, change);
  };
  const sent = [];
  const service = await createEmailNotifications({
    Appointment: model, env: config, logger: { error() {} },
    transport: { async sendMail(message) { sent.push(message); } },
  });
  await service.processPending();
  assert.equal(sent.length, 0, "failed reconciliation must fail closed before sending stale status");
  assert.equal(record.notificationState.requestCustomer, "pending");
  assert.equal(record.notificationState.decisionCustomer, "pending");
  assert.equal(record.notificationState.cancellationCustomer, "pending");
  failSuppression = false;
  await service.processPending();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Appointment Cancelled/);
  assert.equal(record.notificationState.requestCustomer, "suppressed");
  assert.equal(record.notificationState.decisionCustomer, "suppressed");
  assert.equal(record.notificationState.cancellationCustomer, "sent");
});
