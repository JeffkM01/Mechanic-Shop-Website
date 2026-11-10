import "dotenv/config";
import mongoose from "mongoose";
import Appointment from "./Appointment.js";
import SchedulingState from "./SchedulingState.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createEmailNotifications } from "./emailNotifications.js";
import { createSchedulingService } from "./schedulingService.js";
import { createApp } from "./app.js";
import { createCustomerManagement } from "./customerManagement.js";

// Persisted scheduling calculations use explicit IANA timezone conversion.
// Keep the existing default for legacy validation and operational logging.
process.env.TZ = "America/Chicago";
const uri = process.env.MONGODB_URI;
const port = Number(process.env.PORT || 3001);
const auth = createMechanicAuth(process.env.MECHANIC_ADMIN_PASSWORD, { secureCookies: process.env.NODE_ENV === "production" });
if (!uri || uri.includes("DB_USER") || uri.includes("CLUSTER.mongodb.net")) {
  console.error("Set your real MONGODB_URI in server/.env before starting the API.");
  process.exit(1);
}
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([Appointment.init(), SchedulingState.init()]);
  const management = createCustomerManagement({ Appointment });
  const scheduling = createSchedulingService({ Appointment, SchedulingState, management });
  await scheduling.getSettings(); // Seed placeholder defaults once; never overwrite saved settings.
  const notifications = await createEmailNotifications({ Appointment, management });
  notifications.start();
  const app = createApp({ Appointment, scheduling, auth, notifications, management });
  app.listen(port, "127.0.0.1", () => {
    console.log(`Appointment API listening at http://localhost:${port}`);
    console.log(`Email notifications ${notifications.enabled ? "enabled" : "disabled (SMTP not configured)"}`);
  });
} catch (error) {
  console.error("Could not start the appointment API:", error.message);
  process.exit(1);
}
