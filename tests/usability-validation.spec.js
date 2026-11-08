import { chromium } from "@playwright/test";
import axe from "axe-core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import process from "node:process";
import { test, expect, CUSTOMER, PASSWORD } from "./mechanic-fixture.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

const VALID_DETAILS = { name: "Usability Test Customer", email: "usability@example.invalid", phone: "+1 636-555-1234", vehicle: "2018 Honda Civic", notes: "Please call before performing additional work." };
const PENDING = "Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet.";
const widthsByProject = { desktop: [1280, 1440, 1920], tablet: [768], mobile: [320, 390] };
const publicRoutes = ["/", "/about", "/services", "/contact"];
const settingsSections = ["Business Hours", "Closures & Blocked Times", "Booking Settings"];

test.use({ locale: "en-GB", timezoneId: "Pacific/Kiritimati" });
test.setTimeout(60_000);

async function openBooking(page) {
  await page.goto("/appointment?service=Oil+Change");
  await expect(page.getByRole("grid")).toBeVisible();
}
async function chooseSlot(page) {
  const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(CUSTOMER.date)) });
  await expect(day).toHaveAttribute("aria-disabled", "false");
  await day.click();
  const time = page.getByRole("radio", { name: "8:00 AM", exact: true });
  await time.locator("..").click();
  await expect(time).toBeChecked();
}
async function fillDetails(page, details = VALID_DETAILS) {
  for (const [name, value] of Object.entries(details)) await page.locator(`[name="${name}"]`).fill(value);
}
async function reviewRequest(page) {
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toBeVisible();
}
async function showSection(page, name) {
  await page.getByRole("navigation", { name: "Staff dashboard sections" }).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  if (name === "Business Hours") await expect(page.getByLabel("Monday open", { exact: true })).toBeVisible();
  if (name === "Closures & Blocked Times") await expect(page.getByRole("heading", { name: "Closed dates", exact: true })).toBeVisible();
  if (name === "Booking Settings") await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toBeVisible();
}
async function signInIfNeeded(page) {
  const login = page.getByRole("heading", { name: "Staff sign in", exact: true });
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(login.or(signOut)).toBeVisible();
  if (await login.isVisible()) {
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(signOut).toBeVisible();
  }
}
async function noOverflow(page) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  expect(metrics.scroll, `horizontal overflow: ${JSON.stringify(metrics)} at ${page.url()}`).toBeLessThanOrEqual(metrics.client + 1);
}
async function audit(page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
    const result = await globalThis.axe.run(document.querySelector("main"), { runOnly: { type: "tag", values: tags } });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
}
async function fontAtLeast(locator, minimum) {
  for (const element of await locator.all()) {
    if (!await element.isVisible()) continue;
    const size = await element.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(size, `${await element.innerText().catch(() => "input")} font`).toBeGreaterThanOrEqual(minimum);
  }
}
async function checkBookingFonts(page) {
  await fontAtLeast(page.locator(".booking-field"), 15);
  await fontAtLeast(page.locator(".booking-field input,.booking-field select,.booking-field textarea"), 16);
  await fontAtLeast(page.locator(".booking-page button:not(.booking-calendar-day)"), 16);
  await fontAtLeast(page.locator(".booking-notice,.booking-error-summary p,.booking-field-error"), 16);
  const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(CUSTOMER.date)) });
  if (await day.count()) {
    const box = await day.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}
async function screenshot(page, testInfo, name) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}
async function nativeZoomScreenshot(page, testInfo, name, top = true) {
  if (top) await page.evaluate(() => scrollTo(0, 0));
  const session = await page.context().newCDPSession(page);
  try {
    // Playwright's CSS full-page clip can crop a native page-zoom capture.
    // CDP without a clip captures the actual physical browser viewport.
    const { data } = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(data, "base64");
    expect(png.readUInt32BE(16)).toBe(1280);
    await writeFile(testInfo.outputPath(`${name}.png`), png);
  } finally { await session.detach(); }
}

// These cases use the real isolated Express/MongoDB fixture and never the shop
// backend. No application .env or mail transport is loaded.
test("identifies an invalid phone on blur and clears only the corrected error", async ({ page, shop }) => {
  await openBooking(page);
  await chooseSlot(page);
  await fillDetails(page, { ...VALID_DETAILS, phone: "636-55A-1234" });
  const phone = page.getByRole("textbox", { name: "Phone number", exact: true });
  await phone.focus();
  await phone.press("Tab");
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await expect(phone).toHaveAttribute("aria-describedby", /booking-phone-error/);
  await expect(page.locator("#booking-phone-error")).toContainText(/letters are not allowed/i);
  await expect(page.getByRole("region", { name: "Please correct the highlighted fields.", exact: true })).toHaveCount(0);
  expect(await shop.Appointment.countDocuments()).toBe(0);
  await phone.fill("(636) 555-1234");
  await expect(phone).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#booking-phone-error")).toHaveCount(0);
  for (const [name, value] of Object.entries(VALID_DETAILS).filter(([name]) => name !== "phone")) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  expect(shop.calls.filter(call => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(0);
});

test("shows all invalid fields, focuses the first, and retains entries until valid explicit send", async ({ page, shop }) => {
  await page.goto("/appointment");
  await fillDetails(page, { name: "", email: "not-an-email", phone: "636ABC5551234", vehicle: "", notes: VALID_DETAILS.notes });
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Please correct the highlighted fields.", exact: true })).toBeVisible();
  for (const field of ["service", "date", "time", "name", "email", "phone", "vehicle"]) await expect(page.locator(`#booking-${field}-error`)).toBeVisible();
  await expect(page.locator('[name="service"]')).toBeFocused();
  await expect(page.locator('[name="notes"]')).toHaveValue(VALID_DETAILS.notes);
  expect(await shop.Appointment.countDocuments()).toBe(0);
  expect(shop.calls.filter(call => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(0);
  await page.locator('[name="service"]').selectOption("Oil Change");
  await chooseSlot(page);
  await fillDetails(page);
  await reviewRequest(page);
  expect(await shop.Appointment.countDocuments()).toBe(0);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByText(PENDING, { exact: true })).toBeVisible();
  expect(await shop.Appointment.countDocuments()).toBe(1);
  expect((await shop.Appointment.findOne().lean()).phone).toBe(VALID_DETAILS.phone);
});

test("associates backend field errors with the input instead of a vague failure", async ({ page, shop }) => {
  await page.route("**/api/appointments", route => route.fulfill({ status: 400, json: { error: "Please confirm your phone number.", fields: { phone: "Please confirm this phone number before sending." } } }));
  await openBooking(page); await chooseSlot(page); await fillDetails(page); await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.locator("#booking-phone-error")).toHaveText("Please confirm this phone number before sending.");
  await expect(page.locator('[name="phone"]')).toBeFocused();
  await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toHaveCount(0);
  for (const [name, value] of Object.entries(VALID_DETAILS)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  expect(await shop.Appointment.countDocuments()).toBe(0);
});

test("rejects email display names and recipient lists before review or booking POST", async ({ page, shop }) => {
  await openBooking(page); await chooseSlot(page); await fillDetails(page);
  const email = page.locator('[name="email"]');
  for (const value of ["Name <person@example.com>", "first,last@example.com", "person@example.com,second@example.com"]) {
    await email.fill(value); await email.press("Tab");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#booking-email-error")).toContainText(/valid email/i);
    await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
    await expect(email).toBeFocused();
    await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toHaveCount(0);
    await expect(page.locator('[name="vehicle"]')).toHaveValue(VALID_DETAILS.vehicle);
  }
  expect(shop.calls.filter(call => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(0);
  expect(await shop.Appointment.countDocuments()).toBe(0);
  await email.fill(VALID_DETAILS.email);
  await expect(page.locator("#booking-email-error")).toHaveCount(0);
  await reviewRequest(page);
});

test("encodes valid customer mail links and leaves invalid historical recipients unlinked", async ({ page, shop }) => {
  const unusual = "customer?bcc=another@example.com";
  await shop.Appointment.create({ ...CUSTOMER, name: "Valid unusual address", email: unusual, status: "pending" });
  await shop.Appointment.create({ ...CUSTOMER, name: "Historical invalid address", email: "first@example.com,second@example.com", phone: "636ABC5551234", status: "pending" });
  await shop.login();
  const safe = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Valid unusual address", exact: true }) });
  const mail = safe.getByRole("link", { name: unusual, exact: true });
  await expect(mail).toBeVisible();
  const href = await mail.getAttribute("href");
  const parsed = new URL(href);
  expect(parsed.protocol).toBe("mailto:"); expect(parsed.search).toBe("");
  expect(decodeURIComponent(parsed.pathname)).toBe(unusual);
  await expect(safe.getByRole("link", { name: CUSTOMER.phone, exact: true })).toHaveAttribute("href", "tel:+15555550161");
  const legacy = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Historical invalid address", exact: true }) });
  await expect(legacy).toContainText("first@example.com,second@example.com");
  await expect(legacy).toContainText(/verify this address/i);
  await expect(legacy.locator('a[href^="mailto:"]')).toHaveCount(0);
  await expect(legacy.locator('a[href^="tel:"]')).toHaveCount(0);
});

test("does not duplicate a booking when its successful POST response is lost", async ({ page, shop }) => {
  let posts = 0;
  await page.route("**/api/appointments", async route => {
    posts++;
    const result = await route.fetch({ url: `${shop.origin}/api/appointments` });
    expect(result.status()).toBe(201);
    await route.abort("failed");
  });
  await openBooking(page); await chooseSlot(page); await fillDetails(page); await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByRole("heading", { name: "We could not verify whether your request was saved.", exact: true })).toBeVisible();
  expect(await shop.Appointment.countDocuments()).toBe(1);
  expect(posts).toBe(1);
  for (const [name, value] of Object.entries(VALID_DETAILS)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  await expect(page.getByRole("link", { name: "Contact the shop", exact: true })).toHaveAttribute("href", "/contact");
  const readsBefore = shop.calls.filter(call => call.path.startsWith("/api/availability")).length;
  await page.getByRole("button", { name: "Retry availability", exact: true }).click();
  await expect.poll(() => shop.calls.filter(call => call.path.startsWith("/api/availability")).length).toBeGreaterThan(readsBefore);
  expect(posts).toBe(1);
  expect(await shop.Appointment.countDocuments()).toBe(1);
  await expect(page.getByRole("button", { name: "Send Appointment Request", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review Appointment Request", exact: true })).toBeDisabled();
});

test("requires a reviewed decline reason and restores focus when the mechanic cancels", async ({ page, shop }) => {
  const appointment = await shop.scheduling.createAppointment(CUSTOMER);
  await shop.login();
  const decline = page.getByRole("button", { name: "Decline Appointment", exact: true });
  await decline.click();
  const dialog = page.getByRole("dialog", { name: "Review appointment decline", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Reason category", { exact: true }).locator("option")).not.toContainText(["Requested time is unavailable"]);
  await dialog.getByLabel("Reason category", { exact: true }).selectOption("other");
  await dialog.getByRole("button", { name: "Confirm Decline", exact: true }).click();
  await expect(dialog.getByLabel("Additional explanation", { exact: true })).toBeFocused();
  await expect(dialog.locator("#decline-explanation-error")).toContainText(/explanation|reason/i);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  expect(shop.calls.filter(call => call.method === "PATCH" && call.path.endsWith(appointment.id))).toHaveLength(0);
  await dialog.getByLabel("Additional explanation", { exact: true }).fill("We cannot perform the required specialist work at this shop.");
  await expect(dialog.getByRole("region", { name: "Customer message preview", exact: true })).toContainText("specialist work");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(decline).toBeFocused();
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  await decline.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(decline).toBeFocused();
});

test("persists the specific customer-facing decline and releases only its reservation", async ({ page, shop }) => {
  const appointment = await shop.scheduling.createAppointment(CUSTOMER);
  const other = await shop.scheduling.createAppointment({ ...CUSTOMER, name: "Another reserved customer", time: "10:00" });
  await shop.login();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await card.getByRole("button", { name: "Decline Appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review appointment decline", exact: true });
  await dialog.getByLabel("Reason category", { exact: true }).selectOption("parts_unavailable");
  await dialog.getByLabel("Additional explanation", { exact: true }).fill("The required replacement part is no longer available for this vehicle.");
  const preview = await dialog.getByRole("region", { name: "Customer message preview", exact: true }).innerText();
  await audit(page);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  const declineResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/mechanic/appointments/${appointment.id}` && response.request().method() === "PATCH");
  await dialog.getByRole("button", { name: "Confirm Decline", exact: true }).click();
  expect((await declineResponse).status()).toBe(200);
  await expect.poll(async () => (await shop.Appointment.findById(appointment.id).lean()).status).toBe("declined");
  const stored = await shop.Appointment.findById(appointment.id).lean();
  expect(stored.decline).toMatchObject({ category: "parts_unavailable", source: "mechanic" });
  expect(stored.decline.explanation).toContain("no longer available");
  expect(preview).toContain(stored.decline.explanation);
  expect(stored.decline.declinedAt).toBeInstanceOf(Date);
  expect(stored.notificationState.decisionCustomer).toBe("pending");
  const state = await shop.SchedulingState.findById("shop").lean();
  expect(state.reservations.map(item => String(item.appointmentId))).not.toContain(appointment.id);
  expect(state.reservations.map(item => String(item.appointmentId))).toContain(other.id);
  await page.getByLabel("Show appointments", { exact: true }).selectOption("declined");
  await expect(card).toContainText(stored.decline.explanation);
  await expect(card).toContainText("Decline reason");
  const denied = await page.evaluate(async id => {
    const session = await (await fetch("/api/mechanic/session")).json();
    const result = await fetch(`/api/mechanic/appointments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Mechanic-CSRF": session.csrfToken }, body: JSON.stringify({ status: "confirmed" }) });
    return result.status;
  }, appointment.id);
  expect(denied).toBe(409);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("declined");
});

test("keeps a scheduling conflict pending and reads legacy declines without inventing a reason", async ({ page, shop }) => {
  const original = await shop.Appointment.create({ ...CUSTOMER, name: "Expired original request", status: "pending", createdAt: new Date("2030-01-01T12:00:00Z") });
  await shop.scheduling.createAppointment(CUSTOMER);
  await shop.Appointment.create({ ...CUSTOMER, name: "Historical declined customer", status: "declined", date: "2029-12-01" });
  await shop.login();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Expired original request", exact: true }) });
  await card.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/scheduling conflict/i);
  expect((await shop.Appointment.findById(original.id).lean()).status).toBe("pending");
  expect((await shop.Appointment.findById(original.id).lean()).decline).toBeUndefined();
  await page.getByLabel("Show appointments", { exact: true }).selectOption("declined");
  const legacy = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Historical declined customer", exact: true }) });
  await expect(legacy).toContainText(/reason.*not.*recorded|no.*reason.*recorded/i);
  await expect(legacy.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
});

test("enforces CSRF and clears an open private decline form when the session expires", async ({ page, shop }) => {
  const appointment = await shop.scheduling.createAppointment(CUSTOMER);
  let corruptCsrf = true;
  await page.route(`**/api/mechanic/appointments/${appointment.id}`, async route => {
    const headers = route.request().headers();
    if (corruptCsrf) headers["x-mechanic-csrf"] = "invalid-test-csrf";
    await route.fulfill({ response: await route.fetch({ url: `${shop.origin}/api/mechanic/appointments/${appointment.id}`, headers }) });
  });
  await shop.login();
  await page.getByRole("button", { name: "Decline Appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review appointment decline", exact: true });
  await dialog.getByLabel("Reason category", { exact: true }).selectOption("outside_capabilities");
  const explanation = "This repair needs equipment that the shop does not have.";
  await dialog.getByLabel("Additional explanation", { exact: true }).fill(explanation);
  await dialog.getByRole("button", { name: "Confirm Decline", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/CSRF|security|refresh/i);
  await expect(dialog.getByLabel("Additional explanation", { exact: true })).toHaveValue(explanation);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  corruptCsrf = false;
  shop.advanceSession(21 * 60_000);
  await dialog.getByRole("button", { name: "Confirm Decline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Additional explanation", { exact: true })).toHaveCount(0);
  const stored = await shop.Appointment.findById(appointment.id).lean();
  expect(stored.status).toBe("pending"); expect(stored.decline).toBeUndefined();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test("maintains readable typography, targets and accessible layouts at every requested width", async ({ page, shop }, testInfo) => {
  test.setTimeout(150_000);
  for (const width of widthsByProject[testInfo.project.name]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of publicRoutes) {
      await page.goto(route);
      await expect(page.locator("main h1")).toBeVisible();
      await noOverflow(page);
      await fontAtLeast(page.locator("main .home-hero-description,main .services-description,main .page-hero-description"), 16);
      await fontAtLeast(page.locator("a.button,main .text-link,footer a"), 16);
      await screenshot(page, testInfo, `${width}-${route === "/" ? "home" : route.slice(1)}`);
      await audit(page);
    }
    await openBooking(page);
    await chooseSlot(page); await fillDetails(page);
    await checkBookingFonts(page); await noOverflow(page); await audit(page);
    await screenshot(page, testInfo, `${width}-booking`);
    await reviewRequest(page);
    await noOverflow(page); await fontAtLeast(page.locator(".booking-summary dd"), 16); await audit(page);
    await screenshot(page, testInfo, `${width}-review`);
    // This POST is synthetic and persists only in this test's isolated DB.
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByText(PENDING, { exact: true })).toBeVisible();
    await noOverflow(page); await fontAtLeast(page.locator(".booking-success-message,.booking-hold"), 16); await audit(page);
    await screenshot(page, testInfo, `${width}-success`);
    // Release the occupied synthetic slot before the next width; the customer
    // record remains on file, and no other appointment is modified.
    const saved = await shop.Appointment.findOne({ name: VALID_DETAILS.name, status: "pending" }).sort({ createdAt: -1 }).lean();
    await shop.scheduling.reviewAppointment(String(saved._id), "declined", { decline: { category: "unable_to_accommodate" } });
    await page.goto("/mechanic");
    await signInIfNeeded(page);
    await page.getByLabel("Show appointments", { exact: true }).selectOption("declined");
    const declined = page.getByRole("article").filter({ has: page.getByRole("heading", { name: VALID_DETAILS.name, exact: true }) }).first();
    await expect(declined.getByRole("region", { name: "Decline reason", exact: true })).toBeVisible();
    await fontAtLeast(declined.locator("dd,.staff-decline-record p"), 16);
    await noOverflow(page); await audit(page);
    await screenshot(page, testInfo, `${width}-appointment-decline-reason`);
    for (const name of settingsSections) {
      await showSection(page, name);
      await noOverflow(page);
      await fontAtLeast(page.locator(".staff-field,.staff-settings-field"), 15);
      await fontAtLeast(page.locator(".staff-button,.staff-primary,.staff-secondary"), 16);
      await fontAtLeast(page.locator(".staff-field-help,.staff-field-format"), 14);
      await audit(page);
      await screenshot(page, testInfo, `${width}-${name.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`);
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await fontAtLeast(page.locator(".mechanic-login p:not(.staff-kicker),.mechanic-login label,.mechanic-login button"), 16);
    await fontAtLeast(page.locator(".mechanic-login .staff-kicker"), 14);
    await noOverflow(page); await audit(page);
    await screenshot(page, testInfo, `${width}-staff-login`);
  }
});

async function routeIsolated(context, origin) {
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
  });
}

test("supports 200 percent text resizing and real 200/400 percent browser zoom with reflow", async ({ page, shop }, testInfo) => {
  test.setTimeout(120_000);
  if (testInfo.project.name !== "desktop") {
    await openBooking(page); await chooseSlot(page); await fillDetails(page);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await noOverflow(page); await audit(page);
    await screenshot(page, testInfo, "200-percent-text-resize-booking");
    await reviewRequest(page);
    await noOverflow(page); await audit(page);
    return;
  }
  // Chrome's native Page zoom setting changes layout CSS pixels, unlike pinch
  // scaling or deviceScaleFactor-only emulation. The disposable profile keeps
  // the shared browser/settings untouched; extensions are not required.
  const profile = await mkdtemp(join(tmpdir(), "eds-usability-zoom-"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      // Native settings require full Chromium, rather than headless-shell.
      ...(executablePath ? {} : { channel: "chromium" }),
      headless: true, viewport: { width: 1280, height: 1000 }, locale: "en-GB", timezoneId: "Asia/Tokyo", args: ["--no-sandbox"],
    });
    await routeIsolated(context, shop.origin);
    const chromeSettings = context.pages()[0];
    await chromeSettings.goto("chrome://settings/appearance");
    const zoom = chromeSettings.locator("select#zoomLevel");
    await expect(zoom).toBeVisible();
    const zoomPage = await context.newPage();
    const baseURL = testInfo.project.use.baseURL || "http://127.0.0.1:5174";
    for (const factor of [1, 2, 4]) {
      await zoom.selectOption({ label: `${factor * 100}%` });
      for (const route of ["/", "/services", "/appointment?service=Oil+Change"]) {
        await zoomPage.goto(`${baseURL}${route}`);
        const metrics = await zoomPage.evaluate(() => ({ inner: innerWidth, outer: outerWidth, dpr: devicePixelRatio, visual: visualViewport.scale }));
        expect(metrics.outer).toBe(1280); expect(metrics.inner).toBe(Math.round(1280 / factor)); expect(metrics.dpr).toBe(factor); expect(metrics.visual).toBe(1);
        await noOverflow(zoomPage);
        await audit(zoomPage);
        await nativeZoomScreenshot(zoomPage, testInfo, `${factor * 100}-percent-zoom-${route.startsWith("/appointment") ? "booking" : route === "/" ? "home" : "services"}`);
        if (route.startsWith("/appointment")) {
          await expect(zoomPage.getByRole("grid")).toBeVisible();
          await chooseSlot(zoomPage); await fillDetails(zoomPage); await reviewRequest(zoomPage);
          await noOverflow(zoomPage); await audit(zoomPage);
          await zoomPage.locator(".booking-review-panel").scrollIntoViewIfNeeded();
          await nativeZoomScreenshot(zoomPage, testInfo, `${factor * 100}-percent-zoom-booking-review`, false);
        }
      }
      await zoomPage.goto(`${baseURL}/mechanic`);
      await signInIfNeeded(zoomPage);
      await showSection(zoomPage, "Booking Settings");
      await noOverflow(zoomPage); await audit(zoomPage);
      await zoomPage.getByLabel("Simultaneous appointment capacity", { exact: false }).scrollIntoViewIfNeeded();
      await nativeZoomScreenshot(zoomPage, testInfo, `${factor * 100}-percent-zoom-staff-settings`, false);
    }
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
