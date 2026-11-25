const PREFIX = "Could not start the appointment service. ";
const diagnostic = (code, advice) => `${PREFIX}[${code}] ${advice}`;

// Every printable code and sentence is defined here. Never append a driver
// message, stack, URI, environment value, hostname or customer-supplied text.
const PHASES = Object.freeze({
  RUNTIME_CONFIGURATION: "Review HOST, PORT, SERVE_FRONTEND, SHUTDOWN_GRACE_MS and TRUST_PROXY formats.",
  STAGING_CONFIGURATION: "Review DEPLOYMENT_STAGE, the preview password and the matching explicit staging database configuration.",
  BOOKING_RATE_LIMIT_CONFIGURATION: "Review the BOOKING_RATE_LIMIT_ENABLED, BOOKING_RATE_LIMIT_MAX and BOOKING_RATE_LIMIT_WINDOW_MINUTES settings.",
  MECHANIC_AUTH_CONFIGURATION: "Mechanic authentication initialization failed. Review the private staff password configuration.",
  EMAIL_TEST_CONFIGURATION: "Review STAGING_EMAIL_TEST_ENABLED and the private BREVO_API_KEY. The standalone manual probe requires protected staging and is separate from scoped appointment email tests.",
  APPOINTMENT_EMAIL_TEST_CONFIGURATION: "Review STAGING_APPOINTMENT_EMAIL_TEST_ENABLED, its UUID run ID, private Brevo key, public origin and stable management secret. Workflow tests require protected staging and the standalone probe disabled.",
  DATABASE_URI_CONFIGURATION: "Set MONGODB_URI to the intended private MongoDB connection string with an explicit database name.",
  DATABASE_CONNECTION: "MongoDB connection initialization failed. Review the URI, credentials, verified TLS, cluster availability and network access rules.",
  DATABASE_INDEXES: "Database index initialization failed. Review database permissions and stored schema/index compatibility without deleting existing records.",
  CUSTOMER_MANAGEMENT: "Customer-management initialization failed. Review its private server configuration.",
  SCHEDULING_SETTINGS: "Saved scheduling settings could not be initialized. Review database permissions and compatible saved settings; preserve existing data.",
  NOTIFICATIONS: "Notification initialization failed. Review the selected mail transport and scope. Staging permits only the explicitly enabled fixed-inbox appointment test run.",
  HTTP_APPLICATION: "HTTP/frontend initialization failed. Verify the image includes the built frontend and required server files.",
  HTTP_LISTENER: "The HTTP listener could not start. Review HOST, the host-assigned PORT and conflicting listeners.",
});

const MESSAGES = Object.freeze({
  DEPLOYMENT_STAGE: "Set DEPLOYMENT_STAGE to staging, production or development using the documented exact value.",
  STAGING_ACCESS_PASSWORD: "Set STAGING_ACCESS_PASSWORD to a private random value of 32–256 characters, without whitespace or placeholders.",
  STAGING_DATABASE_NAME: "Set MONGODB_DATABASE to an explicit eds_staging_<suffix> database name.",
  STAGING_DATABASE_URI: "Set MONGODB_URI to the same explicit database as MONGODB_DATABASE. Use a valid URI, encode password characters and retain verified TLS for remote hosts.",
  MECHANIC_ADMIN_PASSWORD: "Set MECHANIC_ADMIN_PASSWORD to a private non-placeholder password of at least 12 characters.",
  HOST: "Set HOST to a valid bind IP or localhost; the Docker host normally uses 0.0.0.0.",
  PORT: "Use a whole-number PORT from 1 to 65535; normally retain the hosting platform's assigned value.",
  SERVE_FRONTEND: "Set SERVE_FRONTEND to true or false; the combined Docker image uses true.",
  SHUTDOWN_GRACE_MS: "Set SHUTDOWN_GRACE_MS to a whole number from 1000 to 30000, below the host termination timeout.",
  TRUST_PROXY: "Leave TRUST_PROXY false or use only verified trusted proxy IPs/CIDRs; broad trust and hop counts are not accepted.",
  BOOKING_RATE_LIMIT_ENABLED: "Set BOOKING_RATE_LIMIT_ENABLED to true or false.",
  BOOKING_RATE_LIMIT_MAX: "Set BOOKING_RATE_LIMIT_MAX to a whole number from 1 to 1000.",
  BOOKING_RATE_LIMIT_WINDOW_MINUTES: "Set BOOKING_RATE_LIMIT_WINDOW_MINUTES to a whole number from 1 to 1440.",
  DATABASE_AUTHENTICATION: "MongoDB rejected authentication. Review the intended database user, password and URI password encoding; keep credentials private.",
  DATABASE_PERMISSION: "MongoDB denied a database operation. Verify the application user has the required readWrite privileges on the selected application database.",
  DATABASE_DNS: "A database DNS lookup failed. Check the Atlas cluster hostname, cluster availability and DNS resolution.",
  DATABASE_TLS: "Database TLS verification failed. Check the hostname, certificate trust and clock; keep certificate and hostname verification enabled.",
  DATABASE_UNREACHABLE: "MongoDB was not reachable. Check cluster availability, hostname/DNS, verified TLS and Atlas Network Access for the Render service's outbound addresses. This code does not identify which network rule failed.",
  STARTUP_UNKNOWN: "Review the private runtime configuration and database connectivity. No raw error details are logged.",
});

// Exact comparisons are limited to messages emitted by our own validators.
// Unknown or changed messages fall back to their phase rather than being echoed.
const VALIDATION = new Map([
  ["STAGING_CONFIGURATION", new Map([
    ["DEPLOYMENT_STAGE must be staging, production or development.", "DEPLOYMENT_STAGE"],
    ["Staging requires a private random STAGING_ACCESS_PASSWORD of 32–256 characters.", "STAGING_ACCESS_PASSWORD"],
    ["Staging requires an explicit MONGODB_DATABASE named eds_staging_<suffix>.", "STAGING_DATABASE_NAME"],
    ["Staging requires a valid MongoDB URI selecting the same staging database and verified TLS for remote hosts.", "STAGING_DATABASE_URI"],
  ])],
  ["MECHANIC_AUTH_CONFIGURATION", new Map([
    ["Set MECHANIC_ADMIN_PASSWORD (at least 12 characters) in server/.env.", "MECHANIC_ADMIN_PASSWORD"],
  ])],
  ["RUNTIME_CONFIGURATION", new Map([
    ["HOST must be a valid bind IP address or localhost.", "HOST"],
    ["PORT must be a whole number from 1 to 65535.", "PORT"],
    ["SERVE_FRONTEND must be true or false.", "SERVE_FRONTEND"],
    ["SHUTDOWN_GRACE_MS must be a whole number from 1000 to 30000.", "SHUTDOWN_GRACE_MS"],
    ["TRUST_PROXY must be an explicit IP/CIDR allowlist or false.", "TRUST_PROXY"],
    ["TRUST_PROXY must list trusted proxy IPs or CIDRs; broad trust and hop counts are not accepted.", "TRUST_PROXY"],
  ])],
  ["BOOKING_RATE_LIMIT_CONFIGURATION", new Map([
    ["BOOKING_RATE_LIMIT_ENABLED must be true or false.", "BOOKING_RATE_LIMIT_ENABLED"],
    ["BOOKING_RATE_LIMIT_MAX must be a whole number from 1 to 1000.", "BOOKING_RATE_LIMIT_MAX"],
    ["BOOKING_RATE_LIMIT_WINDOW_MINUTES must be a whole number from 1 to 1440.", "BOOKING_RATE_LIMIT_WINDOW_MINUTES"],
  ])],
]);

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "SERVFAIL", "ESERVFAIL", "ETIMEOUT"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENETDOWN", "EPIPE"]);
const TLS_CODES = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_CERTIFICATE_VERIFY_FAILED"]);
const NETWORK_NAMES = new Set(["MongoServerSelectionError", "MongooseServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError"]);

function property(value, key) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return value[key]; } catch { return undefined; }
}

function errorNodes(error) {
  const queue = [error];
  const visited = new Set();
  const nodes = [];
  // Driver causes and topology descriptions can cycle or be unusually large.
  // Bound both visited objects and server-map entries; never stringify them.
  while (queue.length && nodes.length < 16) {
    const node = queue.shift();
    if (node === null || (typeof node !== "object" && typeof node !== "function") || visited.has(node)) continue;
    visited.add(node); nodes.push(node);
    for (const key of ["cause", "errorResponse", "reason", "error"]) queue.push(property(node, key));
    const servers = property(node, "servers");
    try {
      const iterator = Map.prototype.values.call(servers);
      for (let i = 0; i < 4; i++) {
        const next = iterator.next();
        if (next.done) break;
        queue.push(next.value);
      }
    } catch { /* Not a native Map; do not invoke user-defined iterators. */ }
  }
  return nodes;
}

/** Return a fixed safe diagnostic; do not expose or mutate the supplied error. */
export function startupFailureMessage(phase, error) {
  if (typeof phase !== "string" || !Object.hasOwn(PHASES, phase)) return diagnostic("STARTUP_UNKNOWN", MESSAGES.STARTUP_UNKNOWN);
  const validation = VALIDATION.get(phase);
  if (validation) {
    const message = property(error, "message");
    const code = typeof message === "string" && message.length <= 512 ? validation.get(message) : undefined;
    if (code) return diagnostic(code, MESSAGES[code]);
  }
  if (phase === "DATABASE_CONNECTION" || phase === "DATABASE_INDEXES") {
    const nodes = errorNodes(error);
    const codes = nodes.map(node => property(node, "code"));
    let code;
    if (codes.includes(18)) code = "DATABASE_AUTHENTICATION";
    else if (codes.includes(13)) code = "DATABASE_PERMISSION";
    else if (codes.some(value => TLS_CODES.has(value))) code = "DATABASE_TLS";
    else if (codes.some(value => DNS_CODES.has(value))) code = "DATABASE_DNS";
    else if (codes.some(value => NETWORK_CODES.has(value)) || nodes.some(node => NETWORK_NAMES.has(property(node, "name")))) code = "DATABASE_UNREACHABLE";
    else if (phase === "DATABASE_CONNECTION" && nodes.some(node => ["MongoParseError", "MongoInvalidArgumentError"].includes(property(node, "name")))) code = "DATABASE_URI_CONFIGURATION";
    if (code) return diagnostic(code, MESSAGES[code] ?? PHASES[code]);
  }
  return diagnostic(phase, PHASES[phase]);
}
