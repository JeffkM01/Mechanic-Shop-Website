import { validateAppointmentFields } from "../../shared/appointmentFields.js";

export {
  appointmentFieldOrder, fieldLimits, isValidEmailAddress, isValidUsPhone, localDateString,
  validateAppointmentFields, validateUsPhone,
} from "../../shared/appointmentFields.js";

// Preserve the existing first-error contract for older consumers while the
// booking UI and API can now display all field-specific corrections together.
export function validateAppointment(form, now = new Date(), options) {
  return Object.values(validateAppointmentFields(form, now, options))[0] || null;
}
