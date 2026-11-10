import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import mongoose from "../server/node_modules/mongoose/index.js";
import { appointmentSchema } from "../server/Appointment.js";
import { schedulingStateSchema } from "../server/SchedulingState.js";
import { createApp } from "../server/app.js";
import { createMechanicAuth } from "../server/mechanicAuth.js";
import { createSchedulingService } from "../server/schedulingService.js";
import { createCustomerManagement } from "../server/customerManagement.js";

export const PASSWORD = "isolated-cancellation-browser-password-423";
export const CUSTOMER = {
  name: "Private Cancellation Test Customer", email: "cancellation@example.invalid", phone: "555-555-0167",
  vehicle: "2021 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00",
  notes: "Synthetic cancellation test; never send an email.",
};

// Every case owns a random database and a real Express server. No application
// .env or mail transport is loaded. SMTP-shaped values enable synthetic link
// issuance only; notifications are a stub and cannot deliver mail.
export const test = base.extend({
  shop: async ({ context, page }, provide) => {
    const dbName = `eds_cancellation_browser_test_${randomUUID().replaceAll("-", "")}`;
    const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", {
      dbName, serverSelectionTimeoutMS: 5000,
    });
    let server;
    let shuttingDown = false;
    const pendingRoutes = new Set();
    try {
      try { await connection.asPromise(); }
      catch (error) { throw new Error("Cancellation browser tests require local MongoDB or TEST_MONGODB_URI; the shop database is never used.", { cause: error }); }
      const Appointment = connection.model("Appointment", appointmentSchema.clone());
      const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
      await Promise.all([Appointment.init(), SchedulingState.init()]);
      let clock = +new Date("2030-01-07T12:00:00.000Z");
      let sessionClock = Date.now();
      const management = createCustomerManagement({ Appointment, now: () => new Date(clock), env: {
        NODE_ENV: "test", PUBLIC_WEBSITE_ORIGIN: "http://127.0.0.1:5174",
        APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 94).toString("base64"),
        SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic@example.invalid",
        SMTP_PASS: "isolated-test-not-a-live-secret", MAIL_FROM: "shop@example.invalid", MECHANIC_NOTIFICATION_EMAIL: "mechanic@example.invalid",
      } });
      const scheduling = createSchedulingService({ Appointment, SchedulingState, management, now: () => new Date(clock) });
      const auth = createMechanicAuth(PASSWORD, { now: () => sessionClock });
      const app = createApp({ Appointment, scheduling, management, auth, notifications: { enabled: false, kick() {} } });
      server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
        listener.once("error", reject);
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const calls = [];
      const faults = { loseCancellationResponse: false, mechanicCsrf: false };
      async function routeIsolated(target) {
        await target.route("**/api/**", async route => {
          const operation = (async () => {
            if (shuttingDown) return route.fulfill({ status: 503, json: { error: "Isolated test server is closing." } });
            const request = route.request();
            const url = new URL(request.url());
            // The bearer credential must never appear in recorded test calls.
            const body = request.postDataJSON();
            calls.push({ method: request.method(), path: url.pathname, body: body?.token ? { token: "[redacted]" } : body });
            const headers = request.headers();
            if (faults.mechanicCsrf && request.method() === "POST" && /^\/api\/mechanic\/appointments\/[^/]+\/cancel$/.test(url.pathname)) headers["x-mechanic-csrf"] = "deliberately-invalid-test-token";
            const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers });
            if (faults.loseCancellationResponse && request.method() === "POST" && /^\/api\/customer\/appointments\/[^/]+\/cancel$/.test(url.pathname) && response.ok()) {
              faults.loseCancellationResponse = false;
              return route.abort("failed");
            }
            await route.fulfill({ response });
          })();
          pendingRoutes.add(operation);
          try { await operation; } finally { pendingRoutes.delete(operation); }
        });
      }
      await routeIsolated(context);
      await provide({
        Appointment, SchedulingState, scheduling, management, calls, faults, origin, routeIsolated,
        advanceClock: milliseconds => { clock += milliseconds; },
        advanceSession: milliseconds => { sessionClock += milliseconds; },
        async createAppointment(overrides = {}) { return scheduling.createAppointment({ ...CUSTOMER, ...overrides }); },
        async linkFor(id) {
          const appointment = await Appointment.findById(id).select("+management").lean();
          const link = await management.emailLink(appointment);
          expect(typeof link, "synthetic management configuration should issue an email link").toBe("string");
          return link;
        },
        async login() {
          await page.goto("/mechanic");
          await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
          await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        },
      });
    } finally {
      shuttingDown = true;
      await Promise.allSettled([...pendingRoutes]);
      try {
        if (server) await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } finally {
        try {
          if (connection.readyState === 1) {
            expect(connection.name).toBe(dbName);
            expect(connection.name).toMatch(/^eds_cancellation_browser_test_[a-f\d]{32}$/);
            await connection.dropDatabase();
          }
        } finally { await connection.close(); }
      }
    }
  },
});

export { expect };
