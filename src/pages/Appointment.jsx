import { useState } from "react";
import { localDateString, validateAppointment } from "../utils/appointmentValidation";
import "../styles/Appointment.css";

const services = [
  "Oil Change", "Air Filter Change", "Brake Repairs",
  "AC & Heating Repair", "Engine Diagnostics", "Other / Not Sure",
];

const emptyForm = {
  name: "", email: "", phone: "", vehicle: "", service: "",
  date: "", time: "", notes: "",
};

function Appointment() {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [confirmation, setConfirmation] = useState(null);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setError("");
    setSendError("");
    setPreview(null);
    setConfirmation(null);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const message = validateAppointment(form);
    if (message) {
      setError(message);
      setPreview(null);
      return;
    }

    setError("");
    setSendError("");
    setConfirmation(null);
    setPreview({ ...form });
  }

  async function sendRequest() {
    if (sending || !preview) return;
    setSending(true);
    setSendError("");

    try {
      const response = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preview),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Could not save the appointment request.");
      }

      setConfirmation({ id: data.id, status: data.status, emailNotification: data.emailNotification });
      setPreview(null);
      setForm(emptyForm);
    } catch (err) {
      setSendError(err instanceof TypeError
        ? "Cannot reach the appointment API. Start the backend and try again."
        : err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="appointment-page">
      <h1>Request an Appointment</h1>
      <p className="appointment-intro">
        Tell us about your vehicle and preferred appointment time. Sundays are unavailable.
        All requests must be approved by the mechanic.
      </p>

      <form className="appointment-form" onSubmit={handleSubmit}>
        <label className="appointment-field">
          Full name <input name="name" autoComplete="name" maxLength="80" value={form.name} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Email <input name="email" type="email" autoComplete="email" maxLength="254" value={form.email} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Phone <input name="phone" type="tel" autoComplete="tel" maxLength="24" placeholder="(555) 555-1234" value={form.phone} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Vehicle <input name="vehicle" maxLength="120" placeholder="2018 Honda Civic" value={form.vehicle} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Service needed
          <select name="service" value={form.service} onChange={handleChange} required>
            <option value="">Select a service</option>
            {services.map((service) => <option key={service} value={service}>{service}</option>)}
          </select>
        </label>
        <label className="appointment-field">
          Preferred date <input name="date" type="date" min={localDateString()} value={form.date} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Preferred time <input name="time" type="time" value={form.time} onChange={handleChange} required />
        </label>
        <label className="appointment-field appointment-wide">
          Additional information (optional)
          <textarea name="notes" rows="3" maxLength="1000" placeholder="Describe the problem or any special requests" value={form.notes} onChange={handleChange} />
        </label>

        {error && <p className="appointment-error appointment-wide" role="alert">{error}</p>}
        <button className="appointment-submit appointment-wide" type="submit">Review Appointment Request</button>
      </form>

      {preview && (
        <section className="appointment-preview" aria-label="Review request">
          <h2>Review your request</h2>
          <p>This request is <strong>not saved yet</strong>. Confirm the details below to send it to the shop database.</p>
          <dl>
            <dt>Customer</dt><dd>{preview.name}</dd>
            <dt>Contact</dt><dd>{preview.email} · {preview.phone}</dd>
            <dt>Vehicle</dt><dd>{preview.vehicle}</dd>
            <dt>Service</dt><dd>{preview.service}</dd>
            <dt>Preferred date and time</dt><dd>{preview.date} at {preview.time}</dd>
            {preview.notes.trim() && <><dt>Notes</dt><dd>{preview.notes}</dd></>}
          </dl>
          {sendError && <p className="appointment-error" role="alert">{sendError}</p>}
          <div className="appointment-actions">
            <button className="appointment-submit" type="button" onClick={sendRequest} disabled={sending}>
              {sending ? "Sending request…" : "Send Appointment Request"}
            </button>
            <button className="appointment-secondary" type="button" onClick={() => setPreview(null)} disabled={sending}>
              Edit details
            </button>
          </div>
        </section>
      )}

      {confirmation && (
        <section className="appointment-success" role="status" aria-live="polite">
          <h2>Appointment request saved!</h2>
          <p>Your request has been stored with status <strong>{confirmation.status}</strong>. It is not confirmed until the mechanic approves it.</p>
          <p><strong>Reference ID:</strong> {confirmation.id}</p>
          <p>{confirmation.emailNotification === "queued"
            ? "An acknowledgment email has been queued for delivery. Email delivery may take a little time."
            : "Email notifications are not configured yet. Please contact the mechanic directly if you need an update."}</p>
        </section>
      )}
    </main>
  );
}

export default Appointment;
