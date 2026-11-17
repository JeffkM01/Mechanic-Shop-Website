import axe from "axe-core";
import { test, expect } from "./cancellation-fixture.js";
import { businessProfile, validateBusinessProfile } from "../shared/businessProfile.js";
import { approvedBusinessProfile, draftBusinessProfile } from "./business-profile-fixtures.js";
import { formatBookingDate } from "../src/utils/bookingDates.js";

// Only the synthetic isolated Mongo/Express fixture is used. No .env, normal
// shop database, production origin, or SMTP transport is loaded by this suite.
test.use({ locale: "en-GB", timezoneId: "Pacific/Kiritimati" });
test.setTimeout(60_000);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DRAFT = "Draft — awaiting Edward’s approval";

async function assertContactDetails(page, profile) {
  if (!profile.contact.confirmed) {
    for (const value of ["Phone number to be confirmed", "Public email to be confirmed", "Shop address to be confirmed"]) await expect(page.getByText(value, { exact: true })).toBeVisible();
    await expect(page.locator("main a[href^='tel:'], main a[href^='mailto:']")).toHaveCount(0);
  } else {
    await expect(page.getByRole("link", { name: profile.contact.phone, exact: true })).toHaveAttribute("href", /^tel:\+/);
    await expect(page.getByRole("link", { name: profile.contact.email, exact: true })).toHaveAttribute("href", `mailto:${encodeURIComponent(profile.contact.email)}`);
    for (const line of profile.contact.addressLines) await expect(page.locator("main")).toContainText(line);
    await expect(page.getByText("Contact details are being confirmed.", { exact: true })).toHaveCount(0);
  }
}

async function assertPolicyNotice(page, policy) {
  if (!policy.approved) {
    await expect(page.getByText(DRAFT, { exact: true })).toBeVisible();
    await expect(page.locator("main .policy-effective")).toHaveCount(0);
  } else {
    await expect(page.getByText(DRAFT, { exact: true })).toHaveCount(0);
    const effective = page.locator("main .policy-effective time");
    await expect(effective).toHaveAttribute("datetime", policy.effectiveDate);
    await expect(effective).toHaveText(formatBookingDate(policy.effectiveDate));
  }
}

async function assertPrivacyProviders(page, profile) {
  const providers = [
    ["Website and API hosting", profile.privacy.hostingProvider, "Hosting provider to be confirmed before launch."],
    ["Appointment database", profile.privacy.databaseProvider, "Appointment records use MongoDB. The production database provider and location are awaiting confirmation."],
    ["Email delivery", profile.privacy.emailProvider, "Email provider to be confirmed before launch."],
  ];
  for (const [label, configured, fallback] of providers) {
    const row = page.locator(".policy-provider-list > div").filter({ has: page.getByText(label, { exact: true }) });
    await expect(row.locator("dd")).toHaveText(configured || fallback);
  }
}

async function useSyntheticProfile(page, profile) {
  const validated = validateBusinessProfile(profile);
  let supplied = false;
  // Replace only the browser's Vite JSON module response, before navigation.
  // Production components still perform their usual schema validation; neither
  // the source profile nor any real business approval is changed.
  await page.route("**/shared/businessProfile.json*", route => {
    supplied = true;
    return route.fulfill({ contentType: "text/javascript", body: `export default ${JSON.stringify(validated)};` });
  });
  // These rendering cases need no database. Prevent every API request from
  // reaching a normal development server, including background catalog reads.
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/shop-hours"
    ? route.fulfill({ json: { verified: false, timezone: "America/Chicago", weeklyHours: null, breaks: [], closedDates: [] } })
    : route.fulfill({ status: 503, json: { error: "API unavailable in the isolated profile-rendering fixture." } }));
  return () => expect(supplied, "the rendered profile must come from the synthetic browser fixture").toBe(true);
}

async function openContact(page) {
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/shop-hours");
  await page.goto("/contact");
  const response = await reply;
  await expect(page.getByRole("heading", { name: "Shop hours", exact: true })).toBeVisible();
  return response;
}

function hours(page) { return page.locator(".contact-hours"); }
function dayRow(page, day) { return hours(page).locator("dl > div").filter({ has: page.getByText(day, { exact: true }) }); }

async function assertUnconfirmedHours(page) {
  for (const day of DAYS) await expect(dayRow(page, day)).toContainText(/to be confirmed/i);
  await expect(dayRow(page, "Sunday")).not.toContainText(/closed|no appointments/i);
  await expect(hours(page)).not.toContainText(/8:00 AM|5:00 PM|12:00 PM/);
}

async function audit(page) {
  const sizes = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scroll = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const overflow = scroll > width + 1 ? [...document.querySelectorAll("main *")].map(element => ({
      element: `${element.tagName.toLowerCase()}.${element.className}`, text: element.textContent.slice(0, 80), right: Math.round(element.getBoundingClientRect().right),
    })).filter(element => element.right > width + 1).sort((a, b) => b.right - a.right).slice(0, 12) : [];
    return { width, scroll, overflow };
  });
  expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width + 1);
  await page.addScriptTag({ content: axe.source });
  const issues = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document.querySelector("main"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  });
  expect(issues).toEqual([]);
}

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("renders configured contact information and keeps unverified operating hours unadvertised", async ({ page, shop }) => {
  const response = await openContact(page);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toMatchObject({ verified: false, weeklyHours: null, breaks: [], closedDates: [] });
  await assertContactDetails(page, businessProfile);
  await expect(page.locator("main")).not.toContainText("(555) 010-2020");
  await expect(page.locator("main")).not.toContainText("hello@edsautoshop.example");
  await expect(page.locator("main")).not.toContainText("[Street address]");
  await assertUnconfirmedHours(page);
  expect((await shop.scheduling.getSettings()).settings.businessHoursVerified).toBe(false);
});

test("displays only verified saved hours including Sunday openings, recurring breaks, and closed dates", async ({ page, shop }) => {
  const saved = await shop.scheduling.getSettings();
  const weeklyHours = { ...saved.settings.weeklyHours, "0": [{ start: "10:00", end: "14:00" }], "5": [{ start: "13:00", end: "24:00" }], "6": [] };
  await shop.scheduling.updateSettings({ timezone: "America/Los_Angeles", weeklyHours, breaks: [{ start: "12:00", end: "13:00" }], closedDates: ["2030-01-10"], businessHoursVerified: true });
  await shop.scheduling.addBlockedPeriod({ startAt: "2030-01-11T16:00:00.000Z", endAt: "2030-01-11T17:00:00.000Z", reason: "Private synthetic staff-only explanation" });
  const response = await openContact(page);
  const details = await response.json();
  expect(details).toMatchObject({ verified: true, timezone: "America/Los_Angeles", weeklyHours, breaks: [{ start: "12:00", end: "13:00" }], closedDates: ["2030-01-10"] });
  expect(Object.keys(details).sort()).toEqual(["verified", "timezone", "weeklyHours", "breaks", "closedDates"].sort());
  expect(JSON.stringify(details)).not.toContain("Private synthetic staff-only explanation");
  await expect(dayRow(page, "Sunday")).toContainText("10:00 AM");
  await expect(dayRow(page, "Sunday")).toContainText("2:00 PM");
  await expect(dayRow(page, "Sunday")).not.toContainText(/closed|no appointments/i);
  await expect(dayRow(page, "Saturday")).toContainText(/closed/i);
  await expect(dayRow(page, "Friday")).toContainText("12:00 AM (end of day)");
  await expect(hours(page)).toContainText("America/Los_Angeles");
  await expect(hours(page)).toContainText("12:00 PM");
  await expect(hours(page)).toContainText("1:00 PM");
  await expect(hours(page)).toContainText("01/10/2030");
  // Editing hours clears their verification. A still-open Contact page must
  // not continue presenting the old Sunday opening as approved shop hours.
  await shop.scheduling.updateSettings({ weeklyHours: { "0": [] } });
  const refreshed = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/shop-hours");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).status()).toBe(200);
  await assertUnconfirmedHours(page);
});

test("fails closed when saved shop hours cannot be read or verified instead of restoring placeholder hours", async ({ page, shop }) => {
  let failed = true;
  await page.route("**/api/shop-hours", async route => {
    if (failed) return route.fulfill({ status: 503, json: { error: "Synthetic hours outage." } });
    return route.fulfill({ response: await route.fetch({ url: `${shop.origin}/api/shop-hours` }) });
  });
  const response = await openContact(page);
  expect(response.status()).toBe(503);
  await expect(hours(page)).toContainText(/could not be verified/i);
  await assertUnconfirmedHours(page);
  failed = false;
  await shop.scheduling.updateSettings({ businessHoursVerified: true });
  const retry = page.getByRole("button", { name: /retry.*hours/i });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(hours(page)).toContainText("Confirmed hours");
  await expect(hours(page)).not.toContainText(/could not be verified/i);
  // A refresh failure must also discard an already-visible verified schedule.
  failed = true;
  const refreshed = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/shop-hours");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).status()).toBe(503);
  await assertUnconfirmedHours(page);
  await expect(hours(page)).toContainText(/could not be verified/i);
});

test("opens configured privacy information from the footer without inventing provider guarantees", async ({ page, shop }) => {
  await shop.scheduling.getSettings();
  await page.goto("/");
  const link = page.locator(".site-footer").getByRole("link", { name: "Privacy information", exact: true });
  await expect(link).toHaveAttribute("href", "/privacy");
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy information", exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/Privacy information.*Ed/i);
  await expect(page.locator("#main-content")).toBeFocused();
  await assertPolicyNotice(page, businessProfile.privacy);
  await assertPrivacyProviders(page, businessProfile);
  await expect(page.locator("main")).toContainText(/email|phone/i);
  await expect(page.locator("main")).not.toContainText(/Vercel never sells|providers never share|guaranteed.*privacy/i);
});

test("opens the configured until-start cancellation policy without inventing fees or rescheduling", async ({ page, shop }) => {
  await shop.scheduling.getSettings();
  await page.goto("/");
  const link = page.locator(".site-footer").getByRole("link", { name: "Cancellation policy", exact: true });
  await expect(link).toHaveAttribute("href", "/cancellation-policy");
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cancellation-policy$/);
  await expect(page.getByRole("heading", { name: "Cancellation policy", exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/Cancellation policy.*Ed/i);
  await assertPolicyNotice(page, businessProfile.cancellation);
  await expect(page.locator("main")).toContainText(/pending/);
  await expect(page.locator("main")).toContainText(/confirmed/);
  await expect(page.locator("main")).toContainText(/start/);
  await expect(page.locator("main")).toContainText(/no cancellation fee|no.*fee/i);
  await expect(page.getByRole("button", { name: /reschedule/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /reschedule/i })).toHaveCount(0);
});

for (const [state, fixture] of [["draft", draftBusinessProfile], ["approved", approvedBusinessProfile]]) {
  test(`renders ${state} synthetic contact and policies through the actual public routes`, async ({ page }) => {
    const profile = fixture();
    const assertSupplied = await useSyntheticProfile(page, profile);
    await openContact(page);
    assertSupplied();
    await assertContactDetails(page, profile);
    await assertUnconfirmedHours(page);

    await page.locator(".site-footer").getByRole("link", { name: "Privacy information", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Privacy information", exact: true })).toBeVisible();
    await assertPolicyNotice(page, profile.privacy);
    await assertPrivacyProviders(page, profile);
    if (profile.privacy.approved) {
      await expect(page.locator("main")).toContainText(profile.privacy.retentionPolicy);
      await expect(page.locator("main")).toContainText(profile.privacy.requestInstructions);
      await expect(page.getByRole("link", { name: profile.contact.email, exact: true })).toBeVisible();
    } else {
      await expect(page.locator("main")).toContainText("The shop has not yet confirmed its retention period and deletion process.");
      await expect(page.locator("main")).toContainText("The process for requesting access, corrections, or deletion of personal information is awaiting the shop's confirmation.");
    }

    await page.locator(".site-footer").getByRole("link", { name: "Cancellation policy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Cancellation policy", exact: true })).toBeVisible();
    await assertPolicyNotice(page, profile.cancellation);
    await expect(page.locator("main")).toContainText(profile.cancellation.approved
      ? "There is no cancellation fee under this policy."
      : "Edward must approve this policy before public launch.");
  });
}

test("keeps contact and policy pages accessible and readable at narrow widths and 200 percent text size", async ({ page, shop }, testInfo) => {
  test.setTimeout(120_000);
  await shop.scheduling.getSettings();
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : testInfo.project.name === "tablet" ? 768 : 1440, height: 1000 });
  for (const [path, heading, name] of [["/contact", "Let's get you moving.", "contact"], ["/privacy", "Privacy information", "privacy"], ["/cancellation-policy", "Cancellation policy", "cancellation-policy"]]) {
    if (path === "/contact") await openContact(page); else await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await audit(page); await capture(page, testInfo, name);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await audit(page); await capture(page, testInfo, `${name}-200-percent-text`);
  }
});
