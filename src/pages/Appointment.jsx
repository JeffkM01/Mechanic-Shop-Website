import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SERVICE_CATEGORIES, SERVICES, getService, getServiceSelection } from "../../shared/services.js";
import { validateAppointment } from "../utils/appointmentValidation";
import "../styles/Appointment.css";

const emptyForm = {
  name: "", email: "", phone: "", vehicle: "", service: "",
  date: "", time: "", notes: "",
};

function AppointmentForm({ initialService }) {
  const [form, setForm] = useState(() => ({ ...emptyForm, service: initialService }));
  const selectedService = getService(form.service);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const availabilityKey = `${form.service}|${form.date}|${availabilityRevision}`;
  const currentAvailability = availability?.key === availabilityKey ? availability : null;
  const scheduling = currentAvailability?.data;
  const slots = scheduling?.slots || [];
  const loadingAvailability = Boolean(form.service && form.date && !currentAvailability);
  const selectedSlot = slots.find((slot) => slot.time === form.time);

  useEffect(() => {
    if (!form.service || !form.date) return;

    const controller = new AbortController();
    const query = new URLSearchParams({ service: form.service, date: form.date });

    async function loadAvailability() {
      try {
        const response = await fetch(`/api/availability?${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not load appointment times.");
        if (!Array.isArray(data.slots)) throw new Error("Could not load appointment times.");
        if (!controller.signal.aborted) {
          setAvailability({ key: availabilityKey, data });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setAvailability({
            key: availabilityKey,
            error: err instanceof TypeError
              ? "Cannot load appointment times right now. Please try again."
              : err.message,
          });
        }
      }
    }

    loadAvailability();
    return () => controller.abort();
  }, [form.service, form.date, availabilityKey]);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: value,
      ...(name === "service" || name === "date" ? { time: "" } : {}),
    }));
    setError("");
    setSendError("");
    setPreview(null);
    setConfirmation(null);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const message = validateAppointment(form, new Date(), { schedulingAuthoritative: true });
    if (message) {
      setError(message);
      setPreview(null);
      return;
    }
    if (!selectedSlot) {
      setError("Please select an available appointment time.");
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
    if (!selectedSlot || preview.time !== selectedSlot.time) {
      setError("Please select an available appointment time again.");
      setPreview(null);
      return;
    }
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
        if (response.status === 409) {
          setError(data.error || "That time is no longer available. Please choose another time.");
          setPreview(null);
          setForm((current) => ({ ...current, time: "" }));
          setAvailabilityRevision((current) => current + 1);
          return;
        }
        throw new Error(data.error || "Could not save the appointment request.");
      }

      setConfirmation({ id: data.id, status: data.status, emailNotification: data.emailNotification, holdExpiresAt: data.holdExpiresAt, timezone: scheduling?.timezone });
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
        Tell us about your vehicle and choose an available request time.
        Your appointment requires mechanic approval unless you receive an explicit confirmation.
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
        <label className="appointment-field appointment-wide">
          Service needed
          <select name="service" value={form.service} onChange={handleChange} required aria-describedby={selectedService?.provisional ? "appointment-service-note" : undefined}>
            <option value="">Select a service</option>
            {SERVICE_CATEGORIES.map((category) => (
              <optgroup label={category.label} key={category.id}>
                {SERVICES.filter((service) => service.category === category.id).map((service) => (
                  <option key={service.name} value={service.name}>{service.name}{service.provisional ? " (provisional)" : ""}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {selectedService?.provisional && (
          <p className="appointment-service-note appointment-wide" id="appointment-service-note" role="status">
            <strong>Availability to be confirmed.</strong> {selectedService.name} is a provisional service option.
            Edward will need to confirm whether the shop can provide it before your appointment is approved.
          </p>
        )}
        <label className="appointment-field">
          Preferred date <input name="date" type="date" value={form.date} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Available request time
          <select name="time" value={form.time} onChange={handleChange} required disabled={loadingAvailability || !slots.length} aria-describedby="appointment-availability">
            <option value="">{loadingAvailability ? "Loading available times…" : "Select an available time"}</option>
            {slots.map((slot) => <option key={slot.startAt || slot.time} value={slot.time}>{slot.time}</option>)}
          </select>
        </label>
        <div className="appointment-availability appointment-wide" id="appointment-availability" aria-live="polite" aria-busy={loadingAvailability}>
          {!form.service || !form.date ? (
            <p>Select a service and date to check available request times.</p>
          ) : loadingAvailability ? (
            <p>Checking availability…</p>
          ) : currentAvailability?.error ? (
            <>
              <p className="appointment-error" role="alert">{currentAvailability.error}</p>
              <button className="appointment-secondary" type="button" onClick={() => setAvailabilityRevision((current) => current + 1)}>Retry availability</button>
            </>
          ) : scheduling ? (
            <>
              {!slots.length && <p><strong>No request times are available for this date.</strong> Please choose another date.</p>}
              <p>All times are in <strong>{scheduling.timezone}</strong>. Estimated booking duration: <strong>{scheduling.durationMinutes} minutes</strong>. This is not a guaranteed repair completion time.</p>
              {scheduling.policy && <><p>Request at least {scheduling.policy.minimumNoticeHours} hours ahead, within the next {scheduling.policy.bookingHorizonDays} days.</p><p>Pending requests hold time for {scheduling.policy.pendingHoldHours} hours. If a hold expires, the request remains on file and availability must be checked again before approval.</p></>}
              {scheduling.settingsProvisional && <p>Scheduling hours and capacity are provisional. Requests remain pending until Edward reviews them.</p>}
            </>
          ) : null}
        </div>
        <label className="appointment-field appointment-wide">
          Additional information (optional)
          <textarea name="notes" rows="3" maxLength="1000" placeholder="Describe the problem or any special requests" value={form.notes} onChange={handleChange} />
        </label>

        {error && <p className="appointment-error appointment-wide" role="alert">{error}</p>}
        <button className="appointment-submit appointment-wide" type="submit" disabled={sending || !selectedSlot}>Review Appointment Request</button>
      </form>

      {preview && (
        <section className="appointment-preview" aria-label="Review request">
          <h2>Review your request</h2>
          <p>This request is <strong>not saved yet</strong>. Confirm the details below to send it to the shop database.</p>
          <dl>
            <dt>Customer</dt><dd>{preview.name}</dd>
            <dt>Contact</dt><dd>{preview.email} · {preview.phone}</dd>
            <dt>Vehicle</dt><dd>{preview.vehicle}</dd>
            <dt>Service</dt><dd>{preview.service}{getService(preview.service)?.provisional && <span className="appointment-provisional"> · Provisional — availability to be confirmed</span>}</dd>
            <dt>Requested date and time</dt><dd>{preview.date} at {preview.time} ({scheduling?.timezone})</dd>
            <dt>Estimated booking duration</dt><dd>{scheduling?.durationMinutes} minutes; repair completion time may vary.</dd>
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
          <h2>{confirmation.status === "confirmed" ? "Appointment confirmed" : "Appointment request saved!"}</h2>
          <p>{confirmation.status === "confirmed"
            ? "Your appointment is confirmed. The booking duration is an estimate; repair completion time may vary."
            : "Your request is pending mechanic approval. Your appointment is not confirmed yet."}</p>
          <p><strong>Reference ID:</strong> {confirmation.id}</p>
          {confirmation.status === "pending" && confirmation.holdExpiresAt && <p>Your provisional time reservation expires <time dateTime={confirmation.holdExpiresAt}>{new Date(confirmation.holdExpiresAt).toLocaleString(undefined, { timeZone: confirmation.timezone || "America/Chicago" })}</time> ({confirmation.timezone || "America/Chicago"}). Your request will remain on file; an expired hold does not confirm an appointment.</p>}
          <p>{confirmation.emailNotification === "queued"
            ? "An acknowledgment email has been queued for delivery. Email delivery may take a little time."
            : "Email notifications are not configured yet. Please contact the mechanic directly if you need an update."}</p>
        </section>
      )}
    </main>
  );
}

export default function Appointment() {
  const { search } = useLocation();
  const initialService = getServiceSelection(search);
  // A new service link (including Back/Forward on the same route) starts a
  // matching request and discards any preview for the previous selection.
  return <AppointmentForm key={initialService} initialService={initialService} />;
}
