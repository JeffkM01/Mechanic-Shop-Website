import axe from "axe-core";
import { test, expect, CUSTOMER } from "./mechanic-fixture.js";
import { SERVICES, requiresMechanicApproval } from "../shared/services.js";
import { formatBookingDate, formatBookingTime } from "../src/utils/bookingDates.js";

// Deliberately use a non-US locale and a customer timezone far from Chicago.
// The visible date/time and blocked-time conversion must still be shop-based.
test.use({ locale: "en-GB", timezoneId: "Pacific/Kiritimati" });
test.setTimeout(45_000);

const SETTINGS_PATH = "/api/mechanic/scheduling/settings";
const blockCalls = shop => shop.calls.filter(call => call.path === "/api/mechanic/scheduling/blocks" && call.method === "POST");
const settingWrites = shop => shop.calls.filter(call => call.path === SETTINGS_PATH && call.method === "PATCH");

async function tab(page, name) {
  await page.locator('button').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).click();
}

async function bookingSettings(page) {
  await tab(page, "Booking Settings");
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toBeVisible();
}

async function businessHours(page) {
  await tab(page, "Business Hours");
  await expect(page.getByLabel("Monday open", { exact: true })).toBeVisible();
}

async function closures(page) {
  await tab(page, "Closures & Blocked Times");
  await expect(page.getByRole("heading", { name: "Closed dates", exact: true })).toBeVisible();
}

async function saveChanges(page, shop) {
  const writesBeforeReview = settingWrites(shop).length;
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review scheduling changes", exact: true })).toBeVisible();
  expect(settingWrites(shop), "review alone must never submit settings").toHaveLength(writesBeforeReview);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === SETTINGS_PATH && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Confirm Changes", exact: true }).click();
  await saved;
}

async function rejectInvalidChanges(page, shop) {
  const writesBeforeReview = settingWrites(shop).length;
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review scheduling changes", exact: true })).toHaveCount(0);
  expect(settingWrites(shop)).toHaveLength(writesBeforeReview);
}

async function addClosure(page, value) {
  await page.getByRole("textbox", { name: "Closed date", exact: true }).fill(value);
  await page.getByRole("button", { name: "Add closed date", exact: true }).click();
}

async function fillBlock(page, overrides = {}) {
  const values = { "Block start date": "01/09/2030", "Block start time": "1:00 PM", "Block end date": "01/09/2030", "Block end time": "3:00 PM", ...overrides };
  for (const [label, value] of Object.entries(values)) await page.getByLabel(label, { exact: false }).fill(value);
}

async function expectSetting(shop, key, value) {
  await expect.poll(async () => (await shop.scheduling.getSettings()).settings[key]).toEqual(value);
}

async function audit(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document.querySelector("main"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
}

test("keeps scheduling private and loads the saved configuration without resetting it", async ({ page, shop }) => {
  await shop.scheduling.updateSettings({ capacity: 3, bookingHorizonDays: 21, weeklyHours: { 1: [{ start: "09:15", end: "16:45" }] } });
  const original = await shop.scheduling.getSettings();
  await page.goto("/mechanic");
  await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Business Hours", exact: true })).toHaveCount(0);
  const statuses = await page.evaluate(async () => Promise.all([
    ["GET", "/api/mechanic/scheduling/settings"], ["PATCH", "/api/mechanic/scheduling/settings"],
    ["POST", "/api/mechanic/scheduling/blocks"], ["DELETE", "/api/mechanic/scheduling/blocks/no-such-block"],
  ].map(async ([method, path]) => (await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) })).status)));
  expect(statuses).toEqual([401, 401, 401, 401]);
  await shop.login();
  await bookingSettings(page);
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveValue("3");
  await expect(page.getByLabel("Booking horizon (days)", { exact: false })).toHaveValue("21");
  await businessHours(page);
  await expect(page.getByLabel("Monday opening time 1", { exact: false })).toHaveValue("9:15 AM");
  await expect(page.getByLabel("Monday closing time 1", { exact: false })).toHaveValue("4:45 PM");
  await closures(page);
  await bookingSettings(page);
  expect(shop.calls.filter(call => call.path === SETTINGS_PATH && call.method === "GET")).toHaveLength(2); // unauthenticated probe + one authenticated read
  expect(settingWrites(shop)).toHaveLength(1); // rejected unauthenticated probe only
  expect(await shop.scheduling.getSettings()).toEqual(original);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Shop timezone", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test("edits open days and split working intervals with validation and discard", async ({ page, shop }) => {
  await shop.login();
  await businessHours(page);
  await page.getByLabel("Monday open", { exact: true }).uncheck();
  await expect(page.getByLabel("Monday opening time 1", { exact: false })).toHaveCount(0);
  await page.getByLabel("Monday open", { exact: true }).check();
  await expect(page.getByLabel("Monday opening time 1", { exact: false })).toHaveValue("8:00 AM");
  await page.getByLabel("Monday open", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Add Tuesday interval", exact: true }).click();
  await page.getByLabel("Tuesday closing time 1", { exact: false }).fill("11:30 AM");
  await page.getByLabel("Tuesday opening time 2", { exact: false }).fill("10:00 AM");
  await page.getByLabel("Tuesday closing time 2", { exact: false }).fill("5:00 PM");
  await expect(page.getByRole("alert").filter({ hasText: /overlap/i })).toBeVisible();
  await rejectInvalidChanges(page, shop);
  expect(settingWrites(shop)).toHaveLength(0);
  await page.getByLabel("Tuesday opening time 2", { exact: false }).fill("1:00 PM");
  await saveChanges(page, shop);
  await expectSetting(shop, "weeklyHours", {
    0: [], 1: [], 2: [{ start: "08:00", end: "11:30" }, { start: "13:00", end: "17:00" }],
    3: [{ start: "08:00", end: "17:00" }], 4: [{ start: "08:00", end: "17:00" }], 5: [{ start: "08:00", end: "17:00" }], 6: [],
  });
  expect((await shop.scheduling.getAvailability("Oil Change", "2030-01-14")).slots).toEqual([]);
  await page.getByLabel("Tuesday opening time 1", { exact: false }).fill("9:00 AM");
  await page.getByRole("button", { name: "Discard Changes", exact: true }).click();
  await expect(page.getByLabel("Tuesday opening time 1", { exact: false })).toHaveValue("8:00 AM");
  await expect(page.getByLabel("Monday open", { exact: true })).not.toBeChecked();
  expect((await shop.scheduling.getSettings()).settings.businessHoursVerified).toBe(false);
});

test("saves recurring shop-wide breaks and rejects invalid or overlapping intervals", async ({ page, shop }) => {
  await shop.login();
  await businessHours(page);
  await expect(page.getByText(/not assigned to individual weekdays/i)).toBeVisible();
  await page.getByLabel("Break start time 1", { exact: false }).fill("12:30 PM");
  await page.getByLabel("Break end time 1", { exact: false }).fill("12:00 PM");
  await expect(page.getByRole("alert").filter({ hasText: /after opening|after.*start/i }).first()).toBeVisible();
  await rejectInvalidChanges(page, shop);
  expect(settingWrites(shop)).toHaveLength(0);
  await page.getByLabel("Break end time 1", { exact: false }).fill("1:30 PM");
  await page.getByRole("button", { name: "Add break", exact: true }).click();
  await page.getByLabel("Break start time 2", { exact: false }).fill("1:00 PM");
  await page.getByLabel("Break end time 2", { exact: false }).fill("2:00 PM");
  await expect(page.getByRole("alert").filter({ hasText: /overlap/i })).toBeVisible();
  await page.getByRole("button", { name: "Remove break 2", exact: true }).click();
  await saveChanges(page, shop);
  await expectSetting(shop, "breaks", [{ start: "12:30", end: "13:30" }]);
  const times = (await shop.scheduling.getAvailability("Engine Air Filter Replacement", "2030-01-09")).slots.map(slot => slot.time);
  expect(times).toContain("11:30");
  expect(times).not.toContain("12:30");
  expect(times).not.toContain("13:00");
  await page.getByRole("button", { name: "Remove break 1", exact: true }).click();
  await saveChanges(page, shop);
  await expectSetting(shop, "breaks", []);
});

test("adds sorted American-format closures, prevents duplicates, and confirms removal", async ({ page, shop }) => {
  await shop.login();
  await closures(page);
  await expect(page.getByText("No closed dates are listed.", { exact: true })).toBeVisible();
  await addClosure(page, "02/30/2030");
  await expect(page.getByRole("alert").filter({ hasText: /valid closed date/i })).toBeVisible();
  expect(settingWrites(shop)).toHaveLength(0);
  await addClosure(page, "01/11/2030");
  await addClosure(page, "01/09/2030");
  const list = page.getByRole("list", { name: "Closed dates", exact: true });
  await expect(list.locator("time")).toHaveText(["01/09/2030", "01/11/2030"]);
  await addClosure(page, "01/09/2030");
  await expect(page.getByRole("alert").filter({ hasText: /already listed/i })).toBeVisible();
  await expect(list.locator("li")).toHaveCount(2);
  await saveChanges(page, shop);
  await expectSetting(shop, "closedDates", ["2030-01-09", "2030-01-11"]);
  expect((await shop.scheduling.getAvailability("Oil Change", "2030-01-09")).slots).toEqual([]);
  await page.getByRole("button", { name: "Remove closed date 01/09/2030", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Confirm removing closure 01/09/2030", exact: true });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(list.locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove closed date 01/09/2030", exact: true }).click();
  await confirm.getByRole("button", { name: "Remove closure", exact: true }).click();
  await saveChanges(page, shop);
  await expectSetting(shop, "closedDates", ["2030-01-11"]);
  expect((await shop.scheduling.getAvailability("Oil Change", "2030-01-09")).slots.length).toBeGreaterThan(0);
});

test("creates and removes private blocks using persisted shop-local time rather than browser time", async ({ page, shop }) => {
  await shop.login();
  await closures(page);
  await fillBlock(page);
  const reason = "Private equipment maintenance reason";
  await page.getByLabel("Reason (optional)", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect.poll(async () => (await shop.scheduling.getSettings()).settings.blockedPeriods.length).toBe(1);
  const block = (await shop.scheduling.getSettings()).settings.blockedPeriods[0];
  expect(block).toMatchObject({ startAt: "2030-01-09T19:00:00.000Z", endAt: "2030-01-09T21:00:00.000Z", reason });
  expect(blockCalls(shop)).toHaveLength(1);
  await expect(page.getByRole("list", { name: "Saved blocked periods", exact: true })).toContainText("01/09/2030 at 1:00 PM");
  await expect(page.getByRole("list", { name: "Saved blocked periods", exact: true })).toContainText("01/09/2030 at 3:00 PM");
  const publicResult = await page.evaluate(async () => (await fetch("/api/availability?service=Oil+Change&date=2030-01-09")).json());
  expect(JSON.stringify(publicResult)).not.toContain(reason);
  expect(JSON.stringify(publicResult)).not.toContain(block.id);
  expect(publicResult.slots.some(slot => slot.time === "13:00")).toBe(false);
  await page.getByRole("button", { name: /Remove blocked time 01\/09\/2030 at 1:00 PM/i }).click();
  await page.getByRole("group", { name: /Confirm removing block/i }).getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods).toHaveLength(1);
  await page.getByRole("button", { name: /Remove blocked time 01\/09\/2030 at 1:00 PM/i }).click();
  await page.getByRole("group", { name: /Confirm removing block/i }).getByRole("button", { name: "Remove block", exact: true }).click();
  await expectSetting(shop, "blockedPeriods", []);
  await expect(page.getByText("No blocked periods are saved.", { exact: true })).toBeVisible();
});

test("rejects missing or ambiguous DST times and blocks management while unsaved edits exist", async ({ page, shop }) => {
  await shop.login();
  await closures(page);
  for (const date of ["03/10/2030", "11/03/2030"]) {
    await fillBlock(page, { "Block start date": date, "Block start time": date.startsWith("03") ? "2:30 AM" : "1:30 AM", "Block end date": date, "Block end time": "4:00 AM" });
    await page.getByRole("button", { name: "Add Block", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /missing or ambiguous|clock changes|repeated/i })).toBeVisible();
  }
  expect(blockCalls(shop)).toHaveLength(0);
  await fillBlock(page, { "Block start time": "3:00 PM", "Block end time": "1:00 PM" });
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /end after/i })).toBeVisible();
  expect(blockCalls(shop)).toHaveLength(0);
  await addClosure(page, "01/11/2030");
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeDisabled();
  await expect(page.getByText("Save or discard settings changes before managing blocked time.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard Changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeEnabled();
});

test("saves policy and duration estimates without rewriting historical appointment snapshots", async ({ page, shop }) => {
  const request = await shop.scheduling.createAppointment(CUSTOMER);
  const historical = (await shop.Appointment.findById(request.id).lean()).scheduling;
  await shop.login();
  await bookingSettings(page);
  const changes = {
    "Simultaneous appointment capacity": "2", "Maximum automatic confirmations per day": "4", "Minimum advance notice (hours)": "12",
    "Booking horizon (days)": "21", "Appointment start increment (minutes)": "15", "Appointment buffer (minutes)": "20", "Pending request hold duration (hours)": "48",
    "Oil Change duration (minutes)": "75",
  };
  for (const [label, value] of Object.entries(changes)) await page.getByLabel(label, { exact: false }).fill(value);
  await saveChanges(page, shop);
  const saved = (await shop.scheduling.getSettings()).settings;
  await expectSetting(shop, "capacity", 2);
  expect(saved).toMatchObject({ capacity: 2, maxAutomaticPerDay: 4, minimumNoticeHours: 12, bookingHorizonDays: 21, startIncrementMinutes: 15, bufferMinutes: 20, pendingHoldHours: 48, automaticBookingEnabled: false, businessHoursVerified: false, capacityVerified: false });
  expect(saved.serviceRules["Oil Change"].durationMinutes).toBe(75);
  expect((await shop.scheduling.getAvailability("Oil Change", "2030-01-10")).durationMinutes).toBe(75);
  expect((await shop.Appointment.findById(request.id).lean()).scheduling).toEqual(historical);
  await tab(page, "Appointments");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await expect(card).toContainText("01/09/2030 at 8:00 AM");
  for (const detail of [CUSTOMER.email, CUSTOMER.phone, CUSTOMER.vehicle, CUSTOMER.notes, CUSTOMER.service]) await expect(card).toContainText(detail);
  await expect(card.locator(".mechanic-status")).toHaveText("pending");
});

test("requires explicit verification and automatic-booking confirmation without exposing repair overrides", async ({ page, shop }) => {
  await shop.login();
  await bookingSettings(page);
  const hours = page.getByLabel("Business hours verified", { exact: true });
  const capacity = page.getByLabel("Capacity verified", { exact: true });
  const automatic = page.getByLabel("Automatic booking enabled", { exact: true });
  await expect(hours).not.toBeChecked();
  await expect(capacity).not.toBeChecked();
  await expect(automatic).not.toBeChecked();
  await expect(automatic).toBeDisabled();
  for (const service of SERVICES.filter(requiresMechanicApproval)) {
    await expect(page.getByLabel(`${service.name} requires mechanic approval`, { exact: true })).toHaveCount(0);
  }
  await hours.check();
  await expect(automatic).toBeDisabled();
  await capacity.check();
  await automatic.click();
  await expect(automatic).not.toBeChecked();
  await expect(page.getByRole("group", { name: "Enable automatic booking?", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep automatic booking off", exact: true }).click();
  await expect(automatic).not.toBeChecked();
  await automatic.click();
  await page.getByRole("button", { name: "Enable automatic booking", exact: true }).click();
  await expect(automatic).toBeChecked();
  expect((await shop.scheduling.getSettings()).settings.automaticBookingEnabled).toBe(false);
  await page.getByRole("button", { name: "Discard Changes", exact: true }).click();
  await expect(hours).not.toBeChecked();
  await expect(capacity).not.toBeChecked();
  await expect(automatic).not.toBeChecked();
  await hours.check();
  await capacity.check();
  await saveChanges(page, shop);
  await expectSetting(shop, "businessHoursVerified", true);
  expect((await shop.scheduling.getSettings()).settings.automaticBookingEnabled).toBe(false);
  await businessHours(page);
  await page.getByLabel("Monday opening time 1", { exact: false }).fill("9:00 AM");
  await bookingSettings(page);
  await expect(hours).not.toBeChecked();
  await expect(automatic).toBeDisabled();
  expect((await shop.scheduling.getSettings()).settings.serviceRules["Engine Diagnostics"].requiresApproval).toBe(true);
});

test("shows reservation conflicts without changing saved hours or losing pending appointment details", async ({ page, shop }) => {
  const request = await shop.scheduling.createAppointment(CUSTOMER);
  const original = await shop.scheduling.getSettings();
  await shop.login();
  await businessHours(page);
  await page.getByLabel("Wednesday open", { exact: true }).uncheck();
  await saveChanges(page, shop);
  await expect(page.getByRole("alert").filter({ hasText: /conflicts with a held or confirmed appointment/i })).toBeVisible();
  expect(await shop.scheduling.getSettings()).toEqual(original);
  await expect(page.getByLabel("Wednesday open", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Discard Changes", exact: true }).click();
  await expect(page.getByLabel("Wednesday open", { exact: true })).toBeChecked();
  await closures(page);
  await fillBlock(page, { "Block start time": "8:00 AM", "Block end time": "9:00 AM" });
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /conflicts with a held or confirmed appointment/i })).toBeVisible();
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods).toEqual([]);
  expect((await shop.Appointment.findById(request.id).lean()).status).toBe("pending");
  await tab(page, "Appointments");
  await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) })).toContainText(CUSTOMER.notes);
});

test("recovers from a stale revision only after explicit reload and review while preserving edits", async ({ page, shop }) => {
  await shop.login();
  await bookingSettings(page);
  await page.getByLabel("Simultaneous appointment capacity", { exact: false }).fill("2");
  await shop.scheduling.updateSettings({ bookingHorizonDays: 28 });
  await saveChanges(page, shop);
  await expect(page.getByRole("alert").filter({ hasText: /changed|reload/i }).first()).toBeVisible();
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveValue("2");
  expect((await shop.scheduling.getSettings()).settings.capacity).toBe(1);
  const writesBeforeReload = settingWrites(shop).length;
  await page.getByRole("button", { name: "Reload Latest Settings", exact: true }).click();
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveValue("2");
  expect(settingWrites(shop)).toHaveLength(writesBeforeReload);
  await page.getByRole("button", { name: "Review with Latest Settings", exact: true }).click();
  await expect(page.getByLabel("Booking horizon (days)", { exact: false })).toHaveValue("28");
  await expect(page.getByLabel("Simultaneous appointment capacity", { exact: false })).toHaveValue("2");
  expect((await shop.scheduling.getSettings()).settings.capacity).toBe(1);
  await saveChanges(page, shop);
  await expectSetting(shop, "capacity", 2);
  expect((await shop.scheduling.getSettings()).settings.bookingHorizonDays).toBe(28);
});

test("handles failed reads, CSRF denial, session expiry, and sign-out without retaining private settings", async ({ page, shop }) => {
  shop.faults.settingsRead = true;
  await shop.login();
  await tab(page, "Booking Settings");
  await expect(page.getByRole("alert").filter({ hasText: /temporarily unavailable/i })).toBeVisible();
  shop.faults.settingsRead = false;
  await page.getByRole("button", { name: /retry.*settings/i }).click();
  const capacity = page.getByLabel("Simultaneous appointment capacity", { exact: false });
  await expect(capacity).toBeVisible();
  await capacity.fill("2");
  shop.faults.csrf = true;
  await saveChanges(page, shop);
  await expect(page.getByRole("alert").filter({ hasText: /token missing or invalid|security token/i })).toBeVisible();
  await expect(capacity).toHaveValue("2");
  expect((await shop.scheduling.getSettings()).settings.capacity).toBe(1);
  shop.faults.csrf = false;
  shop.advanceSession(21 * 60_000);
  await saveChanges(page, shop);
  await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  await expect(capacity).toHaveCount(0);
  await expect(page.getByLabel("Shop timezone", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch("/api/mechanic/scheduling/settings")).status);
  expect(status).toBe(401);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect((await shop.scheduling.getSettings()).settings.capacity).toBe(1);
});

test("rejects stale-timezone block conversion until the mechanic reloads and explicitly retries", async ({ page, shop }) => {
  await shop.login();
  await closures(page);
  await fillBlock(page);
  await page.getByLabel("Reason (optional)", { exact: true }).fill("Retain this private reason");
  await shop.scheduling.updateSettings({ timezone: "America/New_York" });
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /settings changed.*reload/i })).toBeVisible();
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods).toEqual([]);
  await expect(page.getByLabel("Block start date", { exact: true })).toHaveValue("01/09/2030");
  await expect(page.getByLabel("Block start time", { exact: true })).toHaveValue("1:00 PM");
  await expect(page.getByLabel("Reason (optional)", { exact: true })).toHaveValue("Retain this private reason");
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeDisabled();
  expect(blockCalls(shop)).toHaveLength(1);
  await page.getByRole("button", { name: "Reload Latest Settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Blocked time", exact: true })).toContainText("America/New_York");
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeEnabled();
  expect(blockCalls(shop)).toHaveLength(1);
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect.poll(async () => (await shop.scheduling.getSettings()).settings.blockedPeriods.length).toBe(1);
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods[0]).toMatchObject({
    startAt: "2030-01-09T18:00:00.000Z", endAt: "2030-01-09T20:00:00.000Z", reason: "Retain this private reason",
  });
  await expect(page.getByRole("list", { name: "Saved blocked periods", exact: true })).toContainText("01/09/2030 at 1:00 PM");
  expect(blockCalls(shop)).toHaveLength(2);
});

test("requires a fresh schedule reload when a block commits but its follow-up read fails", async ({ page, shop }) => {
  await shop.login();
  await closures(page);
  await fillBlock(page);
  shop.faults.failBlockRefresh = true;
  await page.getByRole("button", { name: "Add Block", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /block change was saved.*latest schedule could not be loaded/i })).toBeVisible();
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods).toHaveLength(1);
  expect(blockCalls(shop)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toBeDisabled();
  shop.faults.settingsRead = false;
  shop.faults.failBlockRefresh = false;
  await page.getByRole("button", { name: "Reload Latest Settings", exact: true }).click();
  await expect(page.getByRole("list", { name: "Saved blocked periods", exact: true }).locator("li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add Block", exact: true })).toBeEnabled();
  expect(blockCalls(shop)).toHaveLength(1);
  expect((await shop.scheduling.getSettings()).settings.blockedPeriods).toHaveLength(1);
});

test("keeps appointment dates and every settings section responsive and accessible", async ({ page, shop }, testInfo) => {
  const appointment = await shop.scheduling.createAppointment(CUSTOMER);
  await shop.login();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CUSTOMER.name, exact: true }) });
  await expect(card).toContainText(`${formatBookingDate(CUSTOMER.date)} at ${formatBookingTime(CUSTOMER.time)}`);
  await expect(card.locator(".mechanic-status")).toHaveText("pending");
  expect((await shop.Appointment.findById(appointment.id).lean()).date).toBe("2030-01-09");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("appointments.png"), fullPage: true });
  for (const name of ["Business Hours", "Closures & Blocked Times", "Booking Settings"]) {
    await tab(page, name);
    if (name === "Business Hours") await expect(page.getByLabel("Monday opening time 1", { exact: false })).toHaveValue("8:00 AM");
    if (name === "Closures & Blocked Times") {
      await addClosure(page, "01/11/2030");
      await expect(page.getByRole("list", { name: "Closed dates", exact: true }).locator("time")).toHaveText(["01/11/2030"]);
      await page.getByRole("button", { name: "Discard Changes", exact: true }).click();
    }
    if (name === "Booking Settings") await expect(page.getByLabel("Automatic booking enabled", { exact: true })).not.toBeChecked();
    await audit(page);
    await page.evaluate(() => scrollTo(0, 0));
    const slug = name.toLowerCase().replaceAll(/[^a-z]+/g, "-");
    await page.screenshot({ path: testInfo.outputPath(`${slug}.png`), fullPage: true });
  }
  expect((await shop.scheduling.getSettings()).settings.automaticBookingEnabled).toBe(false);
});
