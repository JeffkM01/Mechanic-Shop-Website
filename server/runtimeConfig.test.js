import test from "node:test";
import assert from "node:assert/strict";
import { readRuntimeConfig } from "./runtimeConfig.js";

test("runtime defaults bind development locally and production to the container interface without enabling frontend or automation", () => {
  assert.deepEqual(readRuntimeConfig({}), { production: false, host: "127.0.0.1", port: 3001, serveFrontend: false, shutdownGraceMs: 10000, trustProxy: false });
  assert.deepEqual(readRuntimeConfig({ NODE_ENV: "production" }), { production: true, host: "0.0.0.0", port: 3001, serveFrontend: false, shutdownGraceMs: 10000, trustProxy: false });
  assert.equal(readRuntimeConfig({ NODE_ENV: "test", HOST: "::1", PORT: "4100", SERVE_FRONTEND: "true", SHUTDOWN_GRACE_MS: "30000" }).serveFrontend, true);
});

test("runtime rejects malformed bind settings, implicit truthy frontend flags and unbounded shutdown windows without echoing values", () => {
  for (const value of ["", "0", "65536", "3001oops", "-1", "1.5", " 3001", 3001]) assert.throws(() => readRuntimeConfig({ PORT: value }), /PORT must/);
  for (const value of ["", "my-secret-password", "https://shop.example", "0.0.0.0 ", "127.0.0.999"]) assert.throws(() => readRuntimeConfig({ HOST: value }), error => error.message === "HOST must be a valid bind IP address or localhost.");
  for (const value of ["", "1", "yes", "TRUE", true]) assert.throws(() => readRuntimeConfig({ SERVE_FRONTEND: value }), /SERVE_FRONTEND must/);
  for (const value of ["0", "999", "30001", "1e3", "ten"]) assert.throws(() => readRuntimeConfig({ SHUTDOWN_GRACE_MS: value }), /SHUTDOWN_GRACE_MS must/);
});

test("proxy trust is disabled unless explicit valid trusted addresses or CIDRs are supplied", () => {
  assert.equal(readRuntimeConfig({ TRUST_PROXY: "false" }).trustProxy, false);
  assert.deepEqual(readRuntimeConfig({ TRUST_PROXY: "127.0.0.1, 10.20.0.0/16,::1/128" }).trustProxy, ["127.0.0.1", "10.20.0.0/16", "::1/128"]);
  for (const value of ["true", "1", "2", "0.0.0.0/0", "::/0", "loopback", "10.0.0.0/33", "::1/129", "10.0.0.1,", "10.0.0.1/32/extra"]) assert.throws(() => readRuntimeConfig({ TRUST_PROXY: value }), /TRUST_PROXY/);
});

test("runtime configuration never returns credentials or a public-origin guess", () => {
  const result = readRuntimeConfig({ MONGODB_URI: "mongodb://private-user:private-password@example.invalid/db", SMTP_PASS: "smtp-secret", APPOINTMENT_MANAGEMENT_SECRET: "management-secret" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  for (const key of ["MONGODB_URI", "SMTP_PASS", "APPOINTMENT_MANAGEMENT_SECRET", "PUBLIC_WEBSITE_ORIGIN"]) assert.equal(Object.hasOwn(result, key), false);
});
