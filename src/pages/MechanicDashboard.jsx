import { useEffect, useState } from "react";
import "../styles/MechanicDashboard.css";

async function mechanicRequest(path, { method = "GET", body, csrfToken } = {}) {
  const response = await fetch(`/api/mechanic${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-Mechanic-CSRF": csrfToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function MechanicDashboard() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [filter, setFilter] = useState("pending");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    mechanicRequest("/session")
      .then((data) => {
        if (!active) return;
        setCsrfToken(data.csrfToken);
        setAuthenticated(true);
      })
      .catch((err) => {
        if (active && err.status !== 401) setError("Could not reach the mechanic API. Is the backend running?");
      })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    setLoading(true);
    setError("");
    mechanicRequest(`/appointments?status=${filter}`)
      .then((data) => { if (active) setAppointments(data.appointments || []); })
      .catch((err) => {
        if (!active) return;
        if (err.status === 401) {
          setAuthenticated(false);
          setCsrfToken("");
          setError("Your session expired. Please sign in again.");
        } else {
          setError(err.message);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authenticated, filter, refreshCount]);

  async function signIn(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSigningIn(true);
    try {
      const data = await mechanicRequest("/login", { method: "POST", body: { password } });
      setPassword("");
      setCsrfToken(data.csrfToken);
      setAuthenticated(true);
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
      await mechanicRequest(`/appointments/${id}`, {
        method: "PATCH", body: { status }, csrfToken,
      });
      setNotice(`Appointment ${status}. Customer notifications are not enabled yet.`);
      setRefreshCount((count) => count + 1);
    } catch (err) {
      if (err.status === 401) {
        setAuthenticated(false);
        setCsrfToken("");
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
    try {
      await mechanicRequest("/logout", { method: "POST", csrfToken });
      setAuthenticated(false);
      setCsrfToken("");
      setAppointments([]);
      setNotice("");
      setPassword("");
    } catch (err) {
      setError(err.message);
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

      {error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
      {notice && <p className="mechanic-message mechanic-success" role="status">{notice}</p>}

      {checkingSession ? (
        <p>Checking your session…</p>
      ) : !authenticated ? (
        <section className="mechanic-login">
          <h2>Staff sign in</h2>
          <p>Use the mechanic password configured in the backend.</p>
          <form onSubmit={signIn}>
            <label htmlFor="mechanic-password">Password</label>
            <input id="mechanic-password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit" disabled={signingIn}>{signingIn ? "Signing in…" : "Sign in"}</button>
          </form>
        </section>
      ) : (
        <section className="mechanic-workspace">
          <div className="mechanic-toolbar">
            <label htmlFor="mechanic-status">Show appointments</label>
            <select id="mechanic-status" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="declined">Declined</option>
              <option value="all">All</option>
            </select>
            <button type="button" className="mechanic-refresh" onClick={() => setRefreshCount((n) => n + 1)} disabled={loading}>
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
          <p className="mechanic-notice">Status changes update MongoDB, but do not notify customers yet. Email notifications are planned for Phase 4.</p>
        </section>
      )}
    </main>
  );
}

export default MechanicDashboard;
