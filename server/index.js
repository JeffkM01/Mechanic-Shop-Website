import dotenv from "dotenv";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import Appointment from "./Appointment.js";
import SchedulingState from "./SchedulingState.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { createSchedulingService } from "./schedulingService.js";
import { createApp } from "./app.js";
import { createCustomerManagement } from "./customerManagement.js";
import { readRuntimeConfig } from "./runtimeConfig.js";
import { createServerRuntime, listen } from "./serverRuntime.js";
import { createOperationTracker } from "./operationTracker.js";
import { notificationEnvironmentForStage, readStagingSafety } from "./stagingSafety.js";
import { createBookingRateLimiter, readBookingAbuseConfig } from "./bookingAbuseProtection.js";
import { startupFailureMessage } from "./startupDiagnostics.js";
import { createEmailConnectionTest } from "./emailConnectionTest.js";
import { readAppointmentEmailTestConfiguration } from "./appointmentEmailTest.js";
import { OWNED_EMAIL_TEST_RECIPIENT } from "./appointmentEmailScope.js";

// Resolve the private development file independently of the shell's working
// directory. Explicit host environment values always take precedence.
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)), quiet: true });
process.env.TZ = "America/Chicago";
let notifications;
let server;
let startupPhase = "RUNTIME_CONFIGURATION";
try {
  const config = readRuntimeConfig();
  startupPhase = "STAGING_CONFIGURATION";
  const staging = readStagingSafety();
  startupPhase = "BOOKING_RATE_LIMIT_CONFIGURATION";
  const bookingRateLimiter = createBookingRateLimiter(readBookingAbuseConfig());
  const uri = process.env.MONGODB_URI;
  startupPhase = "MECHANIC_AUTH_CONFIGURATION";
  const auth = createMechanicAuth(process.env.MECHANIC_ADMIN_PASSWORD, { secureCookies: config.production });
  startupPhase = "APPOINTMENT_EMAIL_TEST_CONFIGURATION";
  const appointmentEmailTest = readAppointmentEmailTestConfiguration({ staging });
  startupPhase = "EMAIL_TEST_CONFIGURATION";
  const emailTest = createEmailConnectionTest({ staging });
  startupPhase = "DATABASE_URI_CONFIGURATION";
  if (typeof uri !== "string" || !/^mongodb(?:\+srv)?:\/\//.test(uri) || uri.includes("DB_USER") || uri.includes("CLUSTER.mongodb.net")) {
    throw new Error("MONGODB_URI must be configured.");
  }
  startupPhase = "DATABASE_CONNECTION";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, ...(staging.enabled ? { dbName: staging.databaseName } : {}) });
  startupPhase = "DATABASE_INDEXES";
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const notificationEnv = appointmentEmailTest.enabled ? appointmentEmailTest.notificationEnv : notificationEnvironmentForStage(staging);
  const deliveryScope = appointmentEmailTest.deliveryScope;
  startupPhase = "CUSTOMER_MANAGEMENT";
  const management = createCustomerManagement({ Appointment, env: notificationEnv, deliveryScope });
  startupPhase = "SCHEDULING_SETTINGS";
  const scheduling = createSchedulingService({ Appointment, SchedulingState, management, deliveryScope });
  await scheduling.getSettings(); // Preserve the existing compatible seed/CAS path.
  // Default staging keeps the dispatcher disabled. Explicit workflow tests
  // receive a locked HTTPS environment and active-run scope; old requests are
  // never retagged or admitted to that queue. The standalone probe is separate.
  startupPhase = "NOTIFICATIONS";
  notifications = await createEmailNotifications({ Appointment, management, env: notificationEnv, deliveryScope });
  startupPhase = "HTTP_APPLICATION";
  const operationTracker = createOperationTracker();
  const app = createApp({ Appointment, scheduling, auth, notifications, management, emailTest,
    appointmentEmailTest: { enabled: appointmentEmailTest.enabled, recipient: OWNED_EMAIL_TEST_RECIPIENT },
    operationTracker,
    requestGate: staging.requestGate, bookingRateLimiter,
    trustProxy: config.trustProxy,
    frontendDirectory: config.serveFrontend ? fileURLToPath(new URL("../dist/", import.meta.url)) : null,
  });
  startupPhase = "HTTP_LISTENER";
  server = createServer(app);
  const runtime = createServerRuntime({ server,
    disconnectDatabase: () => mongoose.disconnect(), stopNotifications: () => notifications.stop(),
    stopApplicationWork: operationTracker.stop, graceMs: config.shutdownGraceMs,
  });
  await listen(server, config);
  runtime.installSignalHandlers();
  // Begin queue delivery only after the HTTP listener has started successfully.
  startupPhase = "NOTIFICATIONS";
  notifications.start();
  console.log(`Appointment service listening on ${config.host}:${config.port}.`);
  console.log(`Frontend serving ${config.serveFrontend ? "enabled" : "disabled"}. Appointment email notifications ${notifications.enabled ? appointmentEmailTest.enabled ? "enabled for the owned-inbox test run only" : "enabled" : "disabled (staging or mail not configured)"}.`);
} catch (error) {
  // Never echo arbitrary MongoDB, SMTP, request or environment values.
  console.error(startupFailureMessage(startupPhase, error));
  await Promise.allSettled([
    Promise.resolve().then(() => notifications?.stop()),
    Promise.resolve().then(() => { server?.close(); server?.closeAllConnections?.(); }),
    mongoose.disconnect(),
  ]);
  process.exitCode = 1;
}
