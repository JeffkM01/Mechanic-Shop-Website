import { expect } from "@playwright/test";
import { SERVICES } from "../shared/services.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

export const MOBILE_POLICY = Object.freeze({ travelBufferMinutes: 75, requiresMechanicApproval: true });
export const CLOCK = +new Date("2030-01-07T12:00:00.000Z");
export const DATE = "2030-01-08";
export const SERVICE = "Wiper Blade Replacement";
export const CSRF = "synthetic-mobile-review-csrf";
export const CUSTOMER = Object.freeze({
  name: "Fictional Mobile Customer", email: "mobile-customer@example.invalid", phone: "555-555-0123",
  vehicle: "2020 Example Test Vehicle", notes: "Synthetic mobile service request.",
  city: "Synthetic City", state: "MO", postalCode: "63000",
});
const PASSWORD = "synthetic-mobile-review-password";
const METADATA = {
  timezone: "America/Chicago", today: "2030-01-07", firstDate: DATE, lastDate: "2030-01-21",
  generatedAt: new Date(CLOCK).toISOString(), settingsProvisional: false,
  policy: {
    minimumNoticeHours: 24, bookingHorizonDays: 14, pendingHoldHours: 24,
    startIncrementMinutes: 30, bufferMinutes: 75, automaticBookingEnabled: false,
    businessHoursVerified: true, capacityVerified: true,
  },
};

function durationFor(service) { return service === "Engine Diagnostics" ? 90 : 30; }
function calendar(service, month = "2030-01") {
  const [year, number] = month.split("-").map(Number);
  return { ...METADATA, service, month, durationMinutes: durationFor(service),
    days: Array.from({ length: new Date(Date.UTC(year, number, 0)).getUTCDate() }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return { date, available: date === DATE };
    }) };
}
function day(service, date) {
  const durationMinutes = durationFor(service);
  const start = new Date(`${date}T15:00:00.000Z`);
  return { ...METADATA, service, date, durationMinutes,
    slots: [{ time: "09:00", startAt: start.toISOString(), endAt: new Date(+start + durationMinutes * 60_000).toISOString(), durationMinutes }] };
}
export function mobileAppointment({ legacy = false, buffer = 75 } = {}) {
  return {
    _id: "507f1f77bcf86cd799439011", name: CUSTOMER.name, email: CUSTOMER.email, phone: CUSTOMER.phone,
    vehicle: CUSTOMER.vehicle, service: SERVICE, date: DATE, time: "09:00", status: "pending", notes: CUSTOMER.notes,
    scheduling: { timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: buffer, holdExpiresAt: "2030-01-08T12:00:00.000Z" },
    cancellationEligibility: { canCancel: false },
    ...(!legacy ? { mobileVisit: { city: CUSTOMER.city, state: CUSTOMER.state, postalCode: CUSTOMER.postalCode, travelBufferMinutes: buffer } } : {}),
  };
}

// Every API request is intercepted. This fixture has no Express listener,
// database, environment-file access, provider credentials, or mail transport.
export async function mobileWorkflow({ page, context }, options = {}) {
  await context.clock.setFixedTime(new Date(CLOCK));
  let authenticated = false;
  const pending = new Set();
  const state = {
    catalog: { revision: 0, services: SERVICES, mobileBooking: { ...MOBILE_POLICY } },
    appointments: [], posts: [], patches: [], reads: [], unexpected: [],
    bookingError: null, reviewError: null, ...options,
  };
  const session = () => ({ authenticated: true, csrfToken: CSRF,
    expiresAt: CLOCK + 8 * 60 * 60 * 1000, idleExpiresAt: CLOCK + 20 * 60 * 1000 });
  await context.route("**/api/**", async route => {
    const operation = (async () => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (method === "GET") state.reads.push(path);
      if (path === "/api/services" && method === "GET") return route.fulfill({ json: state.catalog });
      if (path === "/api/appointment-email-test" && method === "GET") return route.fulfill({ json: { enabled: false } });
      if (path === "/api/mechanic/login" && method === "POST") {
        if (request.postDataJSON()?.password !== PASSWORD) return route.fulfill({ status: 401, json: { error: "Incorrect password." } });
        authenticated = true;
        return route.fulfill({ json: session() });
      }
      if (path.startsWith("/api/mechanic/") && !authenticated) return route.fulfill({ status: 401, json: { error: "Mechanic sign-in required." } });
      if (["/api/mechanic/session", "/api/mechanic/activity"].includes(path)) return route.fulfill({ json: session() });
      if (path === "/api/mechanic/logout" && method === "POST") {
        expect(request.headers()["x-mechanic-csrf"]).toBe(CSRF);
        authenticated = false;
        return route.fulfill({ json: { authenticated: false } });
      }
      if (["/api/mechanic/email-test", "/api/mechanic/appointment-email-test"].includes(path) && method === "GET") {
        return route.fulfill({ json: { enabled: false } });
      }
      if (path === "/api/mechanic/appointments" && method === "GET") {
        const filter = url.searchParams.get("status") || "pending";
        return route.fulfill({ json: { appointments: state.appointments.filter(item => filter === "all" || item.status === filter) } });
      }
      if (/^\/api\/mechanic\/appointments\/[a-f\d]{24}$/.test(path) && method === "PATCH") {
        expect(request.headers()["x-mechanic-csrf"]).toBe(CSRF);
        const body = request.postDataJSON();
        state.patches.push(body);
        if (state.reviewError) return route.fulfill({ status: state.reviewError.status, json: state.reviewError.body });
        const item = state.appointments.find(entry => path.endsWith(entry._id));
        expect(item).toBeTruthy();
        item.status = body.status;
        if (item.mobileVisit) {
          item.mobileVisit = { ...item.mobileVisit, ...body.mobileReview, reviewedAt: new Date(CLOCK).toISOString() };
          item.scheduling.bufferMinutes = body.mobileReview.travelBufferMinutes;
        }
        return route.fulfill({ json: { id: item._id, status: item.status, emailNotification: "disabled" } });
      }
      if (path === "/api/availability/calendar" && method === "GET") {
        return route.fulfill({ json: calendar(url.searchParams.get("service"), url.searchParams.get("month") || "2030-01") });
      }
      if (path === "/api/availability" && method === "GET") {
        return route.fulfill({ json: day(url.searchParams.get("service"), url.searchParams.get("date")) });
      }
      if (path === "/api/appointments" && method === "POST") {
        state.posts.push(request.postDataJSON());
        if (state.bookingError) return route.fulfill({ status: state.bookingError.status, json: state.bookingError.body });
        return route.fulfill({ status: 201, json: {
          id: "synthetic-mobile-booking-reference", status: "pending", emailNotification: "disabled", managementAccess: false,
          holdExpiresAt: "2030-01-08T12:00:00.000Z",
        } });
      }
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 503, json: { error: "Unexpected API request in synthetic mobile fixture." } });
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
  state.drain = () => Promise.allSettled([...pending]);
  return state;
}

export async function fillCustomer(page, { location = true } = {}) {
  for (const [name, value] of Object.entries(CUSTOMER)) {
    if (!location && ["city", "state", "postalCode"].includes(name)) continue;
    if (name === "state") await page.locator('[name="state"]').selectOption(value);
    else await page.locator(`[name="${name}"]`).fill(value);
  }
}
export async function chooseTime(page) {
  const date = page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(DATE)) });
  await expect(date).toHaveAttribute("aria-disabled", "false");
  await date.click();
  const time = page.getByRole("radio", { name: "9:00 AM", exact: true });
  await time.locator("..").click();
  await expect(time).toBeChecked();
}

export async function reviewRequest(page) {
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  const review = page.getByRole("region", { name: "Review your appointment request.", exact: true });
  await expect(review).toBeVisible();
  return review;
}
