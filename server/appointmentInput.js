import { validateAppointment } from "../src/utils/appointmentValidation.js";

// Preserve the existing export for consumers while sharing the catalog.
export { ACCEPTED_SERVICE_NAMES as services } from "../shared/services.js";

const limits = {
  name: 80, email: 254, phone: 24, vehicle: 120,
  service: 50, date: 10, time: 5, notes: 1000,
};

// Only copy fields we explicitly expect: no client-controlled ID or approval status.
export function prepareAppointment(body, now = new Date(), options) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Please provide a valid appointment request." };
  }

  const data = {};
  for (const [key, max] of Object.entries(limits)) {
    const value = body[key] ?? (key === "notes" ? "" : null);
    if (typeof value !== "string") {
      return { error: `Invalid ${key} field.` };
    }
    data[key] = value.trim();
    if (data[key].length > max) {
      return { error: `${key} must be ${max} characters or fewer.` };
    }
  }

  const error = validateAppointment(data, now, options);
  return error ? { error } : { value: data };
}
