import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CANCELLATION_MESSAGE_MAX, CUSTOMER_CANCELLATION_REASONS, validateCancellation } from "../../shared/cancellations.js";
import useCustomerAppointment from "../hooks/useCustomerAppointment.js";
import { formatBookingDate, formatBookingTime, formatShopTimestamp } from "../utils/bookingDates.js";
import "../styles/ManageAppointment.css";

const STATUS_LABELS = { pending: "Pending approval", confirmed: "Confirmed", declined: "Declined", cancelled: "Cancelled" };

function CancellationDialog({ appointment, busy, checking, locked, error, serverFields, onKeep, onConfirm, onRefresh }) {
  const [category, setCategory] = useState("");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState({});
  const dialog = useRef(null);
  const categoryInput = useRef(null);
  const messageInput = useRef(null);
  const fields = { ...serverFields, ...errors };

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element.open) element.showModal();
    categoryInput.current?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.disabled) opener.focus();
      else document.getElementById("manage-appointment-heading")?.focus();
    };
  }, []);

  useEffect(() => {
    if (serverFields["cancellation.category"]) categoryInput.current?.focus();
    else if (serverFields["cancellation.message"]) messageInput.current?.focus();
  }, [serverFields]);

  async function submit(event) {
    event.preventDefault();
    if (busy || locked || checking) return;
    const result = validateCancellation("customer", { category, message });
    setErrors(result.fields || {});
    if (result.error) {
      if (result.fields["cancellation.category"]) categoryInput.current?.focus();
      else messageInput.current?.focus();
      return;
    }
    await onConfirm(result.value);
  }

  return <dialog className="manage-dialog" ref={dialog} aria-labelledby="customer-cancellation-heading" aria-describedby="customer-cancellation-description"
    onCancel={event => { event.preventDefault(); if (!busy && !checking) onKeep(); }}>
    <form onSubmit={submit} noValidate>
      <p className="eyebrow">REVIEW CANCELLATION</p>
      <h2 id="customer-cancellation-heading">Are you sure you want to cancel your appointment?</h2>
      <p id="customer-cancellation-description">Cancellation removes this appointment from the shop's active schedule and releases its reserved time. No replacement appointment will be booked.</p>
      <div className="manage-dialog-summary"><strong>{appointment.service}</strong><span>{formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)}</span><span>{appointment.timezone}</span></div>
      {error && <p className="manage-error" role="alert">{error}</p>}
      <label htmlFor="customer-cancellation-category">Cancellation reason (optional)</label>
      <select ref={categoryInput} id="customer-cancellation-category" value={category} disabled={busy || locked || checking}
        aria-invalid={Boolean(fields["cancellation.category"]) || undefined} aria-describedby={fields["cancellation.category"] ? "customer-cancellation-category-error" : undefined}
        onChange={event => { setCategory(event.target.value); setErrors(current => ({ ...current, "cancellation.category": undefined })); }}>
        <option value="">No reason selected</option>
        {CUSTOMER_CANCELLATION_REASONS.map(reason => <option value={reason.id} key={reason.id}>{reason.label}</option>)}
      </select>
      {fields["cancellation.category"] && <p className="manage-field-error" id="customer-cancellation-category-error">{fields["cancellation.category"]}</p>}
      <label htmlFor="customer-cancellation-message">Additional message (optional)</label>
      <textarea ref={messageInput} id="customer-cancellation-message" rows={4} value={message} maxLength={CANCELLATION_MESSAGE_MAX} disabled={busy || locked || checking}
        aria-invalid={Boolean(fields["cancellation.message"]) || undefined} aria-describedby={`customer-cancellation-message-help${fields["cancellation.message"] ? " customer-cancellation-message-error" : ""}`}
        onChange={event => { setMessage(event.target.value); if (fields["cancellation.message"]) setErrors(current => ({ ...current, "cancellation.message": validateCancellation("customer", { category, message: event.target.value }).fields?.["cancellation.message"] })); }} />
      <p className="manage-help" id="customer-cancellation-message-help">You do not need to explain your cancellation. If you add a message, the shop can read it. Maximum {CANCELLATION_MESSAGE_MAX} characters.</p>
      {fields["cancellation.message"] && <p className="manage-field-error" id="customer-cancellation-message-error">{fields["cancellation.message"]}</p>}
      <div className="manage-dialog-actions">
        <button className="button button-secondary" type="button" onClick={onKeep} disabled={busy || checking}>Keep My Appointment</button>
        {locked ? <button className="button button-primary" type="button" onClick={onRefresh} disabled={busy || checking}>{checking ? "Refreshing status…" : "Refresh appointment status"}</button>
          : <button className="button manage-cancel-button" type="submit" disabled={busy || checking}>{busy ? "Saving cancellation…" : "Confirm Cancellation"}</button>}
      </div>
    </form>
  </dialog>;
}

function NotificationNotice({ notifications }) {
  const values = [notifications?.customer, notifications?.mechanic].map(value => typeof value === "object" ? value?.status : value);
  if (values.some(value => ["queued", "pending", "sending", "retry"].includes(value))) return <p className="manage-help">Cancellation emails are queued for delivery. Delivery may take time; the saved cancellation is already in effect.</p>;
  if (values.some(value => ["failed", "disabled", "unavailable"].includes(value)) || !values.some(Boolean)) return <p className="manage-help">Email delivery is unavailable or could not be queued. Your cancellation is saved and visible to the shop.</p>;
  return <p className="manage-help">Your cancellation is saved and visible to the shop. Email delivery is handled separately.</p>;
}

export default function ManageAppointment() {
  const management = useCustomerAppointment();
  const [review, setReview] = useState(false);
  const [justCancelled, setJustCancelled] = useState(false);
  const resultHeading = useRef(null);
  const appointment = management.data?.appointment;
  const cancellation = appointment?.cancellation;
  const timezone = cancellation?.timezone || appointment?.timezone;
  const cancelled = appointment?.status === "cancelled";

  useEffect(() => {
    if (cancelled) resultHeading.current?.focus();
  }, [cancelled]);

  async function confirm(reason) {
    if (await management.cancel(reason)) {
      setJustCancelled(true);
      setReview(false);
    }
  }

  return <main className="customer-page manage-page">
    <header className="manage-hero"><div className="site-container"><p className="eyebrow">ED'S AUTO SHOP</p><h1 id="manage-appointment-heading" tabIndex={-1}>Manage your appointment</h1><p>Review your visit and securely manage its cancellation.</p></div></header>
    <div className="site-container manage-content">
      {!appointment && management.checking ? <section className="manage-card manage-access-state" aria-label="Verifying appointment access"><p role="status">Securely checking your appointment…</p></section>
        : !appointment ? <section className="manage-card manage-access-state" aria-labelledby="manage-access-heading"><p className="eyebrow">APPOINTMENT ACCESS</p><h2 id="manage-access-heading">{management.logoutPending ? "Details hidden" : "Your appointment is private"}</h2><p role="status">{management.message || "This appointment-management link is no longer valid. Please contact the shop for help."}</p><p>Use the contact details supplied with your appointment or get in touch with the shop. An appointment reference alone cannot open your record.</p><div className="manage-inline-actions">{management.logoutPending ? <button className="button button-secondary" type="button" onClick={management.closeAccess}>Retry closing access</button> : management.canRefresh && <button className="button button-secondary" type="button" onClick={() => management.refresh()}>Refresh appointment status</button>}<Link className="button button-primary" to="/contact">Contact the shop</Link></div></section>
          : <div className="manage-private">
            <section className="manage-card" aria-labelledby={cancelled ? "manage-result-heading" : "manage-details-heading"}>
              <div className="manage-card-heading"><div><p className="eyebrow">{cancelled ? "SAVED CANCELLATION" : "YOUR VISIT"}</p><h2 id={cancelled ? "manage-result-heading" : "manage-details-heading"} tabIndex={-1} ref={resultHeading}>{cancelled ? "Appointment Cancelled" : "Appointment details"}</h2></div><span className={`manage-status manage-status-${appointment.status}`}>{STATUS_LABELS[appointment.status] || appointment.status}</span></div>
              {cancelled && <div className="manage-result" role="status"><p>{justCancelled ? "Your appointment has been cancelled. The shop's schedule has been updated." : "This appointment has already been cancelled."}</p><p>This time slot is no longer reserved for this appointment.</p></div>}
              {appointment.status === "pending" && <p className="manage-status-help">This request is awaiting mechanic approval. It is not a confirmed appointment.</p>}
              <dl className="manage-details">
                <div><dt>Service requested</dt><dd>{appointment.service}</dd></div>
                <div><dt>Vehicle</dt><dd>{appointment.vehicle}</dd></div>
                <div><dt>Appointment date</dt><dd>{formatBookingDate(cancellation?.originalDate || appointment.date) || "Contact the shop to verify"}</dd></div>
                <div><dt>Appointment time</dt><dd>{formatBookingTime(cancellation?.originalTime || appointment.time) || "Contact the shop to verify"}{timezone && <span className="manage-timezone">{timezone}</span>}</dd></div>
                {appointment.durationMinutes > 0 && <div><dt>Estimated service duration</dt><dd>{appointment.durationMinutes} minutes<span className="manage-detail-note">An estimate for booking, not a guaranteed completion time.</span></dd></div>}
                <div><dt>Appointment reference</dt><dd className="manage-reference">{appointment.id}</dd></div>
              </dl>
              {appointment.status === "declined" && <div className="manage-record-note"><h3>Request declined</h3><p>{typeof appointment.decline === "string" ? appointment.decline : appointment.decline?.explanation || "Please contact the shop to discuss another visit."}</p></div>}
              {cancellation && <div className="manage-record-note"><h3>Cancellation details</h3><p><strong>Cancelled by:</strong> {cancellation.by === "mechanic" ? "The shop" : "Customer"}{cancellation.cancelledAt && timezone && <><br /><strong>Cancelled at:</strong> {formatShopTimestamp(cancellation.cancelledAt, timezone)} ({timezone})</>}</p>{cancellation.explanation && <p>{cancellation.explanation}</p>}{cancellation.message && <p><strong>Your message:</strong> {cancellation.message}</p>}</div>}
              {cancelled && <NotificationNotice notifications={management.data.notifications} />}
            </section>
            {!cancelled && <section className="manage-card manage-actions-card" aria-labelledby="manage-actions-heading"><div><p className="eyebrow">NEXT STEPS</p><h2 id="manage-actions-heading">Your appointment options</h2>{appointment.canCancel ? <p>Need to cancel your visit? You can cancel your appointment here. We'll notify the shop.</p> : <p>{appointment.eligibilityMessage || "Online cancellation is no longer available for this appointment. Please contact the shop."}</p>}</div><div className="manage-inline-actions">{appointment.canCancel && <button type="button" className="button manage-cancel-button" disabled={management.busy || management.checking} onClick={() => setReview(true)}>Cancel Appointment</button>}<Link className="text-link" to="/contact">Contact the shop</Link></div></section>}
            {management.message && <p className="manage-error" role="alert">{management.message}</p>}
            <footer className="manage-privacy"><p>Using a shared device? Close appointment access when you are finished. Keep your management link private.</p><button type="button" className="button button-secondary" onClick={management.closeAccess} disabled={management.busy || management.checking}>Close appointment access</button></footer>
            {review && !cancelled && <CancellationDialog appointment={appointment} busy={management.busy} checking={management.checking} locked={management.uncertain} error={management.actionError} serverFields={management.fields} onKeep={() => setReview(false)} onConfirm={confirm} onRefresh={() => management.refresh()} />}
          </div>}
    </div>
  </main>;
}
