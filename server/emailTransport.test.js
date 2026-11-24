import test from "node:test";
import assert from "node:assert/strict";
import { createBrevoApiTransport, isValidBrevoApiKey, readEmailConfiguration } from "./emailTransport.js";

const API_KEY = "synthetic-brevo-key-not-a-live-credential-437";
const apiEnv = () => ({ EMAIL_TRANSPORT: "brevo_api", BREVO_API_KEY: API_KEY,
  MAIL_FROM: "Ed's Auto Shop <shop@synthetic-mail-check.net>", MECHANIC_NOTIFICATION_EMAIL: "staff@synthetic-mail-check.net" });
const smtpEnv = () => ({ SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user", SMTP_PASS: "synthetic-password",
  MAIL_FROM: "shop@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid" });
const message = () => ({ from: apiEnv().MAIL_FROM, to: "customer@synthetic-mail-check.net", replyTo: apiEnv().MECHANIC_NOTIFICATION_EMAIL,
  subject: "Ed's Auto Shop — synthetic test", text: "Synthetic message only.\nNo customer information or real booking." });
const accepted = () => ({ ok: true, status: 201, async json() { return { messageId: "<synthetic-provider-message-id>" }; } });

test("SMTP remains the default and its existing configuration is preserved", () => {
  assert.equal(readEmailConfiguration({}), null);
  const source = smtpEnv();
  assert.deepEqual(readEmailConfiguration(source), { transport: "smtp", from: source.MAIL_FROM,
    mechanicEmail: source.MECHANIC_NOTIFICATION_EMAIL, host: source.SMTP_HOST, port: 587, user: source.SMTP_USER, pass: source.SMTP_PASS });
  assert.equal(readEmailConfiguration({ ...source, EMAIL_TRANSPORT: "smtp" }).transport, "smtp");
  assert.equal(readEmailConfiguration({ ...apiEnv(), EMAIL_TRANSPORT: undefined }), null, "an API key never silently selects HTTPS");
  assert.throws(() => readEmailConfiguration({ ...source, SMTP_PORT: "not-a-port" }), /SMTP_PORT must be a valid TCP port/);
});

test("explicit API configuration requires no SMTP settings and never modifies supplied settings", () => {
  const source = apiEnv();
  const original = structuredClone(source);
  assert.deepEqual(readEmailConfiguration(source), { transport: "brevo_api", from: source.MAIL_FROM,
    mechanicEmail: source.MECHANIC_NOTIFICATION_EMAIL, apiKey: API_KEY });
  assert.deepEqual(source, original);
  assert.equal(readEmailConfiguration({ ...source, SMTP_PORT: "invalid-but-unused", SMTP_PASS: "unused" }).transport, "brevo_api");
  for (const key of ["BREVO_API_KEY", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"]) {
    assert.equal(readEmailConfiguration({ ...source, [key]: "" }), null, key);
    const missing = { ...source }; delete missing[key];
    assert.equal(readEmailConfiguration(missing), null, key);
  }
});

test("unsupported modes and malformed API keys fail without exposing supplied values", () => {
  const secret = "PRIVATE_SYNTHETIC_VALUE_583";
  for (const EMAIL_TRANSPORT of ["", null, true, "https", secret]) {
    assert.throws(() => readEmailConfiguration({ ...smtpEnv(), EMAIL_TRANSPORT }), error =>
      error.message === "EMAIL_TRANSPORT must be smtp or brevo_api." && !String(error).includes(secret));
  }
  for (const key of [undefined, null, "", " key", "key ", "key\nInjected", "key\u007f", "x".repeat(2049)]) {
    assert.equal(isValidBrevoApiKey(key), false);
    assert.throws(() => createBrevoApiTransport({ apiKey: key, fetchImpl: () => assert.fail("No network allowed") }), /BREVO_API_KEY/);
  }
  for (const key of [`${secret}\n`, ` ${secret}`, "x".repeat(2049)]) {
    assert.throws(() => readEmailConfiguration({ ...apiEnv(), BREVO_API_KEY: key }), error => !String(error).includes(secret));
  }
});

test("API configuration refuses multi-recipient and injected sender or staff mailbox headers", () => {
  for (const patch of [{ MAIL_FROM: "one@synthetic-mail-check.net,two@synthetic-mail-check.net" },
    { MAIL_FROM: "Shop\r\nBcc:other@synthetic-mail-check.net" },
    { MECHANIC_NOTIFICATION_EMAIL: "Staff <staff@synthetic-mail-check.net>" },
    { MECHANIC_NOTIFICATION_EMAIL: "one@synthetic-mail-check.net,two@synthetic-mail-check.net" }]) {
    assert.throws(() => readEmailConfiguration({ ...apiEnv(), ...patch }), /email message needs review/);
  }
});

test("constructing HTTPS transport is offline and sends the existing plain-text message shape to the fixed endpoint", async () => {
  const calls = [];
  const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async (...args) => { calls.push(args); return accepted(); } });
  assert.deepEqual(calls, []);
  assert.deepEqual(await transport.sendMail(message()), { messageId: "<synthetic-provider-message-id>" });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error", "credentials must never follow a provider redirect");
  assert.equal(options.headers["api-key"], API_KEY);
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), {
    sender: { name: "Ed's Auto Shop", email: "shop@synthetic-mail-check.net" },
    to: [{ email: message().to }], replyTo: { email: message().replyTo },
    subject: message().subject, textContent: message().text,
  });
  assert.equal(options.body.includes(API_KEY), false);
});

test("bare sender mailboxes work without manufacturing a display name", async () => {
  let payload;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body); return accepted();
  } });
  await transport.sendMail({ ...message(), from: "shop@synthetic-mail-check.net" });
  assert.deepEqual(payload.sender, { email: "shop@synthetic-mail-check.net" });
});

test("recipient lists, address objects, injected headers and extra delivery fields are rejected before any network call", async () => {
  let calls = 0;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async () => { calls++; return accepted(); } });
  const bad = [];
  for (const field of ["from", "to", "replyTo"]) for (const value of [
    "one@synthetic-mail-check.net,two@synthetic-mail-check.net", "customer@synthetic-mail-check.net\r\nBcc:other@synthetic-mail-check.net",
    { email: "customer@synthetic-mail-check.net" }, ["customer@synthetic-mail-check.net"], null,
  ]) bad.push({ ...message(), [field]: value });
  for (const field of ["cc", "bcc", "envelope", "headers", "html", "attachments"]) bad.push({ ...message(), [field]: "unreviewed" });
  bad.push({ ...message(), to: "Customer <customer@synthetic-mail-check.net>" });
  for (const value of bad) await assert.rejects(transport.sendMail(value), error => error.code === "EMAIL_MESSAGE_INVALID");
  assert.equal(calls, 0);
});

test("bounded plain-text messages reject malformed or missing fields without leaking message content", async () => {
  const secret = "PRIVATE_SYNTHETIC_CUSTOMER_593";
  let calls = 0;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async () => { calls++; return accepted(); } });
  const missing = message(); delete missing.replyTo;
  for (const value of [null, [], {}, missing,
    { ...message(), subject: `${secret}\nInjected` }, { ...message(), subject: "x".repeat(251) },
    { ...message(), text: "" }, { ...message(), text: "x".repeat(65_537) }, { ...message(), text: `${secret}\0Injected` }]) {
    await assert.rejects(transport.sendMail(value), error => error.code === "EMAIL_MESSAGE_INVALID" && !String(error).includes(secret));
  }
  assert.equal(calls, 0);
});

test("HTTP failures are redacted single attempts and never fabricated as SMTP recipient rejection", async () => {
  const secret = "PRIVATE_PROVIDER_RESPONSE_653";
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let calls = 0; let cancelled = 0;
    const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async () => {
      calls++;
      return { ok: false, status, body: { async cancel() { cancelled++; } },
        json() { assert.fail(`Provider response ${secret} must not be inspected`); } };
    } });
    await assert.rejects(transport.sendMail(message()), error => {
      assert.equal(error.code, "BREVO_API_REJECTED");
      assert.equal(error.statusCode, status);
      assert.equal(error.command, undefined);
      assert.equal(error.responseCode, undefined);
      assert.equal(String(error).includes(secret), false);
      assert.equal(String(error).includes(API_KEY), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
});

test("network and redirect failures remain uncertain and never expose their raw error or retry automatically", async () => {
  const privateError = new Error(`Private key ${API_KEY} and customer ${message().to}`);
  let calls = 0;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, "error"); throw privateError;
  } });
  await assert.rejects(transport.sendMail(message()), error => {
    assert.equal(error.code, "BREVO_API_UNCERTAIN");
    assert.match(error.message, /Check the inbox before retrying/);
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes(API_KEY), false);
    assert.equal(error.stack.includes(message().to), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("timeouts abort the request and settle even if an injected request ignores its abort signal", async () => {
  let calls = 0; let signal;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, timeoutMs: 5, fetchImpl: (_url, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(transport.sendMail(message()), error => error.code === "BREVO_API_UNCERTAIN");
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("the timeout also bounds stalled provider response parsing", async () => {
  let signal;
  const transport = createBrevoApiTransport({ apiKey: API_KEY, timeoutMs: 5, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 201, json: () => new Promise(() => {}) };
  } });
  await assert.rejects(transport.sendMail(message()), error => error.code === "BREVO_API_UNCERTAIN");
  assert.equal(signal.aborted, true);
});

test("missing or unsafe provider acknowledgement is uncertain after one attempt", async () => {
  for (const result of [null, {}, { messageId: [] }, { messageId: "" }, { messageId: "private\r\nInjected" }, { messageId: "x".repeat(513) }]) {
    let calls = 0;
    const transport = createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: async () => {
      calls++; return { ok: true, status: 201, async json() { return result; } };
    } });
    await assert.rejects(transport.sendMail(message()), error => error.code === "BREVO_API_UNCERTAIN");
    assert.equal(calls, 1);
  }
});

test("invalid timeout and fetch configuration is rejected before construction can perform network I/O", () => {
  for (const timeoutMs of [0, -1, 30_001, 1.5, NaN, "1000"]) {
    assert.throws(() => createBrevoApiTransport({ apiKey: API_KEY, timeoutMs, fetchImpl() { assert.fail("No request allowed"); } }), /timeout must/);
  }
  assert.throws(() => createBrevoApiTransport({ apiKey: API_KEY, fetchImpl: null }), /fetch implementation/);
});
