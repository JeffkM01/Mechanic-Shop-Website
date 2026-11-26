import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { SERVICE_CATEGORIES, getService, getServiceSelection } from "../../shared/services.js";
import { Icon } from "../components/CustomerUI";
import BookingCalendar from "../components/BookingCalendar";
import useBookingAvailability from "../hooks/useBookingAvailability";
import useServiceCatalog from "../hooks/useServiceCatalog";
import ServiceCatalogStatus from "../components/ServiceCatalogStatus";
import AppointmentEmailTestNotice from "../components/AppointmentEmailTestNotice";
import useAppointmentEmailTest from "../hooks/useAppointmentEmailTest";
import { formatBookingDate, formatBookingTime, formatShopTimestamp } from "../utils/bookingDates";
import { fieldLimits, validateAppointmentFields } from "../utils/appointmentValidation";
import { MOBILE_LOCATION_LIMITS, prepareMobileLocation } from "../../shared/mobileBooking.js";
import "../styles/Appointment.css";

const emptyDetails = { name: "", email: "", phone: "", vehicle: "", city: "", state: "", postalCode: "", notes: "" };
const mobileFieldNames = ["city", "state", "postalCode"];
const stepLabels = ["Choose a service", "Find your time", "Your details", "Review & send"];
const fieldOrder = ["service", "date", "time", "name", "email", "phone", "vehicle", ...mobileFieldNames, "notes"];
const fieldLabels = { service: "Service", date: "Appointment date", time: "Appointment time", name: "Full name", email: "Email address", phone: "Phone number", vehicle: "Vehicle information", city: "Service city", state: "Service state", postalCode: "Service ZIP code", notes: "Additional notes" };
const mobilePolicyKey = policy => policy ? `${policy.travelBufferMinutes}:mechanic-review` : "ordinary";
const travelAllowance = (policy, data) => policy ? Math.max(policy.travelBufferMinutes,
  Number.isInteger(data?.policy?.bufferMinutes) ? data.policy.bufferMinutes : 0) : null;

function FieldError({ name, message }) {
  return message ? <p className="booking-field-error" id={`booking-${name}-error`} aria-live="polite" aria-atomic="true">{message}</p> : null;
}

function readableAvailabilityError(message) {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message || "")
    ? "Appointment availability could not be loaded. Check your connection and retry."
    : message;
}

function CustomerField({ name, value, error, onChange, onBlur, inputRef, readOnly = false }) {
  const properties = {
    id: `booking-${name}`, name, value, onChange, onBlur, ref: inputRef,
    maxLength: fieldLimits[name] ?? MOBILE_LOCATION_LIMITS[name], required: name !== "notes", readOnly,
    "aria-invalid": Boolean(error) || undefined,
    "aria-describedby": [name === "phone" && "booking-phone-help", mobileFieldNames.includes(name) && "booking-mobile-location-help", readOnly && "booking-email-test-help", error && `booking-${name}-error`].filter(Boolean).join(" ") || undefined,
  };
  return <div className={`booking-field${name === "notes" ? " booking-wide" : ""}`}>
    <label htmlFor={`booking-${name}`}>{fieldLabels[name]}{name === "notes" ? " (optional)" : ""}</label>
    {name === "state" ? <select {...properties} autoComplete="address-level1"><option value="">Choose a state</option><option value="MO">Missouri</option><option value="IL">Illinois</option></select>
      : name === "notes" ? <textarea {...properties} rows={3} placeholder="Tell us what you’ve noticed or anything else we should know." />
      : <input {...properties} type={name === "email" ? "email" : name === "phone" ? "tel" : "text"}
        autoComplete={readOnly ? "off" : { name: "name", email: "email", phone: "tel", city: "address-level2", postalCode: "postal-code" }[name]}
        inputMode={name === "postalCode" ? "text" : undefined}
        placeholder={name === "phone" ? "(636) 555-1234" : name === "vehicle" ? "Year, make, and model" : undefined} />}
    {name === "phone" && <p className="booking-field-help" id="booking-phone-help">U.S. number, such as (636) 555-1234. An optional +1 country prefix is accepted.</p>}
    {readOnly && <p className="booking-field-help" id="booking-email-test-help">This private test uses the verified test inbox shown above.</p>}
    <FieldError name={name} message={error} />
  </div>;
}

function TimeChoices({ date, data, loading, error, fieldError, selectedTime, onSelect, onRetry, onBlur, groupRef, disabled }) {
  const slots = data?.slots || [];
  return <section className="booking-times" id="booking-time" tabIndex={-1} ref={groupRef} aria-labelledby="booking-times-heading" aria-busy={loading}
    aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? "booking-time-error" : undefined}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur(); }}>
    <p className="booking-kicker">AVAILABLE START TIMES</p>
    <h3 id="booking-times-heading">{date ? formatBookingDate(date) : "Find a time that fits."}</h3>
    <FieldError name="time" message={fieldError} />
    <div aria-live="polite" className="booking-time-message">
      {!date ? <p>Choose an available day on the calendar to see appointment times.</p>
        : loading ? <p role="status">Checking appointment times…</p>
          : error ? <><p role="alert">{readableAvailabilityError(error)}</p><button type="button" className="booking-retry" onClick={onRetry} disabled={disabled}>Retry appointment times <Icon name="arrow" /></button></>
            : !slots.length ? <p>No appointment times are available for this date. Please choose another day.</p>
              : <p>Times shown in <strong>{data.timezone}</strong>.</p>}
    </div>
    {!loading && !error && slots.length > 0 && <div className="booking-time-groups">{["Morning", "Afternoon"].map(period => {
      const group = slots.filter(slot => (Number(slot.time.slice(0, 2)) < 12) === (period === "Morning"));
      return group.length > 0 && <fieldset className="booking-time-group" key={period} disabled={disabled}>
        <legend>{period}</legend><div>{group.map(slot => <label className="booking-time-option" key={slot.startAt}>
          <input type="radio" name="appointment-time" value={slot.time} checked={selectedTime === slot.time} onChange={() => onSelect(slot.time)} aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? "booking-time-error" : undefined} />
          <span>{formatBookingTime(slot.time)}{selectedTime === slot.time && <Icon name="check" />}</span>
        </label>)}</div>
      </fieldset>;
    })}</div>}
    {date && data && !error && <p className="booking-freshness"><Icon name="clock" />Times may change. We’ll check again before you review and send.</p>}
  </section>;
}

function Summary({ request }) {
  return <dl className="booking-summary">
    <div><dt>Service</dt><dd>{request.service}{request.provisional && <span className="booking-provisional-small">Provisional · availability to be confirmed</span>}</dd></div>
    <div><dt>Date & time</dt><dd>{formatBookingDate(request.date)}<br />{formatBookingTime(request.time)} · {request.timezone}</dd></div>
    <div><dt>Booking estimate</dt><dd>{request.durationMinutes} minutes<span className="booking-summary-note">Not a guaranteed repair completion time.</span></dd></div>
    <div><dt>Customer</dt><dd>{request.name}<br />{request.email}<br />{request.phone}</dd></div>
    <div><dt>Vehicle</dt><dd>{request.vehicle}</dd></div>
    {request.mobileBooking && <>
      <div><dt>Service area</dt><dd>{request.city}, {request.state} {request.postalCode}<span className="booking-summary-note">Coverage and the visit location require mechanic review.</span></dd></div>
      <div><dt>Travel allowance</dt><dd>{request.travelBufferMinutes} minutes reserved after service<span className="booking-summary-note">Planning allowance, separate from the service estimate. It does not set a fee or guarantee driving time.</span></dd></div>
    </>}
    {request.notes.trim() && <div><dt>Additional notes</dt><dd>{request.notes}</dd></div>}
  </dl>;
}

function BookingIntro() {
  return <header className="booking-intro"><div className="site-container booking-intro-inner"><div><p className="eyebrow">A LITTLE CARE FOR WHAT’S AHEAD</p><h1>Let’s make time<br />for your car.</h1></div><div><p>Choose a service, find an available time, and tell us about your vehicle. A clear next step starts here.</p><span><Icon name="shield" />Secure requests. Personal service.</span></div></div></header>;
}

function BookingExperience({ initialService, details, setDetails, catalog, emailTest }) {
  const [selection, setSelection] = useState({ service: initialService, date: "", time: "" });
  const [preview, setPreview] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [submissionAnnouncement, setSubmissionAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState(null);
  const [uncertainRequest, setUncertainRequest] = useState(null);
  const [attemptedReview, setAttemptedReview] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const version = useRef(0);
  const active = useRef(true);
  const busy = useRef(false);
  const detailHeading = useRef(null);
  const reviewHeading = useRef(null);
  const errorBox = useRef(null);
  const successHeading = useRef(null);
  const uncertainHeading = useRef(null);
  const errorSummary = useRef(null);
  const fieldElements = useRef({});
  const touched = useRef(new Set());
  const mobileBooking = catalog.mobileBooking;
  const catalogSnapshot = useRef({ ready: catalog.ready, policyKey: mobilePolicyKey(mobileBooking) });
  const service = getService(selection.service, catalog.services);
  const availability = useBookingAvailability(service?.name || "", selection.date);
  const metadata = availability.dayData || availability.calendarData;
  const slot = availability.dayData?.slots.find(item => item.time === selection.time);
  const locked = checking || sending || Boolean(uncertainRequest) || !catalog.ready;
  const currentStep = preview ? 4 : slot ? 3 : service ? 2 : 1;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    catalogSnapshot.current = { ready: catalog.ready, policyKey: mobilePolicyKey(mobileBooking) };
  }, [catalog.ready, mobileBooking]);
  useEffect(() => { if (preview) reviewHeading.current?.focus({ preventScroll: false }); }, [preview]);
  useEffect(() => { if (saved) successHeading.current?.focus({ preventScroll: false }); }, [saved]);
  useEffect(() => { if (error) errorBox.current?.focus({ preventScroll: false }); }, [error]);
  useEffect(() => { if (uncertainRequest) uncertainHeading.current?.focus(); }, [uncertainRequest]);
  useEffect(() => {
    if (focusRequest) (fieldElements.current[focusRequest.name] || errorSummary.current)?.focus();
  }, [focusRequest]);

  function validate(values = { ...details, ...selection }) {
    return { ...validateAppointmentFields(values, new Date(), { schedulingAuthoritative: true, serviceCatalog: catalog.services }),
      ...(mobileBooking ? prepareMobileLocation(values).fields : {}) };
  }
  function validateField(name) {
    touched.current.add(name);
    const message = validate()[name];
    setFieldErrors(current => {
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  }
  function revalidate(values, names) {
    const errors = validate(values);
    setFieldErrors(current => {
      const next = { ...current };
      for (const name of names) if (attemptedReview || touched.current.has(name) || current[name]) {
        if (errors[name]) next[name] = errors[name];
        else delete next[name];
      }
      return next;
    });
  }
  function showValidation(errors) {
    setAttemptedReview(true);
    setFieldErrors(errors);
    const names = fieldOrder.filter(name => errors[name]);
    setSubmissionAnnouncement(`Please correct ${names.length === 1 ? "the highlighted field" : `the ${names.length} highlighted fields`} before reviewing your request.`);
    setFocusRequest({ name: names[0] });
  }
  function focusField(event, name) {
    event.preventDefault();
    (fieldElements.current[name] || errorSummary.current)?.focus();
  }

  function changeService(event) {
    version.current++;
    const next = { service: event.target.value, date: "", time: "" };
    setSelection(next);
    revalidate({ ...details, ...next }, ["service", "date", "time"]);
    setPreview(null); setError(""); availability.resetMonth();
  }
  function chooseDate(date) {
    if (!availability.days.some(day => day.date === date && day.available)) return;
    version.current++;
    const next = { ...selection, date, time: selection.date === date ? selection.time : "" };
    setSelection(next);
    revalidate({ ...details, ...next }, ["date", "time"]);
    setPreview(null); setError("");
  }
  function chooseTime(time) {
    if (!availability.dayData?.slots.some(item => item.time === time)) return;
    version.current++;
    setSelection(current => ({ ...current, time }));
    revalidate({ ...details, ...selection, time }, ["time"]);
    setPreview(null); setError("");
  }
  function changeDetails(event) {
    const { name, value } = event.target;
    if (name === "email" && emailTest) return;
    version.current++;
    setDetails(current => ({ ...current, [name]: value }));
    revalidate({ ...details, [name]: value, ...selection }, [name]);
    setPreview(null); setError("");
  }
  function recoverConflict(message) {
    version.current++;
    setError(message || "The selected time is no longer available. Please choose another appointment time.");
    setSelection(current => ({ ...current, time: "" }));
    setFieldErrors(current => ({ ...current, time: "Please select another available appointment time." }));
    setPreview(null);
    availability.invalidate();
  }

  async function review(event) {
    event.preventDefault();
    if (busy.current || uncertainRequest) return;
    if (!catalog.ready) { setError("Current services must be verified before reviewing a request. Retry services; your details are still here."); return; }
    setError("");
    const errors = validate();
    if (selection.time && !slot) errors.time = "Please select an available appointment time.";
    if (Object.keys(errors).length) { showValidation(errors); return; }
    setFieldErrors({}); setSubmissionAnnouncement("");
    const token = version.current;
    const reviewedPolicyKey = mobilePolicyKey(mobileBooking);
    busy.current = true; setChecking(true); setError("");
    try {
      const fresh = await availability.refreshDay();
      if (!active.current || token !== version.current || !fresh) return;
      if (!catalogSnapshot.current.ready || catalogSnapshot.current.policyKey !== reviewedPolicyKey) {
        setError("The mobile booking rules changed. Review the current services and your details again before sending.");
        return;
      }
      const freshSlot = fresh.slots.find(item => item.time === selection.time);
      if (!freshSlot) { recoverConflict(); return; }
      const location = mobileBooking ? prepareMobileLocation(details).value : {};
      setPreview({ ...details, ...location, ...selection, mobileBooking, mobilePolicyKey: reviewedPolicyKey,
        travelBufferMinutes: travelAllowance(mobileBooking, fresh), provisional: Boolean(service?.provisional),
        timezone: fresh.timezone, durationMinutes: fresh.durationMinutes, startAt: freshSlot.startAt, endAt: freshSlot.endAt });
    } catch (failure) {
      if (active.current && token === version.current) setError(readableAvailabilityError(failure.message) || "We could not recheck this time. Please retry availability.");
    } finally { busy.current = false; if (active.current) setChecking(false); }
  }

  async function send() {
    if (busy.current || !preview || uncertainRequest) return;
    if (preview.email !== details.email) {
      setPreview(null);
      setError("The email test configuration changed. Review your details again before sending.");
      return;
    }
    if (!catalog.ready) { setError("Current services must be verified before sending a request. Retry services; your details are still here."); return; }
    if (preview.mobilePolicyKey !== mobilePolicyKey(mobileBooking)) {
      setPreview(null);
      setError("The mobile booking rules changed. Review your location and travel allowance again before sending.");
      return;
    }
    const errors = validate();
    if (Object.keys(errors).length) { setPreview(null); showValidation(errors); return; }
    const token = version.current;
    let postStarted = false;
    busy.current = true; setSending(true); setError("");
    try {
      const fresh = await availability.refreshDay();
      if (!active.current || token !== version.current || !fresh) return;
      if (!catalogSnapshot.current.ready || catalogSnapshot.current.policyKey !== preview.mobilePolicyKey) {
        setPreview(null);
        setError("The mobile booking rules changed. Review the current services and your details again before sending.");
        return;
      }
      const freshSlot = fresh.slots.find(item => item.time === preview.time);
      if (!freshSlot) { recoverConflict(); return; }
      if (fresh.timezone !== preview.timezone || fresh.durationMinutes !== preview.durationMinutes
        || freshSlot.startAt !== preview.startAt || freshSlot.endAt !== preview.endAt
        || travelAllowance(mobileBooking, fresh) !== preview.travelBufferMinutes) {
        version.current++;
        setPreview(null);
        setError("The shop’s scheduling details have changed. Please review your updated appointment time and duration before sending.");
        return;
      }
      const payload = Object.fromEntries(["name", "email", "phone", "vehicle", "service", "date", "time", "notes",
        ...(preview.mobileBooking ? mobileFieldNames : [])].map(key => [key, preview[key]]));
      postStarted = true;
      const response = await fetch("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!active.current || token !== version.current) return;
      if (response.status === 409) { recoverConflict("The selected time is no longer available. Please choose another appointment time."); return; }
      if (!response.ok) {
        if (response.status >= 500) { setUncertainRequest(preview); setPreview(null); return; }
        const fields = Object.fromEntries(fieldOrder.filter(name => typeof data.fields?.[name] === "string").map(name => [name, data.fields[name]]));
        if (Object.keys(fields).length) { setPreview(null); showValidation(fields); return; }
        setError(data.error || "The shop could not accept this request. Check your details or contact the shop for help.");
        return;
      }
      if (!["pending", "confirmed"].includes(data.status) || typeof data.id !== "string" || !data.id.trim()) { setUncertainRequest(preview); setPreview(null); return; }
      setSaved({ ...data, request: preview });
      setDetails({ ...emptyDetails });
      setPreview(null);
      availability.invalidate();
    } catch (failure) {
      if (active.current && token === version.current) {
        if (postStarted) { setUncertainRequest(preview); setPreview(null); }
        else setError(readableAvailabilityError(failure.message) || "Appointment times could not be checked. Retry availability before sending your request.");
      }
    } finally { busy.current = false; if (active.current) setSending(false); }
  }

  function edit() { setPreview(null); detailHeading.current?.focus({ preventScroll: false }); }
  function anotherRequest() {
    version.current++; setSaved(null); setError("");
    setFieldErrors({}); setSubmissionAnnouncement(""); touched.current.clear(); setAttemptedReview(false);
    setSelection({ service: initialService, date: "", time: "" });
    availability.resetMonth(); availability.invalidate();
  }

  return <main className="customer-page booking-page">
    <BookingIntro />
    <div className="site-container booking-container">
      {!saved && <ServiceCatalogStatus catalog={catalog} />}
      <AppointmentEmailTestNotice configuration={emailTest} />
      {mobileBooking && !saved && <section className="booking-mobile-notice" aria-labelledby="booking-mobile-heading">
        <h2 id="booking-mobile-heading">Mobile requests require mechanic approval</h2>
        <p>All mobile services, including Wiper Blade Replacement, stay pending until the mechanic checks coverage, the visit location, and travel arrangements.</p>
        <p>At least {mobileBooking.travelBufferMinutes} minutes are reserved after service for planned travel. This is separate from the service estimate and is not a driving-time guarantee or a fee.</p>
      </section>}
      {!saved && catalog.ready && selection.service && !service && <p className="booking-error" role="alert">The selected service is no longer available for new appointments. Choose another service; your contact and vehicle details are still here.</p>}
      {!saved && <ol className="booking-steps" aria-label="Booking steps">{stepLabels.map((label, index) => <li key={label} aria-current={currentStep === index + 1 ? "step" : undefined} className={currentStep > index + 1 ? "is-complete" : ""}><span>{currentStep > index + 1 ? <Icon name="check" /> : `0${index + 1}`}</span>{label}</li>)}</ol>}
      {error && <p className="booking-error" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}
      {submissionAnnouncement && <p className="booking-sr-only" role="alert">{submissionAnnouncement}</p>}
      {!saved && attemptedReview && Object.keys(fieldErrors).length > 0 && <section className="booking-error-summary" aria-labelledby="booking-errors-heading" tabIndex={-1} ref={errorSummary}>
        <h2 id="booking-errors-heading">Please correct the highlighted fields.</h2>
        <p>Your information is still here. Correct the fields below, then review your request again.</p>
        <ul>{fieldOrder.filter(name => fieldErrors[name]).map(name => <li key={name}><a href={`#booking-${name}`} onClick={event => focusField(event, name)}>{fieldLabels[name]}: {fieldErrors[name]}</a></li>)}</ul>
      </section>}
      {uncertainRequest && <section className="booking-uncertain" aria-labelledby="booking-uncertain-heading" role="alert">
        <h2 id="booking-uncertain-heading" tabIndex={-1} ref={uncertainHeading}>We could not verify whether your request was saved.</h2>
        <p>The connection or server response was interrupted after sending. Your appointment may already be on file. To avoid a duplicate, this page will not send the request again.</p>
        <p>Contact the shop before starting another request and keep the details below. Retrying availability only refreshes the calendar; it cannot confirm whether your request was saved.</p>
        <div className="booking-actions"><button type="button" className="button button-secondary" onClick={availability.invalidate}>Retry availability</button><Link className="text-link" to="/contact">Contact the shop <Icon name="arrow" /></Link></div>
        <Summary request={uncertainRequest} />
      </section>}
      {saved ? <section className="booking-success" aria-labelledby="booking-success-heading">
        <span className="booking-success-icon"><Icon name={saved.status === "confirmed" ? "check" : "clock"} /></span>
        <p className="eyebrow">{emailTest ? "PRIVATE EMAIL TEST · " : ""}{saved.status === "confirmed" ? "APPOINTMENT CONFIRMED" : "REQUEST RECEIVED"}</p>
        <h2 id="booking-success-heading" tabIndex={-1} ref={successHeading}>{saved.status === "confirmed" ? "You’re on the schedule." : "Your next step is in good hands."}</h2>
        <p className="booking-success-message" role="status">{saved.status === "pending"
          ? saved.request.mobileBooking ? "Your mobile appointment request has been received and is awaiting the mechanic’s coverage, location, and travel review. Your appointment is not confirmed yet." : "Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet."
          : "Your appointment has been confirmed. The service duration is a booking estimate, not a guaranteed repair completion time."}</p>
        <div className="booking-reference"><span>YOUR REFERENCE ID</span><strong>{saved.id}</strong></div>
        {saved.status === "pending" && saved.holdExpiresAt && <p className="booking-hold">Your provisional time reservation expires <time dateTime={saved.holdExpiresAt}>{formatShopTimestamp(saved.holdExpiresAt, saved.request.timezone)}</time> ({saved.request.timezone}). Your request stays on file after expiry, but availability must be checked again before approval.</p>}
        <Summary request={saved.request} />
        {saved.emailNotification === "queued" && <p className="booking-receipt-note">A status email has been queued for delivery. Keep your reference ID for your records.</p>}
        <p className="booking-receipt-note">{saved.managementAccess ? "Open the secure Manage My Appointment link in your email to view or cancel this appointment. Your reference ID alone does not provide access." : "To check or cancel this request, contact the shop. Secure online management is unavailable for this request."}</p>
        <div className="booking-actions"><button type="button" className="button button-primary" onClick={anotherRequest}>Make another request <Icon name="arrow" /></button><Link className="text-link" to="/">Back to the shop</Link></div>
      </section> : <>
        <form onSubmit={review} className="booking-form" noValidate>
          <fieldset className="booking-service-panel booking-panel" disabled={locked}>
            <legend className="booking-sr-only">Step 1: Choose a service</legend>
            <div className="booking-panel-heading"><span className="booking-step-number">01</span><div><p className="booking-kicker">START WITH YOUR VEHICLE</p><h2>What can we help with?</h2></div></div>
            <div className="booking-service-layout"><div className="booking-field"><label htmlFor="booking-service">Service needed</label><select id="booking-service" name="service" value={service ? selection.service : ""} onChange={changeService} onBlur={() => validateField("service")} ref={node => { fieldElements.current.service = node; }} aria-invalid={Boolean(fieldErrors.service) || undefined} aria-describedby={fieldErrors.service ? "booking-service-error" : undefined} required>
              <option value="">Choose a service</option>{SERVICE_CATEGORIES.map(category => <optgroup label={category.label} key={category.id}>{catalog.services.filter(item => item.category === category.id).map(item => <option value={item.name} key={item.name}>{item.name}{item.provisional ? " (provisional)" : ""}</option>)}</optgroup>)}
            </select><FieldError name="service" message={fieldErrors.service} /></div><div className="booking-service-hint"><Icon name={service?.icon || "wrench"} /><p>{mobileBooking ? "Every mobile request needs mechanic review of coverage, location, and travel before confirmation." : service?.category === "repairs" ? "Repairs & Diagnostics requests always need mechanic approval." : "Not sure what your car needs? Choose Other / Not Sure and describe what you’ve noticed."}</p></div></div>
            {service?.provisional && <p className="booking-notice"><strong>Provisional service.</strong> {service.name} availability needs Edward’s confirmation before an appointment can be approved.</p>}
          </fieldset>

          <section className="booking-panel booking-date-panel" aria-labelledby="booking-date-heading">
            <div className="booking-panel-heading"><span className="booking-step-number">02</span><div><p className="booking-kicker">PLAN YOUR VISIT</p><h2 id="booking-date-heading">A day and time that work.</h2></div></div>
            {metadata && <div className="booking-policy-strip"><span><Icon name="clock" />{metadata.durationMinutes}-minute booking estimate</span><span>{metadata.timezone}</span><p>Repair completion time may vary.</p></div>}
            <div className="booking-calendar-layout"><div className="booking-calendar-field" id="booking-date" role="group" aria-label="Choose appointment date" tabIndex={-1} ref={node => { fieldElements.current.date = node; }} aria-invalid={Boolean(fieldErrors.date) || undefined} aria-describedby={fieldErrors.date ? "booking-date-error" : undefined} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) validateField("date"); }}>
              <FieldError name="date" message={fieldErrors.date} /><BookingCalendar month={availability.month} today={availability.calendarData?.today} firstDate={availability.calendarData?.firstDate} lastDate={availability.calendarData?.lastDate} days={availability.days} selectedDate={selection.date} loading={availability.calendarLoading} error={readableAvailabilityError(availability.calendarError)} onMonthChange={availability.setViewMonth} onSelectDate={chooseDate} onRetry={availability.refreshMonth} disabled={locked || !service} /></div>
              <TimeChoices date={selection.date} data={availability.dayData} loading={availability.dayLoading} error={availability.dayError} fieldError={fieldErrors.time} selectedTime={selection.time} onSelect={chooseTime} onRetry={availability.retryDay} onBlur={() => validateField("time")} groupRef={node => { fieldElements.current.time = node; }} disabled={locked} /></div>
            {metadata?.settingsProvisional && <p className="booking-notice"><strong>Subject to mechanic confirmation.</strong> Shop hours and capacity are provisional. Requests remain pending until Edward reviews them.</p>}
            {metadata?.policy && <p className="booking-policy-note">Request at least {metadata.policy.minimumNoticeHours} hours ahead, within the next {metadata.policy.bookingHorizonDays} days. Pending requests reserve time for {metadata.policy.pendingHoldHours} hours after submission.</p>}
            {slot && <div className="booking-picked"><span><Icon name="check" />{formatBookingDate(selection.date)} · {formatBookingTime(selection.time)}</span><button className="text-link" type="button" onClick={() => detailHeading.current?.focus({ preventScroll: false })} disabled={locked}>Continue to your details <Icon name="arrow" /></button></div>}
          </section>

          <fieldset className="booking-panel booking-details-panel" disabled={locked}>
            <legend className="booking-sr-only">Step 3: Customer and vehicle details</legend>
            <div className="booking-panel-heading"><span className="booking-step-number">03</span><div><p className="booking-kicker">LET’S GET TO KNOW YOUR CAR</p><h2 ref={detailHeading} tabIndex={-1}>Your details. Your vehicle.</h2></div></div>
            {!slot && <p className="booking-details-hint">You can enter your details now. Select an available appointment date and time before reviewing your request. Your information stays here if you need to choose a different time.</p>}
            <div className="booking-details-grid">
              {Object.keys(emptyDetails).filter(name => !mobileFieldNames.includes(name) && name !== "notes").map(name => <CustomerField key={name} name={name} value={details[name]} error={fieldErrors[name]} onChange={changeDetails} onBlur={() => validateField(name)} inputRef={node => { fieldElements.current[name] = node; }} readOnly={name === "email" && Boolean(emailTest)} />)}
              {mobileBooking && <section className="booking-mobile-location booking-wide" aria-labelledby="booking-mobile-location-heading">
                <h3 id="booking-mobile-location-heading">Where should we visit?</h3>
                <p id="booking-mobile-location-help">Your city, state, and ZIP code are used privately to review service coverage and travel. Provide the full street address privately when arranging the visit; this form does not verify routes or location suitability.</p>
                <div className="booking-mobile-location-fields">{mobileFieldNames.map(name => <CustomerField key={name} name={name} value={details[name] ?? ""} error={fieldErrors[name]} onChange={changeDetails} onBlur={() => validateField(name)} inputRef={node => { fieldElements.current[name] = node; }} />)}</div>
              </section>}
              <CustomerField name="notes" value={details.notes} error={fieldErrors.notes} onChange={changeDetails} onBlur={() => validateField("notes")} inputRef={node => { fieldElements.current.notes = node; }} />
            </div>
            <div className="booking-review-action"><p>Review your details before anything is sent.</p><button className="button button-primary" type="submit" disabled={locked}>{checking ? "Rechecking your time…" : "Review Appointment Request"}<Icon name="arrow" /></button></div>
          </fieldset>
        </form>
        {preview && <section className="booking-panel booking-review-panel" aria-labelledby="booking-review-heading">
          <div className="booking-panel-heading"><span className="booking-step-number">04</span><div><p className="booking-kicker">ONE LAST LOOK</p><h2 id="booking-review-heading" tabIndex={-1} ref={reviewHeading}>Review your appointment request.</h2></div></div>
          <p>Nothing has been submitted yet. Check the details below, then send your request when you’re ready.</p><Summary request={preview} />
          <p className="booking-notice">{preview.provisional ? "This service is provisional and needs availability confirmation. " : ""}{preview.mobileBooking ? "The mechanic must review coverage, the visit location, and travel before confirming this mobile request. " : ""}A pending request is not a confirmed appointment. We’ll show the status saved by the shop after you send.</p>
          <div className="booking-actions"><button type="button" className="button button-secondary" onClick={edit} disabled={sending}>Edit Details</button><button type="button" className="button button-primary" onClick={send} disabled={sending || !catalog.ready}>{sending ? "Sending your request…" : "Send Appointment Request"}<Icon name="arrow" /></button></div>
        </section>}
      </>}
    </div>
  </main>;
}

export default function Appointment() {
  const { search } = useLocation();
  const catalog = useServiceCatalog();
  const emailTest = useAppointmentEmailTest();
  const initialService = getServiceSelection(search, catalog.services);
  const [details, setDetails] = useState({ ...emptyDetails });
  if (!catalog.loaded) return <main className="customer-page booking-page"><BookingIntro /><div className="site-container booking-container"><ServiceCatalogStatus catalog={catalog} /></div></main>;
  // Linked service changes reset scheduling/review, while keeping unsent contact
  // details in this parent. No contact information is written to browser storage.
  const currentDetails = emailTest ? { ...details, email: emailTest.recipient } : details;
  return <BookingExperience key={search} initialService={initialService} details={currentDetails} setDetails={setDetails} catalog={catalog} emailTest={emailTest} />;
}
