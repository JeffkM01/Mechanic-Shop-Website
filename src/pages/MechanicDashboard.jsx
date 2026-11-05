import { useEffect, useState } from "react";
import "../styles/MechanicDashboard.css";
import useMechanicSession from "../hooks/useMechanicSession";

function MechanicDashboardContent({ auth }) {
  const { session, checking: checkingSession, message, request: mechanicRequest,
    signIn: authenticate, signOut: logout, logoutPending } = auth;
  const authenticated = !!session;
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [filter, setFilter] = useState("pending");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    mechanicRequest(`/appointments?status=${filter}`)
      .then((data) => { if (active) setAppointments(data.appointments || []); })
      .catch((err) => {
        if (!active) return;
        if (err.status === 401) {
          setError("Your session expired. Please sign in again.");
        } else {
          setError(err.message);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authenticated, filter, refreshCount, mechanicRequest]);

  async function signIn(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSigningIn(true);
    try {
      setLoading(true);
      setError("");
      setAppointments([]);
      await authenticate(password);
      setPassword("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSigningIn(false);
    }
  }

  async function changeStatus(id, status) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const result = await mechanicRequest(`/appointments/${id}`, {
        method: "PATCH", body: { status },
      });
      setNotice(`Appointment ${status}. ${result.emailNotification === "queued"
        ? "A customer email has been queued for delivery."
        : "Email notifications are not configured yet."}`);
      setLoading(true);
      setRefreshCount((count) => count + 1);
    } catch (err) {
      if (err.status === 401) {
        setError("Your session expired. Please sign in again.");
      } else {
        setError(err.message);
      }
    } finally {
      setBusyId("");
    }
  }

  async function signOut() {
    setError("");
    setAppointments([]);
    setNotice("");
    setPassword("");
    try {
      await logout();
    } catch {
      // The session hook reports revocation failures and provides a retry.
    }
  }

  return (
    <main className="mechanic-page">
      <header className="mechanic-header">
        <div>
          <p className="mechanic-eyebrow">Ed's Auto Shop · Staff only</p>
          <h1>Mechanic Dashboard</h1>
          <p>Review customer requests and manage their appointment status.</p>
        </div>
        {authenticated && <button className="mechanic-logout" type="button" onClick={signOut}>Sign out</button>}
      </header>

      {message && <p className="mechanic-message" role="status">{message}</p>}
      {error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
      {notice && <p className="mechanic-message mechanic-success" role="status">{notice}</p>}

      {checkingSession ? (
        <p>Checking your session…</p>
      ) : !authenticated ? (
        <section className="mechanic-login">
          <h2>Staff sign in</h2>
          <p>Sign in to manage appointment requests. Sessions expire after 20 minutes of inactivity.</p>
          {logoutPending && <button type="button" onClick={signOut}>Retry sign out</button>}
          <form onSubmit={signIn}>
            <label htmlFor="mechanic-password">Password</label>
            <input id="mechanic-password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit" disabled={signingIn || logoutPending}>{signingIn ? "Signing in…" : "Sign in"}</button>
          </form>
        </section>
      ) : (
        <section className="mechanic-workspace">
          <div className="mechanic-toolbar">
            <label htmlFor="mechanic-status">Show appointments</label>
            <select id="mechanic-status" value={filter} onChange={(e) => { setLoading(true); setFilter(e.target.value); }}>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="declined">Declined</option>
              <option value="all">All</option>
            </select>
            <button type="button" className="mechanic-refresh" onClick={() => { setLoading(true); setRefreshCount((n) => n + 1); }} disabled={loading}>
              Refresh
            </button>
          </div>
          <p className="mechanic-count">{loading ? "Loading requests…" : `${appointments.length} request(s) shown (latest 100)`}</p>
          <div className="mechanic-grid">
            {!loading && appointments.length === 0 && (
              <p className="mechanic-empty">No {filter === "all" ? "" : `${filter} `}appointments found.</p>
            )}
            {!loading && appointments.map((item) => (
              <article className="mechanic-card" key={item._id}>
                <div className="mechanic-card-top">
                  <h2>{item.name}</h2>
                  <span className={`mechanic-status mechanic-status-${item.status}`}>{item.status}</span>
                </div>
                <dl>
                  <dt>Service</dt><dd>{item.service}</dd>
                  <dt>Vehicle</dt><dd>{item.vehicle}</dd>
                  <dt>Requested</dt><dd>{item.date} at {item.time}</dd>
                  <dt>Email</dt><dd><a href={`mailto:${item.email}`}>{item.email}</a></dd>
                  <dt>Phone</dt><dd><a href={`tel:${item.phone}`}>{item.phone}</a></dd>
                  {item.notes && <><dt>Notes</dt><dd>{item.notes}</dd></>}
                </dl>
                {item.status === "pending" && (
                  <div className="mechanic-actions">
                    <button type="button" className="mechanic-approve" disabled={!!busyId}
                      onClick={() => changeStatus(item._id, "confirmed")}>Confirm</button>
                    <button type="button" className="mechanic-decline" disabled={!!busyId}
                      onClick={() => changeStatus(item._id, "declined")}>Decline</button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <p className="mechanic-notice">Changes are saved in MongoDB. If SMTP is configured, customer notification emails are queued and retried if the mail server is temporarily unavailable.</p>
        </section>
      )}
    </main>
  );
}

export default function MechanicDashboard() {
  const auth = useMechanicSession();
  // Discard private data and in-flight UI work on logout or revalidation.
  return <MechanicDashboardContent key={auth.sessionKey} auth={auth} />;
}
