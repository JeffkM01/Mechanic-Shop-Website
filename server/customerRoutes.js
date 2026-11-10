import { Router } from "express";
import { ManagementError } from "./customerManagement.js";
import { SchedulingError } from "./schedulingRules.js";

const plainBody = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Build a deliberately small allowlist. An authorized customer never receives
// staff contact details, notes, reservation internals, or credential metadata.
export function customerAppointmentPayload(context, scheduling, notifications) {
  const saved = context.appointment;
  const eligibility = scheduling.getCancellationEligibility(saved);
  const cancellation = saved.cancellation;
  const appointment = {
    id: String(saved._id ?? saved.id), service: saved.service, vehicle: saved.vehicle,
    date: saved.date, time: saved.time, status: saved.status || "pending",
    ...(Number.isFinite(saved.scheduling?.durationMinutes) && saved.scheduling.durationMinutes > 0 ? { durationMinutes: saved.scheduling.durationMinutes } : {}),
    timezone: cancellation?.timezone || saved.scheduling?.timezone || eligibility.timezone || "America/Chicago",
    canCancel: eligibility.canCancel,
    eligibilityMessage: eligibility.message,
    ...(saved.status === "declined" && saved.decline?.explanation ? { decline: { explanation: saved.decline.explanation } } : {}),
    ...(saved.status === "cancelled" && cancellation ? { cancellation: {
      by: cancellation.by, category: cancellation.category,
      ...(cancellation.message ? { message: cancellation.message } : {}),
      ...(cancellation.explanation ? { explanation: cancellation.explanation } : {}),
      cancelledAt: cancellation.cancelledAt, originalDate: cancellation.originalDate,
      originalTime: cancellation.originalTime, timezone: cancellation.timezone,
    } } : {}),
  };
  const notificationStatus = flag => !notifications.enabled ? "disabled" : flag === "pending" ? "queued" : flag || "not-applicable";
  return {
    appointment, csrfToken: context.csrfToken, sessionExpiresAt: context.sessionExpiresAt,
    ...(saved.status === "cancelled" ? { notifications: {
      customer: notificationStatus(saved.notificationState?.cancellationCustomer),
      mechanic: notificationStatus(saved.notificationState?.cancellationMechanic),
    } } : {}),
  };
}

export function createCustomerRoutes({ management, scheduling, notifications }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    next();
  });

  router.post("/:id/exchange", async (req, res, next) => {
    try {
      management.requireOrigin(req);
      management.limitExchange(req);
      if (!plainBody(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.token !== "string") {
        return res.status(400).json({ error: "Provide one appointment-management credential.", code: "INVALID_MANAGEMENT_REQUEST" });
      }
      const context = await management.exchange(req.params.id, req.body.token);
      management.setCookie(res, context);
      res.json(customerAppointmentPayload(context, scheduling, notifications));
    } catch (error) { next(error); }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const context = await management.authorize(req, req.params.id);
      res.json(customerAppointmentPayload(context, scheduling, notifications));
    } catch (error) { next(error); }
  });

  router.post("/:id/cancel", async (req, res, next) => {
    try {
      management.requireOrigin(req);
      const context = await management.authorize(req, req.params.id);
      management.requireCsrf(req, context);
      // Authentication is complete before any validation can reveal record
      // state. The service conditionally saves status, history, and queue intent.
      context.appointment = await scheduling.cancelAppointment(context.id, "customer", req.body === undefined ? {} : req.body);
      res.json(customerAppointmentPayload(context, scheduling, notifications));
      notifications.kick();
    } catch (error) { next(error); }
  });

  router.post("/:id/logout", async (req, res, next) => {
    try {
      management.requireOrigin(req);
      const context = await management.authorize(req, req.params.id);
      management.requireCsrf(req, context);
      if (req.body !== undefined && (!plainBody(req.body) || Object.keys(req.body).length !== 0)) {
        return res.status(400).json({ error: "Provide no appointment details when closing access.", code: "INVALID_MANAGEMENT_REQUEST" });
      }
      await management.logout(context);
      management.clearCookie(res, context.id);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.use((_req, res) => res.status(404).json({ error: "Appointment management route unavailable.", code: "MANAGEMENT_UNAVAILABLE" }));
  router.use((error, _req, res, _next) => {
    if (error instanceof ManagementError || error instanceof SchedulingError) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(error.status).json({ error: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) });
    }
    // Never log request bodies, cookies, grants, or raw database/transport errors.
    return res.status(503).json({ error: "Unable to verify or update this appointment right now. Please refresh its status or contact the shop.", code: "MANAGEMENT_UNAVAILABLE" });
  });
  return router;
}
