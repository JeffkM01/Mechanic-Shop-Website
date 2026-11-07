import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { SERVICE_CATEGORIES, SERVICES, getService, getServiceSelection } from "../../shared/services.js";
import { Icon } from "../components/CustomerUI";
import BookingCalendar from "../components/BookingCalendar";
import useBookingAvailability from "../hooks/useBookingAvailability";
import { formatBookingDate, formatBookingTime } from "../utils/bookingDates";
import { validateAppointment } from "../utils/appointmentValidation";
import "../styles/Appointment.css";

const emptyDetails = { name: "", email: "", phone: "", vehicle: "", notes: "" };
const stepLabels = ["Choose a service", "Find your time", "Your details", "Review & send"];

function TimeChoices({ date, data, loading, error, selectedTime, onSelect, onRetry, disabled }) {
  const slots = data?.slots || [];
  return <section className="booking-times" aria-labelledby="booking-times-heading" aria-busy={loading}>
    <p className="booking-kicker">AVAILABLE START TIMES</p>
    <h3 id="booking-times-heading">{date ? formatBookingDate(date) : "Find a time that fits."}</h3>
    <div aria-live="polite" className="booking-time-message">
      {!date ? <p>Choose an available day on the calendar to see appointment times.</p>
        : loading ? <p role="status">Checking appointment times…</p>
          : error ? <><p role="alert">{error}</p><button type="button" className="booking-retry" onClick={onRetry} disabled={disabled}>Retry appointment times <Icon name="arrow" /></button></>
            : !slots.length ? <p>No appointment times are available for this date. Please choose another day.</p>
              : <p>Times shown in <strong>{data.timezone}</strong>.</p>}
    </div>
    {!loading && !error && slots.length > 0 && <div className="booking-time-groups">{["Morning", "Afternoon"].map(period => {
      const group = slots.filter(slot => (Number(slot.time.slice(0, 2)) < 12) === (period === "Morning"));
      return group.length > 0 && <fieldset className="booking-time-group" key={period} disabled={disabled}>
        <legend>{period}</legend><div>{group.map(slot => <label className="booking-time-option" key={slot.startAt}>
          <input type="radio" name="appointment-time" value={slot.time} checked={selectedTime === slot.time} onChange={() => onSelect(slot.time)} />
          <span>{formatBookingTime(slot.time)}{selectedTime === slot.time && <Icon name="check" />}</span>
        </label>)}</div>
      </fieldset>;
    })}</div>}
    {date && data && !error && <p className="booking-freshness"><Icon name="clock" />Times may change. We’ll check again before you review and send.</p>}
  </section>;
}

function Summary({ request }) {
  return <dl className="booking-summary">
    <div><dt>Service</dt><dd>{request.service}{getService(request.service)?.provisional && <span className="booking-provisional-small">Provisional · availability to be confirmed</span>}</dd></div>
    <div><dt>Date & time</dt><dd>{formatBookingDate(request.date)}<br />{formatBookingTime(request.time)} · {request.timezone}</dd></div>
    <div><dt>Booking estimate</dt><dd>{request.durationMinutes} minutes<span className="booking-summary-note">Not a guaranteed repair completion time.</span></dd></div>
    <div><dt>Customer</dt><dd>{request.name}<br />{request.email}<br />{request.phone}</dd></div>
    <div><dt>Vehicle</dt><dd>{request.vehicle}</dd></div>
    {request.notes.trim() && <div><dt>Additional notes</dt><dd>{request.notes}</dd></div>}
  </dl>;
}

function BookingExperience({ initialService, details, setDetails }) {
  const [selection, setSelection] = useState({ service: initialService, date: "", time: "" });
  const [preview, setPreview] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const version = useRef(0);
  const active = useRef(true);
  const busy = useRef(false);
  const detailHeading = useRef(null);
  const reviewHeading = useRef(null);
  const errorBox = useRef(null);
  const successHeading = useRef(null);
  const availability = useBookingAvailability(selection.service, selection.date);
  const metadata = availability.dayData || availability.calendarData;
  const service = getService(selection.service);
  const slot = availability.dayData?.slots.find(item => item.time === selection.time);
  const locked = checking || sending;
  const currentStep = preview ? 4 : slot ? 3 : service ? 2 : 1;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (preview) reviewHeading.current?.focus({ preventScroll: false }); }, [preview]);
  useEffect(() => { if (saved) successHeading.current?.focus({ preventScroll: false }); }, [saved]);
  useEffect(() => { if (error) errorBox.current?.focus({ preventScroll: true }); }, [error]);

  function changeService(event) {
    version.current++;
    setSelection({ service: event.target.value, date: "", time: "" });
    setPreview(null); setError(""); availability.resetMonth();
  }
  function chooseDate(date) {
    if (!availability.days.some(day => day.date === date && day.available)) return;
    version.current++;
    setSelection(current => ({ ...current, date, time: current.date === date ? current.time : "" }));
    setPreview(null); setError("");
  }
  function chooseTime(time) {
    if (!availability.dayData?.slots.some(item => item.time === time)) return;
    version.current++;
    setSelection(current => ({ ...current, time }));
    setPreview(null); setError("");
  }
  function changeDetails(event) {
    const { name, value } = event.target;
    version.current++;
    setDetails(current => ({ ...current, [name]: value }));
    setPreview(null); setError("");
  }
  function recoverConflict(message) {
    version.current++;
    setError(message || "The selected time is no longer available. Please choose another appointment time.");
    setSelection(current => ({ ...current, time: "" }));
    setPreview(null);
    availability.invalidate();
  }

  async function review(event) {
    event.preventDefault();
    if (busy.current) return;
    const message = validateAppointment({ ...details, ...selection }, new Date(), { schedulingAuthoritative: true });
    if (message || !slot) { setError(message || "Please explicitly select an available appointment time."); return; }
    const token = version.current;
    busy.current = true; setChecking(true); setError("");
    try {
      const fresh = await availability.refreshDay();
      if (!active.current || token !== version.current || !fresh) return;
      const freshSlot = fresh.slots.find(item => item.time === selection.time);
      if (!freshSlot) { recoverConflict(); return; }
      setPreview({ ...details, ...selection, timezone: fresh.timezone, durationMinutes: fresh.durationMinutes, startAt: freshSlot.startAt, endAt: freshSlot.endAt });
    } catch (failure) {
      if (active.current && token === version.current) setError(failure.message || "We could not recheck this time. Please retry availability.");
    } finally { busy.current = false; if (active.current) setChecking(false); }
  }

  async function send() {
    if (busy.current || !preview) return;
    const token = version.current;
    busy.current = true; setSending(true); setError("");
    try {
      const fresh = await availability.refreshDay();
      if (!active.current || token !== version.current || !fresh) return;
      const freshSlot = fresh.slots.find(item => item.time === preview.time);
      if (!freshSlot) { recoverConflict(); return; }
      if (fresh.timezone !== preview.timezone || fresh.durationMinutes !== preview.durationMinutes
        || freshSlot.startAt !== preview.startAt || freshSlot.endAt !== preview.endAt) {
        version.current++;
        setPreview(null);
        setError("The shop’s scheduling details have changed. Please review your updated appointment time and duration before sending.");
        return;
      }
      const payload = Object.fromEntries(["name", "email", "phone", "vehicle", "service", "date", "time", "notes"].map(key => [key, preview[key]]));
      const response = await fetch("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!active.current || token !== version.current) return;
      if (response.status === 409) { recoverConflict("The selected time is no longer available. Please choose another appointment time."); return; }
      if (!response.ok) throw new Error(data.error || "Your request could not be sent. Please try again.");
      if (!["pending", "confirmed"].includes(data.status) || typeof data.id !== "string") throw new Error("We could not verify the saved request. Please contact the shop before submitting again.");
      setSaved({ ...data, request: preview });
      setDetails({ ...emptyDetails });
      setPreview(null);
      availability.invalidate();
    } catch (failure) {
      if (active.current && token === version.current) setError(failure instanceof TypeError ? "Your request could not be sent right now. Please try again." : failure.message);
    } finally { busy.current = false; if (active.current) setSending(false); }
  }

  function edit() { setPreview(null); detailHeading.current?.focus({ preventScroll: false }); }
  function anotherRequest() {
    version.current++; setSaved(null); setError("");
    setSelection({ service: initialService, date: "", time: "" });
    availability.resetMonth(); availability.invalidate();
  }

  return <main className="customer-page booking-page">
    <header className="booking-intro"><div className="site-container booking-intro-inner"><div><p className="eyebrow">A LITTLE CARE FOR WHAT’S AHEAD</p><h1>Let’s make time<br />for your car.</h1></div><div><p>Choose a service, find an available time, and tell us about your vehicle. A clear next step starts here.</p><span><Icon name="shield" />Secure requests. Personal service.</span></div></div></header>
    <div className="site-container booking-container">
      {!saved && <ol className="booking-steps" aria-label="Booking steps">{stepLabels.map((label, index) => <li key={label} aria-current={currentStep === index + 1 ? "step" : undefined} className={currentStep > index + 1 ? "is-complete" : ""}><span>{currentStep > index + 1 ? <Icon name="check" /> : `0${index + 1}`}</span>{label}</li>)}</ol>}
      {error && <p className="booking-error" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}
      {saved ? <section className="booking-success" aria-labelledby="booking-success-heading">
        <span className="booking-success-icon"><Icon name={saved.status === "confirmed" ? "check" : "clock"} /></span>
        <p className="eyebrow">{saved.status === "confirmed" ? "APPOINTMENT CONFIRMED" : "REQUEST RECEIVED"}</p>
        <h2 id="booking-success-heading" tabIndex={-1} ref={successHeading}>{saved.status === "confirmed" ? "You’re on the schedule." : "Your next step is in good hands."}</h2>
        <p className="booking-success-message" role="status">{saved.status === "pending" ? "Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet." : "Your appointment has been confirmed. The service duration is a booking estimate, not a guaranteed repair completion time."}</p>
        <div className="booking-reference"><span>YOUR REFERENCE ID</span><strong>{saved.id}</strong></div>
        {saved.status === "pending" && saved.holdExpiresAt && <p className="booking-hold">Your provisional time reservation expires <time dateTime={saved.holdExpiresAt}>{new Date(saved.holdExpiresAt).toLocaleString(undefined, { timeZone: saved.request.timezone })}</time> ({saved.request.timezone}). Your request stays on file after expiry, but availability must be checked again before approval.</p>}
        <Summary request={saved.request} />
        {saved.emailNotification === "queued" && <p className="booking-receipt-note">A status email has been queued for delivery. Keep your reference ID for your records.</p>}
        <div className="booking-actions"><button type="button" className="button button-primary" onClick={anotherRequest}>Make another request <Icon name="arrow" /></button><Link className="text-link" to="/">Back to the shop</Link></div>
      </section> : <>
        <form onSubmit={review} className="booking-form">
          <fieldset className="booking-service-panel booking-panel" disabled={locked}>
            <legend className="booking-sr-only">Step 1: Choose a service</legend>
            <div className="booking-panel-heading"><span className="booking-step-number">01</span><div><p className="booking-kicker">START WITH YOUR VEHICLE</p><h2>What can we help with?</h2></div></div>
            <div className="booking-service-layout"><label className="booking-field">Service needed<select name="service" value={selection.service} onChange={changeService} required>
              <option value="">Choose a service</option>{SERVICE_CATEGORIES.map(category => <optgroup label={category.label} key={category.id}>{SERVICES.filter(item => item.category === category.id).map(item => <option value={item.name} key={item.name}>{item.name}{item.provisional ? " (provisional)" : ""}</option>)}</optgroup>)}
            </select></label><div className="booking-service-hint"><Icon name={service?.icon || "wrench"} /><p>{service?.category === "repairs" ? "Repairs & Diagnostics requests always need mechanic approval." : "Not sure what your car needs? Choose Other / Not Sure and describe what you’ve noticed."}</p></div></div>
            {service?.provisional && <p className="booking-notice"><strong>Provisional service.</strong> {service.name} availability needs Edward’s confirmation before an appointment can be approved.</p>}
          </fieldset>

          <section className="booking-panel booking-date-panel" aria-labelledby="booking-date-heading">
            <div className="booking-panel-heading"><span className="booking-step-number">02</span><div><p className="booking-kicker">PLAN YOUR VISIT</p><h2 id="booking-date-heading">A day and time that work.</h2></div></div>
            {metadata && <div className="booking-policy-strip"><span><Icon name="clock" />{metadata.durationMinutes}-minute booking estimate</span><span>{metadata.timezone}</span><p>Repair completion time may vary.</p></div>}
            <div className="booking-calendar-layout"><BookingCalendar month={availability.month} today={availability.calendarData?.today} firstDate={availability.calendarData?.firstDate} lastDate={availability.calendarData?.lastDate} days={availability.days} selectedDate={selection.date} loading={availability.calendarLoading} error={availability.calendarError} onMonthChange={availability.setViewMonth} onSelectDate={chooseDate} onRetry={availability.refreshMonth} disabled={locked || !service} />
              <TimeChoices date={selection.date} data={availability.dayData} loading={availability.dayLoading} error={availability.dayError} selectedTime={selection.time} onSelect={chooseTime} onRetry={availability.retryDay} disabled={locked} /></div>
            {metadata?.settingsProvisional && <p className="booking-notice"><strong>Subject to mechanic confirmation.</strong> Shop hours and capacity are provisional. Requests remain pending until Edward reviews them.</p>}
            {metadata?.policy && <p className="booking-policy-note">Request at least {metadata.policy.minimumNoticeHours} hours ahead, within the next {metadata.policy.bookingHorizonDays} days. Pending requests reserve time for {metadata.policy.pendingHoldHours} hours after submission.</p>}
            {slot && <div className="booking-picked"><span><Icon name="check" />{formatBookingDate(selection.date)} · {formatBookingTime(selection.time)}</span><button className="text-link" type="button" onClick={() => detailHeading.current?.focus({ preventScroll: false })} disabled={locked}>Continue to your details <Icon name="arrow" /></button></div>}
          </section>

          <fieldset className="booking-panel booking-details-panel" disabled={locked || !slot}>
            <legend className="booking-sr-only">Step 3: Customer and vehicle details</legend>
            <div className="booking-panel-heading"><span className="booking-step-number">03</span><div><p className="booking-kicker">LET’S GET TO KNOW YOUR CAR</p><h2 ref={detailHeading} tabIndex={-1}>Your details. Your vehicle.</h2></div></div>
            {!slot && <p className="booking-details-hint">Select an available appointment time to continue. Your details stay here if you need to choose a different time.</p>}
            <div className="booking-details-grid">
              <label className="booking-field">Full name<input name="name" autoComplete="name" maxLength={80} value={details.name} onChange={changeDetails} required /></label>
              <label className="booking-field">Email address<input name="email" type="email" autoComplete="email" maxLength={254} value={details.email} onChange={changeDetails} required /></label>
              <label className="booking-field">Phone number<input name="phone" type="tel" autoComplete="tel" maxLength={24} placeholder="(555) 555-1234" value={details.phone} onChange={changeDetails} required /></label>
              <label className="booking-field">Vehicle information<input name="vehicle" maxLength={120} placeholder="Year, make, and model" value={details.vehicle} onChange={changeDetails} required /></label>
              <label className="booking-field booking-wide">Additional notes (optional)<textarea name="notes" rows={3} maxLength={1000} placeholder="Tell us what you’ve noticed or anything else we should know." value={details.notes} onChange={changeDetails} /></label>
            </div>
            <div className="booking-review-action"><p>Review your details before anything is sent.</p><button className="button button-primary" type="submit" disabled={locked || !slot}>{checking ? "Rechecking your time…" : "Review Appointment Request"}<Icon name="arrow" /></button></div>
          </fieldset>
        </form>
        {preview && <section className="booking-panel booking-review-panel" aria-labelledby="booking-review-heading">
          <div className="booking-panel-heading"><span className="booking-step-number">04</span><div><p className="booking-kicker">ONE LAST LOOK</p><h2 id="booking-review-heading" tabIndex={-1} ref={reviewHeading}>Review your appointment request.</h2></div></div>
          <p>Nothing has been submitted yet. Check the details below, then send your request when you’re ready.</p><Summary request={preview} />
          <p className="booking-notice">{getService(preview.service)?.provisional ? "This service is provisional and needs availability confirmation. " : ""}A pending request is not a confirmed appointment. We’ll show the status saved by the shop after you send.</p>
          <div className="booking-actions"><button type="button" className="button button-secondary" onClick={edit} disabled={sending}>Edit Details</button><button type="button" className="button button-primary" onClick={send} disabled={sending}>{sending ? "Sending your request…" : "Send Appointment Request"}<Icon name="arrow" /></button></div>
        </section>}
      </>}
    </div>
  </main>;
}

export default function Appointment() {
  const { search } = useLocation();
  const initialService = getServiceSelection(search);
  const [details, setDetails] = useState({ ...emptyDetails });
  // Linked service changes reset scheduling/review, while keeping unsent contact
  // details in this parent. No contact information is written to browser storage.
  return <BookingExperience key={initialService} initialService={initialService} details={details} setDetails={setDetails} />;
}
