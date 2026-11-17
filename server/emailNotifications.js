import { buildEmail, EMAIL_KINDS } from "./emailTemplates.js";
import { fieldLimits, isValidEmailAddress } from "../shared/appointmentFields.js";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const FAILURE_HISTORY_LIMIT = 5;
const MAX_FAILURE_COUNT = 1_000_000;

function failureDetails(error, phase, appointment) {
  if (phase === "acknowledgement") return { code: "acknowledgement-error", permanent: false };
  if (phase === "message" && (!isValidEmailAddress(appointment.email)
    || appointment.email.trim().length > fieldLimits.email)) return { code: "invalid-recipient", permanent: true };
  // Only a rejection of this message's recipient is terminal. Authentication,
  // sender, connection and other provider failures may recover after a fix.
  if (phase === "transport" && error?.command === "RCPT TO"
    && Number.isInteger(error.responseCode) && error.responseCode >= 500 && error.responseCode <= 599) {
    return { code: "recipient-rejected", permanent: true };
  }
  return { code: phase === "transport" ? "transport-error" : "record-error", permanent: false };
}

function retryDue(appointment, kind, clock) {
  const next = appointment.notificationRetry?.[kind]?.nextAttemptAt;
  return next == null || +new Date(next) <= +clock;
}

// MongoDB stores the queued email flags in each Appointment document.
// Only one local API process should run this dispatcher at a time.
export async function createEmailNotifications({ Appointment, env = process.env, transport, logger = console, management = null, now = () => new Date() }) {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"];
  const enabled = keys.every((key) => typeof env[key] === "string" && env[key].trim().length > 0);
  if (!enabled) {
    const stop = async () => {};
    return { enabled: false, start: () => stop, stop, kick() {}, processPending: async () => {} };
  }

  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid TCP port number.");
  }

  const mailer = transport ?? (await import("nodemailer")).default.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  const messageOptions = { from: env.MAIL_FROM, mechanicEmail: env.MECHANIC_NOTIFICATION_EMAIL };
  let processing = false;
  let stopped = false;
  let interval = null;
  let draining = null;

  async function recordFailure(appointment, kind, error, phase) {
    const clock = new Date(now());
    const failure = failureDetails(error, phase, appointment);
    const previous = appointment.notificationRetry?.[kind];
    const count = Math.min(MAX_FAILURE_COUNT, Math.max(0, Number.isInteger(previous?.failureCount) ? previous.failureCount : 0) + 1);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(count - 1, 11));
    const history = Array.isArray(previous?.history) ? previous.history.slice(-(FAILURE_HISTORY_LIMIT - 1)) : [];
    const metadata = {
      failureCount: count,
      firstFailureAt: previous?.firstFailureAt ?? clock,
      lastFailureAt: clock,
      lastFailureCode: failure.code,
      nextAttemptAt: failure.permanent ? null : new Date(+clock + delay),
      history: [...history, { at: clock, ...failure }],
    };
    // Pin current intent: a concurrent cancellation/decision may have suppressed
    // this message. Neither a failure nor an acknowledgement can reopen it.
    await Appointment.updateOne({ _id: appointment._id, [`notificationState.${kind}`]: "pending" }, {
      $set: { [`notificationRetry.${kind}`]: metadata, ...(failure.permanent ? { [`notificationState.${kind}`]: "failed" } : {}) },
    }, { runValidators: true, writeConcern: { w: "majority", j: true } });
    logger.error(`Notification ${kind} failed for appointment ${appointment._id}; ${failure.permanent ? "recipient needs review" : "delivery will be retried"}.`);
  }

  async function processPending() {
    if (processing || stopped) return;
    processing = true;
    let finished;
    draining = new Promise(resolve => { finished = resolve; });
    try {
      const clock = new Date(now());
      const unsent = EMAIL_KINDS.map((kind) => ({
        [`notificationState.${kind}`]: "pending",
        $or: [{ [`notificationRetry.${kind}.nextAttemptAt`]: null }, { [`notificationRetry.${kind}.nextAttemptAt`]: { $lte: clock } }],
      }));
      const appointments = await Appointment.find({ $or: unsent })
        .sort({ createdAt: 1 }).limit(50).lean();

      for (const queued of appointments) {
        if (stopped) break;
        for (const kind of EMAIL_KINDS) {
          if (stopped) break;
          let appointment;
          let phase = "record";
          try {
            // The batch is only a list of candidate IDs. A decision or
            // cancellation may have been saved since it was read, or even
            // while the preceding email was in flight. Read current intent
            // before every kind; management verifiers remain private here.
            appointment = await Appointment.findById(queued._id).select("+management +notificationRetry").lean();
            if (!appointment) continue;
            const automaticConfirmation = appointment.status === "confirmed" && appointment.scheduling?.confirmationSource === "automatic";
            const suppress = appointment.status === "cancelled" ? ["requestCustomer", "decisionCustomer"]
              : appointment.status === "declined" || automaticConfirmation ? ["requestCustomer"] : [];
            for (const staleKind of suppress) {
              if (appointment.notificationState?.[staleKind] !== "pending") continue;
              // Preserve sent history. A failed write leaves a retryable
              // queue and never permits an obsolete customer message.
              await Appointment.updateOne({
                _id: appointment._id, status: appointment.status,
                ...(automaticConfirmation ? { "scheduling.confirmationSource": "automatic" } : {}),
                [`notificationState.${staleKind}`]: "pending",
              }, { $set: { [`notificationState.${staleKind}`]: "suppressed" } });
              appointment.notificationState[staleKind] = "suppressed";
            }
            if (appointment.notificationState?.[kind] !== "pending" || !retryDue(appointment, kind, new Date(now()))) continue;
            const customerLink = kind === "requestCustomer" || kind === "cancellationCustomer"
              || (kind === "decisionCustomer" && appointment.status === "confirmed");
            const managementLink = customerLink && management ? await management.emailLink(appointment) : null;
            phase = "message";
            const message = buildEmail(kind, appointment, { ...messageOptions, managementLink });
            if (stopped) break;
            // A status change after this read / once transport starts cannot
            // recall an email. Delivery is at-least-once, never exactly-once.
            phase = "transport";
            await mailer.sendMail(message);
            // Mark as sent only after the email provider accepts it.
            phase = "acknowledgement";
            await Appointment.updateOne(
              { _id: appointment._id, [`notificationState.${kind}`]: "pending" },
              { $set: { [`notificationState.${kind}`]: "sent" } },
            );
          } catch (error) {
            // Persist only allowlisted codes and bounded history. Provider and
            // driver errors can contain customer text, credentials or bearers.
            try {
              if (appointment) await recordFailure(appointment, kind, error, phase);
              else logger.error(`Notification ${kind} could not be read for appointment ${queued._id}; delivery will be retried.`);
            } catch {
              logger.error(`Notification ${kind} retry state could not be saved for appointment ${queued._id}; delivery remains unacknowledged.`);
            }
          }
        }
      }
    } catch {
      logger.error("Notification queue could not be processed; it will be retried.");
    } finally {
      processing = false;
      finished();
      draining = null;
    }
  }

  function kick() {
    if (stopped) return;
    setImmediate(() => { if (!stopped) void processPending(); });
  }

  function start() {
    if (interval) return stop;
    stopped = false;
    kick();
    interval = setInterval(() => { void processPending(); }, 60_000);
    interval.unref?.();
    return stop;
  }

  function stop() {
    stopped = true;
    if (interval) clearInterval(interval);
    interval = null;
    // Await the current send and its Mongo acknowledgement. Unsent kinds stay
    // queued for the next single dispatcher after restart.
    return draining ?? Promise.resolve();
  }

  return { enabled: true, start, stop, kick, processPending };
}
