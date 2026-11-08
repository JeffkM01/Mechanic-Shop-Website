import { useEffect, useRef, useState } from "react";
import { DECLINE_EXPLANATION_MAX, DECLINE_NEXT_STEPS, DECLINE_REASONS, getDeclinePreview, validateDeclineReason } from "../../shared/declineReasons.js";
import { formatBookingDate, formatBookingTime } from "../utils/bookingDates";

export default function DeclineAppointmentDialog({ appointment, busy, locked, error, serverFields = {}, onCancel, onConfirm, onRefresh }) {
  const [category, setCategory] = useState("");
  const [explanation, setExplanation] = useState("");
  const [errors, setErrors] = useState({});
  const dialog = useRef(null);
  const categoryInput = useRef(null);
  const explanationInput = useRef(null);
  const fields = { ...serverFields, ...errors };
  const preview = getDeclinePreview(category, explanation);
  const timezone = appointment.scheduling?.timezone || "America/Chicago";

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
    if (serverFields["decline.category"]) categoryInput.current?.focus();
    else if (serverFields["decline.explanation"]) explanationInput.current?.focus();
  }, [serverFields]);

  async function submit(event) {
    event.preventDefault();
    if (busy || locked) return;
    const prepared = validateDeclineReason({ category, explanation });
    setErrors(prepared.fields || {});
    if (prepared.error) {
      if (prepared.fields?.["decline.category"]) categoryInput.current?.focus();
      else explanationInput.current?.focus();
      return;
    }
    // Send the editable addition, not the assembled preview: the server builds
    // and atomically stores the final customer message with the declined status.
    await onConfirm({ category, explanation: explanation.trim() });
  }

  return <dialog className="decline-dialog" ref={dialog} aria-labelledby="decline-heading" aria-describedby="decline-description"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={submit} noValidate>
      <p className="staff-kicker">A CLEAR EXPLANATION MATTERS</p><h2 id="decline-heading" className="decline-heading">Review appointment decline</h2>
      <p id="decline-description" className="decline-help">Decline only when the shop cannot fulfill this request. For a scheduling conflict, a different date, parts to order, or information to discuss, keep the request pending and contact the customer using their phone or email.</p>
      <p><strong>{appointment.name}</strong><br />{appointment.service} · {formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)} ({timezone})</p>
      {error && <p className="decline-error" role="alert">{error}</p>}
      <label className="decline-field" htmlFor="decline-category">Reason category</label>
      <select id="decline-category" aria-label="Reason category" ref={categoryInput} value={category} disabled={busy || locked} required
        aria-invalid={Boolean(fields["decline.category"]) || undefined} aria-describedby={fields["decline.category"] ? "decline-category-error" : undefined}
        onChange={event => { setCategory(event.target.value); setErrors(current => ({ ...current, "decline.category": undefined, "decline.explanation": fields["decline.explanation"] ? validateDeclineReason({ category: event.target.value, explanation }).fields?.["decline.explanation"] : undefined })); }}>
        <option value="">Choose a reason</option>{DECLINE_REASONS.map(reason => <option value={reason.id} key={reason.id}>{reason.label}</option>)}
      </select>
      {fields["decline.category"] && <p id="decline-category-error" className="decline-error">{fields["decline.category"]}</p>}
      <label className="decline-field" htmlFor="decline-explanation">Additional explanation {category === "other" ? "(required)" : "(optional)"}</label>
      <textarea id="decline-explanation" aria-label="Additional explanation" ref={explanationInput} rows={4} value={explanation} maxLength={DECLINE_EXPLANATION_MAX} disabled={busy || locked} required={category === "other"}
        aria-invalid={Boolean(fields["decline.explanation"]) || undefined} aria-describedby={`decline-explanation-help${fields["decline.explanation"] ? " decline-explanation-error" : ""}`}
        onChange={event => { setExplanation(event.target.value); if (fields["decline.explanation"]) setErrors(current => ({ ...current, "decline.explanation": validateDeclineReason({ category, explanation: event.target.value }).fields?.["decline.explanation"] })); }} />
      <p id="decline-explanation-help" className="decline-help">Customers will receive this explanation. Use at least 10 characters when adding details; keep internal notes and private information out. Maximum {DECLINE_EXPLANATION_MAX} characters.</p>
      {fields["decline.explanation"] && <p id="decline-explanation-error" className="decline-error">{fields["decline.explanation"]}</p>}
      <section className="decline-preview" aria-label="Customer message preview"><h3>Customer message preview</h3>{preview ? <>
        <p>Hello {appointment.name},</p><p>Unfortunately, we're unable to approve your appointment request for {appointment.service} on {formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)} ({timezone}). This request has been declined.</p><p><strong>Reason:</strong> {preview}</p><p>{DECLINE_NEXT_STEPS}</p><p>Thank you,<br />Ed's Auto Shop</p>
      </> : <p>Choose a reason to preview the customer’s message.</p>}</section>
      <p className="decline-help">The request stays pending until you select Confirm Decline. A saved decline releases its reservation; email delivery is handled separately.</p>
      <div className="decline-actions"><button type="button" className="staff-button staff-button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>{locked ? <button type="button" className="staff-button staff-button-primary" onClick={onRefresh} disabled={busy}>Refresh appointment status</button> : <button type="submit" className="staff-button staff-button-primary" disabled={busy}>{busy ? "Saving decline…" : "Confirm Decline"}</button>}</div>
    </form>
  </dialog>;
}
