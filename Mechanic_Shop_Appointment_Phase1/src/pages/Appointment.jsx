import { useState } from "react";
import { localDateString, validateAppointment } from "../utils/appointmentValidation";
import "../styles/Appointment.css";

const services = [
  "Oil Change",
  "Air Filter Change",
  "Brake Repairs",
  "AC & Heating Repair",
  "Engine Diagnostics",
  "Other / Not Sure",
];

const emptyForm = {
  name: "",
  email: "",
  phone: "",
  vehicle: "",
  service: "",
  date: "",
  time: "",
  notes: "",
};

function Appointment() {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setError("");
    setPreview(null);
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
    setPreview({ ...form });
  }

  return (
    <main className="appointment-page">
      <h1>Request an Appointment</h1>
      <p className="appointment-intro">
        Tell us about your vehicle and preferred appointment time. Sundays are unavailable.
        Appointments require mechanic approval.
      </p>

      <form className="appointment-form" onSubmit={handleSubmit}>
        <label className="appointment-field">
          Full name <input name="name" autoComplete="name" value={form.name} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Email <input name="email" type="email" autoComplete="email" value={form.email} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Phone <input name="phone" type="tel" autoComplete="tel" placeholder="(555) 555-1234" value={form.phone} onChange={handleChange} required />
        </label>
        <label className="appointment-field">
          Vehicle <input name="vehicle" placeholder="2018 Honda Civic" value={form.vehicle} onChange={handleChange} required />
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
          <textarea name="notes" rows="3" placeholder="Describe the problem or any special requests" value={form.notes} onChange={handleChange} />
        </label>

        {error && <p className="appointment-error appointment-wide" role="alert">{error}</p>}
        <button className="appointment-submit appointment-wide" type="submit">Review Appointment Request</button>
      </form>

      {preview && (
        <section className="appointment-preview" role="status" aria-live="polite">
          <h2>Request details look good!</h2>
          <p><strong>Demo preview only:</strong> this request has not been saved or sent to the mechanic. Notifications will be added next.</p>
          <dl>
            <dt>Customer</dt><dd>{preview.name}</dd>
            <dt>Contact</dt><dd>{preview.email} · {preview.phone}</dd>
            <dt>Vehicle</dt><dd>{preview.vehicle}</dd>
            <dt>Service</dt><dd>{preview.service}</dd>
            <dt>Preferred date and time</dt><dd>{preview.date} at {preview.time}</dd>
            {preview.notes.trim() && <><dt>Notes</dt><dd>{preview.notes}</dd></>}
          </dl>
        </section>
      )}
    </main>
  );
}

export default Appointment;
