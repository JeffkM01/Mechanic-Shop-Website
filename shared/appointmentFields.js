import { isValidServiceName } from "./services.js";

export const fieldLimits = Object.freeze({
  name: 80, email: 254, phone: 24, vehicle: 120,
  service: 50, date: 10, time: 5, notes: 1000,
});

export const appointmentFieldOrder = Object.freeze(Object.keys(fieldLimits));

const requiredMessages = {
  name: "Please enter your full name.",
  email: "Please enter your email address.",
  phone: "Please enter your phone number.",
  vehicle: "Please enter your vehicle’s year, make, and model.",
  service: "Please select a service.",
  date: "Please select an available appointment date.",
  time: "Please select an available appointment time.",
};
const labels = {
  name: "Your full name", email: "Your email address", phone: "Your phone number",
  vehicle: "Vehicle information", service: "The selected service", date: "The appointment date",
  time: "The appointment time", notes: "Additional notes",
};
const phoneMessage = "Please enter a valid 10-digit U.S. phone number, such as 636-555-1234.";

// Accept ten national digits, optional separators at the 3/3/4 boundaries,
// balanced parentheses around the area code, and an optional leading +1 or 1.
// Only outer ASCII spaces are ignored; no letters, extensions, other country
// codes, control characters, or unsupported punctuation are stripped away.
const usPhonePattern = /^(?:\+?1[ -]?)?(?:\d{3}[ -]?\d{3}[ -]?\d{4}|\(\d{3}\) ?\d{3}[ -]?\d{4})$/;

export function validateUsPhone(value) {
  if (typeof value !== "string") return phoneMessage;
  if (/[A-Za-z]/.test(value)) return "Please enter a valid U.S. phone number. Letters are not allowed.";
  if (!/^[0-9()+ -]*$/.test(value)) return phoneMessage;
  const input = value.trim();
  return input.length <= fieldLimits.phone && usPhonePattern.test(input) ? null : phoneMessage;
}

export function isValidUsPhone(value) {
  return validateUsPhone(value) === null;
}

// One conventional, unquoted ASCII mailbox, not a display name or recipient
// list. Plus addressing and other RFC dot-atom characters remain supported.
// Unicode/quoted addresses and address literals are intentionally unsupported;
// domain labels follow DNS hostname syntax. This checks syntax, not delivery.
export function isValidEmailAddress(value) {
  if (typeof value !== "string" || [...value].some(character => {
    const code = character.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  })) return false;
  const email = value.trim();
  if (email.length > fieldLimits.email) return false;
  const pieces = email.split("@");
  if (pieces.length !== 2) return false;
  const [local, domain] = pieces;
  if (!local || local.length > 64 || domain.length > 253
    || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** Return every invalid booking field without changing customer-entered data. */
export function validateAppointmentFields(form, now = new Date(), { schedulingAuthoritative = false } = {}) {
  const errors = {};
  const values = {};
  for (const [field, maximum] of Object.entries(fieldLimits)) {
    const original = form?.[field] ?? (field === "notes" ? "" : null);
    if (typeof original !== "string") {
      errors[field] = requiredMessages[field] || "Please enter additional notes as text.";
      continue;
    }
    values[field] = original.trim();
    if (!values[field] && field !== "notes") {
      errors[field] = requiredMessages[field];
      continue;
    }
    if (values[field].length > maximum) errors[field] = `${labels[field]} must be ${maximum} characters or fewer.`;
  }

  if (!errors.service && !isValidServiceName(values.service)) errors.service = "Please select a valid service.";
  if (!errors.email && !isValidEmailAddress(form.email)) errors.email = "Please enter a valid email address.";
  if (!errors.phone) {
    const message = validateUsPhone(form.phone);
    if (message) errors.phone = message;
  }

  const date = !errors.date ? validCalendarDate(values.date) : null;
  if (!errors.date && !date) errors.date = "Please choose a valid date.";
  if (!errors.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time)) errors.time = "Please choose a valid time.";
  if (!schedulingAuthoritative) {
    if (!errors.date && values.date < localDateString(now)) errors.date = "Please choose today or a future date.";
    if (!errors.date && date.getUTCDay() === 0) errors.date = "Appointments are unavailable on Sundays. Please choose another day.";
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (!errors.time && !errors.date && values.date === localDateString(now) && values.time <= currentTime) errors.time = "Please choose a future time for today's appointment.";
  }
  return Object.fromEntries(appointmentFieldOrder.filter(field => Object.hasOwn(errors, field)).map(field => [field, errors[field]]));
}
