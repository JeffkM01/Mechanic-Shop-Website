import test from "node:test";
import assert from "node:assert/strict";
import { businessProfile, businessProfileLaunchIssues, validateBusinessProfile } from "./businessProfile.js";

const copy = () => structuredClone(businessProfile);

// Only pure validation uses this synthetic profile. Nothing is published,
// delivered to these addresses, or treated as Edward's actual business data.
function approvedFixture() {
  return {
    schemaVersion: 1,
    name: "Synthetic Auto Test Shop",
    contact: { confirmed: true, phone: "202-555-0148", email: "appointments@synthetic-shop-unit-check.net", addressLines: ["Synthetic unit-test address", "Not a real shop location"] },
    privacy: {
      approved: true, effectiveDate: "2028-02-29", hostingProvider: "Synthetic test host", databaseProvider: "Synthetic test database provider", emailProvider: "Synthetic test mail provider",
      retentionPolicy: "Test-only reviewed retention text, not a shop policy.",
      requestInstructions: "Test-only contact instructions, not a customer process.",
    },
    cancellation: { approved: true, effectiveDate: "2028-02-29", policy: "until_start_no_fee" },
  };
}

test("the shipped profile keeps unknown contacts and unapproved policies as explicit launch blockers", () => {
  assert.equal(businessProfile.contact.confirmed, false);
  assert.equal(businessProfile.contact.phone, null);
  assert.equal(businessProfile.contact.email, null);
  assert.deepEqual(businessProfile.contact.addressLines, []);
  assert.equal(businessProfile.privacy.approved, false);
  assert.equal(businessProfile.privacy.hostingProvider, null);
  assert.equal(businessProfile.privacy.retentionPolicy, null);
  assert.equal(businessProfile.cancellation.approved, false);
  const codes = businessProfileLaunchIssues().map(issue => issue.code);
  for (const code of ["SHOP_CONTACT_UNCONFIRMED", "PRIVACY_NOTICE_UNAPPROVED", "PRIVACY_HOSTING_PROVIDER_UNCONFIRMED", "PRIVACY_RETENTION_POLICY_UNCONFIRMED", "CANCELLATION_POLICY_UNAPPROVED", "CANCELLATION_DATE_UNCONFIRMED"]) assert.ok(codes.includes(code), code);
});

test("complete owner-approved synthetic configuration passes profile checks without inventing business defaults", () => {
  const source = approvedFixture();
  const validated = validateBusinessProfile(source);
  assert.deepEqual(validated, source);
  assert.deepEqual(businessProfileLaunchIssues(source), []);
  assert.equal(businessProfile.contact.confirmed, false);
  assert.equal(businessProfile.privacy.approved, false);
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
