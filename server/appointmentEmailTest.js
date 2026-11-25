import { readEmailConfiguration } from "./emailTransport.js";
import { isCustomerManagementConfigured } from "./customerManagement.js";
import { OWNED_EMAIL_TEST_FROM, OWNED_EMAIL_TEST_RECIPIENT, validateEmailDeliveryScope } from "./appointmentEmailScope.js";

// Offline validation only. No database, transport, file or provider access.
// The returned notification environment is private and must not reach an API.
export function readAppointmentEmailTestConfiguration({ staging, env = process.env } = {}) {
  const flag = env.STAGING_APPOINTMENT_EMAIL_TEST_ENABLED;
  if (flag === undefined || flag === "false") return { enabled: false, deliveryScope: null, notificationEnv: null };
  if (flag !== "true") throw new Error("STAGING_APPOINTMENT_EMAIL_TEST_ENABLED must be true or false.");
  if (staging?.enabled !== true) throw new Error("Appointment email testing requires protected staging.");
  if (env.STAGING_EMAIL_TEST_ENABLED !== undefined && env.STAGING_EMAIL_TEST_ENABLED !== "false") {
    throw new Error("Disable the standalone email connection test before appointment email testing.");
  }
  let deliveryScope;
  try {
    deliveryScope = validateEmailDeliveryScope({ runId: env.STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID, recipient: OWNED_EMAIL_TEST_RECIPIENT });
  } catch { throw new Error("STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID must be a UUID v4."); }
  const notificationEnv = {
    NODE_ENV: env.NODE_ENV, DEPLOYMENT_STAGE: "staging", EMAIL_TRANSPORT: "brevo_api",
    BREVO_API_KEY: env.BREVO_API_KEY, MAIL_FROM: OWNED_EMAIL_TEST_FROM,
    MECHANIC_NOTIFICATION_EMAIL: OWNED_EMAIL_TEST_RECIPIENT,
    PUBLIC_WEBSITE_ORIGIN: env.PUBLIC_WEBSITE_ORIGIN,
    APPOINTMENT_MANAGEMENT_SECRET: env.APPOINTMENT_MANAGEMENT_SECRET,
  };
  let configuration;
  try { configuration = readEmailConfiguration(notificationEnv); } catch { /* Never echo credentials. */ }
  if (!configuration) throw new Error("Appointment email testing requires a valid private BREVO_API_KEY.");
  if (!isCustomerManagementConfigured(notificationEnv)) {
    throw new Error("Appointment email testing requires a valid PUBLIC_WEBSITE_ORIGIN and stable APPOINTMENT_MANAGEMENT_SECRET.");
  }
  return { enabled: true, deliveryScope, notificationEnv: Object.freeze(notificationEnv) };
}
