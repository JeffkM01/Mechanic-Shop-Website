import { isValidEmailAddress } from "../shared/appointmentFields.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"];
const API_KEYS = ["BREVO_API_KEY", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"];
const present = value => typeof value === "string" && value.trim().length > 0;
const hasControls = value => [...value].some(character => {
  const code = character.codePointAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});

class EmailTransportError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "EmailTransportError";
    this.code = code;
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) this.statusCode = statusCode;
  }
}

const invalidMessage = () => new EmailTransportError("EMAIL_MESSAGE_INVALID", "The email message needs review before it can be sent.");
const uncertain = () => new EmailTransportError("BREVO_API_UNCERTAIN", "The email provider's acceptance could not be confirmed. Check the inbox before retrying.");

function mailbox(value, allowName = false) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 340 || hasControls(value)) throw invalidMessage();
  if (isValidEmailAddress(value)) return { email: value };
  const wrapped = allowName && /^([A-Za-z\d &'()._-]{1,80})\s*<([^<>]+)>$/.exec(value);
  if (!wrapped || !wrapped[1].trim() || !isValidEmailAddress(wrapped[2]) || wrapped[2] !== wrapped[2].trim()) throw invalidMessage();
  return { email: wrapped[2], name: wrapped[1].trim() };
}

export function isValidBrevoApiKey(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value);
}

function validateApiKey(value) {
  if (!isValidBrevoApiKey(value)) {
    throw new Error("BREVO_API_KEY must be a non-empty private key without whitespace or control characters.");
  }
}

/** Offline parsing only. No private files, network calls or transport creation. */
export function readEmailConfiguration(env = process.env) {
  const mode = env.EMAIL_TRANSPORT === undefined ? "smtp" : env.EMAIL_TRANSPORT;
  if (!["smtp", "brevo_api"].includes(mode)) throw new Error("EMAIL_TRANSPORT must be smtp or brevo_api.");
  if (!(mode === "smtp" ? SMTP_KEYS : API_KEYS).every(key => present(env[key]))) return null;
  const common = { transport: mode, from: env.MAIL_FROM, mechanicEmail: env.MECHANIC_NOTIFICATION_EMAIL };
  if (mode === "brevo_api") {
    validateApiKey(env.BREVO_API_KEY);
    mailbox(common.from, true);
    mailbox(common.mechanicEmail);
    return { ...common, apiKey: env.BREVO_API_KEY };
  }
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a valid TCP port number.");
  return { ...common, host: env.SMTP_HOST, port, user: env.SMTP_USER, pass: env.SMTP_PASS };
}

function payloadFor(message) {
  const fields = ["from", "to", "replyTo", "subject", "text"];
  if (!message || typeof message !== "object" || Array.isArray(message)
    || Object.keys(message).length !== fields.length || fields.some(field => !Object.hasOwn(message, field))) throw invalidMessage();
  if (typeof message.subject !== "string" || !message.subject.trim() || message.subject.length > 250 || hasControls(message.subject)
    || typeof message.text !== "string" || !message.text.trim() || message.text.length > 65_536 || message.text.includes("\0")) throw invalidMessage();
  return {
    sender: mailbox(message.from, true), to: [mailbox(message.to)], replyTo: mailbox(message.replyTo),
    subject: message.subject, textContent: message.text,
  };
}

/** One HTTPS attempt; the durable dispatcher, never this adapter, owns retries. */
export function createBrevoApiTransport({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  validateApiKey(apiKey);
  if (typeof fetchImpl !== "function") throw new Error("A supported HTTPS fetch implementation is required.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Email transport timeout must be a whole number from 1 to 30000 milliseconds.");
  return {
    async sendMail(message) {
      let payload;
      try { payload = payloadFor(message); }
      catch { throw invalidMessage(); }
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(uncertain()); }, timeoutMs);
      });
      async function request() {
        const response = await fetchImpl(BREVO_ENDPOINT, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "api-key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* No provider body is exposed. */ }
          throw new EmailTransportError("BREVO_API_REJECTED", "The email provider rejected the request. Review the private sender, key and account configuration.", response.status);
        }
        const result = await response.json();
        if (typeof result?.messageId !== "string" || !result.messageId.trim() || result.messageId.length > 512 || hasControls(result.messageId)) throw uncertain();
        return { messageId: result.messageId };
      }
      try { return await Promise.race([request(), deadline]); }
      catch (error) {
        // Never expose provider responses, keys, customer data, redirect URLs,
        // or raw network errors. Acceptance followed by a lost response is
        // uncertain and can produce duplicates if the caller later retries.
        if (error instanceof EmailTransportError) throw error;
        throw uncertain();
      } finally { clearTimeout(timer); }
    },
  };
}
