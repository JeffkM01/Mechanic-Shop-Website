import { createBrevoApiTransport, readEmailConfiguration } from "./emailTransport.js";

export const EMAIL_TEST_RECIPIENT = "contact@edsautoshop.com";
const COOLDOWN_MS = 60_000;
const FROM = `Ed's Auto Shop <${EMAIL_TEST_RECIPIENT}>`;

export class EmailConnectionTestError extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const disabled = () => new EmailConnectionTestError(503, "EMAIL_TEST_DISABLED", "The email connection test is not enabled in this environment.");

// Pure configuration parsing is also used by the offline staging preflight.
export function readEmailConnectionTestConfiguration({ staging, env = process.env } = {}) {
  const flag = env.STAGING_EMAIL_TEST_ENABLED;
  if (flag === undefined || flag === "false") return { enabled: false };
  if (flag !== "true") throw new Error("STAGING_EMAIL_TEST_ENABLED must be true or false.");
  if (staging?.enabled !== true) throw new Error("The email connection test requires protected staging.");
  let configuration;
  try {
    configuration = readEmailConfiguration({
      EMAIL_TRANSPORT: "brevo_api", BREVO_API_KEY: env.BREVO_API_KEY,
      MAIL_FROM: FROM, MECHANIC_NOTIFICATION_EMAIL: EMAIL_TEST_RECIPIENT,
    });
  } catch { /* Configuration errors never echo a supplied API key. */ }
  if (!configuration) throw new Error("The staging email connection test requires a valid private BREVO_API_KEY.");
  return { enabled: true, apiKey: configuration.apiKey };
}

// This is an independent manual diagnostic. It deliberately receives no
// Appointment model, dispatcher, customer input or management-link factory.
export function createEmailConnectionTest({ staging, env = process.env, transport, now = () => Date.now() } = {}) {
  const configuration = readEmailConnectionTestConfiguration({ staging, env });
  if (!configuration.enabled) return {
    status: () => ({ enabled: false }),
    send: async () => { throw disabled(); },
  };
  const mailer = transport ?? createBrevoApiTransport({ apiKey: configuration.apiKey });
  let pending = false;
  let nextAttemptAt = 0;
  const retryAfter = () => Math.max(pending ? 1 : 0, Math.ceil((nextAttemptAt - now()) / 1000), 0);

  function status() {
    return { enabled: true, recipient: EMAIL_TEST_RECIPIENT, retryAfterSeconds: retryAfter() };
  }

  async function send() {
    const retryAfterSeconds = retryAfter();
    if (retryAfterSeconds) throw new EmailConnectionTestError(429, "EMAIL_TEST_RATE_LIMITED", "Please wait before sending another test email.", retryAfterSeconds);
    // Admission is reserved synchronously, before any asynchronous transport.
    // The cooldown also applies to failures; it never renews staff idle time.
    pending = true;
    nextAttemptAt = now() + COOLDOWN_MS;
    try {
      await mailer.sendMail({
        from: FROM, to: EMAIL_TEST_RECIPIENT, replyTo: EMAIL_TEST_RECIPIENT,
        subject: "[TEST ONLY] Ed's Auto Shop — email connection test",
        text: "This is a manually requested email connection test for Ed's Auto Shop.\n\nTEST ONLY: This message does not represent an appointment request, confirmation, decline or cancellation.\n\nIt contains no customer appointment information. Ordinary appointment emails remain disabled in protected staging.\n\nPlease check that this message reached the intended inbox. Replies go to contact@edsautoshop.com.\n\nEd's Auto Shop",
      });
    } catch {
      // A provider may have accepted a message before a connection failed.
      // Neither raw provider errors nor false claims of non-delivery belong in
      // the response. A manual retry may produce another clearly marked test.
      throw new EmailConnectionTestError(503, "EMAIL_TEST_UNCONFIRMED", "Test email acceptance could not be confirmed. Check the inbox before trying again.");
    } finally { pending = false; }
    return { accepted: true, recipient: EMAIL_TEST_RECIPIENT, retryAfterSeconds: retryAfter() };
  }

  return { status, send };
}
