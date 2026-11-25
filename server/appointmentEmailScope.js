export const APPOINTMENT_EMAIL_TEST_FIELD = "notificationTestRunId";
export const OWNED_EMAIL_TEST_RECIPIENT = "contact@edsautoshop.com";
export const OWNED_EMAIL_TEST_FROM = `Ed's Auto Shop <${OWNED_EMAIL_TEST_RECIPIENT}>`;
export const EMAIL_TEST_RUN_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export const isOwnedEmailTestRecipient = value => typeof value === "string"
  && value.trim().toLowerCase() === OWNED_EMAIL_TEST_RECIPIENT;

// Scope comes only from reviewed server configuration, never a request body.
// A null scope means ordinary delivery: all tagged test records are excluded.
export function validateEmailDeliveryScope(value = null) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || typeof value.runId !== "string" || !EMAIL_TEST_RUN_PATTERN.test(value.runId)
    || value.recipient !== OWNED_EMAIL_TEST_RECIPIENT) throw new Error("Use a valid fixed-inbox appointment email test scope.");
  return Object.freeze({ runId: value.runId.toLowerCase(), recipient: OWNED_EMAIL_TEST_RECIPIENT });
}

export function appointmentMatchesEmailScope(appointment, scope = null) {
  if (!appointment || typeof appointment !== "object") return false;
  if (!scope) return appointment[APPOINTMENT_EMAIL_TEST_FIELD] === undefined;
  return typeof scope.runId === "string" && EMAIL_TEST_RUN_PATTERN.test(scope.runId)
    && scope.recipient === OWNED_EMAIL_TEST_RECIPIENT
    && appointment[APPOINTMENT_EMAIL_TEST_FIELD] === scope.runId
    && isOwnedEmailTestRecipient(appointment.email);
}

export function appointmentEmailScopeQuery(value = null) {
  const scope = validateEmailDeliveryScope(value);
  return scope ? { [APPOINTMENT_EMAIL_TEST_FIELD]: scope.runId, email: scope.recipient }
    : { [APPOINTMENT_EMAIL_TEST_FIELD]: { $exists: false } };
}

export function protectAppointmentTestEmail(message, value = null) {
  const scope = validateEmailDeliveryScope(value);
  if (!scope) return message;
  // Refuse a bad destination rather than redirecting another person's data.
  if (message.from !== OWNED_EMAIL_TEST_FROM || message.to !== scope.recipient || message.replyTo !== scope.recipient) {
    throw new Error("The appointment email test requires only the fixed owned mailbox.");
  }
  return { ...message, subject: `[TEST ONLY] ${message.subject}`,
    text: `PRIVATE APPOINTMENT EMAIL TEST — this is not a real customer appointment.\n\n${message.text}` };
}
