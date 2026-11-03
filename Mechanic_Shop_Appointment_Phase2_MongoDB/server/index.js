import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import Appointment from "./Appointment.js";
import { prepareAppointment } from "./appointmentInput.js";

// Preferred appointments are for a shop in the St. Louis area.
// Ensure the date/time check uses shop-local time even if the API is hosted elsewhere.
process.env.TZ = "America/Chicago";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

app.get("/api/health", (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ database: connected ? "connected" : "disconnected" });
});

// Public endpoint: accept a request, but do not allow public access to customer records.
app.post("/api/appointments", async (req, res) => {
  const { error, value } = prepareAppointment(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const appointment = await Appointment.create(value);
    return res.status(201).json({
      id: appointment.id,
      status: appointment.status,
      message: "Request saved. The mechanic has not approved it yet.",
    });
  } catch (err) {
    console.error("Failed to save appointment:", err);
    return res.status(503).json({ error: "Unable to save the request right now. Please try again." });
  }
});

// Report malformed JSON to the form instead of leaving the request hanging.
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

const uri = process.env.MONGODB_URI;
const port = Number(process.env.PORT || 3001);

if (!uri || uri.includes("DB_USER") || uri.includes("CLUSTER.mongodb.net")) {
  console.error("Set your real MONGODB_URI in server/.env before starting the API.");
  process.exit(1);
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  app.listen(port, "127.0.0.1", () => console.log(`Appointment API listening at http://localhost:${port}`));
} catch (err) {
  console.error("Could not connect to MongoDB:", err.message);
  process.exit(1);
}
