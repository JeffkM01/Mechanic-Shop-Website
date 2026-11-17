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

// Resolve the private development file independently of the shell's working
// directory. Explicit host environment values always take precedence.
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)), quiet: true });
process.env.TZ = "America/Chicago";
let notifications;
let server;
try {
  const config = readRuntimeConfig();
  const staging = readStagingSafety();
  const bookingRateLimiter = createBookingRateLimiter(readBookingAbuseConfig());
  const uri = process.env.MONGODB_URI;
  const auth = createMechanicAuth(process.env.MECHANIC_ADMIN_PASSWORD, { secureCookies: config.production });
  if (typeof uri !== "string" || !/^mongodb(?:\+srv)?:\/\//.test(uri) || uri.includes("DB_USER") || uri.includes("CLUSTER.mongodb.net")) {
    throw new Error("MONGODB_URI must be configured.");
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, ...(staging.enabled ? { dbName: staging.databaseName } : {}) });
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const notificationEnv = notificationEnvironmentForStage(staging);
  const management = createCustomerManagement({ Appointment, env: notificationEnv });
  const scheduling = createSchedulingService({ Appointment, SchedulingState, management });
  await scheduling.getSettings(); // Preserve the existing compatible seed/CAS path.
  // Staging never constructs an SMTP transport, even if real SMTP values were
  // accidentally copied into its host environment. Queue state is retained.
  notifications = await createEmailNotifications({ Appointment, management, env: notificationEnv });
  const operationTracker = createOperationTracker();
  const app = createApp({ Appointment, scheduling, auth, notifications, management,
    operationTracker,
    requestGate: staging.requestGate, bookingRateLimiter,
    trustProxy: config.trustProxy,
    frontendDirectory: config.serveFrontend ? fileURLToPath(new URL("../dist/", import.meta.url)) : null,
  });
  server = createServer(app);
  const runtime = createServerRuntime({ server,
    disconnectDatabase: () => mongoose.disconnect(), stopNotifications: () => notifications.stop(),
    stopApplicationWork: operationTracker.stop, graceMs: config.shutdownGraceMs,
  });
  await listen(server, config);
  runtime.installSignalHandlers();
  // Begin queue delivery only after the HTTP listener has started successfully.
  notifications.start();
  console.log(`Appointment service listening on ${config.host}:${config.port}.`);
  console.log(`Frontend serving ${config.serveFrontend ? "enabled" : "disabled"}. Email notifications ${notifications.enabled ? "enabled" : "disabled (SMTP not configured)"}.`);
} catch {
  // Never echo arbitrary MongoDB, SMTP, request or environment values.
  console.error("Could not start the appointment service. Check the private runtime configuration and database connectivity.");
  await Promise.allSettled([
    Promise.resolve().then(() => notifications?.stop()),
    Promise.resolve().then(() => { server?.close(); server?.closeAllConnections?.(); }),
    mongoose.disconnect(),
  ]);
  process.exitCode = 1;
}
