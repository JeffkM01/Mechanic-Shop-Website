import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const COOKIE = "mechanic_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 20 * 60 * 1000;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  const found = cookies.find((entry) => entry.trim().startsWith(`${name}=`));
  return found ? found.trim().slice(name.length + 1) : "";
}

// Local-demo authentication. Sessions are in server memory, not browser storage.
export function createMechanicAuth(password, { now = () => Date.now(), secureCookies = false, hashPassword = scrypt } = {}) {
  if (typeof password !== "string" || password.length < 12 || password.includes("REPLACE_WITH")) {
    throw new Error("Set MECHANIC_ADMIN_PASSWORD (at least 12 characters) in server/.env.");
  }

  const salt = randomBytes(16);
  const expectedHash = scryptSync(password, salt, 64);
  const sessions = new Map();
  const attempts = new Map();
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies,
    path: "/api/mechanic",
    maxAge: SESSION_MS,
  };

  async function matchesPassword(candidate) {
    if (typeof candidate !== "string" || !candidate || candidate.length > 256) return false;
    const candidateHash = await hashPassword(candidate, salt, 64);
    return timingSafeEqual(candidateHash, expectedHash);
  }

  function getSession(req) {
    const token = getCookie(req, COOKIE);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now() || session.lastActivityAt + IDLE_MS <= now()) {
      sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  function requireAuth(req, res, next) {
    const current = getSession(req);
    if (!current) return res.status(401).json({ error: "Mechanic sign-in required." });
    req.mechanic = current;
    next();
  }

  function requireCsrf(req, res, next) {
    const received = req.get("x-mechanic-csrf");
    const expected = req.mechanic?.session.csrf;
    if (!received || received !== expected) {
      return res.status(403).json({ error: "Security token missing or invalid. Sign in again." });
    }
    next();
  }

  async function login(req, res) {
    const ip = req.ip || "local";
    const clock = now();
    let current = attempts.get(ip);
    if (!current) {
      current = { failures: 0, pending: 0, until: clock + LIMIT_WINDOW_MS };
      attempts.set(ip, current);
    } else if (current.until <= clock) {
      // A new fixed window clears settled failures, but an expensive check
      // still in flight keeps its slot even across the window boundary.
      current.failures = 0;
      current.until = clock + LIMIT_WINDOW_MS;
    }
    if (current.failures + current.pending >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    }

    // Reserve before the first await: concurrent requests cannot all observe
    // an empty budget and enqueue unbounded password hashes. The injectable
    // hasher permits deterministic tests; production uses async scrypt.
    current.pending++;
    const passwordInput = req.body?.password;
    let valid = false;
    try {
      valid = await matchesPassword(passwordInput);
    } finally {
      current.pending--;
      // Success clears failures already completed, never pending reservations.
      // A concurrent failure settling after success consumes the budget again.
      if (valid) current.failures = 0;
      else current.failures++;
      if (!current.pending && (!current.failures || current.until <= now())) attempts.delete(ip);
    }
    if (!valid) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    // Clean up expired sessions when a new session is established.
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    const session = { csrf, expiresAt: now() + SESSION_MS, lastActivityAt: now() };
    sessions.set(token, session);
    res.cookie(COOKIE, token, cookieOptions);
    return res.json(sessionDetails(session));
  }

  function sessionDetails(session) {
    return {
      authenticated: true,
      csrfToken: session.csrf,
      expiresAt: session.expiresAt,
      idleExpiresAt: Math.min(session.expiresAt, session.lastActivityAt + IDLE_MS),
    };
  }

  // Only this explicit, CSRF-protected endpoint renews idle time. Reads and
  // background session checks must never keep an unattended dashboard alive.
  function activity(req, res) {
    req.mechanic.session.lastActivityAt = now();
    return res.json(sessionDetails(req.mechanic.session));
  }

  function session(req, res) {
    return res.json(sessionDetails(req.mechanic.session));
  }

  function logout(req, res) {
    sessions.delete(req.mechanic.token);
    res.clearCookie(COOKIE, {
      httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/api/mechanic",
    });
    return res.json({ authenticated: false });
  }

  return { login, session, activity, logout, requireAuth, requireCsrf };
}
