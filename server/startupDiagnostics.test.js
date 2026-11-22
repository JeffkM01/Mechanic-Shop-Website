import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { startupFailureMessage } from "./startupDiagnostics.js";
import { readRuntimeConfig } from "./runtimeConfig.js";
import { readStagingSafety } from "./stagingSafety.js";
import { readBookingAbuseConfig } from "./bookingAbuseProtection.js";
import { createMechanicAuth } from "./mechanicAuth.js";

const PREFIX = "Could not start the appointment service. ";
const SECRET = "SYNTHETIC_SECRET_MUST_NEVER_APPEAR_84019";
const phaseCases = ["RUNTIME_CONFIGURATION", "STAGING_CONFIGURATION", "BOOKING_RATE_LIMIT_CONFIGURATION", "MECHANIC_AUTH_CONFIGURATION", "DATABASE_URI_CONFIGURATION", "DATABASE_CONNECTION", "DATABASE_INDEXES", "CUSTOMER_MANAGEMENT", "SCHEDULING_SETTINGS", "NOTIFICATIONS", "HTTP_APPLICATION", "HTTP_LISTENER"];
const stageEnv = { DEPLOYMENT_STAGE: "staging", STAGING_ACCESS_PASSWORD: "Synthetic-stage-7381-Autumn-5962-unique", MONGODB_DATABASE: "eds_staging_diagnostics", MONGODB_URI: "mongodb+srv://synthetic:synthetic@cluster.example.invalid/eds_staging_diagnostics" };

function rejectedBy(action) {
  try { action(); } catch (error) { return error; }
  assert.fail("Synthetic configuration should have been rejected");
}

test("every known startup phase produces a useful fixed message while unknown phases cannot print caller input", () => {
  for (const phase of phaseCases) {
    const message = startupFailureMessage(phase, new Error(SECRET));
    assert.ok(message.startsWith(`${PREFIX}[${phase}] `), phase);
    assert.equal(message.includes(SECRET), false);
    assert.ok(message.length > PREFIX.length + phase.length + 10);
  }
  for (const phase of [undefined, null, "", SECRET, "__proto__", "constructor", 18, { toString() { throw new Error(SECRET); } }]) {
    assert.match(startupFailureMessage(phase, new Error(SECRET)), /\[STARTUP_UNKNOWN\]/);
    assert.equal(startupFailureMessage(phase, new Error(SECRET)).includes(SECRET), false);
  }
});

test("actual staging validators map missing passwords, database names and malformed URIs to distinct safe codes", () => {
  for (const [patch, code] of [
    [{ DEPLOYMENT_STAGE: "wrong" }, "DEPLOYMENT_STAGE"],
    [{ STAGING_ACCESS_PASSWORD: undefined }, "STAGING_ACCESS_PASSWORD"],
    [{ STAGING_ACCESS_PASSWORD: "short" }, "STAGING_ACCESS_PASSWORD"],
    [{ MONGODB_DATABASE: undefined }, "STAGING_DATABASE_NAME"],
    [{ MONGODB_DATABASE: "normal_shop" }, "STAGING_DATABASE_NAME"],
    [{ MONGODB_URI: undefined }, "STAGING_DATABASE_URI"],
    [{ MONGODB_URI: "mongodb://127.0.0.1/eds_staging_other" }, "STAGING_DATABASE_URI"],
    [{ MONGODB_URI: "mongodb://127.0.0.1/" }, "STAGING_DATABASE_URI"],
    [{ MONGODB_URI: "mongodb+srv://cluster.example.invalid/eds_staging_diagnostics?tls=false" }, "STAGING_DATABASE_URI"],
  ]) {
    const error = rejectedBy(() => readStagingSafety({ ...stageEnv, ...patch }));
    assert.ok(startupFailureMessage("STAGING_CONFIGURATION", error).startsWith(`${PREFIX}[${code}] `), code);
  }
});

test("actual runtime validators report only the known failing setting name", () => {
  for (const [patch, code] of [
    [{ HOST: SECRET }, "HOST"], [{ PORT: "invalid" }, "PORT"], [{ SERVE_FRONTEND: "yes" }, "SERVE_FRONTEND"],
    [{ SHUTDOWN_GRACE_MS: "0" }, "SHUTDOWN_GRACE_MS"], [{ TRUST_PROXY: true }, "TRUST_PROXY"], [{ TRUST_PROXY: "0.0.0.0/0" }, "TRUST_PROXY"],
  ]) {
    const error = rejectedBy(() => readRuntimeConfig(patch));
    const message = startupFailureMessage("RUNTIME_CONFIGURATION", error);
    assert.ok(message.startsWith(`${PREFIX}[${code}] `), code);
    assert.equal(message.includes(SECRET), false);
  }
});

test("actual booking-quota and mechanic-password validators have specific safe diagnostics", () => {
  for (const [patch, code] of [
    [{ BOOKING_RATE_LIMIT_ENABLED: "yes" }, "BOOKING_RATE_LIMIT_ENABLED"],
    [{ BOOKING_RATE_LIMIT_MAX: "0" }, "BOOKING_RATE_LIMIT_MAX"],
    [{ BOOKING_RATE_LIMIT_WINDOW_MINUTES: "0" }, "BOOKING_RATE_LIMIT_WINDOW_MINUTES"],
  ]) {
    const error = rejectedBy(() => readBookingAbuseConfig(patch));
    assert.ok(startupFailureMessage("BOOKING_RATE_LIMIT_CONFIGURATION", error).startsWith(`${PREFIX}[${code}] `), code);
  }
  const error = rejectedBy(() => createMechanicAuth(undefined));
  assert.match(startupFailureMessage("MECHANIC_AUTH_CONFIGURATION", error), /\[MECHANIC_ADMIN_PASSWORD\]/);
});

test("only exact own-validator messages are recognized; added secrets or foreign messages fall back to the phase", () => {
  const known = rejectedBy(() => readStagingSafety({ ...stageEnv, STAGING_ACCESS_PASSWORD: "short" })).message;
  for (const message of [`${known} ${SECRET}`, `${SECRET} ${known}`, SECRET, "x".repeat(4096)]) {
    const result = startupFailureMessage("STAGING_CONFIGURATION", { message, stack: SECRET });
    assert.ok(result.startsWith(`${PREFIX}[STAGING_CONFIGURATION] `));
    assert.equal(result.includes(SECRET), false);
  }
  assert.match(startupFailureMessage("HTTP_APPLICATION", { message: known }), /\[HTTP_APPLICATION\]/);
});

test("MongoDB authentication and operation permissions are distinguished using exact numeric codes", () => {
  for (const phase of ["DATABASE_CONNECTION", "DATABASE_INDEXES"]) {
    assert.match(startupFailureMessage(phase, { code: 18, message: SECRET }), /\[DATABASE_AUTHENTICATION\]/);
    assert.match(startupFailureMessage(phase, { code: 13, message: SECRET }), /\[DATABASE_PERMISSION\]/);
    assert.match(startupFailureMessage(phase, { errorResponse: { code: 13, errmsg: SECRET } }), /\[DATABASE_PERMISSION\]/);
    assert.match(startupFailureMessage(phase, { cause: { code: 18, message: SECRET } }), /\[DATABASE_AUTHENTICATION\]/);
    assert.ok(startupFailureMessage(phase, { code: "18", message: SECRET }).includes(`[${phase}]`));
  }
  assert.match(startupFailureMessage("NOTIFICATIONS", { code: 18, message: SECRET }), /\[NOTIFICATIONS\]/);
});

test("known database DNS, TLS and network failures give fixed advice without guessing an exact allowlist cause", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENODATA", "SERVFAIL", "ESERVFAIL", "ETIMEOUT"]) {
    assert.match(startupFailureMessage("DATABASE_CONNECTION", { code, hostname: SECRET }), /\[DATABASE_DNS\]/);
  }
  for (const code of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN"]) {
    const result = startupFailureMessage("DATABASE_CONNECTION", { cause: { code, message: SECRET } });
    assert.match(result, /\[DATABASE_TLS\]/);
    assert.match(result, /keep certificate and hostname verification enabled/);
    assert.equal(result.includes(SECRET), false);
  }
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"]) {
    const result = startupFailureMessage("DATABASE_CONNECTION", { code, address: SECRET });
    assert.match(result, /\[DATABASE_UNREACHABLE\]/);
    assert.match(result, /does not identify which network rule failed/);
  }
});

test("nested topology failures take specific evidence before generic selection errors and preserve unknown index failures", () => {
  const error = { name: "MongoServerSelectionError", message: SECRET,
    reason: { servers: new Map([[SECRET, { error: { cause: { code: "CERT_HAS_EXPIRED", message: SECRET } } }]]) } };
  assert.match(startupFailureMessage("DATABASE_CONNECTION", error), /\[DATABASE_TLS\]/);
  for (const name of ["MongoServerSelectionError", "MongooseServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError"]) {
    assert.match(startupFailureMessage("DATABASE_CONNECTION", { name, message: SECRET }), /\[DATABASE_UNREACHABLE\]/);
  }
  for (const name of ["MongoParseError", "MongoInvalidArgumentError"]) assert.match(startupFailureMessage("DATABASE_CONNECTION", { name }), /\[DATABASE_URI_CONFIGURATION\]/);
  assert.match(startupFailureMessage("DATABASE_INDEXES", { code: 11000, keyValue: { email: SECRET }, message: SECRET }), /\[DATABASE_INDEXES\]/);
});

test("the installed MongoDB driver's error classes and name accessors produce the expected safe categories", () => {
  const { MongoServerError, MongoServerSelectionError, MongoNetworkError, MongoParseError } = mongoose.mongo;
  for (const [error, code] of [
    [new MongoServerError({ code: 18, errmsg: SECRET }), "DATABASE_AUTHENTICATION"],
    [new MongoServerError({ code: 13, errmsg: SECRET }), "DATABASE_PERMISSION"],
    [new MongoServerSelectionError(SECRET, { servers: new Map() }), "DATABASE_UNREACHABLE"],
    [new MongoNetworkError(SECRET), "DATABASE_UNREACHABLE"],
    [new MongoParseError(SECRET), "DATABASE_URI_CONFIGURATION"],
  ]) {
    const result = startupFailureMessage("DATABASE_CONNECTION", error);
    assert.ok(result.startsWith(`${PREFIX}[${code}] `), code);
    assert.equal(result.includes(SECRET), false);
  }
});

test("database diagnostics never read messages or stacks, invoke string conversion, or echo raw values", () => {
  let reads = 0;
  const error = Object.freeze({
    code: 18,
    get message() { reads++; throw new Error(SECRET); },
    get stack() { reads++; throw new Error(SECRET); },
    toString() { reads++; throw new Error(SECRET); },
    uri: `mongodb+srv://private-user:${SECRET}@private.example.invalid/private_db`,
  });
  const result = startupFailureMessage("DATABASE_CONNECTION", error);
  assert.match(result, /\[DATABASE_AUTHENTICATION\]/);
  assert.equal(reads, 0);
  assert.equal(result.includes(SECRET), false);
  assert.equal(result.includes("private.example.invalid"), false);
});

test("throwing accessors, proxies, primitive errors and untrusted values do not break failure reporting", () => {
  const poisoned = new Proxy({}, { get() { throw new Error(SECRET); } });
  for (const error of [poisoned, undefined, null, SECRET, 18, { code: { toString() { throw new Error(SECRET); } }, name: SECRET }]) {
    for (const phase of ["DATABASE_CONNECTION", "STAGING_CONFIGURATION", "HTTP_APPLICATION"]) {
      const message = startupFailureMessage(phase, error);
      assert.ok(message.startsWith(`${PREFIX}[${phase}] `));
      assert.equal(message.includes(SECRET), false);
    }
  }
});

test("cause traversal handles cycles without mutating errors and stays bounded for hostile graphs", () => {
  const error = { code: "ENOTFOUND", message: SECRET }; error.cause = error;
  Object.freeze(error);
  assert.match(startupFailureMessage("DATABASE_CONNECTION", error), /\[DATABASE_DNS\]/);
  assert.equal(error.cause, error);
  let reads = 0;
  function graph() { return { get cause() { reads++; return graph(); } }; }
  assert.match(startupFailureMessage("DATABASE_CONNECTION", graph()), /\[DATABASE_CONNECTION\]/);
  assert.ok(reads <= 16, `Error traversal must be bounded, saw ${reads} cause reads`);
  const servers = new Map(Array.from({ length: 1000 }, (_, index) => [index, { code: 18 }]));
  assert.match(startupFailureMessage("DATABASE_CONNECTION", { reason: { servers } }), /\[DATABASE_AUTHENTICATION\]/);
});
