import { fieldLimits, validateAppointmentFields } from "../shared/appointmentFields.js";

// Preserve the existing export for consumers while sharing the catalog.
export { ACCEPTED_SERVICE_NAMES as services } from "../shared/services.js";

// Only copy expected fields: no client-controlled ID, status, or decision data.
export function prepareAppointment(body, now = new Date(), options) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Please provide a valid appointment request." };
  }

  const fields = validateAppointmentFields(body, now, options);
  if (Object.keys(fields).length) return { error: Object.values(fields)[0], fields };
  const data = Object.fromEntries(Object.keys(fieldLimits).map(key => [key, (body[key] ?? "").trim()]));
  return { value: data };
}
