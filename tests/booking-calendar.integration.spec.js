import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import process from "node:process";
import mongoose from "../server/node_modules/mongoose/index.js";
import { appointmentSchema } from "../server/Appointment.js";
import { schedulingStateSchema } from "../server/SchedulingState.js";
import { createApp } from "../server/app.js";
import { createMechanicAuth } from "../server/mechanicAuth.js";
import { createSchedulingService } from "../server/schedulingService.js";
import { addMonths, formatBookingDate, formatBookingTime } from "../src/utils/bookingDates.js";

const PENDING_MESSAGE = "Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet.";
const PASSWORD = "isolated-browser-mechanic-password-994";

// This test deliberately uses real Express routes, authentication, scheduling,
// and standalone MongoDB, while owning an entirely separate random database.
// No application .env is loaded and no email transport is instantiated.
test("a calendar request persists pending, reaches the mechanic, and can be approved securely", async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  const dbName = `eds_calendar_browser_test_${randomUUID().replaceAll("-", "")}`;
  const connection = mongoose.createConnection(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017", {
    dbName, serverSelectionTimeoutMS: 5000,
  });
  let server;
  let shuttingDown = false;
  try {
    try {
      await connection.asPromise();
    } catch (error) {
      throw new Error("The calendar browser integration test requires local MongoDB or TEST_MONGODB_URI; it never uses the shop database.", { cause: error });
    }
    const Appointment = connection.model("Appointment", appointmentSchema.clone());
    const SchedulingState = connection.model("SchedulingState", schedulingStateSchema.clone());
    await Promise.all([Appointment.init(), SchedulingState.init()]);
    // Freeze only this isolated scheduler's clock at the actual test start, so a
    // notice boundary cannot move between choosing a slot and submitting it.
    const clock = new Date();
    const scheduling = createSchedulingService({ Appointment, SchedulingState, now: () => new Date(clock) });
    const initialSettings = await scheduling.getSettings();
    expect(initialSettings.settings).toMatchObject({
      automaticBookingEnabled: false, businessHoursVerified: false, capacityVerified: false,
    });
    const app = createApp({
      Appointment,
      scheduling,
      auth: createMechanicAuth(PASSWORD),
      notifications: { enabled: false, kick() {} },
    });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    const isolatedOrigin = `http://127.0.0.1:${server.address().port}`;
    const apiCalls = [];
    // Intercept every API path, including login, CSRF activity, and logout. None
    // of these browser requests may reach Vite's normal backend proxy.
    await page.route("**/api/**", async (route) => {
      if (shuttingDown) return route.fulfill({ status: 503, json: { error: "Isolated test server is closing." } });
      const request = route.request();
      const url = new URL(request.url());
      apiCalls.push({ method: request.method(), path: url.pathname });
      const response = await route.fetch({ url: `${isolatedOrigin}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });

    const service = "Oil Change";
    const firstCalendar = await scheduling.getCalendarAvailability(service);
    let calendar = firstCalendar;
    let date = calendar.days.find((day) => day.available)?.date;
    while (!date && calendar.month < calendar.lastDate.slice(0, 7)) {
      calendar = await scheduling.getCalendarAvailability(service, addMonths(calendar.month, 1));
      date = calendar.days.find((day) => day.available)?.date;
    }
    expect(date, "untouched placeholder settings should offer a real slot within their horizon").toBeTruthy();
    const availability = await scheduling.getAvailability(service, date);
    const time = availability.slots[0].time;
    const customer = {
      name: `Isolated ${testInfo.project.name} Calendar Customer`,
      email: `calendar-${testInfo.project.name}@example.invalid`,
      phone: "555-555-0158",
      vehicle: "2018 Honda Civic",
      notes: "Browser integration test: call before additional work.",
    };

    await page.goto(`/appointment?${new URLSearchParams({ service })}`);
    await expect(page.locator('select[name="service"]')).toHaveValue(service);
    for (let month = firstCalendar.month; month < calendar.month; month = addMonths(month, 1)) {
      await page.getByRole("button", { name: "Next month", exact: true }).click();
    }
    const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(date).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(day).toHaveAttribute("aria-disabled", "false");
    await day.click();
    const timeChoice = page.getByRole("radio", { name: formatBookingTime(time), exact: true });
    await page.locator(".booking-time-option").filter({ has: timeChoice }).click();
    await expect(timeChoice).toBeChecked();
    await page.getByRole("button", { name: /continue to your details/i }).click();
    for (const [name, value] of Object.entries(customer)) await page.locator(`[name="${name}"]`).fill(value);
    await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
    await expect(page.getByRole("region", { name: "Review your appointment request." })).toBeVisible();
    expect(await Appointment.countDocuments(), "review must not submit an appointment").toBe(0);
    const postResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/appointments" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    const response = await postResponse;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({ status: "pending", emailNotification: "disabled" });
    expect(saved.id).toMatch(/^[a-f\d]{24}$/);
    await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.getByText(saved.id, { exact: true })).toBeVisible();
    const stored = await Appointment.findById(saved.id).lean();
    expect(stored).toMatchObject({ ...customer, service, date, time, status: "pending" });
    expect(stored.scheduling.holdExpiresAt).toBeInstanceOf(Date);
    expect(await Appointment.countDocuments()).toBe(1);

    await page.getByRole("link", { name: "Staff Login", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: customer.name, exact: true }) });
    await expect(card).toBeVisible();
    for (const detail of [service, customer.vehicle, customer.email, customer.phone, customer.notes, `${formatBookingDate(date)} at ${formatBookingTime(time)}`]) {
      await expect(card).toContainText(detail);
    }
    await expect(card.locator(".mechanic-status")).toHaveText("pending");
    const approvalResponse = page.waitForResponse((result) => new URL(result.url()).pathname === `/api/mechanic/appointments/${saved.id}` && result.request().method() === "PATCH");
    await card.getByRole("button", { name: "Confirm", exact: true }).click();
    expect((await approvalResponse).status()).toBe(200);
    await expect.poll(async () => (await Appointment.findById(saved.id).lean()).status).toBe("confirmed");
    const confirmed = await Appointment.findById(saved.id).lean();
    expect(confirmed.scheduling.confirmationSource).toBe("manual");
    expect(confirmed.notificationState.decisionCustomer).toBe("pending");
    await page.getByLabel("Show appointments", { exact: true }).selectOption("confirmed");
    await expect(card.locator(".mechanic-status")).toHaveText("confirmed");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    const privateRead = await page.evaluate(async () => {
      const result = await fetch("/api/mechanic/appointments?status=all", { credentials: "same-origin" });
      return { status: result.status, body: await result.json() };
    });
    expect(privateRead).toEqual({ status: 401, body: { error: "Mechanic sign-in required." } });
    expect(await scheduling.getSettings()).toEqual(initialSettings);
    expect(apiCalls.filter((call) => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(1);
    expect(apiCalls.some((call) => call.path.includes("/scheduling/") && call.method !== "GET")).toBe(false);
  } finally {
    // Leave the existing route installed so late timers still cannot reach the
    // normal backend. Cleanup must also work after Playwright closes the page.
    shuttingDown = true;
    try {
      if (server) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally {
      try {
        if (connection.readyState === 1) {
          expect(connection.name).toBe(dbName);
          expect(connection.name).toMatch(/^eds_calendar_browser_test_[a-f\d]{32}$/);
          await connection.dropDatabase();
        }
      } finally {
        await connection.close();
      }
    }
  }
});
