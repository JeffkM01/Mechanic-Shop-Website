import express from "express";
import { prepareAppointment } from "./appointmentInput.js";
import { SchedulingError } from "./schedulingRules.js";
import { createCustomerRoutes } from "./customerRoutes.js";
import { serveBuiltFrontend } from "./staticFrontend.js";
import { createOperationTracker } from "./operationTracker.js";
import { EmailConnectionTestError } from "./emailConnectionTest.js";
import { APPOINTMENT_EMAIL_TEST_FIELD, OWNED_EMAIL_TEST_RECIPIENT } from "./appointmentEmailScope.js";

export function createApp({ Appointment, scheduling, auth, notifications, management = null, emailTest = null, appointmentEmailTest = null, databaseReady = () => Appointment.db.readyState === 1,
  runtimeReady = () => true, frontendDirectory = null, trustProxy = false, logger = console,
  operationTracker = createOperationTracker(), requestGate = null, bookingRateLimiter = null }) {
  const app = express();
  const track = operationTracker.wrap;
  const ready = () => runtimeReady() && operationTracker.isAccepting();
  const emailEnabledFor = appointment => notifications.enabled
    && (typeof notifications.isEnabledFor !== "function" || notifications.isEnabledFor(appointment));
  const workflowEnabled = appointmentEmailTest?.enabled === true && notifications.enabled && management?.enabled === true;
  // Explicit projection keeps private notificationEnv, run identity and keys
  // out of both public/staff status routes even if a caller passes more data.
  const workflowStatus = () => workflowEnabled ? { enabled: true, recipient: OWNED_EMAIL_TEST_RECIPIENT } : { enabled: false };
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  if (requestGate) app.use(requestGate);
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
  if (bookingRateLimiter) app.post("/api/appointments", bookingRateLimiter);
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    const connected = databaseReady();
    const accepting = ready();
    res.status(connected && accepting ? 200 : 503).json({ database: connected ? "connected" : "disconnected", ...(!accepting ? { status: "draining" } : {}) });
  });

  app.get("/api/health/live", (_req, res) => res.status(ready() ? 200 : 503).json({ status: ready() ? "ok" : "draining" }));
  app.use("/api", (_req, res, next) => {
    if (!ready()) return res.status(503).json({ error: "The service is restarting. Please try again shortly.", code: "SERVICE_DRAINING" });
    next();
  });

  app.get("/api/services", track(async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await scheduling.getPublicServices()); }
    catch (error) { next(error); }
  }));

  app.get("/api/appointment-email-test", (_req, res) => res.json(workflowStatus()));

  app.get("/api/shop-hours", track(async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await scheduling.getPublicShopHours()); }
    catch (error) { next(error); }
  }));

  app.get("/api/availability", track(async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.service !== "string" || typeof req.query.date !== "string") return res.status(400).json({ error: "Provide one service and date (YYYY-MM-DD)." });
    try { res.json(await scheduling.getAvailability(req.query.service, req.query.date)); }
    catch (error) { next(error); }
  }));

  app.get("/api/availability/calendar", track(async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.service !== "string" || (req.query.month !== undefined && typeof req.query.month !== "string")) {
      return res.status(400).json({ error: "Provide one service and an optional month (YYYY-MM)." });
    }
    try { res.json(await scheduling.getCalendarAvailability(req.query.service, req.query.month)); }
    catch (error) { next(error); }
  }));

  app.post("/api/appointments", track(async (req, res, next) => {
    // Date/time syntax is checked here; the shop's persisted timezone, hours,
    // notice and capacity rules are applied atomically by scheduling below.
    const { error, fields, value } = prepareAppointment(req.body, new Date(), { schedulingAuthoritative: true, deferServiceValidation: true,
      mobileBookingPolicy: scheduling.getMobileBookingPolicy?.() });
    if (error) return res.status(400).json({ error, ...(fields ? { fields } : {}) });
    try {
      const appointment = await scheduling.createAppointment(value);
      res.status(201).json({
        id: appointment.id,
        status: appointment.status,
        emailNotification: emailEnabledFor(appointment) ? "queued" : "disabled",
        managementAccess: Boolean(management?.enabled && emailEnabledFor(appointment)),
        holdExpiresAt: appointment.status === "pending" ? appointment.scheduling?.holdExpiresAt : undefined,
        message: appointment.status === "confirmed" ? "Your appointment has been confirmed." : "Request saved for mechanic review. The provisional hold expires if it is not reviewed in time; approval is still required.",
      });
      notifications.kick();
    } catch (error) { next(error); }
  }));

  // Customer credentials are scoped to one appointment. These routes never use
  // a reference ID as authorization or return the staff appointment payload.
  if (management) app.use("/api/customer/appointments", createCustomerRoutes({ management, scheduling, notifications, track }));
  else app.use("/api/customer/appointments", (_req, res) => res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).status(503).json({ error: "Online appointment management is unavailable. Please contact the shop." }));

  app.use("/api/mechanic", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.post("/api/mechanic/login", track(auth.login));
  app.get("/api/mechanic/session", auth.requireAuth, auth.session);
  app.post("/api/mechanic/activity", auth.requireAuth, auth.requireCsrf, auth.activity);
  app.post("/api/mechanic/logout", auth.requireAuth, auth.requireCsrf, auth.logout);
  app.get("/api/mechanic/appointment-email-test", auth.requireAuth, (_req, res) => res.json(workflowStatus()));

  app.get("/api/mechanic/email-test", auth.requireAuth, (_req, res) => res.json(emailTest?.status() ?? { enabled: false }));
  app.post("/api/mechanic/email-test", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    // Only an empty diagnostic request is accepted. Recipients, message text,
    // queue IDs and links are never caller-controlled, including via query.
    if (Object.keys(req.query).length || (req.body !== undefined && (!req.body || typeof req.body !== "object"
      || Array.isArray(req.body) || Object.keys(req.body).length))) {
      return res.status(400).json({ error: "Send an empty request for the fixed email connection test.", code: "INVALID_EMAIL_TEST_REQUEST" });
    }
    try {
      if (!emailTest) throw new EmailConnectionTestError(503, "EMAIL_TEST_DISABLED", "The email connection test is not enabled in this environment.");
      res.json(await emailTest.send());
    } catch (error) { next(error); }
  }));

  app.get("/api/mechanic/appointments", auth.requireAuth, track(async (req, res, next) => {
    const status = req.query.status || "pending";
    if (!["all", "pending", "confirmed", "declined", "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid status filter." });
    try {
      const appointments = await Appointment.find(status === "all" ? {} : status === "pending" ? { status: { $in: ["pending", null] } } : { status })
        .select(`name email phone vehicle service date time notes status decline cancellation createdAt updatedAt scheduling +mobileVisit +${APPOINTMENT_EMAIL_TEST_FIELD}`)
        .sort({ createdAt: -1 }).limit(100).lean();
      res.json({ appointments: appointments.map(appointment => {
        const payload = { ...appointment, status: appointment.status || "pending", cancellationEligibility: scheduling.getCancellationEligibility?.(appointment) || { canCancel: false } };
        delete payload[APPOINTMENT_EMAIL_TEST_FIELD];
        if (appointment.mobileVisit) {
          const { city, state, postalCode, travelBufferMinutes, locationConfirmed, travelConfirmed, reviewedAt } = appointment.mobileVisit;
          payload.mobileVisit = { city, state, postalCode, travelBufferMinutes,
            ...(reviewedAt ? { locationConfirmed, travelConfirmed, reviewedAt } : {}) };
        }
        if (workflowEnabled) payload.emailTestEligible = Boolean(emailEnabledFor(appointment));
        return payload;
      }) });
    } catch (error) { next(error); }
  }));

  app.post("/api/mechanic/appointments/:id/cancel", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    try {
      const appointment = await scheduling.cancelAppointment(req.params.id, "mechanic", req.body);
      const emailNotification = !emailEnabledFor(appointment) ? "disabled" : appointment.notificationState?.cancellationCustomer === "sent" ? "sent" : appointment.notificationState?.cancellationCustomer === "pending" ? "queued" : appointment.notificationState?.cancellationCustomer === "failed" ? "failed" : "not-applicable";
      res.json({ id: appointment.id, status: appointment.status, cancellation: appointment.cancellation, emailNotification });
      notifications.kick();
    } catch (error) { next(error); }
  }));

  app.post("/api/mechanic/appointments/:id/management/revoke", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid appointment ID.", code: "INVALID_APPOINTMENT_ID" });
      if (!management) return res.status(503).json({ error: "Online appointment management is unavailable." });
      await management.revoke(req.params.id);
      res.json({ revoked: true });
    } catch (error) { next(error); }
  }));

  app.patch("/api/mechanic/appointments/:id", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !["status", "decline", "mobileReview"].includes(key))
      || (req.body.status !== "declined" && Object.hasOwn(req.body, "decline"))
      || (req.body.status !== "confirmed" && Object.hasOwn(req.body, "mobileReview"))) {
      return res.status(400).json({ error: "Provide a review status, decline details only when declining, and mobile review only when confirming." });
    }
    try {
      const appointment = await scheduling.reviewAppointment(req.params.id, req.body.status, { decline: req.body.decline, mobileReview: req.body.mobileReview });
      res.json({ id: appointment.id, status: appointment.status, ...(appointment.decline ? { decline: appointment.decline } : {}), emailNotification: emailEnabledFor(appointment) ? "queued" : "disabled" });
      notifications.kick();
    } catch (error) { next(error); }
  }));

  app.get("/api/mechanic/scheduling/settings", auth.requireAuth, track(async (_req, res, next) => {
    try { res.json(await scheduling.getSettings()); } catch (error) { next(error); }
  }));

  app.patch("/api/mechanic/scheduling/settings", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    if (!req.body || Object.keys(req.body).some(key => !["revision", "settings"].includes(key)) || !Number.isInteger(req.body.revision) || req.body.revision < 0 || !req.body.settings) return res.status(400).json({ error: "Provide the current revision and a settings patch." });
    try { res.json(await scheduling.updateSettings(req.body.settings, { expectedRevision: req.body.revision })); } catch (error) { next(error); }
  }));

  app.post("/api/mechanic/scheduling/blocks", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    try { res.status(201).json(await scheduling.addBlockedPeriod(req.body)); } catch (error) { next(error); }
  }));

  app.delete("/api/mechanic/scheduling/blocks/:id", auth.requireAuth, auth.requireCsrf, track(async (req, res, next) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "revision"))) return res.status(400).json({ error: "Provide only an optional settings revision." });
    try { res.json(await scheduling.removeBlockedPeriod(req.params.id, { expectedRevision: req.body?.revision })); } catch (error) { next(error); }
  }));

  // Never let an unknown API path fall through to the frontend HTML fallback.
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found.", code: "API_NOT_FOUND" }));
  if (frontendDirectory) serveBuiltFrontend(app, frontendDirectory, { privateResponses: Boolean(requestGate) });

  app.use((error, _req, res, _next) => {
    if (error instanceof EmailConnectionTestError) {
      if (error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds));
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
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
