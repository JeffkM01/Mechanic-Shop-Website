import { useEffect, useRef, useState } from "react";
import { CANCELLATION_MESSAGE_MAX, MECHANIC_CANCELLATION_REASONS, getCancellationPreview, validateCancellation } from "../../shared/cancellations.js";
import { formatBookingDate, formatBookingTime } from "../utils/bookingDates";

export default function CancelAppointmentDialog({ appointment, busy, locked, error, serverFields = {}, onKeep, onConfirm, onRefresh }) {
  const [category, setCategory] = useState("");
  const [explanation, setExplanation] = useState("");
  const [errors, setErrors] = useState({});
  const dialog = useRef(null);
  const categoryInput = useRef(null);
  const explanationInput = useRef(null);
  const fields = { ...serverFields, ...errors };
  const preview = getCancellationPreview(category, explanation);
  const timezone = appointment.cancellationEligibility?.timezone || appointment.scheduling?.timezone || "America/Chicago";

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element.open) element.showModal();
    categoryInput.current?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.disabled) opener.focus();
      else document.getElementById("staff-appointments-heading")?.focus();
    };
  }, []);
  useEffect(() => {
    if (serverFields["cancellation.category"]) categoryInput.current?.focus();
    else if (serverFields["cancellation.explanation"]) explanationInput.current?.focus();
  }, [serverFields]);

  async function submit(event) {
    event.preventDefault();
    if (busy || locked) return;
    const prepared = validateCancellation("mechanic", { category, explanation });
    setErrors(prepared.fields || {});
    if (prepared.error) {
      if (prepared.fields?.["cancellation.category"]) categoryInput.current?.focus();
      else explanationInput.current?.focus();
      return;
    }
    await onConfirm({ category, explanation: explanation.trim() });
  }

  return <dialog className="decline-dialog" ref={dialog} aria-labelledby="cancel-appointment-heading" aria-describedby="cancel-appointment-description"
    onCancel={event => { event.preventDefault(); if (!busy) onKeep(); }}>
    <form onSubmit={submit} noValidate>
      <p className="staff-kicker">REVIEW BEFORE CANCELLING</p><h2 id="cancel-appointment-heading">Cancel this appointment?</h2>
      <p id="cancel-appointment-description">This cancels the saved appointment and releases its time slot. Review the customer-facing explanation below before confirming.</p>
      <p><strong>{appointment.name}</strong><br />{appointment.service} · {formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)} ({timezone})</p>
      {error && <p className="decline-error" role="alert">{error}</p>}
      <label className="decline-field" htmlFor="cancel-appointment-category">Cancellation reason</label>
      <select id="cancel-appointment-category" ref={categoryInput} value={category} required disabled={busy || locked}
        aria-invalid={Boolean(fields["cancellation.category"]) || undefined} aria-describedby={fields["cancellation.category"] ? "cancel-category-error" : undefined}
        onChange={event => { setCategory(event.target.value); setErrors({}); }}>
        <option value="">Choose a reason</option>{MECHANIC_CANCELLATION_REASONS.map(reason => <option value={reason.id} key={reason.id}>{reason.label}</option>)}
      </select>
      {fields["cancellation.category"] && <p id="cancel-category-error" className="decline-error">{fields["cancellation.category"]}</p>}
      <label className="decline-field" htmlFor="cancel-appointment-explanation">Additional explanation {category === "other" ? "(required)" : "(optional)"}</label>
      <textarea id="cancel-appointment-explanation" ref={explanationInput} rows={4} value={explanation} maxLength={CANCELLATION_MESSAGE_MAX} required={category === "other"} disabled={busy || locked}
        aria-invalid={Boolean(fields["cancellation.explanation"]) || undefined} aria-describedby={`cancel-explanation-help${fields["cancellation.explanation"] ? " cancel-explanation-error" : ""}`}
        onChange={event => { setExplanation(event.target.value); setErrors(current => ({ ...current, "cancellation.explanation": undefined })); }} />
      <p id="cancel-explanation-help" className="decline-help">The customer will receive this message when email is configured. Add truthful details using at least 10 characters, up to {CANCELLATION_MESSAGE_MAX}. Other requires an explanation. Keep internal notes out.</p>
      {fields["cancellation.explanation"] && <p id="cancel-explanation-error" className="decline-error">{fields["cancellation.explanation"]}</p>}
      <section className="decline-preview" aria-label="Customer message preview"><h3>Customer message preview</h3>{preview ? <><p>Your {appointment.service} appointment for {formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)} ({timezone}) has been cancelled by the shop.</p><p>{preview}</p></> : <p>Choose a reason to preview the customer’s explanation.</p>}</section>
      <p className="decline-help">The appointment stays unchanged until you select Confirm Cancellation. No replacement appointment will be booked.</p>
      <div className="decline-actions"><button type="button" className="staff-button staff-button-secondary" onClick={onKeep} disabled={busy}>Keep Appointment</button>{locked ? <button type="button" className="staff-button staff-button-primary" onClick={onRefresh} disabled={busy}>Refresh appointment status</button> : <button type="submit" className="staff-button staff-button-primary" disabled={busy}>{busy ? "Saving cancellation…" : "Confirm Cancellation"}</button>}</div>
    </form>
  </dialog>;
}
