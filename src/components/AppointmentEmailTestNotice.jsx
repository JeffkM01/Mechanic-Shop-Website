import "../styles/AppointmentEmailTest.css";

export default function AppointmentEmailTestNotice({ configuration, staff = false }) {
  if (!configuration) return null;
  return <section className="appointment-email-test-notice" aria-labelledby="appointment-email-test-heading">
    <h2 id="appointment-email-test-heading">Private appointment email test</h2>
    {staff ? <p>Only newly submitted requests in this email test can send notifications to <a href={`mailto:${encodeURIComponent(configuration.recipient)}`}>{configuration.recipient}</a>. Older requests stay on file and are excluded.</p>
      : <><p>Use fictional names, phone numbers, vehicle details, and notes.</p><p>Test emails for new requests go only to <a href={`mailto:${encodeURIComponent(configuration.recipient)}`}>{configuration.recipient}</a>. The email field is fixed to that inbox.</p></>}
    <p>Every test message is labeled TEST ONLY. These requests are for private testing, not real customer visits.</p>
  </section>;
}
