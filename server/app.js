import express from "express";
import { prepareAppointment } from "./appointmentInput.js";
import { SchedulingError } from "./schedulingRules.js";
import { createCustomerRoutes } from "./customerRoutes.js";
import { serveBuiltFrontend } from "./staticFrontend.js";

export function createApp({ Appointment, scheduling, auth, notifications, management = null, databaseReady = () => Appointment.db.readyState === 1,
  runtimeReady = () => true, frontendDirectory = null, trustProxy = false, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use("/api", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    next();
  });
  // Include parser failures and oversized requests in the sensitive-route
  // policy, before request bodies reach express.json or any route handler.
  app.use("/api/customer/appointments", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    const connected = databaseReady();
    const ready = runtimeReady();
    res.status(connected && ready ? 200 : 503).json({ database: connected ? "connected" : "disconnected", ...(!ready ? { status: "draining" } : {}) });
  });

  app.get("/api/health/live", (_req, res) => res.status(runtimeReady() ? 200 : 503).json({ status: runtimeReady() ? "ok" : "draining" }));
  app.use("/api", (_req, res, next) => {
    if (!runtimeReady()) return res.status(503).json({ error: "The service is restarting. Please try again shortly.", code: "SERVICE_DRAINING" });
    next();
  });

  app.get("/api/services", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await scheduling.getPublicServices()); }
    catch (error) { next(error); }
  });

  app.get("/api/shop-hours", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await scheduling.getPublicShopHours()); }
    catch (error) { next(error); }
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
    const { error, fields, value } = prepareAppointment(req.body, new Date(), { schedulingAuthoritative: true, deferServiceValidation: true });
    if (error) return res.status(400).json({ error, ...(fields ? { fields } : {}) });
    try {
      const appointment = await scheduling.createAppointment(value);
      res.status(201).json({
        id: appointment.id,
        status: appointment.status,
        emailNotification: notifications.enabled ? "queued" : "disabled",
        managementAccess: Boolean(management?.enabled && notifications.enabled),
        holdExpiresAt: appointment.status === "pending" ? appointment.scheduling?.holdExpiresAt : undefined,
        message: appointment.status === "confirmed" ? "Your appointment has been confirmed." : "Request saved for mechanic review. The provisional hold expires if it is not reviewed in time; approval is still required.",
      });
      notifications.kick();
    } catch (error) { next(error); }
  });

  // Customer credentials are scoped to one appointment. These routes never use
  // a reference ID as authorization or return the staff appointment payload.
  if (management) app.use("/api/customer/appointments", createCustomerRoutes({ management, scheduling, notifications }));
  else app.use("/api/customer/appointments", (_req, res) => res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).status(503).json({ error: "Online appointment management is unavailable. Please contact the shop." }));

  app.use("/api/mechanic", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.post("/api/mechanic/login", auth.login);
  app.get("/api/mechanic/session", auth.requireAuth, auth.session);
  app.post("/api/mechanic/activity", auth.requireAuth, auth.requireCsrf, auth.activity);
  app.post("/api/mechanic/logout", auth.requireAuth, auth.requireCsrf, auth.logout);

  app.get("/api/mechanic/appointments", auth.requireAuth, async (req, res, next) => {
    const status = req.query.status || "pending";
    if (!["all", "pending", "confirmed", "declined", "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid status filter." });
    try {
      const appointments = await Appointment.find(status === "all" ? {} : status === "pending" ? { status: { $in: ["pending", null] } } : { status })
        .select("name email phone vehicle service date time notes status decline cancellation createdAt updatedAt scheduling")
        .sort({ createdAt: -1 }).limit(100).lean();
      res.json({ appointments: appointments.map(appointment => ({ ...appointment, status: appointment.status || "pending", cancellationEligibility: scheduling.getCancellationEligibility?.(appointment) || { canCancel: false } })) });
    } catch (error) { next(error); }
  });

  app.post("/api/mechanic/appointments/:id/cancel", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    try {
      const appointment = await scheduling.cancelAppointment(req.params.id, "mechanic", req.body);
      const emailNotification = !notifications.enabled ? "disabled" : appointment.notificationState?.cancellationCustomer === "sent" ? "sent" : appointment.notificationState?.cancellationCustomer === "pending" ? "queued" : "not-applicable";
      res.json({ id: appointment.id, status: appointment.status, cancellation: appointment.cancellation, emailNotification });
      notifications.kick();
    } catch (error) { next(error); }
  });

  app.post("/api/mechanic/appointments/:id/management/revoke", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid appointment ID.", code: "INVALID_APPOINTMENT_ID" });
      if (!management) return res.status(503).json({ error: "Online appointment management is unavailable." });
      await management.revoke(req.params.id);
      res.json({ revoked: true });
    } catch (error) { next(error); }
  });

  app.patch("/api/mechanic/appointments/:id", auth.requireAuth, auth.requireCsrf, async (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !["status", "decline"].includes(key))
      || (req.body.status !== "declined" && Object.hasOwn(req.body, "decline"))) {
      return res.status(400).json({ error: "Provide a review status and decline details only when declining." });
    }
    try {
      const appointment = await scheduling.reviewAppointment(req.params.id, req.body.status, { decline: req.body.decline });
      res.json({ id: appointment.id, status: appointment.status, ...(appointment.decline ? { decline: appointment.decline } : {}), emailNotification: notifications.enabled ? "queued" : "disabled" });
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

  // Never let an unknown API path fall through to the frontend HTML fallback.
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found.", code: "API_NOT_FOUND" }));
  if (frontendDirectory) serveBuiltFrontend(app, frontendDirectory);

  app.use((error, _req, res, _next) => {
    if (error instanceof SchedulingError) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) });
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) return res.status(400).json({ error: "Invalid JSON request." });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    // Driver and request errors may contain credentials, customer data or a
    // management bearer. Keep ordinary production logs fixed and redacted.
    logger.error("Appointment API request failed; the request can be retried.");
    return res.status(503).json({ error: "Unable to process the request right now. Please try again." });
  });
  return app;
}
