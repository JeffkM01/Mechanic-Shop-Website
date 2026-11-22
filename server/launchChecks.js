import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { businessProfile, businessProfileLaunchIssues } from "../shared/businessProfile.js";
import { isValidEmailAddress } from "../shared/appointmentFields.js";
import { readRuntimeConfig } from "./runtimeConfig.js";

const placeholder = value => /replace[_ -]?with|change[_ -]?me|your[_ -]?(?:own|password|secret|key)|db_user|cluster\.mongodb\.net/i.test(value);
const hasControls = value => [...value].some(character => {
  const code = character.codePointAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});
const supplied = value => typeof value === "string" && value.trim().length > 0 && !hasControls(value) && !placeholder(value);
const reservedHost = hostname => /(?:^|\.)(?:localhost|example|invalid|test)$/.test(hostname)
  || /(?:^|\.)example\.(?:com|org|net)$/.test(hostname);

function nonpublicAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (reservedHost(host)) return true;
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) {
    // URL normalizes an IPv4-mapped address to hexadecimal groups. Do not let
    // mapped loopback/private IPv4 addresses bypass the public-origin check.
    const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(host);
    if (mapped) {
      const first = Number.parseInt(mapped[1], 16);
      const second = Number.parseInt(mapped[2], 16);
      return nonpublicAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
    return host === "::" || host === "::1" || /^(?:f[cd]|fe[89ab])/.test(host);
  }
  return false;
}

function productionOrigin(value) {
  if (!supplied(value) || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash && !nonpublicAddress(url.hostname);
  } catch { return false; }
}

function managementSecret(value) {
  if (!supplied(value) || !/^[A-Za-z\d+/_-]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.length <= 128
    && decoded.toString("base64url") === value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Validate only the supported connection-string shape. This deliberately does
// not resolve hosts, authenticate, or read the database named by the operator.
function databaseUri(value) {
  if (!supplied(value) || value !== value.trim() || /\s/.test(value)) return false;
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)\/([^/?#]+)(?:\?[^#]*)?$/.exec(value);
  if (!match) return false;
  const [, scheme, authority, encodedDatabase] = match;
  const parts = authority.split("@");
  if (parts.length > 2 || parts.some(part => !part)) return false;
  if (parts.length === 2) {
    try { if (hasControls(decodeURIComponent(parts[0]))) return false; }
    catch { return false; }
  }
  let database;
  try { database = decodeURIComponent(encodedDatabase); }
  catch { return false; }
  if (!/^[A-Za-z\d][A-Za-z\d_-]{0,62}$/.test(database)
    || ["admin", "config", "local", "test"].includes(database.toLowerCase())) return false;
  const hosts = parts.at(-1).split(",");
  if (scheme === "mongodb+srv" && hosts.length !== 1) return false;
  return hosts.every(host => {
    const hostMatch = /^(\[[A-Fa-f\d:]+\]|[A-Za-z\d_-]+(?:\.[A-Za-z\d_-]+)*)(?::(\d+))?$/.exec(host);
    if (!hostMatch) return false;
    if (scheme === "mongodb+srv" && (hostMatch[2] || hostMatch[1].startsWith("["))) return false;
    if (hostMatch[1].startsWith("[") && isIP(hostMatch[1].slice(1, -1)) !== 6) return false;
    return hostMatch[2] === undefined || (Number.isInteger(Number(hostMatch[2])) && Number(hostMatch[2]) >= 1 && Number(hostMatch[2]) <= 65535);
  });
}

function senderAddress(value) {
  if (!supplied(value)) return false;
  if (isValidEmailAddress(value)) return !reservedHost(value.trim().split("@")[1].toLowerCase());
  const wrapped = /^([A-Za-z\d &'()._-]{1,80})\s*<([^<>]+)>$/.exec(value);
  return Boolean(wrapped && isValidEmailAddress(wrapped[2]) && !reservedHost(wrapped[2].split("@")[1].toLowerCase()));
}

export const LIVE_LAUNCH_CHECKS = Object.freeze([
  Object.freeze({ code: "HTTPS_AND_ROUTING_UNVERIFIED", message: "Verify the real HTTPS site, API forwarding, secure cookies, private response headers, and direct page links from an external device." }),
  Object.freeze({ code: "DATABASE_ACCESS_UNVERIFIED", message: "Verify the intended production database, least-privilege authentication, transport protection, network access rules and operator access; URI syntax is not a connection test." }),
  Object.freeze({ code: "SCHEDULING_UNVERIFIED", message: "Edward must review the saved database hours, timezone, closures, capacity, service estimates and cancellation policy; keep automation off until verified and explicitly enabled." }),
  Object.freeze({ code: "EMAIL_DELIVERY_UNVERIFIED", message: "Verify the real sender/reply inbox, delivery, secure management links, approval and cancellation using an operator-approved controlled test." }),
  Object.freeze({ code: "BACKUP_RECOVERY_UNVERIFIED", message: "Configure protected backups and complete a restore drill into a new isolated recovery database before relying on recovery." }),
  Object.freeze({ code: "PROXY_AND_WORKER_TOPOLOGY_UNVERIFIED", message: "Verify trusted proxy/edge rate limits and run one API/email dispatcher instance; process-local staff sessions do not survive restarts or span instances." }),
  Object.freeze({ code: "PROVIDER_AND_OWNER_REVIEW_UNVERIFIED", message: "Review actual provider agreements, access, retention and shop contact/policy accuracy; configuration flags are owner attestations, not independent verification." }),
]);

/** Offline validation only. Never load private env files or contact a service. */
export function checkLaunchConfiguration({ env = process.env, profile = businessProfile } = {}) {
  const settings = env && typeof env === "object" && !Array.isArray(env) ? env : {};
  const checks = [];
  const add = (code, ok, message) => checks.push({ code, ok: Boolean(ok), message });
  add("NODE_ENV", settings.NODE_ENV === "production", "NODE_ENV must be production for a public launch.");
  try { readRuntimeConfig(settings); add("SERVER_RUNTIME", true, "Runtime bind, port, frontend-serving, shutdown and proxy settings have valid syntax."); }
  catch { add("SERVER_RUNTIME", false, "Review HOST, PORT, SERVE_FRONTEND, SHUTDOWN_GRACE_MS and TRUST_PROXY using the documented runtime formats."); }
  add("PUBLIC_WEBSITE_ORIGIN", productionOrigin(settings.PUBLIC_WEBSITE_ORIGIN), "PUBLIC_WEBSITE_ORIGIN must be the real public HTTPS origin, without credentials, a path, query, fragment, loopback/private address or example hostname.");
  add("MONGODB_URI", databaseUri(settings.MONGODB_URI), "MONGODB_URI must be a non-placeholder MongoDB connection string with an explicit shop database; authentication and backup readiness remain unverified.");
  add("MECHANIC_ADMIN_PASSWORD", supplied(settings.MECHANIC_ADMIN_PASSWORD) && settings.MECHANIC_ADMIN_PASSWORD.length >= 12 && settings.MECHANIC_ADMIN_PASSWORD.length <= 256, "Set a unique random MECHANIC_ADMIN_PASSWORD of 12–256 characters; placeholders are not accepted.");
  add("APPOINTMENT_MANAGEMENT_SECRET", managementSecret(settings.APPOINTMENT_MANAGEMENT_SECRET), "Set APPOINTMENT_MANAGEMENT_SECRET to 32–128 cryptographically random bytes encoded as base64/base64url; only format and length are checked.");
  add("SMTP_HOST", supplied(settings.SMTP_HOST) && /^[A-Za-z\d_-]+(?:\.[A-Za-z\d_-]+)*$/.test(settings.SMTP_HOST) && !nonpublicAddress(settings.SMTP_HOST.toLowerCase()), "SMTP_HOST must identify the intended production mail provider rather than a URL, local address or example hostname.");
  const port = typeof settings.SMTP_PORT === "string" && /^\d+$/.test(settings.SMTP_PORT) ? Number(settings.SMTP_PORT) : NaN;
  add("SMTP_PORT", Number.isInteger(port) && port >= 1 && port <= 65535, "SMTP_PORT must be an integer from 1 to 65535; verify the provider's TLS/STARTTLS requirement.");
  add("SMTP_USER", supplied(settings.SMTP_USER), "Configure the production SMTP_USER privately.");
  add("SMTP_PASS", supplied(settings.SMTP_PASS), "Configure the production SMTP_PASS privately.");
  add("MAIL_FROM", senderAddress(settings.MAIL_FROM), "MAIL_FROM must contain one real sender address, optionally preceded by an unquoted display name; sender authorization and delivery remain unverified.");
  add("MECHANIC_NOTIFICATION_EMAIL", supplied(settings.MECHANIC_NOTIFICATION_EMAIL) && isValidEmailAddress(settings.MECHANIC_NOTIFICATION_EMAIL) && !reservedHost(settings.MECHANIC_NOTIFICATION_EMAIL.trim().split("@")[1].toLowerCase()), "MECHANIC_NOTIFICATION_EMAIL must be one real staff notification address.");
  const profileIssues = businessProfileLaunchIssues(profile);
  add("PUBLIC_BUSINESS_PROFILE", profileIssues.length === 0, "Confirm the public business details, privacy notice, providers, retention, request handling and cancellation policy before launch.");
  const blockers = [...checks.filter(check => !check.ok).map(({ code, message }) => ({ code, message })), ...profileIssues];
  return {
    checkType: "offline-configuration",
    configurationReady: blockers.length === 0,
    readyForPublicLaunch: false,
    networkAccessed: false,
    databaseAccessed: false,
    checks, blockers,
    unverified: LIVE_LAUNCH_CHECKS.map(check => ({ ...check })),
  };
}
