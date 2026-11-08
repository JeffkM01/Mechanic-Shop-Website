import { buildEmail, EMAIL_KINDS } from "./emailTemplates.js";

// MongoDB stores the queued email flags in each Appointment document.
// Only one local API process should run this dispatcher at a time.
export async function createEmailNotifications({ Appointment, env = process.env, transport, logger = console }) {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MECHANIC_NOTIFICATION_EMAIL"];
  const enabled = keys.every((key) => typeof env[key] === "string" && env[key].trim().length > 0);
  if (!enabled) {
    return { enabled: false, start() {}, kick() {}, processPending: async () => {} };
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

  async function processPending() {
    if (processing) return;
    processing = true;
    try {
      const unsent = EMAIL_KINDS.map((kind) => ({ [`notificationState.${kind}`]: "pending" }));
      const appointments = await Appointment.find({ $or: unsent })
        .sort({ createdAt: 1 }).limit(50).lean();

      for (const appointment of appointments) {
        const automaticConfirmation = appointment.status === "confirmed" && appointment.scheduling?.confirmationSource === "automatic";
        if ((appointment.status === "declined" || automaticConfirmation) && appointment.notificationState?.requestCustomer === "pending") {
          // Also reconcile unsent queues written by an earlier PR revision.
          // Automatic confirmations and declines belong to decisionCustomer.
          // A declined request must never send a queued "still pending" receipt.
          // A failed suppression write retries without sending a false receipt.
          await Appointment.updateOne({
            _id: appointment._id,
            status: appointment.status,
            ...(automaticConfirmation ? { "scheduling.confirmationSource": "automatic" } : {}),
            "notificationState.requestCustomer": "pending",
          }, { $set: { "notificationState.requestCustomer": "suppressed" } });
          appointment.notificationState.requestCustomer = "suppressed";
        }
        for (const kind of EMAIL_KINDS) {
          if (appointment.notificationState?.[kind] !== "pending") continue;
          try {
            const message = buildEmail(kind, appointment, messageOptions);
            await mailer.sendMail(message);
            // Mark as sent only after the email provider accepts it.
            await Appointment.updateOne(
              { _id: appointment._id, [`notificationState.${kind}`]: "pending" },
              { $set: { [`notificationState.${kind}`]: "sent" } },
            );
          } catch (err) {
            // Keep it pending. The next queue sweep retries the message.
            logger.error(`Notification ${kind} failed for appointment ${appointment._id}: ${err.code || err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Notification queue could not be processed: ${err.code || err.message}`);
    } finally {
      processing = false;
    }
  }

  function kick() {
    setImmediate(() => { void processPending(); });
  }

  function start() {
    kick();
    const interval = setInterval(() => { void processPending(); }, 60_000);
    interval.unref?.();
    return () => clearInterval(interval);
  }

  return { enabled: true, start, kick, processPending };
}
