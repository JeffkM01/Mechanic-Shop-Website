import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uri = "mongodb://SYNTHETIC_DB_USER:SYNTHETIC_DB_PASSWORD@127.0.0.1:1/eds_staging_diagnostic_test";
const baseline = () => ({
  NODE_ENV: "production", HOST: "0.0.0.0", SERVE_FRONTEND: "false", TRUST_PROXY: "false",
  DEPLOYMENT_STAGE: "staging", BOOKING_RATE_LIMIT_ENABLED: "true",
  MONGODB_DATABASE: "eds_staging_diagnostic_test", MONGODB_URI: uri,
  STAGING_ACCESS_PASSWORD: "Synthetic-preview-private-secret-2083",
  MECHANIC_ADMIN_PASSWORD: "Synthetic-staff-private-secret-2083",
  APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 83).toString("base64url"),
  SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-mail-user",
  SMTP_PASS: "SYNTHETIC_SMTP_PASSWORD_NOT_FOR_LOGS", MAIL_FROM: "synthetic@example.invalid",
  MECHANIC_NOTIFICATION_EMAIL: "synthetic-staff@example.invalid",
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "eds-startup-bootstrap-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const part of ["server", "shared", "src/utils"]) await mkdir(join(directory, part), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  // Execute an isolated copy of the actual bootstrap. Its dotenv lookup points
  // to this temporary server directory, never the checkout's private .env.
  for (const part of ["server", "shared"]) {
    const entries = await readdir(join(project, part), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".test.js")) continue;
      const runtimeSource = entry.name.endsWith(".js") || (part === "shared" && entry.name.endsWith(".json"))
        || (part === "server" && entry.name === "package.json");
      if (runtimeSource) await copyFile(join(project, part, entry.name), join(directory, part, entry.name));
    }
  }
  await copyFile(join(project, "src/utils/bookingDates.js"), join(directory, "src/utils/bookingDates.js"));
  await symlink(join(project, "server/node_modules"), join(directory, "server/node_modules"), "dir");
  return directory;
}

const cases = [
  ["missing preview password", { STAGING_ACCESS_PASSWORD: undefined }, "STAGING_ACCESS_PASSWORD"],
  ["short preview password", { STAGING_ACCESS_PASSWORD: "SECRET_SHORT" }, "STAGING_ACCESS_PASSWORD"],
  ["missing staging database name", { MONGODB_DATABASE: undefined }, "STAGING_DATABASE_NAME"],
  ["non-staging database name", { MONGODB_DATABASE: "eds_production_test" }, "STAGING_DATABASE_NAME"],
  ["legacy URL variable without the required URI variable", { MONGODB_URI: undefined, MONGODB_URL: uri }, "STAGING_DATABASE_URI"],
  ["omitted database path", { MONGODB_URI: uri.replace("/eds_staging_diagnostic_test", "/") }, "STAGING_DATABASE_URI"],
  ["mismatched URI database", { MONGODB_URI: uri.replace("/eds_staging_diagnostic_test", "/eds_staging_other_test") }, "STAGING_DATABASE_URI"],
  ["missing staff password", { MECHANIC_ADMIN_PASSWORD: undefined }, "MECHANIC_ADMIN_PASSWORD"],
  ["invalid deployment stage", { DEPLOYMENT_STAGE: "SYNTHETIC_INVALID_STAGE" }, "DEPLOYMENT_STAGE"],
  ["invalid runtime host", { HOST: "SYNTHETIC_INVALID_HOST" }, "HOST"],
  ["invalid runtime port", { PORT: "SYNTHETIC_INVALID_PORT" }, "PORT"],
  ["invalid booking quota flag", { BOOKING_RATE_LIMIT_ENABLED: "SYNTHETIC_INVALID_BOOLEAN" }, "BOOKING_RATE_LIMIT_ENABLED"],
];

test("actual bootstrap identifies configuration failures before any database connection without exposing values", async t => {
  const directory = await fixture(t);
  for (const [description, patch, code] of cases) {
    await t.test(description, () => {
      // Never inherit MONGODB_URI, SMTP credentials, NODE_OPTIONS, or other
      // private values from the caller. Port 1 is an additional guard against
      // accidentally reaching the usual development MongoDB at port 27017.
      const supplied = { ...baseline(), ...patch };
      const env = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined));
      const result = spawnSync(process.execPath, [join(directory, "server/index.js")], {
        cwd: directory, env, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.error, undefined, "invalid configuration must exit promptly before MongoDB selection timeout");
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "", "failed startup must never advertise an accepting listener");
      assert.ok(result.stderr.startsWith(`Could not start the appointment service. [${code}] `), result.stderr);
      assert.equal(result.stderr.trim().split("\n").length, 1, "only the fixed diagnostic line is logged");
      for (const secret of [uri, "SYNTHETIC_DB_USER", "SYNTHETIC_DB_PASSWORD", baseline().STAGING_ACCESS_PASSWORD,
        baseline().MECHANIC_ADMIN_PASSWORD, baseline().APPOINTMENT_MANAGEMENT_SECRET, baseline().SMTP_PASS,
        "SECRET_SHORT", "SYNTHETIC_INVALID_STAGE", "SYNTHETIC_INVALID_HOST", "SYNTHETIC_INVALID_PORT", "SYNTHETIC_INVALID_BOOLEAN"]) {
        assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, "diagnostic must not echo configuration values");
      }
    });
  }
});
