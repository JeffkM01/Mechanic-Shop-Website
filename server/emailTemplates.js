import { formatBookingDate, formatBookingTime, formatShopTimestamp } from "../src/utils/bookingDates.js";
import { DECLINE_NEXT_STEPS } from "../shared/declineReasons.js";
import { fieldLimits, isValidEmailAddress } from "../shared/appointmentFields.js";
import { CUSTOMER_CANCELLATION_REASONS, MECHANIC_CANCELLATION_REASONS } from "../shared/cancellations.js";

// Staff/customer text is placed only in a plain-text body, never HTML or
// headers. Subjects are fixed, and replies use the configured shop inbox.
export const EMAIL_KINDS = ["requestCustomer", "requestMechanic", "decisionCustomer", "cancellationCustomer", "cancellationMechanic"];

export function buildEmail(kind, appointment, { from, mechanicEmail, managementLink = null }) {
  // Older stored values may predate the single-mailbox booking validator.
  // Refuse them before passing a To/Reply-To value to Nodemailer's address
  // parser; a recipient list must not expose this appointment to other people.
  if (!isValidEmailAddress(appointment.email) || appointment.email.trim().length > fieldLimits.email) {
    throw new Error("Customer notification address needs review before email can be sent.");
  }
  const customerEmail = appointment.email.trim();
  const id = String(appointment._id ?? appointment.id);
  const automaticallyConfirmed = appointment.status === "confirmed" && appointment.scheduling?.confirmationSource === "automatic";
  const timezone = appointment.scheduling?.timezone || "America/Chicago";
  const date = formatBookingDate(appointment.date) || "Date needs review";
  const time = formatBookingTime(appointment.time) || "Time needs review";
  const estimate = appointment.scheduling?.durationMinutes
    ? `\nEstimated booking duration: ${appointment.scheduling.durationMinutes} minutes (not a guaranteed repair completion time).` : "";
  const holdExpiry = formatShopTimestamp(appointment.scheduling?.holdExpiresAt, timezone);
  const holdNote = appointment.status === "pending" && holdExpiry
    ? `\nThe provisional time reservation expires at ${holdExpiry} (${timezone}). Your request remains on file after expiry, but availability must be checked again before approval.` : "";
  const details = `Reference: ${id}\nCustomer: ${appointment.name}\nVehicle: ${appointment.vehicle}\nService: ${appointment.service}\nRequested time: ${date} at ${time} (${timezone})${estimate}${holdNote}`;
  const managementNote = managementLink
    ? `Manage this appointment securely: ${managementLink}\nKeep this private link to yourself. It authorizes access to this appointment.`
    : "To manage this appointment, please contact the shop by replying to this email. A secure online management link is not available in this message.";

  if (kind === "requestCustomer") {
    if (automaticallyConfirmed) throw new Error("Automatically confirmed appointments use the decision notification, not a request receipt.");
    if (appointment.status === "declined") throw new Error("Declined appointments use the decision notification, not a pending request receipt.");
    if (appointment.status === "cancelled") throw new Error("Cancelled appointments use the cancellation notification, not a request receipt.");
    const receiptStatus = appointment.status === "confirmed"
      ? "We received your appointment request. The mechanic has already reviewed it; please see the separate appointment decision email for its status."
      : "We received your appointment request. It is PENDING until the mechanic approves it.";
    return {
      from,
      to: customerEmail,
      replyTo: mechanicEmail,
      subject: "Ed's Auto Shop — appointment request received",
      text: `Hello ${appointment.name},\n\n${receiptStatus}\n\n${details}\n\n${appointment.status === "confirmed" ? "Reply to this email if you have a question about your request." : "We will contact you after the request is reviewed."}\n\n${managementNote}\n\nEd's Auto Shop`,
    };
  }

  if (kind === "requestMechanic") {
    const alreadyConfirmed = appointment.status === "confirmed";
    const alreadyDeclined = appointment.status === "declined";
    const alreadyCancelled = appointment.status === "cancelled";
    const introduction = alreadyCancelled ? "A customer appointment has already been CANCELLED. This delayed request notice reflects its current status."
      : automaticallyConfirmed ? "A customer appointment was CONFIRMED automatically under verified booking rules."
      : alreadyConfirmed ? "A customer appointment has already been CONFIRMED by the mechanic."
        : alreadyDeclined ? "A customer appointment request has already been declined by the mechanic."
          : "A customer submitted an appointment request. Sign in to the mechanic dashboard to approve or decline it.";
    const currentStatus = alreadyCancelled ? "This appointment is cancelled. No approval action is available. Review its recorded cancellation in the mechanic dashboard."
      : alreadyConfirmed ? "This appointment is already confirmed."
      : alreadyDeclined ? "This request is already declined. No further approval action is needed."
        : "This request has NOT been approved yet.";
    const reason = alreadyDeclined && appointment.decline?.explanation
      ? `\nCustomer-facing decline reason: ${appointment.decline.explanation}` : "";
    return {
      from,
      to: mechanicEmail,
      replyTo: customerEmail,
      subject: "Ed's Auto Shop — new appointment request",
      text: `${introduction}\n\n${details}\nEmail: ${appointment.email}\nPhone: ${appointment.phone}\nNotes: ${appointment.notes || "None"}${reason}\n\n${currentStatus}`,
    };
  }

  if (kind === "decisionCustomer") {
    if (!["confirmed", "declined"].includes(appointment.status)) {
      throw new Error("Cannot send a decision message for a pending appointment.");
    }
    const confirmed = appointment.status === "confirmed";
    if (confirmed) return {
      from,
      to: customerEmail,
      replyTo: mechanicEmail,
      subject: "Ed's Auto Shop — appointment confirmed",
      text: `Hello ${appointment.name},\n\nYour appointment request has been CONFIRMED.\n\n${details}\n\n${managementNote}\n\nEd's Auto Shop`,
    };
    // Only a saved final explanation is sent. Older declined records remain
    // valid, but no category/default is used to invent a historical reason.
    const explanation = typeof appointment.decline?.explanation === "string" && appointment.decline.explanation.trim()
      ? `Reason: ${appointment.decline.explanation.trim()}`
      : "A customer-facing reason was not recorded for this older declined request.";
    return {
      from,
      to: customerEmail,
      replyTo: mechanicEmail,
      subject: "Update on Your Appointment Request — Ed’s Auto Shop",
      text: `Hello ${appointment.name},\n\nUnfortunately, we're unable to approve your appointment request for ${appointment.service} on ${date} at ${time} (${timezone}). This request has been declined.\n\n${explanation}\n\n${details}\n\n${DECLINE_NEXT_STEPS}\n\nThank you,\nEd's Auto Shop`,
    };
  }

  if (kind === "cancellationCustomer" || kind === "cancellationMechanic") {
    if (appointment.status !== "cancelled" || !["customer", "mechanic"].includes(appointment.cancellation?.by)) {
      throw new Error("Cancellation notifications require a saved cancellation.");
    }
    const cancellation = appointment.cancellation;
    if (kind === "cancellationMechanic" && cancellation.by !== "customer") {
      throw new Error("Only customer cancellations queue a separate mechanic notification.");
    }
    const originalDate = formatBookingDate(cancellation.originalDate || appointment.date) || "Date needs review";
    const originalTime = formatBookingTime(cancellation.originalTime || appointment.time) || "Time needs review";
    const originalTimezone = cancellation.timezone || timezone;
    const cancelledAt = formatShopTimestamp(cancellation.cancelledAt, originalTimezone);
    const cancellationDetails = `Reference: ${id}\nVehicle: ${appointment.vehicle}\nService: ${appointment.service}\nOriginal appointment: ${originalDate} at ${originalTime} (${originalTimezone})${cancelledAt ? `\nCancelled at: ${cancelledAt} (${originalTimezone})` : ""}\nCancelled by: ${cancellation.by === "customer" ? "Customer" : "Mechanic"}`;
    const categoryLabel = (cancellation.by === "mechanic" ? MECHANIC_CANCELLATION_REASONS : CUSTOMER_CANCELLATION_REASONS)
      .find(item => item.id === cancellation.category)?.label;
    const reason = cancellation.by === "mechanic"
      ? (typeof cancellation.explanation === "string" && cancellation.explanation.trim()
        ? `${categoryLabel ? `Reason category: ${categoryLabel}\n` : ""}Reason: ${cancellation.explanation.trim()}`
        : "A customer-facing explanation was not recorded. Please contact the shop for details.")
      : `Customer reason: ${categoryLabel || "Not provided."}${cancellation.message ? `\nCustomer message: ${cancellation.message}` : ""}`;
    if (kind === "cancellationMechanic") return {
      from, to: mechanicEmail, replyTo: customerEmail,
      subject: "Customer Cancelled Appointment — Ed's Auto Shop",
      text: `The customer cancelled their ${appointment.service} appointment. It is no longer an active appointment.\n\nCustomer: ${appointment.name}\n${cancellationDetails}\n\n${reason}\n\nReview the cancellation in the mechanic dashboard. Do not confirm this cancelled appointment.`,
    };
    const introduction = cancellation.by === "mechanic"
      ? `The shop has cancelled your ${appointment.service} appointment for ${originalDate} at ${originalTime} (${originalTimezone}). We apologize for the inconvenience.`
      : `Your ${appointment.service} appointment for ${originalDate} at ${originalTime} (${originalTimezone}) has been cancelled as you requested.`;
    return {
      from, to: customerEmail, replyTo: mechanicEmail,
      subject: "Appointment Cancelled — Ed's Auto Shop",
      text: `Hello ${appointment.name},\n\n${introduction}\n\n${cancellationDetails}\n\n${reason}\n\nIf you need another appointment, you can submit a new request through our website. No replacement appointment has been booked. Reply to this email to contact the shop.\n\n${managementNote}\n\nEd's Auto Shop`,
    };
  }

  throw new Error(`Unknown notification kind: ${kind}`);
}
