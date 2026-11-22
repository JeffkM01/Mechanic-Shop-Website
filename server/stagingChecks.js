import { readRuntimeConfig } from "./runtimeConfig.js";
import { readStagingSafety } from "./stagingSafety.js";
import { readBookingAbuseConfig } from "./bookingAbuseProtection.js";
import { checkLaunchConfiguration } from "./launchChecks.js";

// Offline syntax checks only. Do not import index.js, load dotenv, construct a
// mail transport, resolve a database host, or return environment values.
export function checkStagingConfiguration({ env = process.env } = {}) {
  const checks = [];
  const add = (code, ok, message) => checks.push({ code, ok: Boolean(ok), message });
  try {
    const config = readStagingSafety(env);
    add("STAGING_ISOLATION", config.enabled, "Use DEPLOYMENT_STAGE=staging, a separate strong gateway password, and a matching explicit eds_staging_* database with verified transport settings.");
  } catch {
    add("STAGING_ISOLATION", false, "Review DEPLOYMENT_STAGE, STAGING_ACCESS_PASSWORD, MONGODB_DATABASE and MONGODB_URI. Staging requires an explicit matching eds_staging_* database and protected remote transport.");
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
    checks, blockers,
    unverified: [
      "Owner approval, current compute quote/terms, region and initial-deploy review.",
      "Separate clean database, least-privilege credentials, TLS and actual network rules.",
      "Hosted HTTPS, gateway enforcement, secure cookies, proxy/client-IP topology and abuse controls.",
      "Saved business settings reviewed in the isolated database; seed settings do not reproduce the owner's saved configuration.",
      "Synthetic-only preview with outgoing email forcibly disabled; live Brevo and management-email checks remain blocked.",
      "Encrypted backups, isolated restore, uptime/error alerts and compatible rollback.",
      "Public contact, mobile work location/travel, service area, retention and policy approval before public launch.",
    ],
  };
}
