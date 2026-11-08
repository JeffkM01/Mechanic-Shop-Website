import express from "express";
import { prepareAppointment } from "./appointmentInput.js";
import { SchedulingError } from "./schedulingRules.js";

export function createApp({ Appointment, scheduling, auth, notifications, databaseReady = () => Appointment.db.readyState === 1 }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    const connected = databaseReady();
    res.status(connected ? 200 : 503).json({ database: connected ? "connected" : "disconnected" });
  });

  app.get("/api/availability", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.service !== "string" || typeof req.query.date !== "string") return res.status(400).json({ error: "Provide one service and date (YYYY-MM-DD)." });
    try { res.json(await scheduling.getAvailability(req.query.service, req.query.date)); }
    catch (error) { next(error); }
  });

  app.get("/api/availability/calendar", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.service !== "string" || (req.query.month !== undefined && typeof req.query.month !== "string")) {
      return res.status(400).json({ error: "Provide one service and an optional month (YYYY-MM)." });
    }
    try { res.json(await scheduling.getCalendarAvailability(req.query.service, req.query.month)); }
    catch (error) { next(error); }
  });

  app.post("/api/appointments", async (req, res, next) => {
    // Date/time syntax is checked here; the shop's persisted timezone, hours,
    // notice and capacity rules are applied atomically by scheduling below.
    const { error, value } = prepareAppointment(req.body, new Date(), { schedulingAuthoritative: true });
    if (error) return res.status(400).json({ error });
    try {
      const appointment = await scheduling.createAppointment(value);
      res.status(201).json({
        id: appointment.id,
        status: appointment.status,
        emailNotification: notifications.enabled ? "queued" : "disabled",
        holdExpiresAt: appointment.status === "pending" ? appointment.scheduling?.holdExpiresAt : undefined,
        message: appointment.status === "confirmed" ? "Your appointment has been confirmed." : "Request saved for mechanic review. The provisional hold expires if it is not reviewed in time; approval is still required.",
      });
      notifications.kick();
    } catch (error) { next(error); }
  });

  app.use("/api/mechanic", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.post("/api/mechanic/login", auth.login);
  app.get("/api/mechanic/session", auth.requireAuth, auth.session);
  app.post("/api/mechanic/activity", auth.requireAuth, auth.requireCsrf, auth.activity);
  app.post("/api/mechanic/logout", auth.requireAuth, auth.requireCsrf, auth.logout);

  app.get("/api/mechanic/appointments", auth.requireAuth, async (req, res, next) => {
    const status = req.query.status || "pending";
    if (!["all", "pending", "confirmed", "declined"].includes(status)) return res.status(400).json({ error: "Invalid status filter." });
    try {
      const appointments = await Appointment.find(status === "all" ? {} : status === "pending" ? { status: { $in: ["pending", null] } } : { status })
        .select("name email phone vehicle service date time notes status createdAt updatedAt scheduling")
        .sort({ createdAt: -1 }).limit(100).lean();
      res.json({ appointments: appointments.map(appointment => ({ ...appointment, status: appointment.status || "pending" })) });
    } catch (error) { next(error); }
  });

  app.patch("/api/mechanic/appointments/:id", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    try {
      const appointment = await scheduling.reviewAppointment(req.params.id, req.body?.status);
      res.json({ id: appointment.id, status: appointment.status, emailNotification: notifications.enabled ? "queued" : "disabled" });
      notifications.kick();
    } catch (error) { next(error); }
  });

  app.get("/api/mechanic/scheduling/settings", auth.requireAuth, async (_req, res, next) => {
    try { res.json(await scheduling.getSettings()); } catch (error) { next(error); }
  });

  app.patch("/api/mechanic/scheduling/settings", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    if (!req.body || Object.keys(req.body).some(key => !["revision", "settings"].includes(key)) || !Number.isInteger(req.body.revision) || req.body.revision < 0 || !req.body.settings) return res.status(400).json({ error: "Provide the current revision and a settings patch." });
    try { res.json(await scheduling.updateSettings(req.body.settings, { expectedRevision: req.body.revision })); } catch (error) { next(error); }
  });

  app.post("/api/mechanic/scheduling/blocks", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    try { res.status(201).json(await scheduling.addBlockedPeriod(req.body)); } catch (error) { next(error); }
  });

  app.delete("/api/mechanic/scheduling/blocks/:id", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "revision"))) return res.status(400).json({ error: "Provide only an optional settings revision." });
    try { res.json(await scheduling.removeBlockedPeriod(req.params.id, { expectedRevision: req.body?.revision })); } catch (error) { next(error); }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SchedulingError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) return res.status(400).json({ error: "Invalid JSON request." });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    console.error("Appointment API request failed:", error);
    return res.status(503).json({ error: "Unable to process the request right now. Please try again." });
  });
  return app;
}
