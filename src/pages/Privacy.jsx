import { Link } from "react-router-dom";
import { businessProfile } from "../../shared/businessProfile.js";
import { PageHero } from "../components/CustomerUI";
import PolicyNotice from "../components/PolicyNotice";
import "../styles/Policies.css";

export default function Privacy() {
  const { contact, privacy } = businessProfile;
  return <main className="customer-page policy-page">
    <PageHero eyebrow={businessProfile.name} title="Privacy information" description="How appointment information is used, where it is processed, and how to contact the shop about it." />
    <div className="site-container section-pad policy-content">
      <PolicyNotice approved={privacy.approved} effectiveDate={privacy.effectiveDate} />
      <section aria-labelledby="privacy-information"><h2 id="privacy-information">Information used for appointments</h2><p>The appointment form asks for your name, email, phone number, vehicle details, requested service, date and time, and optional notes. A cancellation may also include an optional reason and message. Please share only information relevant to the vehicle service.</p><p>The current website does not create customer accounts or collect card payments.</p></section>
      <section aria-labelledby="privacy-purpose"><h2 id="privacy-purpose">Why the shop uses it</h2><p>Appointment information helps the shop review requests, reserve available time, contact you, and record confirmations, declines, or cancellations. Cancelled requests remain in appointment history rather than being erased automatically.</p><p>Staff sign-in and limited appointment-access sessions help protect private records and manage access to them.</p></section>
      <section aria-labelledby="privacy-providers"><h2 id="privacy-providers">Services that process information</h2><dl className="policy-provider-list">
        <div><dt>Website and API hosting</dt><dd>{privacy.hostingProvider || "Hosting provider to be confirmed before launch."}</dd></div>
        <div><dt>Appointment database</dt><dd>{privacy.databaseProvider || "Appointment records use MongoDB. The production database provider and location are awaiting confirmation."}</dd></div>
        <div><dt>Email delivery</dt><dd>{privacy.emailProvider || "Email provider to be confirmed before launch."}</dd></div>
      </dl><p>Hosting and database services process requests and stored records needed to operate the website. When email notifications are enabled, the configured email provider processes recipient addresses and appointment-message contents. Provider terms and the final production configuration must be reviewed before this notice is approved.</p></section>
      <section aria-labelledby="privacy-access"><h2 id="privacy-access">Cookies and private appointment links</h2><p>Staff sign-in and secure customer appointment access use limited session cookies. Unsent appointment details are held in the page's memory while you complete the form.</p><p>A management link sent by email can authorize viewing and cancelling that one appointment. Keep the link private. Links and limited access sessions expire; if access is unavailable, contact the shop.</p></section>
      <section aria-labelledby="privacy-tracking"><h2 id="privacy-tracking">Analytics and other uses</h2><p>The current application does not include advertising or analytics integrations. Hosting and email providers may process operational information under their own service terms. Any changes to those services or data uses need to be reflected in this notice.</p></section>
      <section aria-labelledby="privacy-retention"><h2 id="privacy-retention">How long records are kept</h2><p>{privacy.retentionPolicy || "The shop has not yet confirmed its retention period and deletion process. The current system keeps appointment requests and cancellation history on file until retention is handled separately."}</p></section>
      <section aria-labelledby="privacy-requests"><h2 id="privacy-requests">Questions and information requests</h2><p>{privacy.requestInstructions || "The process for requesting access, corrections, or deletion of personal information is awaiting the shop's confirmation."}</p>{contact.confirmed ? <p>Contact {businessProfile.name} at <a href={`mailto:${encodeURIComponent(contact.email)}`}>{contact.email}</a>.</p> : <p>The shop's public contact details are also awaiting confirmation.</p>}<Link className="text-link" to="/contact">Contact and shop details</Link></section>
      <div className="policy-actions"><Link className="button button-secondary" to="/cancellation-policy">Cancellation policy</Link><Link className="text-link" to="/">Back to the shop</Link></div>
    </div>
  </main>;
}
