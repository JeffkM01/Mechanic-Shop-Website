import { readRuntimeConfig } from "./runtimeConfig.js";
import { readStagingSafety } from "./stagingSafety.js";
import { readBookingAbuseConfig } from "./bookingAbuseProtection.js";
import { checkLaunchConfiguration } from "./launchChecks.js";
import { readEmailConnectionTestConfiguration } from "./emailConnectionTest.js";
import { readAppointmentEmailTestConfiguration } from "./appointmentEmailTest.js";

// Offline syntax checks only. Do not import index.js, load dotenv, construct a
// mail transport, resolve a database host, or return environment values.
export function checkStagingConfiguration({ env = process.env } = {}) {
  const checks = [];
  const add = (code, ok, message) => checks.push({ code, ok: Boolean(ok), message });
  let staging;
  let emailTestEnabled = false;
  let appointmentEmailTestEnabled = false;
  try {
    staging = readStagingSafety(env);
    add("STAGING_ISOLATION", staging.enabled, "Use DEPLOYMENT_STAGE=staging, a separate strong gateway password, and a matching explicit eds_staging_* database with verified transport settings.");
  } catch {
    add("STAGING_ISOLATION", false, "Review DEPLOYMENT_STAGE, STAGING_ACCESS_PASSWORD, MONGODB_DATABASE and MONGODB_URI. Staging requires an explicit matching eds_staging_* database and protected remote transport.");
  }
  try {
    emailTestEnabled = readEmailConnectionTestConfiguration({ staging, env }).enabled;
    add("STAGING_EMAIL_TEST", true, emailTestEnabled
      ? "The optional fixed-inbox manual connection test is configured; real acceptance and inbox delivery remain unverified. Ordinary appointment email stays disabled."
      : "The optional manual email connection test is disabled.");
  } catch {
    add("STAGING_EMAIL_TEST", false, "Use STAGING_EMAIL_TEST_ENABLED=true only in protected staging with a private valid BREVO_API_KEY, or leave the optional test disabled.");
  }
  try {
    appointmentEmailTestEnabled = readAppointmentEmailTestConfiguration({ staging, env }).enabled;
    add("STAGING_APPOINTMENT_EMAIL_TEST", true, appointmentEmailTestEnabled
      ? "Scoped appointment email testing is configured for newly created requests in the current reviewed run and fixed owner inbox only; previous requests remain excluded. Real delivery and management links remain unverified."
      : "The optional scoped appointment email workflow test is disabled.");
  } catch {
    add("STAGING_APPOINTMENT_EMAIL_TEST", false, "Enable STAGING_APPOINTMENT_EMAIL_TEST_ENABLED=true only in protected staging with the standalone connection test disabled, a valid UUID v4 run identifier, a private BREVO_API_KEY and valid management-link configuration, or leave the workflow test disabled.");
  }
  try {
    const runtime = readRuntimeConfig(env);
    add("STAGING_RUNTIME", runtime.production && runtime.serveFrontend && runtime.host === "0.0.0.0", "Use NODE_ENV=production, HOST=0.0.0.0, SERVE_FRONTEND=true and valid runtime/proxy/shutdown settings.");
  } catch {
    add("STAGING_RUNTIME", false, "Review NODE_ENV, HOST, PORT, SERVE_FRONTEND, SHUTDOWN_GRACE_MS and TRUST_PROXY using the documented runtime formats.");
  }
  try {
    add("BOOKING_RATE_LIMIT", readBookingAbuseConfig(env).enabled, "Enable the process-local booking quota for staging; actual proxy/client-IP handling must still be verified.");
  } catch {
    add("BOOKING_RATE_LIMIT", false, "Use valid BOOKING_RATE_LIMIT_ENABLED, BOOKING_RATE_LIMIT_MAX and BOOKING_RATE_LIMIT_WINDOW_MINUTES settings.");
  }
  const required = new Set(["PUBLIC_WEBSITE_ORIGIN", "MECHANIC_ADMIN_PASSWORD", "APPOINTMENT_MANAGEMENT_SECRET"]);
  for (const check of checkLaunchConfiguration({ env }).checks) if (required.has(check.code)) checks.push(check);
  const blockers = checks.filter(check => !check.ok).map(({ code, message }) => ({ code, message }));
  return {
    checkType: "offline-protected-staging-configuration", configurationReady: blockers.length === 0,
    deploymentApproved: false, readyForPublicLaunch: false, networkAccessed: false, databaseAccessed: false,
    emailConnectionTestEnabled: emailTestEnabled,
    appointmentEmailTestEnabled,
    checks, blockers,
    unverified: [
      "Owner approval, current compute quote/terms, region and initial-deploy review.",
      "Separate clean database, least-privilege credentials, TLS and actual network rules.",
      "Hosted HTTPS, gateway enforcement, secure cookies, proxy/client-IP topology and abuse controls.",
      "Saved business settings reviewed in the isolated database; seed settings do not reproduce the owner's saved configuration.",
      appointmentEmailTestEnabled
        ? "Scoped appointment email and management links are enabled only for newly created synthetic requests in the current reviewed run and fixed owner inbox. Previous requests and other runs are excluded; real workflow delivery remains unverified."
        : emailTestEnabled
        ? "Ordinary appointment email and management grants are forcibly disabled. The fixed-inbox manual test is enabled; Brevo acceptance and inbox delivery remain unverified."
        : "Synthetic-only preview with appointment email forcibly disabled and the optional manual email test disabled; live Brevo and management-email checks remain blocked.",
      "Encrypted backups, isolated restore, uptime/error alerts and compatible rollback.",
      "Public contact, mobile work location/travel, service area, retention and policy approval before public launch.",
    ],
  };
}
