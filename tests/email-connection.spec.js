import { test, expect } from "@playwright/test";
import axe from "axe-core";

const RECIPIENT = "contact@edsautoshop.com";
const CSRF = "synthetic-email-connection-csrf-token";
const PASSWORD = "synthetic-email-connection-staff-password";
const CLOCK = +new Date("2030-01-07T12:00:00.000Z");
const PATH = "/api/mechanic/email-test";

// Every API request is fulfilled here, including authentication and logout.
// These rendering tests never connect to MongoDB, load .env, or send mail.
async function isolatedMailbox({ page, context }, overrides = {}) {
  await context.clock.setFixedTime(new Date(CLOCK));
  let authenticated = false;
  let release;
  let sendGate;
  const pending = new Set();
  const state = {
    enabled: true, readStatus: 200, retryAfterSeconds: 0,
    sendStatus: 200, sendError: "Brevo could not accept the test message. Please try again later.",
    reads: 0, sends: [], ...overrides,
    holdNextSend() {
      sendGate = new Promise(resolve => { release = resolve; });
    },
    releaseSend() { release?.(); sendGate = null; },
  };
  const session = () => ({ authenticated: true, csrfToken: CSRF, expiresAt: CLOCK + 8 * 60 * 60 * 1000, idleExpiresAt: CLOCK + 20 * 60 * 1000 });
  const unauthorized = { error: "Mechanic sign-in required." };
  await context.route("**/api/**", async route => {
    const operation = (async () => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.pathname === "/api/mechanic/login" && method === "POST") {
        if (request.postDataJSON()?.password !== PASSWORD) return route.fulfill({ status: 401, json: { error: "Incorrect password." } });
        authenticated = true;
        return route.fulfill({ json: session() });
      }
      if (url.pathname.startsWith("/api/mechanic/") && !authenticated) return route.fulfill({ status: 401, json: unauthorized });
      if (url.pathname === "/api/mechanic/session" && method === "GET") return route.fulfill({ json: session() });
      if (url.pathname === "/api/mechanic/activity" && method === "POST") return route.fulfill({ json: session() });
      if (url.pathname === "/api/mechanic/logout" && method === "POST") {
        expect(request.headers()["x-mechanic-csrf"]).toBe(CSRF);
        authenticated = false;
        return route.fulfill({ json: { authenticated: false } });
      }
      if (url.pathname === "/api/mechanic/appointments" && method === "GET") return route.fulfill({ json: { appointments: [] } });
      if (url.pathname === PATH && method === "GET") {
        state.reads++;
        return route.fulfill({ status: state.readStatus, json: state.readStatus === 200
          ? state.enabled ? { enabled: true, recipient: RECIPIENT, retryAfterSeconds: state.retryAfterSeconds } : { enabled: false }
          : { error: "The optional connection test is unavailable." } });
      }
      if (url.pathname === PATH && method === "POST") {
        state.sends.push({ body: request.postDataJSON(), csrf: request.headers()["x-mechanic-csrf"] });
        if (sendGate) await sendGate;
        if (state.sendStatus !== 200) return route.fulfill({ status: state.sendStatus, json: {
          error: state.sendError, code: "EMAIL_TEST_UNAVAILABLE", providerBody: "PRIVATE_PROVIDER_RESPONSE_MUST_NOT_RENDER",
        } });
        return route.fulfill({ json: { accepted: true, recipient: RECIPIENT, retryAfterSeconds: 60 } });
      }
      return route.fulfill({ status: 503, json: { error: "API disabled in the isolated email-connection rendering fixture." } });
    })();
    pending.add(operation);
    try { await operation; } finally { pending.delete(operation); }
  });
  state.login = async () => {
    await page.goto("/mechanic");
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  };
  state.drain = async () => { state.releaseSend(); await Promise.allSettled([...pending]); };
  return state;
}

const panel = page => page.getByRole("region", { name: "Email connection test", exact: true });
const button = page => panel(page).getByRole("button", { name: "Send test email", exact: true });

for (const [name, options] of [["disabled", { enabled: false }], ["unavailable", { readStatus: 503 }]]) {
  test(`hides the optional connection test when ${name}`, async ({ page, context }) => {
    const mailbox = await isolatedMailbox({ page, context }, options);
    try {
      await mailbox.login();
      await expect.poll(() => mailbox.reads).toBeGreaterThan(0);
      await expect(panel(page)).toHaveCount(0);
      expect(mailbox.sends).toEqual([]);
      await expect(page.getByRole("navigation", { name: "Staff dashboard sections" }).getByRole("button")).toHaveCount(4);
    } finally { await mailbox.drain(); }
  });
}

test("shows the enabled fixed inbox only after staff sign-in without a recipient or message editor", async ({ page, context }) => {
  const mailbox = await isolatedMailbox({ page, context });
  try {
    await page.goto("/mechanic");
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(mailbox.reads).toBe(0);
    await mailbox.login();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText(RECIPIENT);
    await expect(panel(page)).toContainText(/synthetic|test message/i);
    await expect(panel(page)).toContainText(/appointment.*disabled/i);
    await expect(panel(page).getByRole("textbox")).toHaveCount(0);
    await expect(button(page)).toBeEnabled();
    expect(mailbox.sends).toEqual([]);
  } finally { await mailbox.drain(); }
});

test("submits only an empty CSRF-protected request and prevents busy or cooldown resends", async ({ page, context }) => {
  const mailbox = await isolatedMailbox({ page, context });
  try {
    mailbox.holdNextSend();
    await mailbox.login();
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === PATH && response.request().method() === "POST");
    await button(page).click();
    await expect.poll(() => mailbox.sends.length).toBe(1);
    await expect(panel(page).getByRole("button")).toBeDisabled();
    expect(mailbox.sends).toEqual([{ body: {}, csrf: CSRF }]);
    mailbox.releaseSend();
    await accepted;
    await expect(panel(page)).toContainText(/Brevo accepted/i);
    await expect(panel(page)).toContainText(/inbox|spam/i);
    await expect(panel(page).getByRole("button")).toBeDisabled();
    expect(mailbox.sends).toHaveLength(1);
  } finally { await mailbox.drain(); }
});

test("honors a cooldown already in progress when the dashboard opens", async ({ page, context }) => {
  const mailbox = await isolatedMailbox({ page, context }, { retryAfterSeconds: 45 });
  try {
    await mailbox.login();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("button")).toBeDisabled();
    expect(mailbox.sends).toEqual([]);
  } finally { await mailbox.drain(); }
});

test("shows safe rejection feedback without claiming delivery or rendering provider details", async ({ page, context }) => {
  const mailbox = await isolatedMailbox({ page, context }, { sendStatus: 503, sendError: "PRIVATE_PROVIDER_RESPONSE_MUST_NOT_RENDER" });
  try {
    await mailbox.login();
    await button(page).click();
    await expect(panel(page).getByRole("alert")).toBeVisible();
    await expect(panel(page)).toContainText(/could not|unable|not accepted/i);
    await expect(panel(page)).not.toContainText(/Brevo accepted/i);
    await expect(panel(page)).not.toContainText("PRIVATE_PROVIDER_RESPONSE_MUST_NOT_RENDER");
    expect(mailbox.sends).toEqual([{ body: {}, csrf: CSRF }]);
  } finally { await mailbox.drain(); }
});

test("logout hides the connection test and a late provider response cannot restore it", async ({ page, context }) => {
  const mailbox = await isolatedMailbox({ page, context });
  try {
    mailbox.holdNextSend();
    await mailbox.login();
    const reply = page.waitForResponse(response => new URL(response.url()).pathname === PATH && response.request().method() === "POST");
    await button(page).click();
    await expect.poll(() => mailbox.sends.length).toBe(1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    mailbox.releaseSend();
    await reply;
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Staff sign in", exact: true })).toBeVisible();
  } finally { await mailbox.drain(); }
});

test("keeps the email test readable and accessible at narrow widths and enlarged text", async ({ page, context }, testInfo) => {
  const mailbox = await isolatedMailbox({ page, context });
  try {
    await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : testInfo.project.name === "tablet" ? 768 : 1440, height: 1000 });
    await mailbox.login();
    await expect(panel(page)).toBeVisible();
    for (const zoom of [false, true]) {
      if (zoom) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await panel(page).scrollIntoViewIfNeeded();
      const sizes = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return { width, scroll: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll("main *")].map(element => ({ tag: element.tagName, className: element.className,
            text: element.textContent.slice(0, 60), right: Math.round(element.getBoundingClientRect().right) }))
            .filter(element => element.right > width + 1).slice(0, 10) };
      });
      expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.width + 1);
      await page.addScriptTag({ content: axe.source });
      const violations = await panel(page).evaluate(async element => {
        const result = await globalThis.axe.run(element, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
        return result.violations.map(({ id, impact }) => ({ id, impact }));
      });
      expect(violations).toEqual([]);
      const path = testInfo.outputPath(zoom ? "email-test-enlarged.png" : "email-test.png");
      await panel(page).screenshot({ path });
      await testInfo.attach(zoom ? "email-test-enlarged" : "email-test", { path, contentType: "image/png" });
    }
  } finally { await mailbox.drain(); }
});
