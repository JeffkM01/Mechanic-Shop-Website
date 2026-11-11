import { Link } from "react-router-dom";
import { businessProfile } from "../../shared/businessProfile.js";
import { PageHero } from "../components/CustomerUI";
import PolicyNotice from "../components/PolicyNotice";
import "../styles/Policies.css";

export default function CancellationPolicy() {
  const { cancellation } = businessProfile;
  return <main className="customer-page policy-page">
    <PageHero eyebrow={businessProfile.name} title="Cancellation policy" description="Review online cancellation availability and what happens to a saved appointment when it is cancelled." />
    <div className="site-container section-pad policy-content">
      <PolicyNotice approved={cancellation.approved} effectiveDate={cancellation.effectiveDate} />
      <section aria-labelledby="policy-cancellation-availability"><h2 id="policy-cancellation-availability">Online cancellation availability</h2><p>{cancellation.approved ? "You may cancel a future pending or confirmed appointment online until its scheduled start. There is no cancellation fee under this policy." : "The current provisional setup allows a future pending or confirmed appointment to be cancelled until its scheduled start. The website does not calculate or collect cancellation fees. Edward must approve this policy before public launch."}</p><p>Eligibility uses the shop's recorded appointment time and timezone. A pending request can still be cancelled before that time even if its temporary reservation has already expired.</p></section>
      <section aria-labelledby="policy-cancellation-steps"><h2 id="policy-cancellation-steps">How to cancel</h2><ol><li>Open the private management link in your appointment email, when one is available.</li><li>Review the appointment and choose <strong>Cancel Appointment</strong>.</li><li>Choose <strong>Confirm Cancellation</strong> to save the cancellation, or <strong>Keep My Appointment</strong> to leave it unchanged.</li></ol><p>You can provide a reason or message, but it is optional. A cancellation is complete only when the saved status shows <strong>Cancelled</strong>.</p></section>
      <section aria-labelledby="policy-cancellation-contact"><h2 id="policy-cancellation-contact">When to contact the shop</h2><p>Online cancellation is unavailable after an appointment has started or when a request has already been declined. If your management link is missing, expired, or unavailable, contact the shop. An appointment reference alone cannot open a private record.</p><p>To discuss a different visit time, contact the shop or submit a new request. Cancelling does not book a replacement appointment.</p><Link className="text-link" to="/contact">Contact and shop details</Link></section>
      <section aria-labelledby="policy-cancellation-result"><h2 id="policy-cancellation-result">After a cancellation</h2><p>The saved cancellation releases that appointment's reservation. Its original details and cancellation history stay on file. An already-cancelled appointment is not cancelled again.</p><p>When email is configured, cancellation messages are queued separately from saving the decision. A saved cancellation remains in effect if email delivery is delayed or fails. If a response is interrupted, refresh the saved status before trying another action.</p></section>
      <section aria-labelledby="policy-shop-cancellation"><h2 id="policy-shop-cancellation">If the shop cancels</h2><p>The mechanic records a customer-facing explanation when cancelling an eligible appointment. It is shown with the saved cancellation and included in the customer notice when email delivery is configured.</p></section>
      <div className="policy-actions"><Link className="button button-secondary" to="/privacy">Privacy information</Link><Link className="text-link" to="/">Back to the shop</Link></div>
    </div>
  </main>;
}
