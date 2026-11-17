// CI-only synthetic container check, piped to Node inside the packaged image.
// Never use this against a hosted service or a normal database.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";

assert.equal(process.env.DEPLOYMENT_STAGE, "staging");
assert.match(process.env.MONGODB_DATABASE, /^eds_staging_image_test_/);
const preflight = spawnSync(process.execPath, ["scripts/check-staging.js", "--json"], {
  env: { ...process.env, PUBLIC_WEBSITE_ORIGIN: "https://staging.synthetic-shop.org", APPOINTMENT_MANAGEMENT_SECRET: Buffer.alloc(32, 93).toString("base64url") },
  encoding: "utf8",
});
assert.equal(preflight.status, 0, "Packaged offline staging check must validate the synthetic environment");
assert.equal(JSON.parse(preflight.stdout).deploymentApproved, false);
const origin = "http://127.0.0.1:3001";
const authorization = `Basic ${Buffer.from(`staging:${process.env.STAGING_ACCESS_PASSWORD}`).toString("base64")}`;
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { healthy = (await fetch(`${origin}/api/health`)).ok; } catch { /* wait for local startup */ }
  if (healthy) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(healthy, "Packaged staging API must connect to the disposable database");
for (const path of ["/", "/appointment", "/mechanic", "/api/services", "/api/mechanic/appointments"]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 401, path);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
}
const page = await fetch(`${origin}/appointment`, { headers: { authorization } });
assert.equal(page.status, 200);
assert.equal(page.headers.get("cache-control"), "no-store");
const html = await page.text();
assert.ok(html.includes('<div id="root"></div>'));
const assetPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
assert.ok(assetPath, "Packaged frontend entry asset must exist");
assert.equal((await fetch(origin + assetPath)).status, 401);
const asset = await fetch(origin + assetPath, { headers: { authorization } });
assert.equal(asset.status, 200);
assert.equal(asset.headers.get("cache-control"), "no-store");

const login = await fetch(`${origin}/api/mechanic/login`, {
  method: "POST", headers: { authorization, "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.MECHANIC_ADMIN_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie");
assert.match(cookie, /HttpOnly/i);
assert.match(cookie, /Secure/i);
assert.match(cookie, /SameSite=Strict/i);
const sessionCookie = cookie.split(";")[0];
const session = await login.json();
assert.equal((await fetch(`${origin}/api/mechanic/appointments`, { headers: { authorization } })).status, 401);
const privateHeaders = { authorization, cookie: sessionCookie, "Content-Type": "application/json" };
assert.equal((await fetch(`${origin}/api/mechanic/appointments`, { headers: privateHeaders })).status, 200);
assert.equal((await fetch(`${origin}/api/mechanic/logout`, { method: "POST", headers: privateHeaders })).status, 403);
assert.equal((await fetch(`${origin}/api/mechanic/logout`, { method: "POST", headers: { ...privateHeaders, "x-mechanic-csrf": session.csrfToken } })).status, 200);
assert.equal((await fetch(`${origin}/api/mechanic/appointments`, { headers: privateHeaders })).status, 401);

const service = "Wiper Blade Replacement";
let calendar = await (await fetch(`${origin}/api/availability/calendar?${new URLSearchParams({ service })}`, { headers: { authorization } })).json();
let date = calendar.days.find(day => day.available)?.date;
if (!date && calendar.lastDate.slice(0, 7) !== calendar.month) {
  calendar = await (await fetch(`${origin}/api/availability/calendar?${new URLSearchParams({ service, month: calendar.lastDate.slice(0, 7) })}`, { headers: { authorization } })).json();
  date = calendar.days.find(day => day.available)?.date;
}
assert.ok(date, "Fresh synthetic schedule must offer a future date");
const availability = await (await fetch(`${origin}/api/availability?${new URLSearchParams({ service, date })}`, { headers: { authorization } })).json();
const booking = await fetch(`${origin}/api/appointments`, {
  method: "POST", headers: { authorization, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Synthetic Container Customer", email: "container@example.invalid", phone: "555-555-0123", vehicle: "2018 Honda Civic", service, date, time: availability.slots[0].time, notes: "CI-only synthetic request" }),
});
assert.equal(booking.status, 201);
const saved = await booking.json();
assert.equal(saved.status, "pending", "Untouched seed automation must remain disabled");
assert.equal(saved.emailNotification, "disabled", "Staging must force mail off despite supplied synthetic SMTP settings");
assert.equal(saved.managementAccess, false);
console.log("Packaged protected staging: gateway, assets, sessions, CSRF, booking and forced-mail-off checks passed.");
