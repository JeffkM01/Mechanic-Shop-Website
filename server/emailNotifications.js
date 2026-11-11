import { buildEmail, EMAIL_KINDS } from "./emailTemplates.js";

// MongoDB stores the queued email flags in each Appointment document.
// Only one local API process should run this dispatcher at a time.
export async function createEmailNotifications({ Appointment, env = process.env, transport, logger = console, management = null }) {
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

  async function processPending() {
    if (processing || stopped) return;
    processing = true;
    let finished;
    draining = new Promise(resolve => { finished = resolve; });
    try {
      const unsent = EMAIL_KINDS.map((kind) => ({ [`notificationState.${kind}`]: "pending" }));
      const appointments = await Appointment.find({ $or: unsent })
        .sort({ createdAt: 1 }).limit(50).lean();

      for (const queued of appointments) {
        if (stopped) break;
        for (const kind of EMAIL_KINDS) {
          if (stopped) break;
          try {
            // The batch is only a list of candidate IDs. A decision or
            // cancellation may have been saved since it was read, or even
            // while the preceding email was in flight. Read current intent
            // before every kind; management verifiers remain private here.
            const appointment = await Appointment.findById(queued._id).select("+management").lean();
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
            if (appointment.notificationState?.[kind] !== "pending") continue;
            const customerLink = kind === "requestCustomer" || kind === "cancellationCustomer"
              || (kind === "decisionCustomer" && appointment.status === "confirmed");
            const managementLink = customerLink && management ? await management.emailLink(appointment) : null;
            const message = buildEmail(kind, appointment, { ...messageOptions, managementLink });
            if (stopped) break;
            // A status change after this read / once transport starts cannot
            // recall an email. Delivery is at-least-once, never exactly-once.
            await mailer.sendMail(message);
            // Mark as sent only after the email provider accepts it.
            await Appointment.updateOne(
              { _id: appointment._id, [`notificationState.${kind}`]: "pending" },
              { $set: { [`notificationState.${kind}`]: "sent" } },
            );
          } catch {
            // Keep it pending. The next queue sweep retries the message.
            // Transport/database errors can echo message bodies or bearer
            // URLs. Do not log arbitrary error messages or error codes.
            logger.error(`Notification ${kind} failed for appointment ${queued._id}; delivery will be retried.`);
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
