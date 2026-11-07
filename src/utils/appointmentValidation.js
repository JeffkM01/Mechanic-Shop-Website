import { isValidServiceName } from "../../shared/services.js";

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function validateAppointment(form, now = new Date(), { schedulingAuthoritative = false } = {}) {
  const required = {
    name: "name",
    email: "email address",
    phone: "phone number",
    vehicle: "vehicle information",
    service: "service",
    date: "preferred date",
    time: "preferred time",
  };

  for (const [field, label] of Object.entries(required)) {
    if (!String(form[field] ?? "").trim()) {
      return `Please provide your ${label}.`;
    }
  }

  if (!isValidServiceName(form.service)) {
    return "Please select a valid service.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    return "Please enter a valid email address.";
  }

  const digits = form.phone.replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) {
    return "Please enter a valid 10-digit US phone number.";
  }

  const date = new Date(`${form.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== form.date) {
    return "Please choose a valid date.";
  }

  if (!schedulingAuthoritative && form.date < localDateString(now)) {
    return "Please choose today or a future date.";
  }

  // The shop does not accept Sunday appointment requests.
  if (!schedulingAuthoritative && date.getUTCDay() === 0) {
    return "Appointments are unavailable on Sundays. Please choose another day.";
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) {
    return "Please choose a valid time.";
  }

  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (!schedulingAuthoritative && form.date === localDateString(now) && form.time <= currentTime) {
    return "Please choose a future time for today's appointment.";
  }

  return null;
}
