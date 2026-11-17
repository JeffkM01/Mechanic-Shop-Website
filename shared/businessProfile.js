import suppliedProfile from "./businessProfile.json" with { type: "json" };
import { isValidEmailAddress, isValidUsPhone } from "./appointmentFields.js";

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const noControls = value => ![...value].some(character => {
  const code = character.codePointAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});

function keys(value, expected, label) {
  if (!plain(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain only the documented public fields.`);
  }
}

function text(value, maximum, label, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || !noControls(value)) {
    throw new Error(`${label} must be trimmed text of 1–${maximum} characters without control characters.`);
  }
  return value;
}

function date(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) throw new Error(`${label} must use a valid YYYY-MM-DD date.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} must use a valid YYYY-MM-DD date.`);
  return value;
}

/** Public, source-controlled business details only. Never put secrets here. */
export function validateBusinessProfile(value) {
  keys(value, ["schemaVersion", "name", "contact", "privacy", "cancellation"], "Business profile");
  if (value.schemaVersion !== 1) throw new Error("Use business-profile schema version 1.");
  const name = text(value.name, 80, "Shop name", false);
  keys(value.contact, ["confirmed", "phone", "email", "addressLines"], "Public contact details");
  if (typeof value.contact.confirmed !== "boolean") throw new Error("Contact confirmation must be true or false.");
  const phone = text(value.contact.phone, 24, "Public phone");
  const email = text(value.contact.email, 254, "Public email");
  if (phone !== null && !isValidUsPhone(phone)) throw new Error("Public phone must be a valid U.S. phone number.");
  if (email !== null && (!isValidEmailAddress(email)
    || /\.(?:example|invalid|test|localhost)$/i.test(email)
    || /(?:^|\.)example\.(?:com|net|org)$/i.test(email.split("@")[1]))) throw new Error("Provide a valid public email address rather than an example address.");
  if (!Array.isArray(value.contact.addressLines) || value.contact.addressLines.length > 4) throw new Error("Public address may contain up to four lines.");
  const addressLines = value.contact.addressLines.map(line => text(line, 120, "Address line", false));
  if (value.contact.confirmed && (!phone || !email || !addressLines.length)) throw new Error("Confirm actual phone, email, and address before marking contact details confirmed.");
  const contact = { confirmed: value.contact.confirmed, phone, email, addressLines };

  keys(value.privacy, ["approved", "effectiveDate", "hostingProvider", "databaseProvider", "emailProvider", "retentionPolicy", "requestInstructions"], "Privacy information");
  if (typeof value.privacy.approved !== "boolean") throw new Error("Privacy approval must be true or false.");
  const privacy = {
    approved: value.privacy.approved,
    effectiveDate: date(value.privacy.effectiveDate, "Privacy effective date"),
    hostingProvider: text(value.privacy.hostingProvider, 160, "Hosting provider"),
    databaseProvider: text(value.privacy.databaseProvider, 160, "Database provider"),
    emailProvider: text(value.privacy.emailProvider, 160, "Email provider"),
    retentionPolicy: text(value.privacy.retentionPolicy, 1000, "Retention policy"),
    requestInstructions: text(value.privacy.requestInstructions, 1000, "Data-request instructions"),
  };
  if (privacy.approved && (!contact.confirmed || Object.entries(privacy).some(([key, field]) => key !== "approved" && field === null))) {
    throw new Error("Approve privacy information only after confirming contact details, providers, retention, request handling, and its effective date.");
  }
  keys(value.cancellation, ["approved", "effectiveDate", "policy"], "Cancellation policy");
  if (typeof value.cancellation.approved !== "boolean" || value.cancellation.policy !== "until_start_no_fee") throw new Error("The current cancellation implementation supports only the until-start, no-fee policy.");
  const cancellation = { approved: value.cancellation.approved, effectiveDate: date(value.cancellation.effectiveDate, "Cancellation effective date"), policy: value.cancellation.policy };
  if (cancellation.approved && !cancellation.effectiveDate) throw new Error("Set the cancellation effective date before marking its policy approved.");
  return { schemaVersion: 1, name, contact, privacy, cancellation };
}

export function businessProfileLaunchIssues(value = businessProfile) {
  let profile;
  try { profile = validateBusinessProfile(value); }
  catch (error) { return [{ code: "INVALID_BUSINESS_PROFILE", message: error.message }]; }
  const issues = [];
  const add = (condition, code, message) => { if (condition) issues.push({ code, message }); };
  add(!profile.contact.confirmed, "SHOP_CONTACT_UNCONFIRMED", "Confirm the shop's real public phone, email, and address.");
  add(!profile.privacy.approved, "PRIVACY_NOTICE_UNAPPROVED", "Edward must review and approve the public privacy information.");
  for (const [field, label] of [["effectiveDate", "effective date"], ["hostingProvider", "hosting provider"], ["databaseProvider", "database provider"], ["emailProvider", "email provider"], ["retentionPolicy", "data-retention policy"], ["requestInstructions", "data-request process"]]) {
    add(profile.privacy[field] === null, `PRIVACY_${field.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}_UNCONFIRMED`, `Confirm the privacy notice's ${label}.`);
  }
  add(!profile.cancellation.approved, "CANCELLATION_POLICY_UNAPPROVED", "Edward must approve the current cancellation policy or request implementation changes.");
  add(!profile.cancellation.effectiveDate, "CANCELLATION_DATE_UNCONFIRMED", "Confirm the cancellation policy's effective date.");
  return issues;
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

export const businessProfile = freeze(validateBusinessProfile(suppliedProfile));
