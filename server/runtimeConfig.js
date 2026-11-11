import { isIP } from "node:net";

function integer(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isInteger(Number(value))
    || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function trustedProxyList(value) {
  if (value === undefined || value === "" || value === "false") return false;
  if (typeof value !== "string") throw new Error("TRUST_PROXY must be an explicit IP/CIDR allowlist or false.");
  const entries = value.split(",").map(entry => entry.trim());
  if (!entries.length || entries.length > 32 || entries.some(entry => {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix)
      || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)));
  })) throw new Error("TRUST_PROXY must list trusted proxy IPs or CIDRs; broad trust and hop counts are not accepted.");
  return entries;
}

// Runtime configuration never prints or returns database, SMTP or management
// credentials. Launch-specific business/configuration approval is checked by
// the separate offline preflight, not by silently enabling application features.
export function readRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const host = env.HOST === undefined ? production ? "0.0.0.0" : "127.0.0.1" : env.HOST;
  if (typeof host !== "string" || (host !== "localhost" && !isIP(host))) {
    throw new Error("HOST must be a valid bind IP address or localhost.");
  }
  return {
    production, host,
    port: integer(env.PORT, 3001, 1, 65535, "PORT"),
    serveFrontend: boolean(env.SERVE_FRONTEND, false, "SERVE_FRONTEND"),
    shutdownGraceMs: integer(env.SHUTDOWN_GRACE_MS, 10000, 1000, 30000, "SHUTDOWN_GRACE_MS"),
    trustProxy: trustedProxyList(env.TRUST_PROXY),
  };
}
