import { test, expect } from "@playwright/test";
import axe from "axe-core";
import { CUSTOMER, DATE, SERVICE, chooseTime, fillCustomer, mobileAppointment, mobileWorkflow, reviewRequest } from "./mobile-booking-fixture.js";

const dialog = page => page.getByRole("dialog", { name: "Review mobile appointment", exact: true });
const coverage = page => dialog(page).getByRole("checkbox", { name: "I checked service coverage, the private visit address, and site access.", exact: true });
const travel = page => dialog(page).getByRole("checkbox", { name: "I checked the route between appointments and allowed enough travel time.", exact: true });
const buffer = page => dialog(page).getByLabel("Travel buffer (minutes)", { exact: true });
const confirm = page => dialog(page).getByRole("button", { name: "Confirm mobile appointment", exact: true });

async function openMobileReview(page, workflow) {
  await workflow.login();
  await expect(page.getByRole("article")).toContainText(CUSTOMER.city);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

test("requires a private city, supported state and ZIP before a mobile request can be reviewed", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context });
  try {
    await workflow.openBooking();
    await expect(page.getByRole("heading", { name: "Where should we visit?", exact: true })).toBeVisible();
    await fillCustomer(page, { location: false });
    await chooseTime(page);
    await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
    for (const name of ["city", "state", "postalCode"]) await expect(page.locator(`[name="${name}"]`)).toHaveAttribute("aria-invalid", "true");
    expect(workflow.posts).toEqual([]);
    await page.locator('[name="city"]').fill(CUSTOMER.city);
    await page.locator('[name="state"]').selectOption("MO");
    await page.locator('[name="postalCode"]').fill("12AB");
    await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
    await expect(page.locator('[name="postalCode"]')).toHaveAttribute("aria-invalid", "true");
    const states = await page.locator('[name="state"] option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
    expect(states.sort()).toEqual(["IL", "MO"]);
    await page.locator('[name="postalCode"]').fill(CUSTOMER.postalCode);
    await reviewRequest(page);
    expect(workflow.posts).toEqual([]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("reviews location and travel separately from service duration and saves wipers as pending", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context });
  try {
    await workflow.openBooking();
    await fillCustomer(page);
    await chooseTime(page);
    const review = await reviewRequest(page);
    await expect(review).toContainText(CUSTOMER.city);
    await expect(review).toContainText(CUSTOMER.postalCode);
    await expect(review).toContainText("75");
    await expect(review).toContainText(/travel allowance/i);
    await expect(page.locator("main")).toContainText(/mobile requests require mechanic approval/i);
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByText("synthetic-mobile-booking-reference", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("awaiting the mechanic’s coverage, location, and travel review");
    await expect(page.getByRole("status")).toContainText("not confirmed yet");
    expect(workflow.posts).toEqual([{ ...CUSTOMER, service: SERVICE, date: DATE, time: "09:00" }]);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(storage).not.toContain(CUSTOMER.city);
    expect(storage).not.toContain(CUSTOMER.postalCode);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("preserves private mobile details through service changes and a lost slot", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context }, { bookingError: {
    status: 409, body: { error: "That time is no longer available.", code: "SLOT_UNAVAILABLE" },
  } });
  try {
    await workflow.openBooking();
    await fillCustomer(page);
    await page.getByLabel("Service needed", { exact: true }).selectOption("Engine Diagnostics");
    for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
    await chooseTime(page);
    await reviewRequest(page);
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /no longer available/i })).toBeVisible();
    for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
    expect(workflow.posts).toHaveLength(1);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("fails closed when catalog mobile policy is malformed", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context });
  workflow.catalog.mobileBooking = { travelBufferMinutes: 75, requiresMechanicApproval: false };
  try {
    await page.goto("/appointment");
    await expect(page.getByRole("alert").filter({ hasText: /current services could not be loaded/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Appointment Request", exact: true })).toHaveCount(0);
    await expect(page.locator("main form")).toHaveCount(0);
    expect(workflow.posts).toEqual([]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("requires a fresh customer review when the mobile allowance changes before submission", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context });
  try {
    await workflow.openBooking();
    await fillCustomer(page);
    await chooseTime(page);
    await reviewRequest(page);
    workflow.catalog.mobileBooking.travelBufferMinutes = 90;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/services");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await expect(page.locator(".booking-mobile-notice")).toContainText("90 minutes");
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("mobile booking rules changed");
    expect(workflow.posts).toEqual([]);
    for (const name of ["city", "state", "postalCode"]) await expect(page.locator(`[name="${name}"]`)).toHaveValue(CUSTOMER[name]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("requires both mechanic acknowledgments and retains the booked travel minimum", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context }, { appointments: [mobileAppointment()] });
  try {
    await openMobileReview(page, workflow);
    await expect(buffer(page)).toHaveValue("75");
    await expect(buffer(page)).toHaveAttribute("min", "75");
    await expect(buffer(page)).toHaveAttribute("max", "120");
    await confirm(page).click();
    expect(workflow.patches).toEqual([]);
    await coverage(page).check();
    await confirm(page).click();
    expect(workflow.patches).toEqual([]);
    await travel(page).check();
    await buffer(page).fill("74");
    await confirm(page).click();
    expect(workflow.patches).toEqual([]);
    await buffer(page).fill("90");
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(workflow.patches).toEqual([{ status: "confirmed", mobileReview: {
      locationConfirmed: true, travelConfirmed: true, travelBufferMinutes: 90,
    } }]);
    expect(workflow.appointments[0].status).toBe("confirmed");
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("reports an approval travel conflict without confirming or declining the pending request", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context }, { appointments: [mobileAppointment()], reviewError: {
    status: 409, body: { error: "The extended travel allowance conflicts with another reservation.", code: "SLOT_UNAVAILABLE" },
  } });
  try {
    await openMobileReview(page, workflow);
    await coverage(page).check();
    await travel(page).check();
    await buffer(page).fill("120");
    await confirm(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(/conflict/i);
    await expect(dialog(page)).toBeVisible();
    expect(workflow.appointments[0].status).toBe("pending");
    expect(workflow.patches).toEqual([{ status: "confirmed", mobileReview: {
      locationConfirmed: true, travelConfirmed: true, travelBufferMinutes: 120,
    } }]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("preserves legacy staff approval without adding location history", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context }, { appointments: [mobileAppointment({ legacy: true })] });
  try {
    await workflow.login();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /appointment confirmed/i })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(workflow.patches).toEqual([{ status: "confirmed" }]);
    expect(workflow.appointments[0].mobileVisit).toBeUndefined();
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("removes the mobile review and private location when staff signs out", async ({ page, context }) => {
  const workflow = await mobileWorkflow({ page, context }, { appointments: [mobileAppointment()] });
  try {
    await openMobileReview(page, workflow);
    await coverage(page).check();
    // Close the modal before using the workspace's sign-out control, as its
    // focus trap deliberately prevents interacting with background content.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(CUSTOMER.city);
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(workflow.patches).toEqual([]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

for (const view of ["customer", "staff"]) {
  test(`keeps ${view} mobile booking readable and accessible at narrow widths and enlarged text`, async ({ page, context }, testInfo) => {
    const workflow = await mobileWorkflow({ page, context }, { appointments: [mobileAppointment()] });
    try {
      await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : testInfo.project.name === "tablet" ? 768 : 1440, height: 1000 });
      if (view === "customer") { await workflow.openBooking(); await fillCustomer(page); }
      else await openMobileReview(page, workflow);
      for (const enlarged of [false, true]) {
        if (enlarged) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async staff => {
          const root = staff ? document.querySelector("dialog[open]") : document.querySelector("main");
          const results = await globalThis.axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
          return results.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
        }, view === "staff");
        expect(violations).toEqual([]);
        const label = `mobile-${view}${enlarged ? "-200-percent-text" : ""}`;
        const path = testInfo.outputPath(`${label}.png`);
        await page.screenshot({ path, fullPage: true, animations: "disabled" });
        await testInfo.attach(label, { path, contentType: "image/png" });
      }
      expect(workflow.posts).toEqual([]);
      expect(workflow.patches).toEqual([]);
      expect(workflow.unexpected).toEqual([]);
    } finally { await workflow.drain(); }
  });
}
