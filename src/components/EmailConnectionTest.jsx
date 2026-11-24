import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/EmailConnectionTest.css";

const TEST_RECIPIENT = "contact@edsautoshop.com";
const validCooldown = value => Number.isInteger(value) && value >= 0 && value <= 60;

export default function EmailConnectionTest({ request }) {
  const [configuration, setConfiguration] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);
  const cooldownTimer = useRef(null);

  const startCooldown = useCallback(seconds => {
    clearTimeout(cooldownTimer.current);
    setCooling(seconds > 0);
    if (seconds > 0) cooldownTimer.current = setTimeout(() => setCooling(false), seconds * 1000);
  }, []);

  useEffect(() => {
    const version = ++generation.current;
    request("/email-test").then(data => {
      if (version !== generation.current || data.enabled !== true
        || data.recipient !== TEST_RECIPIENT || !validCooldown(data.retryAfterSeconds)) return;
      setConfiguration({ recipient: data.recipient });
      startCooldown(data.retryAfterSeconds);
    }).catch(() => {
      // Optional tooling stays hidden when unavailable; authentication failures
      // are handled by the shared session hook and unmount the private view.
    });
    return () => {
      generation.current = version + 1;
      clearTimeout(cooldownTimer.current);
    };
  }, [request, startCooldown]);

  async function sendTest() {
    if (!configuration || pending.current || cooling) return;
    pending.current = true;
    const version = generation.current;
    setBusy(true); setNotice(""); setError("");
    // Reserve the local cooldown before awaiting. The server independently
    // enforces admission; a lost response must not encourage a second send.
    startCooldown(60);
    try {
      const result = await request("/email-test", { method: "POST", body: {} });
      if (version !== generation.current) return;
      if (result.accepted !== true || result.recipient !== configuration.recipient
        || !validCooldown(result.retryAfterSeconds)) throw new Error("Unverified test result.");
      startCooldown(result.retryAfterSeconds);
      setNotice("Brevo accepted the test message. Check the inbox and spam folder to confirm delivery.");
    } catch (failure) {
      if (version !== generation.current) return;
      setError(failure.status === 429
        ? "Please wait one minute before sending another test."
        : "The email test could not be confirmed. Check the inbox and spam folder before retrying; the result may be uncertain.");
    } finally {
      if (version === generation.current) { pending.current = false; setBusy(false); }
    }
  }

  if (!configuration) return null;
  return <section className="staff-settings-card staff-email-connection" aria-labelledby="email-connection-heading">
    <div className="staff-settings-heading">
      <p className="staff-kicker">PRIVATE TESTING</p>
      <h2 id="email-connection-heading">Email connection test</h2>
      <p>Send one clearly labeled test message to <a href={`mailto:${encodeURIComponent(configuration.recipient)}`}>{configuration.recipient}</a>.</p>
    </div>
    <p>Appointment emails stay disabled in this staging preview. This test does not create an appointment or send queued messages.</p>
    <div className="staff-inline-actions"><button type="button" className="staff-button staff-button-primary" onClick={sendTest} disabled={busy || cooling}>{busy ? "Sending test…" : "Send test email"}</button></div>
    {notice && <p className="mechanic-message mechanic-success" role="status">{notice}</p>}
    {error && <p className="mechanic-message mechanic-error" role="alert">{error}</p>}
    {cooling && <p className="staff-email-cooldown">Wait one minute before sending another test.</p>}
  </section>;
}
