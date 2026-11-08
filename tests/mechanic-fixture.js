import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import process from "node:process";
import mongoose from "../server/node_modules/mongoose/index.js";
import { appointmentSchema } from "../server/Appointment.js";
import { schedulingStateSchema } from "../server/SchedulingState.js";
import { createApp } from "../server/app.js";
import { createMechanicAuth } from "../server/mechanicAuth.js";
import { createSchedulingService } from "../server/schedulingService.js";

export const PASSWORD = "isolated-scheduling-dashboard-password-095";
export const CUSTOMER = {
  name: "Private Dashboard Test Customer", email: "dashboard-test@example.invalid", phone: "555-555-0161",
  vehicle: "2020 Honda Civic", service: "Oil Change", date: "2030-01-09", time: "08:00", notes: "Synthetic test only: call before additional work.",
};

// Every test owns one database. Neither the application .env nor an SMTP
// transport is loaded. Even login/activity/logout traffic is intercepted, so
// no browser API request can reach Vite's normal shop backend proxy.
export const test = base.extend({
  shop: async ({ page }, provide) => {
    const dbName = `eds_dashboard_browser_test_${randomUUID().replaceAll("-", "")}`;
    const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", {
      dbName, serverSelectionTimeoutMS: 5000,
    });
    let server;
    let shuttingDown = false;
    const pendingRoutes = new Set();
    try {
      try { await connection.asPromise(); }
      catch (error) { throw new Error("Dashboard browser tests require local MongoDB or TEST_MONGODB_URI; the shop database is never used.", { cause: error }); }
      const Appointment = connection.model("Appointment", appointmentSchema.clone());
      const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
      await Promise.all([Appointment.init(), SchedulingState.init()]);
      const scheduling = createSchedulingService({ Appointment, SchedulingState, now: () => new Date("2030-01-07T12:00:00.000Z") });
      let sessionClock = Date.now();
      const auth = createMechanicAuth(PASSWORD, { now: () => sessionClock });
      const app = createApp({ Appointment, scheduling, auth, notifications: { enabled: false, kick() {} } });
      server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
        listener.once("error", reject);
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const calls = [];
      const faults = { settingsRead: false, csrf: false, failBlockRefresh: false };
      await page.route("**/api/**", async route => {
        const operation = (async () => {
        if (shuttingDown) return route.fulfill({ status: 503, json: { error: "Isolated test server is closing." } });
        const request = route.request();
        const url = new URL(request.url());
        calls.push({ method: request.method(), path: url.pathname, query: url.search, body: request.postDataJSON() });
        if (faults.settingsRead && request.method() === "GET" && url.pathname === "/api/mechanic/scheduling/settings") {
          return route.fulfill({ status: 503, json: { error: "Test schedule temporarily unavailable. Please retry." } });
        }
        const headers = request.headers();
        if (faults.csrf && request.method() === "PATCH" && url.pathname === "/api/mechanic/scheduling/settings") headers["x-mechanic-csrf"] = "deliberately-invalid-test-token";
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers });
        if (faults.failBlockRefresh && request.method() === "POST" && url.pathname === "/api/mechanic/scheduling/blocks" && response.ok()) faults.settingsRead = true;
        await route.fulfill({ response });
        })();
        pendingRoutes.add(operation);
        try { await operation; } finally { pendingRoutes.delete(operation); }
      });
      await provide({
        Appointment, SchedulingState, scheduling, calls, faults,
        advanceSession: milliseconds => { sessionClock += milliseconds; },
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
      // A block mutation is followed by a private settings read. Drain proxy
      // work before closing its server so teardown cannot reset that response.
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
            expect(connection.name).toMatch(/^eds_dashboard_browser_test_[a-f\d]{32}$/);
            await connection.dropDatabase();
          }
        } finally { await connection.close(); }
      }
    }
  },
});

export { expect };
