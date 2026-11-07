// Plain-text messages avoid rendering user-supplied notes as HTML.
// Only approved customer inputs reach this module after server validation.
export const EMAIL_KINDS = ["requestCustomer", "requestMechanic", "decisionCustomer"];

export function buildEmail(kind, appointment, { from, mechanicEmail }) {
  const id = String(appointment._id ?? appointment.id);
  const automaticallyConfirmed = appointment.status === "confirmed" && appointment.scheduling?.confirmationSource === "automatic";
  const timezone = appointment.scheduling?.timezone || "America/Chicago";
  const estimate = appointment.scheduling?.durationMinutes
    ? `\nEstimated booking duration: ${appointment.scheduling.durationMinutes} minutes (not a guaranteed repair completion time).` : "";
  const holdNote = appointment.status === "pending" && appointment.scheduling?.holdExpiresAt
    ? `\nThe provisional time reservation expires at ${new Date(appointment.scheduling.holdExpiresAt).toISOString()}. Your request remains on file after expiry, but availability must be checked again before approval.` : "";
  const details = `Reference: ${id}\nCustomer: ${appointment.name}\nVehicle: ${appointment.vehicle}\nService: ${appointment.service}\nRequested time: ${appointment.date} at ${appointment.time} (${timezone})${estimate}${holdNote}`;

  if (kind === "requestCustomer") {
    return {
      from,
      to: appointment.email,
      subject: "Ed's Auto Shop — appointment request received",
      text: `Hello ${appointment.name},\n\n${automaticallyConfirmed ? "Your appointment has been CONFIRMED by the verified automatic booking rules." : "We received your appointment request. It is PENDING until the mechanic approves it."}\n\n${details}\n\nWe will contact you after the request is reviewed.\n\nEd's Auto Shop`,
    };
  }

  if (kind === "requestMechanic") {
    return {
      from,
      to: mechanicEmail,
      replyTo: appointment.email,
      subject: "Ed's Auto Shop — new appointment request",
      text: `${automaticallyConfirmed ? "A customer appointment was CONFIRMED automatically under verified booking rules." : "A customer submitted an appointment request. Sign in to the mechanic dashboard to approve or decline it."}\n\n${details}\nEmail: ${appointment.email}\nPhone: ${appointment.phone}\nNotes: ${appointment.notes || "None"}\n\n${automaticallyConfirmed ? "This appointment is already confirmed." : "This request has NOT been approved yet."}`,
    };
  }

  if (kind === "decisionCustomer") {
    if (!["confirmed", "declined"].includes(appointment.status)) {
      throw new Error("Cannot send a decision message for a pending appointment.");
    }
    const confirmed = appointment.status === "confirmed";
    return {
      from,
      to: appointment.email,
      subject: `Ed's Auto Shop — appointment ${appointment.status}`,
      text: `Hello ${appointment.name},\n\n${confirmed ? "Your appointment request has been CONFIRMED." : "Your requested appointment time has been DECLINED. Please contact the shop to discuss another time."}\n\n${details}\n\nEd's Auto Shop`,
    };
  }

  throw new Error(`Unknown notification kind: ${kind}`);
}
