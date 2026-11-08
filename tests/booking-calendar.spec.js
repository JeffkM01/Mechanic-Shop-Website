import { test, expect } from "@playwright/test";
import axe from "axe-core";
import { SERVICE_CATEGORIES, SERVICES } from "../shared/services.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

// Deliberately use a shop date, timezone, and horizon unrelated to the browser's
// clock. The customer UI must use the API's calendar bounds and date-only values.
const SHOP = {
  timezone: "Pacific/Honolulu",
  today: "2030-01-29",
  firstDate: "2030-01-30",
  lastDate: "2030-02-05",
  generatedAt: "2030-01-29T20:00:00.000Z",
  settingsProvisional: true,
  policy: { minimumNoticeHours: 6, bookingHorizonDays: 7, pendingHoldHours: 5 },
};
const AVAILABLE_DATES = new Set(["2030-01-30", "2030-01-31", "2030-02-01", "2030-02-04", "2030-02-05"]);
const CUSTOMER = {
  name: "Calendar Test Customer",
  email: "calendar-test@example.invalid",
  phone: "555-555-0123",
  vehicle: "2018 Honda Civic",
  notes: "Please inspect the oil leak; call before any additional work.",
};
const PENDING_MESSAGE = "Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet.";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function durationFor(service) {
  if (service === "Engine Diagnostics") return 90;
  if (/Filter|Wiper/.test(service)) return 30;
  return 60;
}

function monthData(service, month = "2030-01", overrides = {}) {
  const [year, monthNumber] = month.split("-").map(Number);
  const numberOfDays = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    ...SHOP,
    service,
    month,
    durationMinutes: durationFor(service),
    days: Array.from({ length: numberOfDays }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return { date, available: AVAILABLE_DATES.has(date) };
    }),
    ...overrides,
  };
}

function dayData(service, date, times = ["08:00", "14:30"], overrides = {}) {
  const durationMinutes = durationFor(service);
  return {
    ...SHOP,
    service,
    date,
    durationMinutes,
    slots: times.map((time) => {
      const startAt = new Date(`${date}T${time}:00-10:00`);
      return {
        time,
        startAt: startAt.toISOString(),
        endAt: new Date(startAt.getTime() + durationMinutes * 60_000).toISOString(),
        durationMinutes,
      };
    }),
    ...overrides,
  };
}

async function mockScheduling(page, overrides = {}) {
  const state = { calendar: [], days: [], posts: [], order: [], active: 0, maxActive: 0 };
  const pending = new Set();
  function finish(request) {
    pending.delete(request);
    state.active = pending.size;
  }
  page.on("requestfailed", finish);
  await page.route("**/api/availability**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const service = url.searchParams.get("service");
    const isCalendar = url.pathname === "/api/availability/calendar";
    const kind = isCalendar ? "calendar" : "day";
    const requestedMonth = url.searchParams.get("month");
    const month = requestedMonth || "2030-01";
    const date = url.searchParams.get("date");
    const entry = { service, date, month, requestedMonth };
    const entries = isCalendar ? state.calendar : state.days;
    entries.push(entry);
    state.order.push(kind);
    pending.add(request);
    state.active = pending.size;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      const custom = await overrides[kind]?.({ ...entry, index: entries.length, state });
      await route.fulfill({
        status: custom?.status || 200,
        json: custom?.body || (isCalendar ? monthData(service, month) : dayData(service, date)),
      });
    } finally {
      finish(request);
    }
  });
  await page.route("**/api/appointments", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 405, json: { error: "Unexpected test request" } });
      return;
    }
    const body = route.request().postDataJSON();
    state.posts.push(body);
    state.order.push("post");
    const custom = await overrides.post?.({ body, index: state.posts.length, state });
    await route.fulfill({
      status: custom?.status || 201,
      json: custom?.body || {
        id: "calendar-pending-reference",
        status: "pending",
        holdExpiresAt: "2030-01-30T23:00:00.000Z",
        emailNotification: "sent",
      },
    });
  });
  return state;
}

function dateButton(page, date) {
  return page.getByRole("grid").getByRole("button", { name: new RegExp(formatBookingDate(date), "i") });
}

async function openBooking(page, service = "Oil Change") {
  await page.goto(`/appointment?${new URLSearchParams({ service })}`);
  await expect(page.locator('select[name="service"]')).toHaveValue(service);
  await expect(dateButton(page, "2030-01-30")).toHaveAttribute("aria-disabled", "false");
}

async function selectTime(page, date = "2030-01-30", time = "8:00 AM") {
  await dateButton(page, date).click();
  await chooseRadio(page, time);
  const continueButton = page.getByRole("button", { name: /continue.*details/i });
  if (await continueButton.isVisible()) await continueButton.click();
}

async function chooseRadio(page, time) {
  const radio = page.getByRole("radio", { name: time, exact: true });
  await expect(radio).toBeVisible();
  // Click the full, visible label just as a touch user does; the native radio
  // remains focusable but is visually replaced by its generous button label.
  await radio.locator("..").click();
  await expect(radio).toBeChecked();
}

async function fillCustomer(page) {
  for (const [name, value] of Object.entries(CUSTOMER)) {
    await page.locator(`[name="${name}"]`).fill(value);
  }
}

async function reviewRequest(page) {
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toBeVisible();
}

test("uses the shared service groups and preserves canonical, legacy, and provisional links", async ({ page }) => {
  await mockScheduling(page);
  await openBooking(page);
  const select = page.locator('select[name="service"]');
  await expect(select.locator("optgroup")).toHaveCount(SERVICE_CATEGORIES.length);
  for (const category of SERVICE_CATEGORIES) {
    await expect(select.locator(`optgroup[label="${category.label}"] option`))
      .toHaveCount(SERVICES.filter((service) => service.category === category.id).length);
  }
  await page.goto("/appointment?service=Air+Filter+Change");
  await expect(select).toHaveValue("Engine Air Filter Replacement");
  await openBooking(page, "Tire Rotation");
  await expect(page.getByText(/Provisional service\./i)).toBeVisible();
  await expect(page.getByText(/Tire Rotation availability needs Edward.*confirmation/i)).toBeVisible();
});

test("shows only backend slots in 12-hour groups with authoritative shop metadata", async ({ page }) => {
  await mockScheduling(page);
  await openBooking(page);
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "2:30 PM", exact: true })).toBeVisible();
  await expect(page.getByText("Morning", { exact: true })).toBeVisible();
  await expect(page.getByText("Afternoon", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "8:30 AM", exact: true })).toHaveCount(0);
  await expect(page.getByText(SHOP.timezone, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/60-minute booking estimate/).first()).toBeVisible();
  await expect(page.getByText(/not a guaranteed repair completion time|repair completion time may vary/i)).toBeVisible();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
});

test("clears time on date changes and clears date and time when service changes", async ({ page }) => {
  const state = await mockScheduling(page);
  await openBooking(page);
  await selectTime(page);
  await dateButton(page, "2030-01-31").click();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  await chooseRadio(page, "8:00 AM");
  await page.locator('select[name="service"]').selectOption("Engine Diagnostics");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("gridcell", { selected: true })).toHaveCount(0);
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByText(/90-minute booking estimate/).first()).toBeVisible();
  expect(state.days.at(-1).service).toBe("Engine Diagnostics");
});

test("indicates loading and displays the exact empty-date message without claiming fully booked", async ({ page }) => {
  const gate = deferred();
  await mockScheduling(page, {
    day: async ({ service, date }) => {
      await gate.promise;
      return { body: dayData(service, date, []) };
    },
  });
  await openBooking(page);
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByText(/checking.*(availability|times)|loading.*times/i).first()).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  gate.resolve();
  await expect(page.getByText("No appointment times are available for this date. Please choose another day.", { exact: true })).toBeVisible();
  await expect(page.getByText(/fully booked/i)).toHaveCount(0);
});

test("recovers from calendar and selected-day failures through explicit retry controls", async ({ page }) => {
  let calendarFails = true;
  let dayFails = true;
  await mockScheduling(page, {
    calendar: () => {
      if (calendarFails) {
        return { status: 503, body: { error: "Calendar service temporarily unavailable." } };
      }
    },
    day: () => {
      if (dayFails) {
        return { status: 503, body: { error: "Appointment times temporarily unavailable." } };
      }
    },
  });
  await page.goto("/appointment?service=Oil+Change");
  await expect(page.getByRole("alert")).toContainText("Calendar service temporarily unavailable.");
  calendarFails = false;
  await page.getByRole("button", { name: /retry|try again/i }).click();
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByRole("alert")).toContainText("Appointment times temporarily unavailable.");
  dayFails = false;
  await page.getByRole("button", { name: /retry/i }).click();
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toBeVisible();
});

test("ignores an out-of-order day response after the customer changes dates", async ({ page }) => {
  const stale = deferred();
  const state = await mockScheduling(page, {
    day: async ({ service, date }) => {
      if (date === "2030-01-30") await stale.promise;
      return { body: dayData(service, date, date === "2030-01-30" ? ["08:00"] : ["10:00"]) };
    },
  });
  await openBooking(page);
  await dateButton(page, "2030-01-30").click();
  await expect.poll(() => state.days.length).toBe(1);
  await dateButton(page, "2030-01-31").click();
  await expect(page.getByRole("radio", { name: "10:00 AM", exact: true })).toBeVisible();
  stale.resolve();
  await expect.poll(() => state.active).toBe(0);
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "10:00 AM", exact: true })).toBeVisible();
});

test("ignores stale service results and uses one bounded month request rather than a request per day", async ({ page }) => {
  const stale = deferred();
  const state = await mockScheduling(page, {
    calendar: async ({ service, month }) => {
      if (service === "Oil Change") await stale.promise;
      return { body: monthData(service, month) };
    },
  });
  await page.goto("/appointment?service=Oil+Change");
  await expect.poll(() => state.calendar.length).toBeGreaterThanOrEqual(1);
  await page.locator('select[name="service"]').selectOption("Engine Diagnostics");
  await expect(dateButton(page, "2030-01-30")).toHaveAttribute("aria-disabled", "false");
  stale.resolve();
  await expect.poll(() => state.active).toBe(0);
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByText(/90-minute booking estimate/).first()).toBeVisible();
  expect(state.calendar.filter(request => request.service === "Engine Diagnostics")).toHaveLength(1);
  expect(state.calendar.filter(request => request.service === "Oil Change").length).toBeLessThanOrEqual(2);
  expect(state.days).toHaveLength(1);
  expect(state.days[0].service).toBe("Engine Diagnostics");
  expect(state.maxActive).toBeLessThanOrEqual(2);
});

test("ignores an old month response after returning to the cached month", async ({ page }) => {
  const stale = deferred();
  const state = await mockScheduling(page, {
    calendar: async ({ service, month }) => {
      if (month === "2030-02") await stale.promise;
      return { body: monthData(service, month) };
    },
  });
  await openBooking(page);
  const initialCalls = state.calendar.length;
  await page.getByRole("button", { name: /next month/i }).click();
  await expect.poll(() => state.calendar.length).toBe(initialCalls + 1);
  await page.getByRole("button", { name: /previous month/i }).click();
  await expect(page.getByRole("grid")).toHaveAccessibleName("January 2030");
  stale.resolve();
  await expect.poll(() => state.active).toBe(0);
  await expect(page.getByRole("grid")).toHaveAccessibleName("January 2030");
  await expect(dateButton(page, "2030-01-30")).toHaveAttribute("aria-disabled", "false");
  expect(state.calendar).toHaveLength(initialCalls + 1);
  expect(state.days).toHaveLength(0);
  expect(state.maxActive).toBeLessThanOrEqual(2);
});

test("reloads the server-selected month when changed shop bounds invalidate the viewed month", async ({ page }) => {
  let boundsMoved = false;
  const state = await mockScheduling(page, {
    calendar: ({ service, month, requestedMonth }) => {
      if (requestedMonth === "2030-02") {
        boundsMoved = true;
        return { status: 400, body: { code: "MONTH_OUT_OF_RANGE", error: "The shop booking window has changed." } };
      }
      if (boundsMoved) {
        const current = monthData(service, "2030-03", {
          today: "2030-03-01", firstDate: "2030-03-02", lastDate: "2030-03-09",
        });
        return { body: { ...current, days: current.days.map(day => ({ ...day, available: day.date === "2030-03-04" })) } };
      }
      return { body: monthData(service, month) };
    },
  });
  await openBooking(page);
  const initialCalls = state.calendar.length;
  await page.getByRole("button", { name: /next month/i }).click();
  await expect(page.getByRole("grid")).toHaveAccessibleName("March 2030");
  await expect(dateButton(page, "2030-03-04")).toHaveAttribute("aria-disabled", "false");
  await expect(page.getByRole("button", { name: /previous month/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /next month/i })).toBeDisabled();
  expect(state.calendar).toHaveLength(initialCalls + 2);
  expect(state.posts).toHaveLength(0);
});

test("limits calendar navigation to server bounds, preserves date-only labels, and supports the keyboard", async ({ page }) => {
  const state = await mockScheduling(page);
  await openBooking(page);
  const grid = page.getByRole("grid");
  await expect(grid.getByRole("columnheader")).toHaveCount(7);
  await expect(page.getByRole("button", { name: /previous month/i })).toBeDisabled();
  const first = dateButton(page, "2030-01-30");
  await expect(first).toHaveAccessibleName(/01\/30\/2030.*available/i);
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dateButton(page, "2030-01-31")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dateButton(page, "2030-02-01")).toBeFocused();
  await expect(page.getByRole("button", { name: /next month/i })).toBeDisabled();
  const closed = dateButton(page, "2030-02-02");
  await expect(closed).toHaveAttribute("aria-disabled", "true");
  const before = state.days.length;
  await closed.focus();
  await page.keyboard.press("Enter");
  expect(state.days).toHaveLength(before);
  await page.getByRole("button", { name: /previous month/i }).click();
  await expect(dateButton(page, "2030-01-29")).toHaveAccessibleName(/today/i);
});

test("requires explicit time selection and validated customer fields before review", async ({ page }) => {
  const state = await mockScheduling(page);
  await openBooking(page);
  await dateButton(page, "2030-01-30").click();
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toBeVisible();
  const review = page.getByRole("button", { name: "Review Appointment Request", exact: true });
  await expect(review).toBeDisabled();
  await selectTime(page);
  await fillCustomer(page);
  await page.locator('[name="email"]').fill("not-an-email");
  await review.click();
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  await page.locator('[name="email"]').fill(CUSTOMER.email);
  await reviewRequest(page);
});

test("freshly checks review and send, shows the complete summary, and never posts before explicit confirmation", async ({ page }) => {
  const state = await mockScheduling(page);
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await reviewRequest(page);
  expect(state.days).toHaveLength(2);
  expect(state.posts).toHaveLength(0);
  const summary = page.getByRole("region", { name: "Review your appointment request." });
  for (const value of ["Oil Change", "8:00 AM", SHOP.timezone, CUSTOMER.name, CUSTOMER.email, CUSTOMER.phone, CUSTOMER.vehicle, CUSTOMER.notes]) {
    await expect(summary).toContainText(value);
  }
  await expect(summary).toContainText(/01\/30\/2030/);
  await expect(summary).toContainText(/60 minutes/);
  await page.getByRole("button", { name: /edit details/i }).click();
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('[name="notes"]')).toHaveValue(CUSTOMER.notes);
  await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.order[state.order.indexOf("post") - 1]).toBe("day");
  expect(state.posts[0]).toMatchObject({ ...CUSTOMER, service: "Oil Change", date: "2030-01-30", time: "08:00" });
  await expect(page.getByText("calendar-pending-reference", { exact: false })).toBeVisible();
  await expect(page.locator('time[datetime="2030-01-30T23:00:00.000Z"]')).toBeVisible();
  await expect(page.getByText("APPOINTMENT CONFIRMED", { exact: true })).toHaveCount(0);
});

test("rechecks stale slots before sending and does not post when the selected time disappears", async ({ page }) => {
  const state = await mockScheduling(page, {
    day: ({ service, date, index }) => ({ body: dayData(service, date, index >= 3 ? ["14:30"] : ["08:00", "14:30"]) }),
  });
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(/no longer available|choose another time/i);
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toHaveCount(0);
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
});

test("does not open a review when its fresh availability check finds a stale selected time", async ({ page }) => {
  const state = await mockScheduling(page, {
    day: ({ service, date, index }) => ({ body: dayData(service, date, index >= 2 ? ["14:30"] : ["08:00", "14:30"]) }),
  });
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await page.getByRole("button", { name: "Review Appointment Request", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(/no longer available|choose another time/i);
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toHaveCount(0);
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
});

test("requires a new review when the shop changes scheduling details before send", async ({ page }) => {
  const state = await mockScheduling(page, {
    day: ({ service, date, index }) => {
      const current = dayData(service, date);
      if (index < 3) return { body: current };
      return {
        body: {
          ...current,
          timezone: "America/Chicago",
          durationMinutes: 90,
          slots: current.slots.map(slot => {
            const startAt = new Date(`${date}T${slot.time}:00-06:00`);
            return { ...slot, startAt: startAt.toISOString(), endAt: new Date(startAt.getTime() + 90 * 60_000).toISOString(), durationMinutes: 90 };
          }),
        },
      };
    },
  });
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await reviewRequest(page);
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toContainText(SHOP.timezone);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(/scheduling details have changed/i);
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toBeChecked();
  for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  await reviewRequest(page);
  const summary = page.getByRole("region", { name: "Review your appointment request." });
  await expect(summary).toContainText("America/Chicago");
  await expect(summary).toContainText("90 minutes");
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test("recovers from an atomic 409 conflict without losing contact, vehicle, or notes", async ({ page }) => {
  let conflict = false;
  const state = await mockScheduling(page, {
    day: ({ service, date }) => ({ body: dayData(service, date, conflict ? ["14:30"] : ["08:00", "14:30"]) }),
    post: ({ index }) => {
      if (index === 1) {
        conflict = true;
        return { status: 409, body: { error: "That time is no longer available. Please choose another time." } };
      }
    },
  });
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(/no longer available/i);
  await expect(page.getByRole("region", { name: "Review your appointment request." })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "8:00 AM", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  for (const [name, value] of Object.entries(CUSTOMER)) await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  await expect.poll(() => state.calendar.length).toBeGreaterThan(1);
  await chooseRadio(page, "2:30 PM");
  await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toMatchObject({ ...CUSTOMER, time: "14:30" });
});

test("shows confirmed status only when the appointment API explicitly returns confirmed", async ({ page }) => {
  await mockScheduling(page, {
    post: () => ({ body: { id: "confirmed-by-server", status: "confirmed", emailNotification: "sent" } }),
  });
  await openBooking(page);
  await selectTime(page);
  await fillCustomer(page);
  await reviewRequest(page);
  await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
  await expect(page.getByText("APPOINTMENT CONFIRMED", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Your appointment has been confirmed.");
  await expect(page.getByText("confirmed-by-server", { exact: false })).toBeVisible();
  await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toHaveCount(0);
});

test("keeps the calendar and review usable without overflow and passes an automated accessibility audit", async ({ page }, testInfo) => {
  await mockScheduling(page);
  await openBooking(page);
  const day = dateButton(page, "2030-01-30");
  const bounds = await day.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await selectTime(page);
  await fillCustomer(page);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("booking-page.png"), fullPage: true });
  await reviewRequest(page);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("booking-review.png"), fullPage: true });
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1)).toBe(true);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const results = await globalThis.axe.run(globalThis.document.querySelector("main"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return results.violations.map(({ id, impact, description, nodes }) => ({ id, impact, description, targets: nodes.map((node) => node.target) }));
  });
  expect(violations).toEqual([]);
});

test.describe("American display independent of visitor settings", () => {
  test.use({ locale: "en-GB", timezoneId: "Asia/Tokyo" });
  test("keeps numeric U.S. dates and AM/PM in review and success for a non-U.S. visitor", async ({ page }) => {
    const state = await mockScheduling(page);
    await openBooking(page);
    await selectTime(page);
    await fillCustomer(page);
    await reviewRequest(page);
    const summary = page.getByRole("region", { name: "Review your appointment request." });
    await expect(summary).toContainText("01/30/2030");
    await expect(summary).toContainText("8:00 AM");
    await expect(summary).not.toContainText("30/01/2030");
    await page.getByRole("button", { name: "Send Appointment Request", exact: true }).click();
    await expect(page.getByText(PENDING_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.locator('time[datetime="2030-01-30T23:00:00.000Z"]')).toHaveText("01/30/2030 at 1:00 PM");
    await expect(page.locator(".booking-success .booking-summary")).toContainText("01/30/2030");
    expect(state.posts[0]).toMatchObject({ date: "2030-01-30", time: "08:00" });
  });
});
