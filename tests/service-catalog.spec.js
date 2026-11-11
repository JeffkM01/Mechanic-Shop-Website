import axe from "axe-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, CUSTOMER } from "./cancellation-fixture.js";
import { requiresMechanicApproval } from "../shared/services.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

// Reuse the actual Express/Mongo fixture: each case owns one random database,
// intercepts every API request, and has no SMTP transport or application .env.
test.use({ locale: "en-GB", timezoneId: "Pacific/Kiritimati" });
test.setTimeout(60_000);
const SETTINGS_PATH = "/api/mechanic/scheduling/settings";
const SUSPENSION = {
  name: "Suspension Repair", category: "repairs", icon: "wrench",
  description: "Describe steering, ride, or suspension concerns for mechanic review.",
  active: true, provisional: false, appointmentOnly: false, legacyNames: [],
};

async function openSettings(page, shop) {
  await shop.login();
  await page.getByRole("navigation", { name: "Staff dashboard sections" }).getByRole("button", { name: "Booking Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Service catalog", exact: true })).toBeVisible();
}
async function navigate(page, name) {
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  const link = page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name, exact: true });
  const target = new URL(await link.getAttribute("href"), page.url()).href;
  await link.click();
  await expect(page).toHaveURL(target);
  await expect(page.locator(name === "Services" ? "main.services-page" : "main.home-page")).toBeVisible();
}
function settingWrites(shop) {
  return shop.calls.filter(call => call.path === SETTINGS_PATH && call.method === "PATCH");
}
async function saveSettings(page, shop, expectedStatus = 200) {
  const before = settingWrites(shop).length;
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review scheduling changes", exact: true })).toBeVisible();
  expect(settingWrites(shop)).toHaveLength(before);
  const response = page.waitForResponse(result => new URL(result.url()).pathname === SETTINGS_PATH && result.request().method() === "PATCH");
  await page.getByRole("button", { name: "Confirm Changes", exact: true }).click();
  expect((await response).status()).toBe(expectedStatus);
}
async function addSuspensionDraft(page) {
  await page.getByLabel("Service name", { exact: true }).fill(SUSPENSION.name);
  await page.getByLabel("Service category", { exact: true }).selectOption(SUSPENSION.category);
  await page.getByLabel("Customer description", { exact: true }).fill(SUSPENSION.description);
  await page.getByLabel("New service duration (minutes)", { exact: true }).fill("120");
  await page.getByLabel("Service icon", { exact: true }).selectOption(SUSPENSION.icon);
  await page.getByLabel("I confirm the shop offers this service", { exact: true }).check();
  await page.getByRole("button", { name: "Add service to draft", exact: true }).click();
  await expect(page.getByLabel(`${SUSPENSION.name} duration (minutes)`, { exact: true })).toHaveValue("120");
}
async function addSuspensionSaved(shop) {
  const saved = await shop.scheduling.getSettings();
  await shop.scheduling.updateSettings({
    serviceCatalog: [...saved.settings.serviceCatalog, SUSPENSION],
    serviceRules: { [SUSPENSION.name]: { durationMinutes: 120, requiresApproval: true } },
  }, { expectedRevision: saved.revision });
}
async function chooseSlot(page, time = "8:00 AM") {
  const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(CUSTOMER.date)) });
  await expect(day).toHaveAttribute("aria-disabled", "false");
  await day.click();
  await page.getByRole("radio", { name: time, exact: true }).locator("..").click();
  await page.getByRole("button", { name: /continue to your details/i }).click();
}
async function submitBooking(page, service, time = "8:00 AM") {
  await page.goto(`/appointment?${new URLSearchParams({ service })}`);
  await expect(page.locator('[name="service"]')).toHaveValue(service);
  await chooseSlot(page, time);
  for (const field of ["name", "email", "phone", "vehicle", "notes"]) await page.locator(`[name="${field}"]`).fill(CUSTOMER[field]);
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toBeVisible();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/appointments" && result.request().method() === "POST");
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  return saved.json();
}
async function audit(page) {
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) }));
  expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width + 1);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document.querySelector("main"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
}
async function capture(page, testInfo, name, target = null) {
  const path = testInfo.outputPath(`${name}.png`);
  const png = target ? await target.screenshot({ path }) : await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const folder = "/workspace/artifacts/service-catalog";
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${testInfo.project.name}-${name}.png`), png);
}

test("keeps existing services and enforces the new Wiper-only automatic policy without enabling automation", async ({ page, shop }) => {
  const original = await shop.scheduling.getSettings();
  expect(original.settings.automaticBookingEnabled).toBe(false);
  expect(original.settings.capacity).toBe(1);
  expect(original.settings.serviceCatalog.map(service => service.name)).toContain("Oil Change");
  expect(original.settings.serviceCatalog.map(service => service.name)).not.toContain(SUSPENSION.name);
  await openSettings(page, shop);
  for (const service of original.settings.serviceCatalog.filter(requiresMechanicApproval)) {
    expect(original.settings.serviceRules[service.name].requiresApproval).toBe(true);
    await expect(page.getByLabel(`${service.name} requires mechanic approval`, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByLabel("Wiper Blade Replacement requires mechanic approval", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Automatic booking enabled", { exact: true })).not.toBeChecked();
  expect(await shop.scheduling.getSettings()).toEqual(original);
  expect(settingWrites(shop)).toHaveLength(0);
});

test("adds a reviewed Suspension Repair service and books it through public cards with manual approval", async ({ page, shop }, testInfo) => {
  await openSettings(page, shop);
  await addSuspensionDraft(page);
  expect(settingWrites(shop)).toHaveLength(0);
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.some(service => service.name === SUSPENSION.name)).toBe(false);
  await saveSettings(page, shop);
  const saved = await shop.scheduling.getSettings();
  expect(saved.settings.serviceCatalog.find(service => service.name === SUSPENSION.name)).toEqual(SUSPENSION);
  expect(saved.settings.serviceRules[SUSPENSION.name]).toEqual({ durationMinutes: 120, requiresApproval: true });
  expect(saved.settings.serviceCatalog.find(service => service.name === "Oil Change").active).toBe(true);
  expect(saved.settings.automaticBookingEnabled).toBe(false);
  // Stay in the same React session after the staff save. A full navigation
  // would conceal a stale shared catalog/provider invalidation bug.
  await navigate(page, "Services");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: SUSPENSION.name, exact: true }) });
  await expect(card).toContainText(SUSPENSION.description);
  const link = card.getByRole("link", { name: `Request an appointment for ${SUSPENSION.name}`, exact: true });
  await expect(link).toHaveAttribute("href", `/appointment?${new URLSearchParams({ service: SUSPENSION.name })}`);
  await audit(page); await capture(page, testInfo, "published-service");
  await link.click();
  await expect(page.locator('[name="service"]')).toHaveValue(SUSPENSION.name);
  const appointment = await submitBooking(page, SUSPENSION.name);
  expect(appointment.status).toBe("pending");
  expect((await shop.Appointment.findById(appointment.id).lean()).service).toBe(SUSPENSION.name);
});

test("deactivates Oil Change across customer pages while retaining historical review, cancellation and records", async ({ page, shop }) => {
  const original = await shop.createAppointment();
  const snapshot = original.scheduling.toObject ? original.scheduling.toObject() : { ...original.scheduling };
  await openSettings(page, shop);
  await page.getByRole("button", { name: "Deactivate Oil Change", exact: true }).click();
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.find(service => service.name === "Oil Change").active).toBe(true);
  await saveSettings(page, shop);
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.find(service => service.name === "Oil Change").active).toBe(false);
  await navigate(page, "Home");
  await expect(page.getByRole("heading", { name: "Oil Change", exact: true })).toHaveCount(0);
  await navigate(page, "Services");
  await expect(page.getByRole("heading", { name: "Oil Change", exact: true })).toHaveCount(0);
  await page.goto("/appointment?service=Oil+Change");
  await expect(page.locator('[name="service"] option[value="Oil Change"]')).toHaveCount(0);
  await expect(page.locator('[name="service"]')).toHaveValue("");
  const denied = await page.evaluate(async request => {
    const response = await fetch("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  }, { ...CUSTOMER, time: "10:00" });
  expect([400, 409]).toContain(denied.status);
  expect(await shop.Appointment.countDocuments()).toBe(1);
  await page.goto("/mechanic");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await expect(card).toContainText("Oil Change");
  await card.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => (await shop.Appointment.findById(original.id).lean()).status).toBe("confirmed");
  await page.getByLabel("Show appointments", { exact: true }).selectOption("confirmed");
  await card.getByRole("button", { name: "Cancel Appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this appointment?", exact: true });
  await dialog.getByLabel("Cancellation reason", { exact: true }).selectOption("shop_closed");
  await dialog.getByRole("button", { name: "Confirm Cancellation", exact: true }).click();
  await expect.poll(async () => (await shop.Appointment.findById(original.id).lean()).status).toBe("cancelled");
  const retained = await shop.Appointment.findById(original.id).lean();
  expect(retained.service).toBe("Oil Change");
  expect(retained.scheduling.startAt).toEqual(snapshot.startAt);
  expect(retained.scheduling.durationMinutes).toBe(snapshot.durationMinutes);
  expect(await shop.Appointment.countDocuments()).toBe(1);
  await page.getByRole("navigation", { name: "Staff dashboard sections" }).getByRole("button", { name: "Booking Settings", exact: true }).click();
  await page.getByRole("button", { name: "Reactivate Oil Change", exact: true }).click();
  await saveSettings(page, shop);
  await navigate(page, "Services");
  await expect(page.getByRole("heading", { name: "Oil Change", exact: true })).toBeVisible();
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.find(service => service.name === "Oil Change").active).toBe(true);
});

test("preserves an unsaved catalog draft through stale revision review without overwriting newer settings", async ({ page, shop }) => {
  await openSettings(page, shop);
  await addSuspensionDraft(page);
  await shop.scheduling.updateSettings({ capacity: 2 });
  await saveSettings(page, shop, 409);
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.some(service => service.name === SUSPENSION.name)).toBe(false);
  await page.getByRole("button", { name: "Reload Latest Settings", exact: true }).click();
  await page.getByRole("button", { name: "Review with Latest Settings", exact: true }).click();
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveValue("2");
  await expect(page.getByLabel(`${SUSPENSION.name} duration (minutes)`, { exact: true })).toHaveValue("120");
  await saveSettings(page, shop);
  const saved = await shop.scheduling.getSettings();
  expect(saved.settings.capacity).toBe(2);
  expect(saved.settings.serviceCatalog.some(service => service.name === SUSPENSION.name)).toBe(true);
  expect(saved.settings.automaticBookingEnabled).toBe(false);
});

test("requires a saved-state reload after an accepted catalog response is lost without repeating its addition", async ({ page, shop }) => {
  await openSettings(page, shop);
  await addSuspensionDraft(page);
  let loseResponse = true;
  await page.route("**/api/mechanic/scheduling/settings", async route => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    shop.calls.push({ path: SETTINGS_PATH, method: request.method(), body: request.postDataJSON() });
    const response = await route.fetch({ url: `${shop.origin}${SETTINGS_PATH}` });
    if (loseResponse && response.ok()) {
      loseResponse = false;
      return route.abort("failed");
    }
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/could not verify whether the settings were saved/i);
  expect((await shop.scheduling.getSettings()).settings.serviceCatalog.filter(service => service.name === SUSPENSION.name)).toHaveLength(1);
  expect(settingWrites(shop)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deactivate Oil Change", exact: true })).toBeDisabled();
  const getLatest = page.waitForResponse(response => new URL(response.url()).pathname === SETTINGS_PATH && response.request().method() === "GET");
  await page.getByRole("button", { name: "Reload Latest Settings", exact: true }).click();
  expect((await getLatest).status()).toBe(200);
  await page.getByRole("button", { name: "Review with Latest Settings", exact: true }).click();
  await expect(page.getByLabel(`${SUSPENSION.name} duration (minutes)`, { exact: true })).toHaveValue("120");
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toBeDisabled();
  expect(settingWrites(shop)).toHaveLength(1);
  const writeIndex = shop.calls.findIndex(call => call.path === SETTINGS_PATH && call.method === "PATCH");
  expect(shop.calls.slice(writeIndex + 1).some(call => call.path === SETTINGS_PATH && call.method === "GET")).toBe(true);
});

test("fails closed on catalog outages and preserves contact entries when a selected service is deactivated", async ({ page, shop }) => {
  let unavailable = true;
  await page.route("**/api/services", async route => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: "Synthetic catalog outage." } });
    await route.fulfill({ response: await route.fetch({ url: `${shop.origin}/api/services` }) });
  });
  await page.goto("/appointment?service=Oil+Change");
  await expect(page.getByRole("button", { name: "Retry services", exact: true })).toBeVisible();
  await expect(page.locator('[name="service"] option[value="Oil Change"]')).toHaveCount(0);
  expect(shop.calls.filter(call => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(0);
  unavailable = false;
  await page.getByRole("button", { name: "Retry services", exact: true }).click();
  await expect(page.locator('[name="service"]')).toHaveValue("Oil Change");
  await chooseSlot(page);
  for (const field of ["name", "email", "phone", "vehicle", "notes"]) await page.locator(`[name="${field}"]`).fill(CUSTOMER[field]);
  const state = await shop.scheduling.getSettings();
  await shop.scheduling.updateSettings({ serviceCatalog: state.settings.serviceCatalog.map(service => service.name === "Oil Change" ? { ...service, active: false } : service) });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator('[name="service"] option[value="Oil Change"]')).toHaveCount(0);
  for (const field of ["name", "email", "phone", "vehicle", "notes"]) await expect(page.locator(`[name="${field}"]`)).toHaveValue(CUSTOMER[field]);
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toHaveCount(0);
  expect(shop.calls.filter(call => call.path === "/api/appointments" && call.method === "POST")).toHaveLength(0);
});

test("automatically confirms only an enabled verified Wiper request while other selected services remain pending", async ({ page, shop }) => {
  await addSuspensionSaved(shop);
  await shop.scheduling.updateSettings({ automaticBookingEnabled: true, businessHoursVerified: true, capacityVerified: true });
  const wiper = await submitBooking(page, "Wiper Blade Replacement");
  expect(wiper.status).toBe("confirmed");
  await expect(page.getByRole("heading", { name: "You’re on the schedule.", exact: true })).toBeVisible();
  for (const [service, time] of [["Oil Change", "10:00"], ["Cabin Air Filter Replacement", "13:00"], [SUSPENSION.name, "14:00"]]) {
    const result = await page.evaluate(async request => {
      const response = await fetch("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    }, { ...CUSTOMER, service, time });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("pending");
  }
  expect(await shop.Appointment.countDocuments()).toBe(4);
});

test("keeps the catalog editor and custom service cards readable and accessible at responsive widths", async ({ page, shop }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : testInfo.project.name === "tablet" ? 768 : 1440, height: 1000 });
  await openSettings(page, shop);
  await addSuspensionDraft(page);
  await audit(page); await capture(page, testInfo, "service-editor");
  await capture(page, testInfo, "add-service-form", page.locator(".staff-service-add"));
  await saveSettings(page, shop);
  await page.goto("/services");
  await expect(page.getByRole("heading", { name: SUSPENSION.name, exact: true })).toBeVisible();
  await audit(page); await capture(page, testInfo, "service-cards");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await audit(page); await capture(page, testInfo, "service-cards-200-percent-text");
});
