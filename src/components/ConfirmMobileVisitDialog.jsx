import { useEffect, useRef, useState } from "react";
import { prepareMobileReview } from "../../shared/mobileBooking.js";
import { formatBookingDate, formatBookingTime } from "../utils/bookingDates";
import "../styles/ConfirmMobileVisit.css";

const reviewFields = ["locationConfirmed", "travelConfirmed", "travelBufferMinutes"];
const normalizeFields = fields => Object.fromEntries(reviewFields.map(name => [name, fields[`mobileReview.${name}`] || fields[name]]));

export default function ConfirmMobileVisitDialog({ appointment, busy, locked, error, serverFields = {}, onCancel, onConfirm, onRefresh }) {
  const minimum = Math.max(appointment.scheduling?.bufferMinutes || 0, appointment.mobileVisit.travelBufferMinutes);
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const [travelConfirmed, setTravelConfirmed] = useState(false);
  const [travelBufferMinutes, setTravelBufferMinutes] = useState(minimum);
  const [errors, setErrors] = useState({});
  const dialog = useRef(null);
  const locationInput = useRef(null);
  const travelInput = useRef(null);
  const bufferInput = useRef(null);
  const timezone = appointment.scheduling?.timezone || "America/Chicago";
  const fields = { ...normalizeFields(serverFields), ...errors };
  const fieldError = name => fields[name];

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element.open) element.showModal();
    locationInput.current?.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.disabled) opener.focus();
      else document.getElementById("staff-appointments-heading")?.focus();
    };
  }, []);
  useEffect(() => {
    if (serverFields["mobileReview.locationConfirmed"] || serverFields.locationConfirmed) locationInput.current?.focus();
    else if (serverFields["mobileReview.travelConfirmed"] || serverFields.travelConfirmed) travelInput.current?.focus();
    else if (serverFields["mobileReview.travelBufferMinutes"] || serverFields.travelBufferMinutes) bufferInput.current?.focus();
  }, [serverFields]);

  function clearError(name) {
    setErrors(current => ({ ...current, [name]: undefined }));
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || locked) return;
    const prepared = prepareMobileReview({ locationConfirmed, travelConfirmed, travelBufferMinutes }, minimum);
    setErrors(normalizeFields(prepared.fields || {}));
    if (prepared.error) {
      const fields = prepared.fields || {};
      if (fields.locationConfirmed || fields["mobileReview.locationConfirmed"]) locationInput.current?.focus();
      else if (fields.travelConfirmed || fields["mobileReview.travelConfirmed"]) travelInput.current?.focus();
      else bufferInput.current?.focus();
      return;
    }
    await onConfirm(prepared.value);
  }

  return <dialog className="decline-dialog mobile-confirm-dialog" ref={dialog} aria-labelledby="mobile-confirm-heading" aria-describedby="mobile-confirm-description"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={submit} noValidate>
      <p className="staff-kicker">CHECK THE VISIT AND THE JOURNEY</p><h2 id="mobile-confirm-heading">Review mobile appointment</h2>
      <p id="mobile-confirm-description">Confirm only after reviewing the actual service location, site access, and route between visits. The website does not calculate driving time or verify coverage for you.</p>
      <p><strong>{appointment.name}</strong><br />{appointment.service} · {formatBookingDate(appointment.date)} at {formatBookingTime(appointment.time)} ({timezone})<br />{appointment.mobileVisit.city}, {appointment.mobileVisit.state} {appointment.mobileVisit.postalCode}</p>
      {error && <p className="decline-error" role="alert">{error}</p>}
      <fieldset className="mobile-confirm-checks" disabled={busy || locked}>
        <legend>Required mechanic checks</legend>
        <label className="staff-check mobile-confirm-check"><input type="checkbox" ref={locationInput} checked={locationConfirmed}
          aria-invalid={Boolean(fieldError("locationConfirmed")) || undefined} aria-describedby={fieldError("locationConfirmed") ? "mobile-location-review-error" : undefined}
          onChange={event => { setLocationConfirmed(event.target.checked); clearError("locationConfirmed"); }} /><span>I checked service coverage, the private visit address, and site access.</span></label>
        {fieldError("locationConfirmed") && <p id="mobile-location-review-error" className="decline-error">{fieldError("locationConfirmed")}</p>}
        <label className="staff-check mobile-confirm-check"><input type="checkbox" ref={travelInput} checked={travelConfirmed}
          aria-invalid={Boolean(fieldError("travelConfirmed")) || undefined} aria-describedby={fieldError("travelConfirmed") ? "mobile-travel-review-error" : undefined}
          onChange={event => { setTravelConfirmed(event.target.checked); clearError("travelConfirmed"); }} /><span>I checked the route between appointments and allowed enough travel time.</span></label>
        {fieldError("travelConfirmed") && <p id="mobile-travel-review-error" className="decline-error">{fieldError("travelConfirmed")}</p>}
        <label className="decline-field" htmlFor="mobile-travel-buffer">Travel buffer (minutes)</label>
        <input id="mobile-travel-buffer" type="number" ref={bufferInput} min={minimum} max="120" step="1" required value={travelBufferMinutes}
          aria-invalid={Boolean(fieldError("travelBufferMinutes")) || undefined} aria-describedby={`mobile-travel-buffer-help${fieldError("travelBufferMinutes") ? " mobile-buffer-review-error" : ""}`}
          onChange={event => { setTravelBufferMinutes(event.target.value === "" ? "" : Number(event.target.value)); clearError("travelBufferMinutes"); }} />
        <p id="mobile-travel-buffer-help" className="decline-help">At least {minimum} minutes are already reserved after the service. Increase the allowance up to 120 minutes when the reviewed route needs it. Existing reserved time cannot be shortened. The server checks any extension for conflicts before confirming.</p>
        {fieldError("travelBufferMinutes") && <p id="mobile-buffer-review-error" className="decline-error">{fieldError("travelBufferMinutes")}</p>}
      </fieldset>
      <p className="decline-help">The request stays pending until confirmation is saved. No replacement time is offered automatically. If this route cannot fit the schedule, keep the request pending and contact the customer.</p>
      <div className="decline-actions"><button type="button" className="staff-button staff-button-secondary" onClick={onCancel} disabled={busy}>Keep pending</button>{locked
        ? <button type="button" className="staff-button staff-button-primary" onClick={onRefresh} disabled={busy}>Refresh appointment status</button>
        : <button type="submit" className="staff-button staff-button-primary" disabled={busy}>{busy ? "Saving confirmation…" : "Confirm mobile appointment"}</button>}</div>
      {!locked && error && <button type="button" className="staff-text-button mobile-confirm-refresh" onClick={onRefresh} disabled={busy}>Refresh appointment status</button>}
    </form>
  </dialog>;
}
