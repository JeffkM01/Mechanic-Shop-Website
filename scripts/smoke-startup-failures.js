// CI/local Docker regression checks only. Every container has networking
// disabled, synthetic credentials, and no mounted files or host env secrets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

const image = process.argv[2] || "eds-auto-shop:ci";
const dockerEnv = { ...process.env };
for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete dockerEnv[name];
function docker(args, timeout = 30000) {
  const result = spawnSync("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    env: dockerEnv, encoding: "utf8", timeout,
  });
  assert.equal(result.error, undefined, "isolated Docker operation must finish within its deadline");
  assert.equal(result.status, 0, "isolated Docker operation must succeed");
  return result;
}

const database = "eds_staging_image_failure_test";
const uri = `mongodb://synthetic-user:synthetic-database-private-marker@127.0.0.1:1/${database}`;
const baseline = {
  DEPLOYMENT_STAGE: "staging", MONGODB_DATABASE: database, MONGODB_URI: uri,
  STAGING_ACCESS_PASSWORD: "Synthetic-preview-private-secret-5930",
  MECHANIC_ADMIN_PASSWORD: "Synthetic-staff-private-secret-5930",
  BOOKING_RATE_LIMIT_ENABLED: "true",
};
const cases = [
  ["STAGING_ACCESS_PASSWORD", { STAGING_ACCESS_PASSWORD: "synthetic-short" }],
  ["STAGING_DATABASE_NAME", { MONGODB_DATABASE: "wrong_database_test" }],
  ["STAGING_DATABASE_URI", { MONGODB_URI: undefined, MONGODB_URL: uri }],
  ["MECHANIC_ADMIN_PASSWORD", { MECHANIC_ADMIN_PASSWORD: undefined }],
  ["EMAIL_TEST_CONFIGURATION", { STAGING_EMAIL_TEST_ENABLED: "invalid" }],
  ["EMAIL_TEST_CONFIGURATION", { STAGING_EMAIL_TEST_ENABLED: "true" }],
  ["EMAIL_TEST_CONFIGURATION", { DEPLOYMENT_STAGE: "production", STAGING_EMAIL_TEST_ENABLED: "true", BREVO_API_KEY: "synthetic-private-api-marker-for-negative-test" }],
  ["DATABASE_UNREACHABLE", {}],
];

for (const [code, patch] of cases) {
  const env = { ...baseline, ...patch };
  const args = ["create", "--network", "none"];
  for (const [name, value] of Object.entries(env)) if (value !== undefined) args.push("--env", `${name}=${value}`);
  args.push(image);
  const id = docker(args).stdout.trim();
  assert.match(id, /^[a-f\d]{64}$/);
  try {
    docker(["start", id]);
    assert.equal(docker(["wait", id]).stdout.trim(), "1", "failed startup must retain a nonzero exit");
    const result = docker(["logs", id]);
    const logs = result.stdout + result.stderr;
    assert.ok(logs.includes(`Could not start the appointment service. [${code}] `), "packaged bootstrap must identify the failed stage");
    assert.equal(logs.trim().split("\n").length, 1, "failed startup emits only one safe diagnostic");
    for (const secret of [uri, "synthetic-database-private-marker", baseline.STAGING_ACCESS_PASSWORD,
      baseline.MECHANIC_ADMIN_PASSWORD, "synthetic-short", "synthetic-private-api-marker-for-negative-test"]) assert.equal(logs.includes(secret), false, "startup diagnostics must never echo synthetic secrets");
    assert.equal(logs.includes("mongodb://"), false);
    console.log(`Packaged startup [${code}]: exit 1 and redacted diagnostic verified.`);
  } finally {
    docker(["rm", "--force", id]);
  }
}
