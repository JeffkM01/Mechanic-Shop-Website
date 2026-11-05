import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import Appointment from "./Appointment.js";
import { prepareAppointment } from "./appointmentInput.js";
import { createMechanicAuth } from "./mechanicAuth.js";
import { createEmailNotifications } from "./emailNotifications.js";

// The mechanic's requested dates/times are local to the St. Louis area.
process.env.TZ = "America/Chicago";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

const uri = process.env.MONGODB_URI;
const port = Number(process.env.PORT || 3001);
const auth = createMechanicAuth(process.env.MECHANIC_ADMIN_PASSWORD, {
  secureCookies: process.env.NODE_ENV === "production",
});

// Created during startup after MongoDB connects. Routes only run after startup.
let notifications;

app.get("/api/health", (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ database: connected ? "connected" : "disconnected" });
});

// Public customer endpoint: new appointments always start as pending.
app.post("/api/appointments", async (req, res) => {
  const { error, value } = prepareAppointment(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const appointment = await Appointment.create(value);
    res.status(201).json({
      id: appointment.id,
      status: appointment.status,
      emailNotification: notifications.enabled ? "queued" : "disabled",
      message: "Request saved. The mechanic has not approved it yet.",
    });
    notifications.kick();
  } catch (err) {
    console.error("Failed to save appointment:", err);
    return res.status(503).json({ error: "Unable to save the request right now. Please try again." });
  }
});

// Prevent browser/proxy caching of private appointment responses.
app.use("/api/mechanic", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Mechanic routes: no public endpoint exposes customers' contact details.
app.post("/api/mechanic/login", auth.login);
app.get("/api/mechanic/session", auth.requireAuth, auth.session);
app.post("/api/mechanic/activity", auth.requireAuth, auth.requireCsrf, auth.activity);
app.post("/api/mechanic/logout", auth.requireAuth, auth.requireCsrf, auth.logout);

app.get("/api/mechanic/appointments", auth.requireAuth, async (req, res) => {
  const status = req.query.status || "pending";
  if (!["all", "pending", "confirmed", "declined"].includes(status)) {
    return res.status(400).json({ error: "Invalid status filter." });
  }

  try {
    const query = status === "all" ? {} : { status };
    const appointments = await Appointment.find(query)
      .select("name email phone vehicle service date time notes status createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ appointments });
  } catch (err) {
    console.error("Failed to read appointments:", err);
    return res.status(503).json({ error: "Unable to load appointments right now." });
  }
});

app.patch("/api/mechanic/appointments/:id", auth.requireAuth, auth.requireCsrf, async (req, res) => {
  const { id } = req.params;
  const status = req.body?.status;
  if (!/^[a-f\d]{24}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid appointment ID." });
  }
  if (status !== "confirmed" && status !== "declined") {
    return res.status(400).json({ error: "Choose confirmed or declined." });
  }

  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: id, status: "pending" },
      { $set: { status, "notificationState.decisionCustomer": "pending" } },
      { returnDocument: "after", runValidators: true },
    ).select("status date time service name");
    if (!appointment) {
      return res.status(409).json({ error: "This request was already reviewed or no longer exists." });
    }
    res.json({ id: appointment.id, status: appointment.status, emailNotification: notifications.enabled ? "queued" : "disabled" });
    notifications.kick();
  } catch (err) {
    console.error("Failed to update appointment:", err);
    return res.status(503).json({ error: "Unable to update this appointment right now." });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON request." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request is too large." });
  }
  console.error("Request error:", err);
  return res.status(500).json({ error: "Unexpected server error." });
});

if (!uri || uri.includes("DB_USER") || uri.includes("CLUSTER.mongodb.net")) {
  console.error("Set your real MONGODB_URI in server/.env before starting the API.");
  process.exit(1);
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  notifications = await createEmailNotifications({ Appointment });
  notifications.start();
  app.listen(port, "127.0.0.1", () => {
    console.log(`Appointment API listening at http://localhost:${port}`);
    console.log(`Email notifications ${notifications.enabled ? "enabled" : "disabled (SMTP not configured)"}`);
  });
} catch (err) {
  console.error("Could not start the appointment API:", err.message);
  process.exit(1);
}
