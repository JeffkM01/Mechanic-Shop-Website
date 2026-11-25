import { test, expect } from "@playwright/test";
import axe from "axe-core";
import { SERVICES } from "../shared/services.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

const RECIPIENT = "contact@edsautoshop.com";
const CLOCK = +new Date("2030-01-07T12:00:00.000Z");
const DATE = "2030-01-08";
const SERVICE = "Wiper Blade Replacement";
const CSRF = "synthetic-appointment-email-csrf";
const PASSWORD = "synthetic-appointment-email-password";
const PUBLIC_STATUS = "/api/appointment-email-test";
const PRIVATE_STATUS = "/api/mechanic/appointment-email-test";
const EXCLUDED = "This older request is excluded from the current email test. No test notification will be sent for it.";
const CUSTOMER = {
  name: "Fictional Email Test Customer",
  phone: "555-555-0123",
  vehicle: "2020 Example Test Vehicle",
  notes: "Fictional appointment for a controlled email test.",
};
const POLICY = {
  timezone: "America/Chicago", today: "2030-01-07", firstDate: DATE, lastDate: "2030-01-21",
  generatedAt: new Date(CLOCK).toISOString(), settingsProvisional: true,
  policy: { minimumNoticeHours: 24, bookingHorizonDays: 14, pendingHoldHours: 24 },
};

function monthData(service, month = "2030-01") {
  const [year, number] = month.split("-").map(Number);
  return {
    ...POLICY, service, month, durationMinutes: 30,
    days: Array.from({ length: new Date(Date.UTC(year, number, 0)).getUTCDate() }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return { date, available: date === DATE };
    }),
  };
}

function dayData(service, date) {
  return {
    ...POLICY, service, date, durationMinutes: 30,
    slots: [{ time: "09:00", startAt: `${date}T15:00:00.000Z`, endAt: `${date}T15:30:00.000Z`, durationMinutes: 30 }],
  };
}

function appointment(id, name, eligible) {
  return {
    _id: id, name, email: RECIPIENT, phone: CUSTOMER.phone, vehicle: CUSTOMER.vehicle,
    notes: CUSTOMER.notes, service: SERVICE, date: DATE, time: "09:00", status: "pending",
    emailTestEligible: eligible,
    scheduling: { timezone: POLICY.timezone, durationMinutes: 30, holdExpiresAt: "2030-01-08T12:00:00.000Z" },
    cancellationEligibility: { canCancel: false },
  };
}

// Every API is fulfilled in this fixture, including session checks and the
// separate connection probe. There is no Express server, database, provider
// connection, .env access, or real mail delivery in these browser tests.
async function isolatedWorkflow({ page, context }, options = {}) {
  await context.clock.setFixedTime(new Date(CLOCK));
  let authenticated = false;
  let statusGate;
  let releaseStatus;
  const pending = new Set();
  const state = {
    body: { enabled: true, recipient: RECIPIENT }, status: 200,
    reads: [], posts: [], mutations: [], unexpected: [], appointments: [], ...options,
    holdStatus() { statusGate = new Promise(resolve => { releaseStatus = resolve; }); },
    releaseStatus() { releaseStatus?.(); statusGate = null; },
  };
  const session = () => ({
    authenticated: true, csrfToken: CSRF,
    expiresAt: CLOCK + 8 * 60 * 60 * 1000, idleExpiresAt: CLOCK + 20 * 60 * 1000,
  });
  await context.route("**/api/**", async route => {
    const operation = (async () => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (path === "/api/services" && method === "GET") return route.fulfill({ json: { revision: 0, services: SERVICES } });
      if (path === "/api/mechanic/login" && method === "POST") {
        if (request.postDataJSON()?.password !== PASSWORD) return route.fulfill({ status: 401, json: { error: "Incorrect password." } });
        authenticated = true;
        return route.fulfill({ json: session() });
      }
      if (path.startsWith("/api/mechanic/") && !authenticated) return route.fulfill({ status: 401, json: { error: "Mechanic sign-in required." } });
      if (path === "/api/mechanic/session" && method === "GET") return route.fulfill({ json: session() });
      if (path === "/api/mechanic/activity" && method === "POST") return route.fulfill({ json: session() });
      if (path === "/api/mechanic/logout" && method === "POST") {
        expect(request.headers()["x-mechanic-csrf"]).toBe(CSRF);
        authenticated = false;
        return route.fulfill({ json: { authenticated: false } });
      }
      if ([PUBLIC_STATUS, PRIVATE_STATUS].includes(path) && method === "GET") {
        state.reads.push(path);
        if (statusGate) await statusGate;
        return route.fulfill({ status: state.status, json: state.body });
      }
      if (path === "/api/mechanic/email-test" && method === "GET") return route.fulfill({ json: { enabled: false } });
      if (path === "/api/mechanic/appointments" && method === "GET") return route.fulfill({ json: { appointments: state.appointments } });
      if (/^\/api\/mechanic\/appointments\//.test(path) && method !== "GET") {
        state.mutations.push({ path, method, body: request.postDataJSON() });
        return route.fulfill({ status: 503, json: { error: "Mutations are disabled in this rendering fixture." } });
      }
      if (path === "/api/availability/calendar" && method === "GET") {
        return route.fulfill({ json: monthData(url.searchParams.get("service"), url.searchParams.get("month") || "2030-01") });
      }
      if (path === "/api/availability" && method === "GET") {
        return route.fulfill({ json: dayData(url.searchParams.get("service"), url.searchParams.get("date")) });
      }
      if (path === "/api/appointments" && method === "POST") {
        state.posts.push(request.postDataJSON());
        return route.fulfill({ status: 201, json: {
          id: "synthetic-appointment-email-reference", status: "pending", emailNotification: "queued",
          holdExpiresAt: "2030-01-08T12:00:00.000Z", managementAccess: false,
        } });
      }
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 503, json: { error: "API disabled in isolated appointment-email rendering fixture." } });
    })();
    pending.add(operation);
    try { await operation; } finally { pending.delete(operation); }
  });
  state.openBooking = async () => {
    await page.goto(`/appointment?${new URLSearchParams({ service: SERVICE })}`);
    await expect(page.getByLabel("Service needed", { exact: true })).toHaveValue(SERVICE);
  };
  state.login = async () => {
    await page.goto("/mechanic");
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  };
  state.drain = async () => { state.releaseStatus(); await Promise.allSettled([...pending]); };
  return state;
}

const notice = page => page.getByRole("region", { name: "Private appointment email test", exact: true });
const email = page => page.getByLabel("Email address", { exact: true });

async function fillFictionalDetails(page) {
  for (const [name, value] of Object.entries(CUSTOMER)) await page.locator(`[name="${name}"]`).fill(value);
}

async function chooseTime(page) {
  const day = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(DATE)) });
  await expect(day).toHaveAttribute("aria-disabled", "false");
  await day.click();
  const choice = page.getByRole("radio", { name: "9:00 AM", exact: true });
  await choice.locator("..").click();
  await expect(choice).toBeChecked();
}

test("locks only the verified inbox and submits the usual appointment payload", async ({ page, context }) => {
  const workflow = await isolatedWorkflow({ page, context });
  try {
    await workflow.openBooking();
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("Use fictional names, phone numbers, vehicle details, and notes.");
    await expect(notice(page)).toContainText("TEST ONLY");
    await expect(email(page)).toHaveValue(RECIPIENT);
    await expect(email(page)).toHaveAttribute("readonly", "");
    await expect(email(page)).toBeEnabled();
    await fillFictionalDetails(page);
    await chooseTime(page);
    await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
    const review = page.getByRole("region", { name: "Review your appointment request.", exact: true });
    await expect(review).toBeVisible();
    await expect(review).toContainText(RECIPIENT);
    expect(workflow.posts).toEqual([]);
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByText("synthetic-appointment-email-reference", { exact: true })).toBeVisible();
    expect(workflow.posts).toEqual([{ ...CUSTOMER, email: RECIPIENT, service: SERVICE, date: DATE, time: "09:00" }]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("preserves unsent name, phone, vehicle and notes when the test notice arrives late", async ({ page, context }) => {
  const workflow = await isolatedWorkflow({ page, context });
  try {
    workflow.holdStatus();
    await workflow.openBooking();
    await expect.poll(() => workflow.reads.length).toBeGreaterThan(0);
    await fillFictionalDetails(page);
    await expect(notice(page)).toHaveCount(0);
    workflow.releaseStatus();
    await expect(notice(page)).toBeVisible();
    await expect(email(page)).toHaveValue(RECIPIENT);
    await expect(email(page)).toHaveAttribute("readonly", "");
    for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
    await page.getByLabel("Service needed", { exact: true }).selectOption("Engine Diagnostics");
    for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
    expect(workflow.posts).toEqual([]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

for (const [name, options] of [
  ["disabled", { body: { enabled: false } }],
  ["unavailable", { status: 503, body: { error: "PRIVATE_PROVIDER_CONFIGURATION_MUST_NOT_RENDER" } }],
  ["unverified", { body: { enabled: true, recipient: "unexpected@example.invalid" } }],
]) {
  test(`leaves ordinary booking editable when the optional test is ${name}`, async ({ page, context }) => {
    const workflow = await isolatedWorkflow({ page, context }, options);
    try {
      const status = page.waitForResponse(response => new URL(response.url()).pathname === PUBLIC_STATUS);
      await workflow.openBooking();
      await status;
      await expect(email(page)).toBeEditable();
      await email(page).fill("fictional-customer@example.invalid");
      await fillFictionalDetails(page);
      await expect(notice(page)).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("PRIVATE_PROVIDER_CONFIGURATION_MUST_NOT_RENDER");
      await chooseTime(page);
      await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
      await expect(page.getByRole("region", { name: "Review your appointment request.", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
      await expect(page.getByText("synthetic-appointment-email-reference", { exact: true })).toBeVisible();
      expect(workflow.posts).toEqual([{ ...CUSTOMER, email: "fictional-customer@example.invalid", service: SERVICE, date: DATE, time: "09:00" }]);
      expect(workflow.unexpected).toEqual([]);
    } finally { await workflow.drain(); }
  });
}

test("shows staff the active test and excludes older rows without changing navigation or sending mail", async ({ page, context }) => {
  const workflow = await isolatedWorkflow({ page, context }, { appointments: [
    appointment("synthetic-current-request", "Fictional Current Test Request", true),
    appointment("synthetic-older-request", "Fictional Older Request", false),
  ] });
  try {
    await page.goto("/mechanic");
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    expect(workflow.reads).toEqual([]);
    await workflow.login();
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText(RECIPIENT);
    await expect(notice(page)).toContainText(/Only newly submitted requests/i);
    await expect(notice(page)).toContainText(/Older requests.*excluded/i);
    const current = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Fictional Current Test Request", exact: true }) });
    const older = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Fictional Older Request", exact: true }) });
    await expect(current).toBeVisible();
    await expect(older).toContainText(EXCLUDED);
    await expect(current).not.toContainText(EXCLUDED);
    await expect(page.getByRole("navigation", { name: "Staff dashboard sections" }).getByRole("button")).toHaveCount(4);
    await expect(page.getByRole("region", { name: "Email connection test", exact: true })).toHaveCount(0);
    expect(workflow.reads).toContain(PRIVATE_STATUS);
    expect(workflow.posts).toEqual([]);
    expect(workflow.mutations).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

test("a delayed staff test status cannot restore private content after logout", async ({ page, context }) => {
  const workflow = await isolatedWorkflow({ page, context });
  try {
    workflow.holdStatus();
    await workflow.login();
    await expect.poll(() => workflow.reads.includes(PRIVATE_STATUS)).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    workflow.releaseStatus();
    await workflow.drain();
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(workflow.mutations).toEqual([]);
    expect(workflow.unexpected).toEqual([]);
  } finally { await workflow.drain(); }
});

for (const view of ["customer", "staff"]) {
  test(`keeps the ${view} test notice readable and accessible at narrow widths and enlarged text`, async ({ page, context }, testInfo) => {
    const workflow = await isolatedWorkflow({ page, context });
    try {
      await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : testInfo.project.name === "tablet" ? 768 : 1440, height: 1000 });
      if (view === "customer") await workflow.openBooking();
      else await workflow.login();
      await expect(notice(page)).toBeVisible();
      for (const zoom of [false, true]) {
        if (zoom) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        await notice(page).scrollIntoViewIfNeeded();
        const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(dimensions.scroll, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.width + 1);
        await page.addScriptTag({ content: axe.source });
        const violations = await notice(page).evaluate(async element => {
          const results = await globalThis.axe.run(element, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
          return results.violations.map(({ id, impact }) => ({ id, impact }));
        });
        expect(violations).toEqual([]);
        // Axe may leave its keyboard-focus probe on the skip link. Restore
        // resting focus before capturing the notice's visual layout.
        await page.evaluate(() => document.activeElement?.blur());
        await expect(page.getByRole("link", { name: "Skip to content", exact: true })).not.toBeInViewport();
        const label = `${view}-appointment-email-test${zoom ? "-enlarged" : ""}`;
        const path = testInfo.outputPath(`${label}.png`);
        await notice(page).screenshot({ path });
        await testInfo.attach(label, { path, contentType: "image/png" });
      }
      expect(workflow.posts).toEqual([]);
      expect(workflow.mutations).toEqual([]);
      expect(workflow.unexpected).toEqual([]);
    } finally { await workflow.drain(); }
  });
}
