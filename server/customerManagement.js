import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MANAGEMENT_LINK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MANAGEMENT_SESSION_LIFETIME_MS = 20 * 60 * 1000;
const MAX_SESSIONS = 5;
const LINK_CONTEXT = "eds-appointment-management-link-v1\0";
const CSRF_CONTEXT = "eds-appointment-management-csrf-v1";
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"];
const TOKEN_PATTERN = /^[A-Za-z\d_-]{43}$/;
const ID_PATTERN = /^[a-f\d]{24}$/i;
const HASH_PATTERN = /^[a-f\d]{64}$/;
const unauthorizedMessage = "This appointment link or session is unavailable. Please contact the shop.";

export class ManagementError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unauthorized = () => new ManagementError(401, unauthorizedMessage, "MANAGEMENT_UNAUTHORIZED");
const unavailable = () => new ManagementError(503, "Appointment management is unavailable. Please contact the shop.", "MANAGEMENT_UNAVAILABLE");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const finiteDate = value => value !== undefined && value !== null && Number.isFinite(+new Date(value));
const isToken = value => typeof value === "string" && TOKEN_PATTERN.test(value)
  && Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value;

function equalText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readConfiguration(env) {
  let origin;
  let key;
  try {
    if (typeof env.PUBLIC_WEBSITE_ORIGIN !== "string" || !env.PUBLIC_WEBSITE_ORIGIN.trim()) return null;
    const configured = env.PUBLIC_WEBSITE_ORIGIN.trim();
    const parsed = new URL(configured);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    // Explicitly configured loopback HTTP is useful for local development;
    // production and unspecified environments never fall back to localhost.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    const development = ["development", "test"].includes(env.NODE_ENV);
    if (parsed.protocol !== "https:" && !(development && loopback && parsed.protocol === "http:")) return null;
    if (env.NODE_ENV === "production" && loopback) return null;
    origin = parsed.origin;
    const raw = env.APPOINTMENT_MANAGEMENT_SECRET;
    if (typeof raw !== "string" || !/^[A-Za-z\d+/_-]+={0,2}$/.test(raw)) return null;
    key = Buffer.from(raw, "base64url");
    if (key.length < 32 || key.length > 128 || key.toString("base64url") !== raw.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")) return null;
    if (!SMTP_KEYS.every(name => typeof env[name] === "string" && env[name].trim())) return null;
    const port = Number(env.SMTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  } catch {
    return null;
  }
  return { origin, key, keyId: sha256(key).slice(0, 32), secureCookie: new URL(origin).protocol === "https:" };
}

// This bounded process-local abuse control supplements the durable Mongo-backed
// credentials. Multiple production instances should also rate-limit at the edge.
function createRateLimiter(now, { maximum, windowMs = 15 * 60 * 1000, maxEntries = 10_000 }) {
  const entries = new Map();
  function cleanup(clock) {
    for (const [ip, entry] of entries) if (entry.resetAt <= clock) entries.delete(ip);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
  }
  return {
    take(ip) {
      const clock = +new Date(now());
      cleanup(clock);
      const key = String(ip || "unknown").slice(0, 128);
      const entry = entries.get(key) || { attempts: 0, resetAt: clock + windowMs };
      entry.attempts++;
      entries.set(key, entry);
      if (entry.attempts > maximum) {
        const error = new ManagementError(429, "Too many attempts. Please try again later.", "MANAGEMENT_RATE_LIMITED");
        error.retryAfter = Math.max(1, Math.ceil((entry.resetAt - clock) / 1000));
        throw error;
      }
    },
  };
}

function rawCookie(req, name) {
  const matches = (req.headers?.cookie || "").split(";")
    .map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  return matches[0].slice(name.length + 1);
}

export function createCustomerManagement({ Appointment, env = process.env, now = () => new Date() }) {
  const configuration = readConfiguration(env);
  const exchangeLimiter = createRateLimiter(now, { maximum: 10 });
  const failureLimiter = createRateLimiter(now, { maximum: 30 });
  const enabled = Boolean(configuration);
  const cookieName = id => `appointment_manage_${id.toLowerCase()}`;
  const cookiePath = id => `/api/customer/appointments/${id.toLowerCase()}`;
  const clockNow = () => new Date(now());
  const validId = id => typeof id === "string" && ID_PATTERN.test(id);

  function requireEnabled() {
    if (!enabled) throw unavailable();
  }

  function derivedToken(id, nonce) {
    return createHmac("sha256", configuration.key).update(`${LINK_CONTEXT}${String(id).toLowerCase()}\0${nonce}`).digest("base64url");
  }

  function activeGrant(appointment, clock) {
    const grant = appointment?.management;
    if (!configuration || !grant || grant.keyId !== configuration.keyId || grant.revokedAt
      || !isToken(grant.nonce) || !HASH_PATTERN.test(grant.tokenHash || "")
      || !finiteDate(grant.issuedAt) || !finiteDate(grant.expiresAt)
      || +new Date(grant.issuedAt) > +clock || +new Date(grant.expiresAt) <= +clock
      || +new Date(grant.expiresAt) > +new Date(grant.issuedAt) + MANAGEMENT_LINK_LIFETIME_MS) return null;
    const token = derivedToken(appointment._id ?? appointment.id, grant.nonce);
    return equalText(sha256(token), grant.tokenHash) ? { grant, token } : null;
  }

  function createGrant(id, clock = clockNow()) {
    if (!enabled || !validId(String(id)) || !finiteDate(clock)) return undefined;
    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = new Date(clock);
    return {
      nonce,
      tokenHash: sha256(derivedToken(id, nonce)),
      keyId: configuration.keyId,
      issuedAt,
      expiresAt: new Date(+issuedAt + MANAGEMENT_LINK_LIFETIME_MS),
      revokedAt: null,
      sessions: [],
    };
  }

  function emailLink(appointment) {
    const active = activeGrant(appointment, clockNow());
    if (!active) return null;
    const fragment = new URLSearchParams({ id: String(appointment._id ?? appointment.id), token: active.token });
    return `${configuration.origin}/manage-appointment#${fragment}`;
  }

  function requireOrigin(req) {
    requireEnabled();
    if (req.headers.origin !== configuration.origin) {
      throw new ManagementError(403, "This request must come from the appointment website.", "ORIGIN_MISMATCH");
    }
  }

  const csrfFor = raw => createHmac("sha256", Buffer.from(raw, "base64url")).update(CSRF_CONTEXT).digest("base64url");

  async function exchange(id, token) {
    requireEnabled();
    if (!validId(id) || !isToken(token)) throw unauthorized();
    const clock = clockNow();
    const appointment = await Appointment.findById(id).select("+management").lean();
    const active = activeGrant(appointment, clock);
    if (!active || !equalText(sha256(token), active.grant.tokenHash)) throw unauthorized();
    const raw = randomBytes(32).toString("base64url");
    const session = {
      tokenHash: sha256(raw), issuedAt: clock,
      expiresAt: new Date(Math.min(+clock + MANAGEMENT_SESSION_LIFETIME_MS, +new Date(active.grant.expiresAt))),
    };
    const updated = await Appointment.updateOne({
      _id: id, "management.tokenHash": active.grant.tokenHash,
      "management.keyId": configuration.keyId, "management.revokedAt": null,
      "management.expiresAt": { $gt: clock },
    }, { $push: { "management.sessions": { $each: [session], $slice: -MAX_SESSIONS } } }, { runValidators: true });
    if (updated.modifiedCount !== 1) throw unauthorized();
    return { appointment, sessionHash: session.tokenHash, csrfToken: csrfFor(raw), sessionExpiresAt: session.expiresAt, cookie: raw, id: id.toLowerCase() };
  }

  async function authorize(req, id) {
    requireEnabled();
    const reject = () => { failureLimiter.take(req.ip); throw unauthorized(); };
    if (!validId(id)) return reject();
    const raw = rawCookie(req, cookieName(id));
    if (!isToken(raw)) return reject();
    const clock = clockNow();
    const appointment = await Appointment.findById(id).select("+management").lean();
    const active = activeGrant(appointment, clock);
    if (!active) return reject();
    const hash = sha256(raw);
    const session = active.grant.sessions?.find(item => HASH_PATTERN.test(item.tokenHash || "") && equalText(item.tokenHash, hash)
      && finiteDate(item.issuedAt) && finiteDate(item.expiresAt) && +new Date(item.issuedAt) <= +clock
      && +new Date(item.expiresAt) > +clock && +new Date(item.expiresAt) <= +new Date(item.issuedAt) + MANAGEMENT_SESSION_LIFETIME_MS
      && +new Date(item.expiresAt) <= +new Date(active.grant.expiresAt));
    if (!session) return reject();
    return { appointment, sessionHash: hash, csrfToken: csrfFor(raw), sessionExpiresAt: new Date(session.expiresAt), id: id.toLowerCase() };
  }

  function requireCsrf(req, context) {
    const received = req.headers["x-appointment-csrf"];
    if (!isToken(received) || !equalText(received, context.csrfToken)) {
      throw new ManagementError(403, "Please refresh this appointment page and try again.", "CSRF_INVALID");
    }
  }

  function setCookie(res, context) {
    res.cookie(cookieName(context.id), context.cookie, {
      path: cookiePath(context.id), httpOnly: true, sameSite: "strict", secure: configuration.secureCookie,
      maxAge: Math.max(0, +context.sessionExpiresAt - +clockNow()),
    });
  }

  function clearCookie(res, id) {
    if (!validId(id)) return;
    res.clearCookie(cookieName(id), { path: cookiePath(id), httpOnly: true, sameSite: "strict", secure: configuration?.secureCookie ?? true });
  }

  async function logout(context) {
    await Appointment.updateOne({ _id: context.id }, { $pull: { "management.sessions": { tokenHash: context.sessionHash } } });
  }

  async function revoke(id) {
    if (!validId(id)) return false;
    const updated = await Appointment.updateOne({ _id: id, "management.tokenHash": { $exists: true }, "management.revokedAt": null }, {
      $set: { "management.revokedAt": clockNow(), "management.sessions": [] },
    });
    if (updated.modifiedCount === 1) return true;
    return Boolean(await Appointment.exists({ _id: id, "management.revokedAt": { $type: "date" } }));
  }

  return {
    enabled, createGrant, emailLink, exchange, authorize, logout, revoke,
    requireOrigin, requireCsrf, setCookie, clearCookie,
    limitExchange(req) { exchangeLimiter.take(req.ip); },
  };
}
