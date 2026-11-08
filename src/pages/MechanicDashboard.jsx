import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/CustomerUI";
import BusinessHoursSettings from "../components/BusinessHoursSettings";
import BookingSettings from "../components/BookingSettings";
import ClosuresAndBlocks from "../components/ClosuresAndBlocks";
import useMechanicSession from "../hooks/useMechanicSession";
import useSchedulingSettings from "../hooks/useSchedulingSettings";
import { formatBookingDate, formatBookingTime, formatShopTimestamp } from "../utils/bookingDates";
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

  useEffect(() => {
    let active = true;
    request(`/appointments?status=${filter}`)
      .then(data => { if (active) setAppointments(data.appointments || []); })
      .catch(failure => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filter, refreshCount, request]);

  async function changeStatus(id, status) {
    setBusyId(id); setError(""); setNotice("");
    try {
      const result = await request(`/appointments/${id}`, { method: "PATCH", body: { status } });
      setNotice(`Appointment ${status}. ${result.emailNotification === "queued" ? "A customer email has been queued for delivery." : "Email notifications are not configured yet."}`);
      setLoading(true); setRefreshCount(value => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { setBusyId(""); }
  }

  return <section className="mechanic-workspace" aria-labelledby="staff-appointments-heading">
    <div className="staff-section-heading"><div><p className="staff-kicker">KEEP THE DAY MOVING</p><h2 id="staff-appointments-heading">Appointment requests</h2><p>Review the request, then confirm or decline. Pending requests are not confirmed appointments.</p></div><span className="staff-badge staff-badge-neutral">Latest 100 requests</span></div>
    {error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
    {notice && <p className="mechanic-message mechanic-success" role="status">{notice}</p>}
    <div className="mechanic-toolbar"><label htmlFor="mechanic-status">Show appointments</label><select id="mechanic-status" value={filter} onChange={event => { setLoading(true); setError(""); setFilter(event.target.value); }}>
      <option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option><option value="all">All</option>
    </select><button type="button" className="mechanic-refresh" onClick={() => { setLoading(true); setError(""); setRefreshCount(value => value + 1); }} disabled={loading}>Refresh</button><span className="mechanic-count" role="status">{loading ? "Loading requests…" : `${appointments.length} request(s) shown`}</span></div>
    <div className="mechanic-grid" aria-busy={loading}>
      {!loading && appointments.length === 0 && <p className="mechanic-empty">No {filter === "all" ? "" : `${filter} `}appointments found.</p>}
      {!loading && appointments.map(item => {
        const timezone = item.scheduling?.timezone || "America/Chicago";
        return <article className="mechanic-card" key={item._id}>
          <div className="mechanic-card-top"><div><p className="staff-kicker">{item.service}</p><h3>{item.name}</h3></div><span className={`mechanic-status mechanic-status-${item.status}`}>{item.status}</span></div>
          <div className="staff-appointment-time"><Icon name="calendar" /><span>{formatBookingDate(item.date) || "Date needs review"} at {formatBookingTime(item.time) || "Time needs review"}<small>{timezone}</small></span></div>
          <dl><dt>Service</dt><dd>{item.service}</dd><dt>Vehicle</dt><dd>{item.vehicle}</dd><dt>Email</dt><dd><a href={`mailto:${item.email}`}>{item.email}</a></dd><dt>Phone</dt><dd><a href={`tel:${item.phone}`}>{item.phone}</a></dd>{item.scheduling?.durationMinutes && <><dt>Estimate</dt><dd>{item.scheduling.durationMinutes} minutes · booked estimate</dd></>}{item.notes && <><dt>Notes</dt><dd>{item.notes}</dd></>}</dl>
          {item.status === "pending" && item.scheduling?.holdExpiresAt && <p className="staff-hold">Provisional hold expires {formatShopTimestamp(item.scheduling.holdExpiresAt, timezone)} ({timezone}). Approval always rechecks availability.</p>}
          {item.status === "pending" && <div className="mechanic-actions"><button type="button" className="mechanic-approve" disabled={!!busyId} onClick={() => changeStatus(item._id, "confirmed")}>Confirm</button><button type="button" className="mechanic-decline" disabled={!!busyId} onClick={() => changeStatus(item._id, "declined")}>Decline</button></div>}
        </article>;
      })}
    </div>
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
      <h3 id="staff-conflict-heading">Reload the saved schedule before continuing.</h3><p>{settings.conflict.blockReload ? "The last block change needs to be checked against the saved schedule. No further changes will be sent until you reload." : "Another administrator or process changed the saved configuration. Your unsaved edits are kept here. Reload the latest settings, then explicitly review your edits against them."}</p>
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
