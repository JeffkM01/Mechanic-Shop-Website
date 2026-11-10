import { chromium } from "@playwright/test";
import axe from "axe-core";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test, expect, CUSTOMER } from "./cancellation-fixture.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

const CUSTOMER_DIALOG = "Are you sure you want to cancel your appointment?";
const INVALID_LINK = "This appointment-management link is no longer valid. Please contact the shop for help.";
const widthsByProject = { desktop: [1280, 1440, 1920], tablet: [768], mobile: [320, 390] };
test.use({ locale: "en-GB", timezoneId: "Pacific/Kiritimati" });
test.setTimeout(60_000);

async function openManagement(page, shop, appointment) {
  const link = await shop.linkFor(appointment.id || String(appointment._id));
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Manage your appointment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close appointment access", exact: true })).toBeVisible();
  return link;
}
async function customerReview(page) {
  await page.getByRole("button", { name: "Cancel Appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: CUSTOMER_DIALOG, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
function customerPosts(shop) {
  return shop.calls.filter(call => call.method === "POST" && /^\/api\/customer\/appointments\/[^/]+\/cancel$/.test(call.path));
}
async function audit(page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const root = document.querySelector("dialog[open]") || document.querySelector("main");
    const result = await globalThis.axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
}
async function noOverflow(page) {
  const sizes = await page.evaluate(() => {
    const dialog = document.querySelector("dialog[open]");
    return { client: document.documentElement.clientWidth, scroll: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), dialogClient: dialog?.clientWidth, dialogScroll: dialog?.scrollWidth };
  });
  expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.client + 1);
  if (sizes.dialogClient !== undefined) expect(sizes.dialogScroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.dialogClient + 1);
}
async function reachable(control) {
  await control.focus();
  await control.scrollIntoViewIfNeeded();
  const position = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
  });
  expect(position.left).toBeGreaterThanOrEqual(-1);
  expect(position.right).toBeLessThanOrEqual(position.width + 1);
  expect(position.top).toBeGreaterThanOrEqual(-1);
  expect(position.bottom).toBeLessThanOrEqual(position.height + 1);
}
async function capture(page, testInfo, name, nativeZoom = false) {
  const path = testInfo.outputPath(`${name}.png`);
  let png;
  if (nativeZoom) {
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      png = Buffer.from(result.data, "base64");
      expect(png.readUInt32BE(16)).toBe(1280);
    } finally { await session.detach(); }
    await writeFile(path, png);
  } else {
    // Native modal geometry is tied to the viewport. A full-page capture changes
    // the capture height and misrepresents the dialog/backdrop and focus state.
    const modalOpen = await page.locator("dialog[open]").count() > 0;
    png = await page.screenshot({ path, fullPage: !modalOpen });
  }
  // A portable Playwright attachment and cloud-visible evidence contain only
  // synthetic appointments; scrubbed page URLs never contain access tokens.
  await testInfo.attach(name, { path, contentType: "image/png" });
  const artifacts = "/workspace/artifacts/cancellation";
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, `${testInfo.project.name}-${name}.png`), png);
}
async function submitBooking(page) {
  await page.goto("/appointment?service=Oil+Change");
  const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(CUSTOMER.date)) });
  await expect(day).toHaveAttribute("aria-disabled", "false");
  await day.click();
  await page.getByRole("radio", { name: "8:00 AM", exact: true }).locator("..").click();
  await page.getByRole("button", { name: /continue to your details/i }).click();
  for (const key of ["name", "email", "phone", "vehicle", "notes"]) await page.locator(`[name="${key}"]`).fill(CUSTOMER[key]);
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/appointments" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  return response.json();
}

test("exchanges a fragment credential, scrubs the URL and exposes only authorized appointment details", async ({ page, context, shop }) => {
  const appointment = await shop.createAppointment();
  const link = await shop.linkFor(appointment.id);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  expect(token).toBeTruthy();
  const outgoing = [];
  page.on("request", request => outgoing.push({ url: request.url(), referer: request.headers().referer || "" }));
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/customer/appointments/${appointment.id}/exchange` && response.request().method() === "POST");
  await page.goto(link);
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/manage-appointment\\?appointment=${appointment.id}$`));
  const response = await responsePromise;
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  const details = await response.json();
  expect(details.appointment).toMatchObject({ id: appointment.id, service: CUSTOMER.service, vehicle: CUSTOMER.vehicle, date: CUSTOMER.date, time: CUSTOMER.time, status: "pending" });
  for (const field of ["name", "email", "phone", "notes", "management", "scheduling", "notificationState"]) expect(details.appointment).not.toHaveProperty(field);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(JSON.stringify(storage)).not.toContain(token);
  expect(outgoing.every(request => !request.url.includes(token) && !request.referer.includes(token))).toBe(true);
  const cookies = await context.cookies();
  expect(cookies.some(cookie => cookie.httpOnly && cookie.path.includes(appointment.id))).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close appointment access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(INVALID_LINK, { exact: true })).toBeVisible();
});

test("rejects reference-only, invalid, expired, revoked and another appointment's credential without private data", async ({ page, context, shop }) => {
  const first = await shop.createAppointment();
  const second = await shop.createAppointment({ name: "Another Private Customer", time: "10:00" });
  const firstLink = await shop.linkFor(first.id);
  const secondLink = await shop.linkFor(second.id);
  const cross = new URL(firstLink);
  const crossFragment = new URLSearchParams(cross.hash.slice(1));
  crossFragment.set("id", second.id); cross.hash = crossFragment.toString();
  const invalid = new URL(firstLink);
  const invalidFragment = new URLSearchParams(invalid.hash.slice(1));
  invalidFragment.set("token", "x".repeat(43)); invalid.hash = invalidFragment.toString();
  const urls = [`/manage-appointment?appointment=${first.id}`, invalid.href, cross.href];
  for (const url of urls) {
    await context.clearCookies();
    await page.goto(url);
    await expect(page.getByText(INVALID_LINK, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(CUSTOMER.vehicle);
    await expect(page.locator("main")).not.toContainText(CUSTOMER.name);
  }
  await shop.Appointment.updateOne({ _id: first.id }, { $set: { "management.expiresAt": new Date("2030-01-06T12:00:00Z") } });
  await page.goto(firstLink);
  await expect(page.getByText(INVALID_LINK, { exact: true })).toBeVisible();
  await shop.management.revoke(second.id);
  await page.goto(secondLink);
  await expect(page.getByText(INVALID_LINK, { exact: true })).toBeVisible();
  expect((await shop.Appointment.findById(first.id).lean()).status).toBe("pending");
  expect((await shop.Appointment.findById(second.id).lean()).status).toBe("pending");
});

test("keeps two appointment tabs scoped when either is cancelled or its access is closed", async ({ page, context, shop }) => {
  const first = await shop.createAppointment();
  const second = await shop.createAppointment({ vehicle: "2020 Toyota Corolla", time: "10:00" });
  await openManagement(page, shop, first);
  const secondPage = await context.newPage();
  try {
    await openManagement(secondPage, shop, second);
    await page.bringToFront();
    await page.reload();
    await expect(page.locator("main")).toContainText(CUSTOMER.vehicle);
    await expect(page.locator("main")).not.toContainText("2020 Toyota Corolla");
    await (await customerReview(page)).getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
    await secondPage.bringToFront(); await secondPage.reload();
    await expect(secondPage.getByRole("button", { name: "Cancel Appointment", exact: true })).toBeVisible();
    await expect(secondPage.locator("main")).toContainText("2020 Toyota Corolla");
    expect((await shop.Appointment.findById(second.id).lean()).status).toBe("pending");
    await page.bringToFront();
    await page.getByRole("button", { name: "Close appointment access", exact: true }).click();
    await secondPage.bringToFront(); await secondPage.reload();
    await expect(secondPage.getByRole("button", { name: "Cancel Appointment", exact: true })).toBeVisible();
    shop.advanceClock(20 * 60_000 + 1);
    await secondPage.reload();
    await expect(secondPage.getByText(INVALID_LINK, { exact: true })).toBeVisible();
    await expect(secondPage.locator("main")).not.toContainText("2020 Toyota Corolla");
    expect((await shop.Appointment.findById(second.id).lean()).status).toBe("pending");
  } finally { await secondPage.close(); }
});

test("reviews then keeps a pending appointment, or explicitly cancels with no optional reason", async ({ page, shop }) => {
  const appointment = await shop.createAppointment();
  const other = await shop.createAppointment({ name: "Another Reserved Customer", time: "10:00" });
  await openManagement(page, shop, appointment);
  const cancel = page.getByRole("button", { name: "Cancel Appointment", exact: true });
  let dialog = await customerReview(page);
  await expect(dialog).toContainText(formatBookingDate(CUSTOMER.date));
  await expect(dialog).toContainText("8:00 AM");
  await dialog.getByRole("button", { name: "Keep My Appointment", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(cancel).toBeFocused();
  expect(customerPosts(shop)).toHaveLength(0);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  dialog = await customerReview(page);
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  const saved = await shop.Appointment.findById(appointment.id).lean();
  expect(saved).toMatchObject({ ...CUSTOMER, status: "cancelled", cancellation: { by: "customer", originalDate: CUSTOMER.date, originalTime: CUSTOMER.time, timezone: "America/Chicago" } });
  expect(saved.cancellation.cancelledAt).toBeInstanceOf(Date);
  expect(saved.notificationState).toMatchObject({ cancellationCustomer: "pending", cancellationMechanic: "pending" });
  expect((await shop.Appointment.findById(other.id).lean()).status).toBe("pending");
  expect(await shop.Appointment.countDocuments()).toBe(2);
  await expect(page.locator("main")).toContainText(/email.*disabled|email.*unavailable|not.*sent/i);
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
});

test("cancels a confirmed appointment with an optional reason and message and safely returns its saved repeat result", async ({ page, shop }) => {
  const appointment = await shop.createAppointment();
  await shop.scheduling.reviewAppointment(appointment.id, "confirmed");
  await openManagement(page, shop, appointment);
  const dialog = await customerReview(page);
  await dialog.getByLabel("Cancellation reason (optional)", { exact: true }).selectOption("plans_changed");
  await dialog.getByLabel("Additional message (optional)", { exact: true }).fill("My work schedule changed; I will request another visit later.");
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  const before = await shop.Appointment.findById(appointment.id).lean();
  expect(before.cancellation).toMatchObject({ category: "plans_changed", message: "My work schedule changed; I will request another visit later." });
  const repeated = await page.evaluate(async id => {
    const path = `/api/customer/appointments/${id}`;
    const current = await (await fetch(path)).json();
    const result = await fetch(`${path}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "X-Appointment-CSRF": current.csrfToken }, body: JSON.stringify({ category: "other", message: "Must not replace the saved cancellation." }) });
    return { status: result.status, body: await result.json() };
  }, appointment.id);
  expect(repeated.status).toBe(200);
  expect(repeated.body.appointment.status).toBe("cancelled");
  const after = await shop.Appointment.findById(appointment.id).lean();
  expect(after.cancellation).toEqual(before.cancellation);
  expect(after.notificationState).toEqual(before.notificationState);
  expect(after.updatedAt).toEqual(before.updatedAt);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
});

test("books through the real calendar, cancels, and restores only that reservation's availability", async ({ page, shop }) => {
  const other = await shop.createAppointment({ name: "Reservation To Preserve", time: "10:00" });
  const saved = await submitBooking(page);
  expect(saved.status).toBe("pending");
  const occupied = await shop.scheduling.getAvailability(CUSTOMER.service, CUSTOMER.date);
  expect(occupied.slots.some(slot => slot.time === "08:00")).toBe(false);
  await openManagement(page, shop, saved);
  await (await customerReview(page)).getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  await page.goto("/appointment?service=Oil+Change");
  await page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(CUSTOMER.date)) }).click();
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "10:00 AM", exact: true })).toHaveCount(0);
  const available = await shop.scheduling.getAvailability(CUSTOMER.service, CUSTOMER.date);
  expect(available.slots.some(slot => slot.time === "08:00")).toBe(true);
  expect(available.slots.some(slot => slot.time === "10:00")).toBe(false);
  expect((await shop.Appointment.findById(saved.id).lean()).status).toBe("cancelled");
  expect((await shop.Appointment.findById(other.id).lean()).status).toBe("pending");
  expect(await shop.Appointment.countDocuments()).toBe(2);
});

test("shows declined and already-started appointments without an online cancellation action", async ({ page, shop }) => {
  const declined = await shop.createAppointment();
  const started = await shop.createAppointment({ time: "10:00" });
  await shop.scheduling.reviewAppointment(declined.id, "declined", { decline: { category: "unable_to_accommodate" } });
  await openManagement(page, shop, declined);
  await expect(page.locator("main")).toContainText(/declined/i);
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
  const startedLink = await shop.linkFor(started.id);
  shop.advanceClock(2 * 24 * 60 * 60_000 + 4 * 60 * 60_000);
  await page.goto(startedLink);
  await expect(page.locator("main")).toContainText(/Online cancellation is no longer available/);
  await expect(page.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
  expect(customerPosts(shop)).toHaveLength(0);
  expect((await shop.Appointment.findById(started.id).lean()).status).toBe("pending");
});

test("refreshes authoritative status after a committed cancellation response is lost without retrying the mutation", async ({ page, shop }) => {
  const appointment = await shop.createAppointment();
  await openManagement(page, shop, appointment);
  shop.faults.loseCancellationResponse = true;
  await (await customerReview(page)).getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByText(/couldn't confirm whether the cancellation was completed/i)).toBeVisible();
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("cancelled");
  expect(customerPosts(shop)).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toHaveCount(0);
  const refresh = page.getByRole("button", { name: "Refresh appointment status", exact: true });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  expect(customerPosts(shop)).toHaveLength(1);
  const mutationIndex = shop.calls.findIndex(call => call.method === "POST" && call.path.endsWith(`/${appointment.id}/cancel`));
  expect(shop.calls.slice(mutationIndex + 1).some(call => call.method === "GET" && call.path.endsWith(`/${appointment.id}`))).toBe(true);
});

test("requires a reviewed mechanic explanation, preserves Keep, and retains cancellation history without terminal actions", async ({ page, shop }, testInfo) => {
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 1000 });
  const appointment = await shop.createAppointment();
  await shop.login();
  let card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  const cancel = card.getByRole("button", { name: "Cancel Appointment", exact: true });
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: "Cancel this appointment?", exact: true });
  await dialog.getByLabel("Cancellation reason", { exact: true }).selectOption("other");
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  const explanation = dialog.getByLabel(/explanation/i);
  await expect(explanation).toBeFocused();
  await expect(explanation).toHaveAttribute("aria-invalid", "true");
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  await explanation.fill("The vehicle requires specialist equipment that is unavailable at our shop.");
  await expect(dialog.getByRole("region", { name: "Customer message preview", exact: true })).toContainText("specialist equipment");
  await noOverflow(page); await audit(page);
  await capture(page, testInfo, "staff-cancellation-review");
  await dialog.getByRole("button", { name: "Keep Appointment", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(cancel).toBeFocused();
  expect(shop.calls.filter(call => call.method === "POST" && call.path.endsWith(`/${appointment.id}/cancel`))).toHaveLength(0);
  await cancel.click();
  await dialog.getByLabel("Cancellation reason", { exact: true }).selectOption("other");
  await dialog.getByLabel(/explanation/i).fill("The vehicle requires specialist equipment that is unavailable at our shop.");
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Show appointments", { exact: true }).selectOption("cancelled");
  card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText("specialist equipment");
  await expect(card).toContainText(/no longer reserved/i);
  await expect(card).toContainText(/mechanic/i);
  await expect(card.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Decline Appointment", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Cancel Appointment", exact: true })).toHaveCount(0);
  const saved = await shop.Appointment.findById(appointment.id).lean();
  expect(saved.status).toBe("cancelled");
  expect(saved.cancellation.by).toBe("mechanic");
  expect(saved.notificationState.cancellationCustomer).toBe("pending");
  expect(saved.notificationState.cancellationMechanic).toBe("not-applicable");
  await noOverflow(page); await audit(page);
  await capture(page, testInfo, "staff-cancelled-history");
});

test("rejects mechanic cancellation after CSRF failure or session expiry and hides private data", async ({ page, shop }) => {
  const appointment = await shop.createAppointment();
  await shop.login();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await card.getByRole("button", { name: "Cancel Appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this appointment?", exact: true });
  await dialog.getByLabel("Cancellation reason", { exact: true }).selectOption("mechanic_unavailable");
  await dialog.getByLabel(/explanation/i).fill("The mechanic is unavailable for this appointment. Please contact us to arrange another visit.");
  shop.faults.mechanicCsrf = true;
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${appointment.id}/cancel`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  expect((await rejected).status()).toBe(403);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
  shop.faults.mechanicCsrf = false;
  shop.advanceSession(20 * 60_000 + 1);
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText(CUSTOMER.email, { exact: true })).toHaveCount(0);
  const unauthenticated = await page.evaluate(async id => {
    const result = await fetch(`/api/mechanic/appointments/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "mechanic_unavailable", explanation: "Never authorized." }) });
    return result.status;
  }, appointment.id);
  expect(unauthenticated).toBe(401);
  expect((await shop.Appointment.findById(appointment.id).lean()).status).toBe("pending");
});

test("reflows accessible management, review and saved status at all requested widths with keyboard controls", async ({ page, shop }, testInfo) => {
  test.setTimeout(120_000);
  const appointment = await shop.createAppointment();
  for (const width of widthsByProject[testInfo.project.name]) {
    await page.setViewportSize({ width, height: 1000 });
    await openManagement(page, shop, appointment);
    await noOverflow(page); await audit(page);
    await capture(page, testInfo, `${width}-management`);
    const cancel = page.getByRole("button", { name: "Cancel Appointment", exact: true });
    await cancel.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: CUSTOMER_DIALOG, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Cancellation reason (optional)", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Additional message (optional)", { exact: true })).toBeVisible();
    await noOverflow(page); await audit(page);
    await capture(page, testInfo, `${width}-customer-review`);
    await reachable(dialog.getByRole("button", { name: "Keep My Appointment", exact: true }));
    await reachable(dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }));
    await capture(page, testInfo, `${width}-customer-cancellation-actions`);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible(); await expect(cancel).toBeFocused();
  }
  await (await customerReview(page)).getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  await noOverflow(page); await audit(page);
  await capture(page, testInfo, "saved-cancellation");
  await page.getByRole("button", { name: "Close appointment access", exact: true }).click();
  await page.goto("/manage-appointment");
  await expect(page.getByText(INVALID_LINK, { exact: true })).toBeVisible();
  await noOverflow(page); await audit(page);
  await capture(page, testInfo, "invalid-management-link");
});

test("supports 200 percent text resizing and native 200/400 percent zoom on management and confirmation", async ({ page, shop }, testInfo) => {
  test.setTimeout(120_000);
  const appointment = await shop.createAppointment();
  if (testInfo.project.name !== "desktop") {
    await openManagement(page, shop, appointment);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await noOverflow(page); await audit(page);
    await capture(page, testInfo, "200-percent-text-management");
    await customerReview(page); await noOverflow(page); await audit(page);
    await reachable(page.getByRole("button", { name: "Keep My Appointment", exact: true }));
    await reachable(page.getByRole("button", { name: "Confirm Cancellation", exact: true }));
    await capture(page, testInfo, "200-percent-text-cancellation-review");
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), "eds-cancellation-zoom-"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath, ...(executablePath ? {} : { channel: "chromium" }),
      headless: true, viewport: { width: 1280, height: 1000 }, locale: "en-GB", timezoneId: "Asia/Tokyo", args: ["--no-sandbox"],
    });
    await shop.routeIsolated(context);
    const settings = context.pages()[0];
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("select#zoomLevel");
    await expect(zoom).toBeVisible();
    const zoomPage = await context.newPage();
    for (const factor of [1, 2, 4]) {
      await zoom.selectOption({ label: `${factor * 100}%` });
      await openManagement(zoomPage, shop, appointment);
      const metrics = await zoomPage.evaluate(() => ({ inner: innerWidth, outer: outerWidth, dpr: devicePixelRatio, visual: visualViewport.scale }));
      expect(metrics).toEqual({ inner: Math.round(1280 / factor), outer: 1280, dpr: factor, visual: 1 });
      await noOverflow(zoomPage); await audit(zoomPage);
      await capture(zoomPage, testInfo, `${factor * 100}-percent-zoom-management`, true);
      await customerReview(zoomPage); await noOverflow(zoomPage); await audit(zoomPage);
      await capture(zoomPage, testInfo, `${factor * 100}-percent-zoom-cancellation-review`, true);
      await reachable(zoomPage.getByRole("button", { name: "Keep My Appointment", exact: true }));
      await reachable(zoomPage.getByRole("button", { name: "Confirm Cancellation", exact: true }));
      await capture(zoomPage, testInfo, `${factor * 100}-percent-zoom-cancellation-actions`, true);
      await zoomPage.keyboard.press("Escape");
    }
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
