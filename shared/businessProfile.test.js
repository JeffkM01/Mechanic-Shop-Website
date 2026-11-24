import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { businessProfile, businessProfileLaunchIssues, validateBusinessProfile } from "./businessProfile.js";
import { approvedBusinessProfile, draftBusinessProfile } from "../tests/business-profile-fixtures.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const approvedFixture = approvedBusinessProfile;
const copy = draftBusinessProfile;

test("the checked-in profile is valid whether business details are draft or approved", () => {
  assert.deepEqual(validateBusinessProfile(businessProfile), businessProfile);
  assert.deepEqual(businessProfileLaunchIssues(), businessProfileLaunchIssues(businessProfile));
});

test("an explicit draft profile keeps unknown contacts and unapproved policies as launch blockers", () => {
  const source = draftBusinessProfile();
  assert.deepEqual(validateBusinessProfile(source), source);
  const codes = businessProfileLaunchIssues(source).map(issue => issue.code);
  for (const code of ["SHOP_CONTACT_UNCONFIRMED", "PRIVACY_NOTICE_UNAPPROVED", "PRIVACY_HOSTING_PROVIDER_UNCONFIRMED", "PRIVACY_RETENTION_POLICY_UNCONFIRMED", "CANCELLATION_POLICY_UNAPPROVED", "CANCELLATION_DATE_UNCONFIRMED"]) assert.ok(codes.includes(code), code);
});

test("complete owner-approved synthetic configuration passes profile checks without inventing business defaults", () => {
  const source = approvedFixture();
  const validated = validateBusinessProfile(source);
  assert.deepEqual(validated, source);
  assert.deepEqual(businessProfileLaunchIssues(source), []);
  assert.deepEqual(source, approvedFixture());
});

test("unit suite accepts an approved source profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "eds-approved-profile-unit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(["shared", "src/utils", "server", "tests"].map(directory => mkdir(join(root, directory), { recursive: true })));
  await Promise.all([
    cp(join(project, "shared"), join(root, "shared"), { recursive: true }),
    cp(join(project, "src/utils"), join(root, "src/utils"), { recursive: true }),
    cp(join(project, "server/schedulingRules.js"), join(root, "server/schedulingRules.js")),
    cp(join(project, "tests/business-profile-fixtures.js"), join(root, "tests/business-profile-fixtures.js")),
  ]);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  // Only this disposable copy receives approved synthetic values. The source
  // profile and its owner's approval state are never modified by the test.
  await writeFile(join(root, "shared/businessProfile.json"), JSON.stringify(approvedFixture()));
  const unitFiles = (await Promise.all(["shared", "src/utils"].map(async directory =>
    (await readdir(join(root, directory))).filter(file => file.endsWith(".test.js")).map(file => join(directory, file))
  ))).flat();
  const result = spawnSync(process.execPath, ["--test", "--test-skip-pattern=^unit suite accepts an approved source profile$", ...unitFiles], {
    cwd: root, env: {}, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
});

test("public profile fields are strict and errors never echo extra secret values", () => {
  for (const patch of [null, [], {}, { ...copy(), schemaVersion: 2 }, { ...copy(), SMTP_PASS: "DO-NOT-ECHO-PRIVATE-VALUE" }]) {
    assert.throws(() => validateBusinessProfile(patch));
    const issues = businessProfileLaunchIssues(patch);
    assert.equal(issues[0].code, "INVALID_BUSINESS_PROFILE");
    assert.equal(JSON.stringify(issues).includes("DO-NOT-ECHO-PRIVATE-VALUE"), false);
  }
  for (const section of ["contact", "privacy", "cancellation"]) {
    const source = copy(); source[section].unexpected = true;
    assert.throws(() => validateBusinessProfile(source), /documented public fields/);
  }
  const inherited = copy(); inherited.contact = Object.assign(Object.create({ inherited: true }), inherited.contact);
  assert.throws(() => validateBusinessProfile(inherited), /documented public fields/);
});

test("contact confirmation requires bounded public phone, email and address instead of incomplete or reserved placeholders", () => {
  for (const patch of [{ phone: null }, { email: null }, { addressLines: [] }, { phone: "call me" }, { phone: "202-555-0148 ext 3" }, { email: "Display Name <shop@synthetic-shop-unit-check.net>" }, { email: "shop@synthetic-shop-unit-check.net,other@synthetic-shop-unit-check.net" }, { email: "shop@site.invalid" }, { email: "shop@site.example" }, { email: "shop@example.com" }, { email: "shop@mail.example.net" }, { email: "shop@example.org" }, { addressLines: [" "] }, { addressLines: ["x".repeat(121)] }]) {
    const source = approvedFixture(); Object.assign(source.contact, patch);
    assert.throws(() => validateBusinessProfile(source));
  }
  const unconfirmed = approvedFixture();
  unconfirmed.contact.confirmed = false; unconfirmed.privacy.approved = false;
  assert.equal(validateBusinessProfile(unconfirmed).contact.confirmed, false);
  assert.ok(businessProfileLaunchIssues(unconfirmed).some(issue => issue.code === "SHOP_CONTACT_UNCONFIRMED"));
});

test("an independently confirmed inbox does not approve missing phone, location or policies", () => {
  const source = draftBusinessProfile();
  source.contact.email = "contact@synthetic-shop-unit-check.net";
  source.contact.emailConfirmed = true;
  const validated = validateBusinessProfile(source);
  assert.deepEqual(validated, source);
  assert.equal(validated.contact.confirmed, false);
  assert.equal(validated.contact.phone, null);
  assert.deepEqual(validated.contact.addressLines, []);
  const codes = businessProfileLaunchIssues(validated).map(issue => issue.code);
  for (const code of ["SHOP_CONTACT_UNCONFIRMED", "PRIVACY_NOTICE_UNAPPROVED", "PRIVACY_RETENTION_POLICY_UNCONFIRMED", "CANCELLATION_POLICY_UNAPPROVED"]) assert.ok(codes.includes(code), code);
  source.contact.confirmed = true;
  assert.throws(() => validateBusinessProfile(source), /Confirm actual phone, email, and address/);
});

test("independent inbox approval requires a boolean flag and a valid public address", () => {
  for (const emailConfirmed of [undefined, null, "true", 1, {}, []]) {
    const source = draftBusinessProfile();
    source.contact.email = "contact@synthetic-shop-unit-check.net";
    source.contact.emailConfirmed = emailConfirmed;
    assert.throws(() => validateBusinessProfile(source), /Email confirmation/);
  }
  for (const email of [null, "", "contact@example.com", "contact@site.invalid", "not-an-email", "contact@synthetic-shop-unit-check.net\r\nInjected"]) {
    const source = draftBusinessProfile();
    source.contact.email = email;
    source.contact.emailConfirmed = true;
    assert.throws(() => validateBusinessProfile(source));
  }
});

test("legacy and explicitly unapproved draft inboxes retain their approval state", () => {
  const source = draftBusinessProfile();
  source.contact.email = "draft@synthetic-shop-unit-check.net";
  const legacy = validateBusinessProfile(source);
  assert.deepEqual(legacy, source);
  assert.equal(Object.hasOwn(legacy.contact, "emailConfirmed"), false);
  source.contact.emailConfirmed = false;
  assert.deepEqual(validateBusinessProfile(source), source);
  assert.ok(businessProfileLaunchIssues(source).some(issue => issue.code === "SHOP_CONTACT_UNCONFIRMED"));
});

test("published privacy information requires all reviewed providers, retention, request handling, contact and date", () => {
  for (const field of ["effectiveDate", "hostingProvider", "databaseProvider", "emailProvider", "retentionPolicy", "requestInstructions"]) {
    const source = approvedFixture(); source.privacy[field] = null;
    assert.throws(() => validateBusinessProfile(source), /Approve privacy information/);
  }
  const source = approvedFixture(); source.contact.confirmed = false;
  assert.throws(() => validateBusinessProfile(source), /Approve privacy information/);
  for (const field of ["hostingProvider", "databaseProvider", "emailProvider"]) {
    const source = approvedFixture(); source.privacy[field] = "x".repeat(161);
    assert.throws(() => validateBusinessProfile(source), /160/);
  }
  for (const field of ["retentionPolicy", "requestInstructions"]) {
    const source = approvedFixture(); source.privacy[field] = "x".repeat(1001);
    assert.throws(() => validateBusinessProfile(source), /1000/);
  }
});

test("policy dates are strict calendar dates, including leap years, and do not normalize invalid days", () => {
  assert.equal(validateBusinessProfile(approvedFixture()).privacy.effectiveDate, "2028-02-29");
  for (const section of ["privacy", "cancellation"]) for (const date of ["2026-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "11/11/2026", "2026-1-01", "2026-11-11T00:00:00Z"]) {
    const source = approvedFixture(); source[section].effectiveDate = date;
    assert.throws(() => validateBusinessProfile(source), /YYYY-MM-DD/);
  }
});

test("cancellation approval cannot claim an unimplemented cutoff or fee policy", () => {
  for (const policy of ["24_hour_fee", "no_cancellation", "until_start_with_fee", null]) {
    const source = approvedFixture(); source.cancellation.policy = policy;
    assert.throws(() => validateBusinessProfile(source), /until-start, no-fee policy/);
  }
  const noDate = approvedFixture(); noDate.cancellation.effectiveDate = null;
  assert.throws(() => validateBusinessProfile(noDate), /effective date/);
  const extraFee = approvedFixture(); extraFee.cancellation.fee = 50;
  assert.throws(() => validateBusinessProfile(extraFee), /documented public fields/);
});

test("text and approval flags reject controls, padded content, invalid types and oversized values", () => {
  for (const name of ["", " Ed's Auto Shop", "Ed's Auto Shop ", "Shop\nInjected", "x".repeat(81)]) {
    const source = copy(); source.name = name;
    assert.throws(() => validateBusinessProfile(source), /Shop name/);
  }
  for (const section of ["contact", "privacy", "cancellation"]) {
    const source = copy(); source[section][section === "contact" ? "confirmed" : "approved"] = "true";
    assert.throws(() => validateBusinessProfile(source));
  }
  const source = approvedFixture(); source.privacy.requestInstructions = "Text\u007fwith control";
  assert.throws(() => validateBusinessProfile(source), /control characters/);
});

test("validation returns independent structures and the shipped profile remains deeply frozen", () => {
  const source = approvedFixture();
  const result = validateBusinessProfile(source);
  assert.notEqual(result, source);
  assert.notEqual(result.contact, source.contact);
  assert.notEqual(result.contact.addressLines, source.contact.addressLines);
  assert.notEqual(result.privacy, source.privacy);
  result.contact.addressLines[0] = "Changed only in the returned object";
  assert.equal(source.contact.addressLines[0], "Synthetic unit-test address");
  for (const value of [businessProfile, businessProfile.contact, businessProfile.contact.addressLines, businessProfile.privacy, businessProfile.cancellation]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { businessProfile.contact.phone = "202-555-0148"; }, TypeError);
  assert.throws(() => { businessProfile.contact.addressLines.push("Unconfirmed address"); }, TypeError);
});
