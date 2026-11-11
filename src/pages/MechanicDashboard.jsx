import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/CustomerUI";
import BusinessHoursSettings from "../components/BusinessHoursSettings";
import BookingSettings from "../components/BookingSettings";
import ClosuresAndBlocks from "../components/ClosuresAndBlocks";
import DeclineAppointmentDialog from "../components/DeclineAppointmentDialog";
import CancelAppointmentDialog from "../components/CancelAppointmentDialog";
import { getDeclineReason } from "../../shared/declineReasons.js";
import { CUSTOMER_CANCELLATION_REASONS, MECHANIC_CANCELLATION_REASONS } from "../../shared/cancellations.js";
import useMechanicSession from "../hooks/useMechanicSession";
import useSchedulingSettings from "../hooks/useSchedulingSettings";
import { formatBookingDate, formatBookingTime, formatShopTimestamp } from "../utils/bookingDates";
import { isValidEmailAddress, isValidUsPhone } from "../../shared/appointmentFields.js";
import "../styles/MechanicDashboard.css";

const sections = ["Appointments", "Business Hours", "Closures & Blocked Times", "Booking Settings"];

function Appointments({ request }) {
  const [filter, setFilter] = useState("pending");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [declining, setDeclining] = useState(null);
  const [declineFields, setDeclineFields] = useState({});
  const [cancelling, setCancelling] = useState(null);
  const [cancellationFields, setCancellationFields] = useState({});
  const [decisionUnknown, setDecisionUnknown] = useState(false);
  const actionBusy = useRef(false);

  useEffect(() => {
    let active = true;
    request(`/appointments?status=${filter}`)
      .then(data => {
        if (!active) return;
        const items = data.appointments || [];
        setAppointments(items); setDecisionUnknown(false);
        setDeclining(current => current && items.some(item => item._id === current._id && item.status === "pending") ? current : null);
        setCancelling(current => current ? items.find(item => item._id === current._id && item.cancellationEligibility?.canCancel) || null : null);
      })
      .catch(failure => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filter, refreshCount, request]);

  function refreshAppointments() {
    setLoading(true); setError(""); setDeclineFields({}); setCancellationFields({}); setRefreshCount(value => value + 1);
  }

  async function cancelAppointment(id, reason) {
    if (actionBusy.current || decisionUnknown) return false;
    actionBusy.current = true;
    setBusyId(id); setError(""); setNotice(""); setCancellationFields({});
    try {
      const result = await request(`/appointments/${id}/cancel`, { method: "POST", body: reason });
      if (result.status !== "cancelled") throw new Error("Cancellation status could not be verified.");
      const delivery = result.emailNotification === "queued" ? "A customer email has been queued for delivery." : result.emailNotification === "sent" ? "The cancellation email has already been sent." : "No customer email is queued. Contact the customer directly.";
      setNotice(`Appointment cancelled. ${delivery}`);
      setCancelling(null); setLoading(true); setRefreshCount(value => value + 1);
      return true;
    } catch (failure) {
      if (!failure.status || failure.status >= 500 || failure.status === 409) {
        setDecisionUnknown(true);
        setError("We could not verify the current cancellation status. Refresh appointment status before trying another action. The appointment may already have changed.");
      } else { setError(failure.message); setCancellationFields(failure.fields || {}); }
      return false;
    } finally { actionBusy.current = false; setBusyId(""); }
  }

  async function changeStatus(id, status, decline) {
    if (actionBusy.current || decisionUnknown) return false;
    actionBusy.current = true;
    setBusyId(id); setError(""); setNotice(""); setDeclineFields({});
    try {
      const result = await request(`/appointments/${id}`, { method: "PATCH", body: { status, ...(decline ? { decline } : {}) } });
      setNotice(`Appointment ${status}. ${result.emailNotification === "queued" ? "A customer email has been queued for delivery." : "Email notifications are not configured yet."}`);
      setDeclining(null);
      setLoading(true); setRefreshCount(value => value + 1);
      return true;
    } catch (failure) {
      const schedulingConflict = status === "confirmed" && failure.status === 409 && failure.code !== "SCHEDULING_ERROR";
      if (schedulingConflict) setError(`Scheduling conflict: ${failure.message.replace(/^Scheduling conflict:\s*/i, "")} The request has not been declined. Contact the customer to discuss next steps; no different time has been offered or confirmed.`);
      else if (!failure.status || failure.status >= 500) {
        setDecisionUnknown(true);
        setError("We could not verify whether the decision was saved. Refresh appointment status before trying another action. Do not repeat the decision until its saved status is known.");
      } else {
        setError(failure.message);
        setDeclineFields(failure.fields || {});
      }
      return false;
    } finally { actionBusy.current = false; setBusyId(""); }
  }

  return <section className="mechanic-workspace" aria-labelledby="staff-appointments-heading">
    <div className="staff-section-heading"><div><p className="staff-kicker">KEEP THE DAY MOVING</p><h2 id="staff-appointments-heading" tabIndex={-1}>Appointment requests</h2><p>Review the request, then confirm or decline. Pending requests are not confirmed appointments.</p></div><span className="staff-badge staff-badge-neutral">Latest 100 requests</span></div>
    {error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
    {notice && <p className="mechanic-message mechanic-success" role="status">{notice}</p>}
    <div className="mechanic-toolbar"><label htmlFor="mechanic-status">Show appointments</label><select id="mechanic-status" value={filter} onChange={event => { setLoading(true); setError(""); setFilter(event.target.value); }}>
      <option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option><option value="cancelled">Cancelled</option><option value="all">All</option>
    </select><button type="button" className="mechanic-refresh" onClick={refreshAppointments} disabled={loading || !!busyId}>Refresh</button><span className="mechanic-count" role="status">{loading ? "Loading requests…" : `${appointments.length} request(s) shown`}</span></div>
    <div className="mechanic-grid" aria-busy={loading}>
      {!loading && appointments.length === 0 && <p className="mechanic-empty">No {filter === "all" ? "" : `${filter} `}appointments found.</p>}
      {!loading && appointments.map(item => {
        const timezone = item.scheduling?.timezone || "America/Chicago";
        // Format only an already validated U.S. number for a standard tel URI;
        // keep the customer's original formatting in storage and on screen.
        const phoneDigits = isValidUsPhone(item.phone) ? item.phone.replace(/\D/g, "") : "";
        const dialNumber = phoneDigits ? `+${phoneDigits.length === 10 ? "1" : ""}${phoneDigits}` : "";
        return <article className="mechanic-card" key={item._id}>
          <div className="mechanic-card-top"><div><p className="staff-kicker">{item.service}</p><h3>{item.name}</h3></div><span className={`mechanic-status mechanic-status-${item.status}`}>{item.status}</span></div>
          <div className="staff-appointment-time"><Icon name="calendar" /><span>{formatBookingDate(item.date) || "Date needs review"} at {formatBookingTime(item.time) || "Time needs review"}<small>{timezone}</small></span></div>
          <dl><dt>Service</dt><dd>{item.service}</dd><dt>Vehicle</dt><dd>{item.vehicle}</dd><dt>Email</dt><dd>{isValidEmailAddress(item.email) ? <a href={`mailto:${encodeURIComponent(item.email.trim())}`}>{item.email}</a> : <>{item.email}<span className="staff-field-help">Verify this address before contacting the customer.</span></>}</dd><dt>Phone</dt><dd>{dialNumber ? <a href={`tel:${dialNumber}`}>{item.phone}</a> : <>{item.phone}<span className="staff-field-help">Verify this number before calling.</span></>}</dd>{item.scheduling?.durationMinutes && <><dt>Estimate</dt><dd>{item.scheduling.durationMinutes} minutes · booked estimate</dd></>}{item.notes && <><dt>Notes</dt><dd>{item.notes}</dd></>}</dl>
          {item.status === "pending" && item.scheduling?.holdExpiresAt && <p className="staff-hold">Provisional hold expires {formatShopTimestamp(item.scheduling.holdExpiresAt, timezone)} ({timezone}). Approval always rechecks availability.</p>}
          {item.status === "declined" && <section className="staff-decline-record" aria-label="Decline reason"><h4>Decline reason</h4>{item.decline?.explanation ? <><p><strong>{getDeclineReason(item.decline.category)?.label || "Recorded explanation"}</strong></p><p>{item.decline.explanation}</p>{item.decline.declinedAt && <p>Declined {formatShopTimestamp(item.decline.declinedAt, timezone)} ({timezone})</p>}</> : <p>No reason was recorded with this historical decision.</p>}</section>}
          {item.status === "cancelled" && <section className="staff-cancellation-record" aria-label="Cancellation details"><h4>Cancellation Details</h4><p>Cancelled by: {item.cancellation?.by === "customer" ? "Customer" : item.cancellation?.by === "mechanic" ? "Mechanic" : "Not recorded"}</p><p>Reason: {(item.cancellation?.by === "customer" ? CUSTOMER_CANCELLATION_REASONS : MECHANIC_CANCELLATION_REASONS).find(reason => reason.id === item.cancellation?.category)?.label || "Not recorded"}</p>{(item.cancellation?.message || item.cancellation?.explanation) && <p>{item.cancellation.message || item.cancellation.explanation}</p>}{item.cancellation?.cancelledAt && <p>Cancelled at: {formatShopTimestamp(item.cancellation.cancelledAt, item.cancellation.timezone || timezone)} ({item.cancellation.timezone || timezone})</p>}<p>Time slot: No longer reserved</p></section>}
          {item.status === "pending" && <><p className="staff-change-guidance">Need another date, parts to order, or more information? Contact the customer using the details above and keep this request pending while you discuss next steps. No replacement time is offered automatically.</p><div className="mechanic-actions"><button type="button" className="mechanic-approve" disabled={!!busyId || decisionUnknown} onClick={() => changeStatus(item._id, "confirmed")}>Confirm</button><button type="button" className="mechanic-decline" disabled={!!busyId || decisionUnknown} onClick={() => { setError(""); setDeclineFields({}); setDeclining(item); }}>Decline Appointment</button></div></>}
          {item.cancellationEligibility?.canCancel && ["pending", "confirmed"].includes(item.status) && <div className="mechanic-actions"><button type="button" className="staff-danger" disabled={!!busyId || decisionUnknown} onClick={() => { setError(""); setCancellationFields({}); setCancelling(item); }}>Cancel Appointment</button></div>}
        </article>;
      })}
    </div>
    {declining && <DeclineAppointmentDialog key={declining._id} appointment={declining} busy={!!busyId} locked={decisionUnknown} error={error} serverFields={declineFields} onCancel={() => { setDeclining(null); setDeclineFields({}); }} onConfirm={decline => changeStatus(declining._id, "declined", decline)} onRefresh={refreshAppointments} />}
    {cancelling && <CancelAppointmentDialog key={cancelling._id} appointment={cancelling} busy={!!busyId} locked={decisionUnknown} error={error} serverFields={cancellationFields} onKeep={() => { setCancelling(null); setCancellationFields({}); }} onConfirm={reason => cancelAppointment(cancelling._id, reason)} onRefresh={refreshAppointments} />}
    <p className="mechanic-notice">Appointment decisions are saved securely. Configured email notifications keep their existing delivery and retry behavior.</p>
  </section>;
}

function SchedulingWorkspace({ settings, section }) {
  const [review, setReview] = useState(false);
  const errorBox = useRef(null);
  const reviewHeading = useRef(null);
  const locked = settings.busy || Boolean(settings.conflict) || review;
  useEffect(() => { if (settings.error) errorBox.current?.focus(); }, [settings.error]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  async function confirmChanges() { await settings.save(); setReview(false); }
  function discardChanges() { setReview(false); settings.discard(); }
  return <section className="staff-scheduling" aria-label="Scheduling management">
    <div className="staff-section-heading"><div><p className="staff-kicker">MAKE THE SCHEDULE YOURS</p><h2>{section}</h2><p>Saved shop settings control customer availability. Review changes before applying them.</p></div>{settings.saved && <span className={`staff-badge ${settings.dirty ? "staff-badge-provisional" : "staff-badge-active"}`}>{settings.dirty ? "Unsaved changes" : "Saved settings"}</span>}</div>
    {settings.error && <p className="mechanic-message mechanic-error" role="alert" tabIndex={-1} ref={errorBox}>{settings.error}</p>}
    {settings.notice && <p className="mechanic-message mechanic-success" role="status">{settings.notice}</p>}
    {settings.loading && <p className="staff-loading" role="status">Loading saved scheduling settings…</p>}
    {!settings.saved && settings.error && <button className="staff-button staff-button-secondary" type="button" onClick={settings.retry}>Retry settings</button>}
    {settings.conflict && <section className="staff-revision-conflict" aria-labelledby="staff-conflict-heading">
      <h3 id="staff-conflict-heading">Reload the saved schedule before continuing.</h3><p>{settings.conflict.uncertainSave ? "We could not verify whether the settings were saved. Reload the latest settings before trying another change. Your draft is kept for review; no further changes will be sent until the saved state is known." : settings.conflict.blockReload ? "The last block change needs to be checked against the saved schedule. No further changes will be sent until you reload." : "Another administrator or process changed the saved configuration. Your unsaved edits are kept here. Reload the latest settings, then explicitly review your edits against them."}</p>
      <button type="button" className="staff-button staff-button-secondary" onClick={settings.reloadLatest} disabled={settings.busy}>Reload Latest Settings</button>
      {settings.conflict.latest && <div className="staff-conflict-review"><p><strong>Latest saved settings are ready.</strong> Unrelated newer values will be kept. Any overlapping fields below will use your edits only when you choose Review with Latest Settings. You must review and confirm again before saving. Hours and capacity may need fresh verification.</p>
        {settings.conflict.overlaps.length ? <ul>{settings.conflict.overlaps.map(change => <li key={change.path}><strong>{change.label}</strong><span>Latest saved: {change.latestDisplay}</span><span>Your edit: {change.afterDisplay}</span></li>)}</ul> : <p>Your edited fields do not overlap the newer saved values.</p>}
        <button type="button" className="staff-button staff-button-primary" onClick={settings.reviewLatest} disabled={settings.busy}>Review with Latest Settings</button>
      </div>}
    </section>}
    {settings.draft && <>
      <div className="staff-saved-status"><span><Icon name="shield" />Staff-only scheduling controls</span><span>Saved automation: <strong>{settings.saved.settings.automaticBookingEnabled ? "Enabled" : "Disabled"}</strong> · Hours {settings.saved.settings.businessHoursVerified ? "verified" : "unverified"} · Capacity {settings.saved.settings.capacityVerified ? "verified" : "unverified"}</span></div>
      <div className="staff-save-bar"><div><strong>{settings.dirty ? "You have unsaved changes." : "Your settings are up to date."}</strong><span>{settings.dirty ? "Save applies the reviewed changes to customer availability." : "Edits stay in this session until you review and save them."}</span></div><div><button type="button" className="staff-button staff-button-secondary" disabled={settings.busy || (!settings.dirty && !settings.conflict?.latest) || Boolean(settings.conflict && !settings.conflict.latest)} onClick={discardChanges}>Discard Changes</button><button type="button" className="staff-button staff-button-primary" disabled={locked || !settings.dirty} onClick={() => { if (settings.validate()) setReview(true); }}>Save Changes <Icon name="arrow" /></button></div></div>
      {section === "Business Hours" && <BusinessHoursSettings draft={settings.draft} onChange={settings.change} disabled={locked} />}
      {section === "Closures & Blocked Times" && <ClosuresAndBlocks draft={settings.draft} savedSettings={settings.saved.settings} onChange={settings.change} disabled={locked} dirty={settings.dirty} onAddBlock={settings.addBlock} onRemoveBlock={settings.removeBlock} />}
      {section === "Booking Settings" && <BookingSettings draft={settings.draft} onChange={settings.change} disabled={locked} />}
      {review && <section className="staff-save-review" aria-labelledby="staff-save-review-heading"><p className="staff-kicker">ONE LAST CHECK</p><h3 id="staff-save-review-heading" tabIndex={-1} ref={reviewHeading}>Review scheduling changes</h3><p>These changes affect customer availability. Existing held and confirmed appointments remain protected by the server. Nothing has been saved yet.</p><ul className="staff-change-list">{settings.changes.map(change => <li key={change.path}><strong>{change.label}</strong><span>Saved: {change.beforeDisplay}</span><span>Proposed: {change.afterDisplay}</span></li>)}</ul><div className="staff-inline-actions"><button type="button" className="staff-button staff-button-primary" onClick={confirmChanges} disabled={settings.busy}>{settings.busy ? "Saving changes…" : "Confirm Changes"}</button><button type="button" className="staff-button staff-button-secondary" onClick={() => setReview(false)} disabled={settings.busy}>Keep Editing</button></div></section>}
    </>}
  </section>;
}

function MechanicWorkspace({ auth }) {
  const [section, setSection] = useState("Appointments");
  const settings = useSchedulingSettings(auth.request, section !== "Appointments");
  return <>
    <nav className="staff-navigation" aria-label="Staff dashboard sections">{sections.map(name => <button type="button" key={name} aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav>
    {section === "Appointments" ? <Appointments request={auth.request} /> : <SchedulingWorkspace settings={settings} section={section} />}
  </>;
}

function MechanicDashboardContent({ auth }) {
  const { session, checking, message, signIn, signOut, logoutPending } = auth;
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  async function authenticate(event) {
    event.preventDefault(); setError(""); setSigningIn(true);
    try { await signIn(password); setPassword(""); }
    catch (failure) { setError(failure.message); }
    finally { setSigningIn(false); }
  }
  async function logout() { setPassword(""); setError(""); try { await signOut(); } catch { /* The session hook exposes a safe retry without restoring private data. */ } }
  return <main className="mechanic-page">
    <header className="mechanic-header"><div><p className="mechanic-eyebrow">ED’S AUTO SHOP · STAFF WORKSPACE</p><h1>Your shop. Your schedule.</h1><p>Make room for good work. Manage requests and keep availability current.</p></div>{session && <button type="button" className="mechanic-logout" onClick={logout}>Sign out <Icon name="arrow" /></button>}</header>
    <div className="staff-dashboard-container">
      {message && <p className="mechanic-message" role="status">{message}</p>}{error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
      {checking ? <p className="staff-loading" role="status">Checking your session…</p> : !session ? <section className="mechanic-login"><span className="staff-login-icon"><Icon name="shield" /></span><p className="staff-kicker">WELCOME BACK</p><h2>Staff sign in</h2><p>Manage appointments and shop availability. Sessions expire after 20 minutes of inactivity.</p>{logoutPending && <button type="button" className="staff-button staff-button-secondary" onClick={logout}>Retry sign out</button>}<form onSubmit={authenticate}><label htmlFor="mechanic-password">Password</label><input id="mechanic-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /><button type="submit" className="staff-button staff-button-primary" disabled={signingIn || logoutPending}>{signingIn ? "Signing in…" : "Sign in"}</button></form></section> : <MechanicWorkspace auth={auth} />}
    </div>
  </main>;
}

export default function MechanicDashboard() {
  const auth = useMechanicSession();
  // Unmount all private appointment/settings drafts and ignore old replies on
  // logout, expiry, visibility revalidation, and back/forward cache restoration.
  return <MechanicDashboardContent key={auth.sessionKey} auth={auth} />;
}
