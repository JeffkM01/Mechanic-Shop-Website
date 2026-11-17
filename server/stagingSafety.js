import { createHash, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";

const PROBE_PATHS = new Set(["/api/health", "/api/health/live"]);
const digest = value => createHash("sha256").update(value).digest();

// Constructing a MongoClient parses its URI; it does not resolve hosts or open
// a connection. Never include parser errors, URIs or passwords in diagnostics.
function stagingDatabase(uri, expected) {
  if (typeof expected !== "string" || !/^eds_staging_[a-z0-9][a-z0-9_]{0,47}$/.test(expected)) {
    throw new Error("Staging requires an explicit MONGODB_DATABASE named eds_staging_<suffix>.");
  }
  try {
    if (typeof uri !== "string") throw new Error();
    const options = new mongoose.mongo.MongoClient(uri).options;
    const loopback = !options.srvHost && options.hosts.length > 0
      && options.hosts.every(host => ["127.0.0.1", "::1", "localhost"].includes(host.host));
    if (options.dbName !== expected || (!loopback && options.tls !== true)
      || options.tlsInsecure || options.rejectUnauthorized === false || options.checkServerIdentity) throw new Error();
  } catch {
    throw new Error("Staging requires a valid MongoDB URI selecting the same staging database and verified TLS for remote hosts.");
  }
  return expected;
}

function accessGate(password) {
  const expected = digest(`staging:${password}`);
  return function restrictStaging(req, res, next) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    if ((req.method === "GET" || req.method === "HEAD") && PROBE_PATHS.has(req.path)) return next();
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string" && /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    let supplied = "";
    if (match && match[1].length <= 512) {
      const decoded = Buffer.from(match[1], "base64");
      // Reject malformed encodings and invalid UTF-8 rather than normalizing
      // attacker-supplied credential bytes into a valid password.
      if (decoded.toString("base64") === match[1] && Buffer.from(decoded.toString("utf8"), "utf8").equals(decoded)) supplied = decoded.toString("utf8");
    }
    if (timingSafeEqual(digest(supplied), expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Ed\'s Auto Shop staging", charset="UTF-8"');
    return res.status(401).type("text/plain").send("Staging access requires an operator password.");
  };
}

// This gate is separate from mechanic authentication. It protects an unlaunched
// website and its assets, not just staff data. Only minimal health probes bypass
// it. HTTPS and a private random password are still required at the host.
export function readStagingSafety(env = process.env) {
  if (env.DEPLOYMENT_STAGE === undefined || env.DEPLOYMENT_STAGE === "production" || env.DEPLOYMENT_STAGE === "development") return { enabled: false, requestGate: null };
  if (env.DEPLOYMENT_STAGE !== "staging") throw new Error("DEPLOYMENT_STAGE must be staging, production or development.");
  const password = env.STAGING_ACCESS_PASSWORD;
  if (typeof password !== "string" || password.length < 32 || password.length > 256 || /\s/.test(password)
    || [...password].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
    || new Set(password).size < 8 || /replace|placeholder|example/i.test(password)) {
    throw new Error("Staging requires a private random STAGING_ACCESS_PASSWORD of 32–256 characters.");
  }
  const databaseName = stagingDatabase(env.MONGODB_URI, env.MONGODB_DATABASE);
  return { enabled: true, databaseName, requestGate: accessGate(password) };
}

export function notificationEnvironmentForStage(staging, env = process.env) {
  return staging.enabled ? {} : env;
}
