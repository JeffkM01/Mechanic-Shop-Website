// Plain-text messages avoid rendering user-supplied notes as HTML.
// Only approved customer inputs reach this module after server validation.
export const EMAIL_KINDS = ["requestCustomer", "requestMechanic", "decisionCustomer"];

export function buildEmail(kind, appointment, { from, mechanicEmail }) {
  const id = String(appointment._id ?? appointment.id);
  const details = `Reference: ${id}\nCustomer: ${appointment.name}\nVehicle: ${appointment.vehicle}\nService: ${appointment.service}\nRequested time: ${appointment.date} at ${appointment.time} (Central Time)`;

  if (kind === "requestCustomer") {
    return {
      from,
      to: appointment.email,
      subject: "Ed's Auto Shop — appointment request received",
      text: `Hello ${appointment.name},\n\nWe received your appointment request. It is PENDING until the mechanic approves it.\n\n${details}\n\nWe will contact you after the request is reviewed.\n\nEd's Auto Shop`,
    };
  }

  if (kind === "requestMechanic") {
    return {
      from,
      to: mechanicEmail,
      replyTo: appointment.email,
      subject: "Ed's Auto Shop — new appointment request",
      text: `A customer submitted an appointment request. Sign in to the mechanic dashboard to approve or decline it.\n\n${details}\nEmail: ${appointment.email}\nPhone: ${appointment.phone}\nNotes: ${appointment.notes || "None"}\n\nThis request has NOT been approved yet.`,
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
