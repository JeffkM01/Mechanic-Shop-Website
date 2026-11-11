import { Link } from "react-router-dom";
import { Icon, PageHero, BookingBanner } from "../components/CustomerUI";
import { businessProfile } from "../../shared/businessProfile.js";
import usePublicShopHours from "../hooks/usePublicShopHours.js";
import { dateInTimezone, formatBookingDate } from "../utils/bookingDates.js";
import { formatPublicHoursInterval } from "../utils/publicShopHours.js";
import "../styles/AboutContact.css";

export default function Contact() {
  const contact = businessProfile.contact;
  const hours = usePublicShopHours();
  const verified = hours.data?.verified === true;
  const weekdays = [["Monday", "1"], ["Tuesday", "2"], ["Wednesday", "3"], ["Thursday", "4"], ["Friday", "5"], ["Saturday", "6"], ["Sunday", "0"]];
  const timeRange = formatPublicHoursInterval;
  const phoneDigits = contact.confirmed ? contact.phone.replace(/\D/g, "") : "";
  const phoneHref = phoneDigits ? `tel:+${phoneDigits.length === 10 ? "1" : ""}${phoneDigits}` : null;
  const today = verified ? dateInTimezone(new Date(), hours.data.timezone) : null;
  const closedDates = verified ? hours.data.closedDates.filter(date => date >= today) : [];
  return (
    <main className="customer-page contact-page">
      <PageHero
        eyebrow="CONTACT ED'S AUTO SHOP"
        title="Let's get you moving."
        description="Have a service in mind or a vehicle concern to discuss? Start with an appointment request and tell us a little about what you need."
      />

      <section className="site-container section-pad contact-details" aria-labelledby="contact-details-heading">
        <div className="contact-intro">
          <div><p className="eyebrow">GET IN TOUCH</p><h2 id="contact-details-heading">A conversation away.</h2></div>
          {!contact.confirmed && <p className="contact-placeholder-note"><Icon name="chat" /><span><strong>Contact details are being confirmed.</strong> The shop's public phone, email, and address have not yet been approved. Do not rely on example contact details. You can review available appointment-request times online.</span></p>}
        </div>
        <div className="contact-cards">
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="phone" /><span className="contact-placeholder-tag">{contact.confirmed ? "Shop contact" : "To be confirmed"}</span></div>
            <h3>Give us a call</h3>
            <p className="contact-detail-value">{phoneHref ? <a href={phoneHref}>{contact.phone}</a> : "Phone number to be confirmed"}</p>
            <p>{contact.confirmed ? "Contact the shop to discuss your vehicle or an existing appointment." : "A callable shop number will appear after Edward confirms it."}</p>
          </article>
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="mail" /><span className="contact-placeholder-tag">{contact.confirmed ? "Shop contact" : "To be confirmed"}</span></div>
            <h3>Send an email</h3>
            <p className="contact-detail-value contact-email">{contact.confirmed ? <a href={`mailto:${encodeURIComponent(contact.email)}`}>{contact.email}</a> : "Public email to be confirmed"}</p>
            <p>{contact.confirmed ? "Use this address for appointment questions and shop inquiries." : "An approved public inbox will appear here when it is ready."}</p>
          </article>
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="pin" /><span className="contact-placeholder-tag">{contact.confirmed ? "Shop location" : "To be confirmed"}</span></div>
            <h3>Visit the shop</h3>
            <p className="contact-detail-value">{contact.confirmed ? contact.addressLines.map((line, index) => <span className="contact-address-line" key={index}>{line}</span>) : "Shop address to be confirmed"}</p>
            <p>{contact.confirmed ? "Check your saved appointment status and the shop's operating hours before visiting." : "Please verify the shop location before visiting."}</p>
          </article>
        </div>
      </section>

      <section className="contact-options-section section-pad" aria-labelledby="contact-options-heading">
        <div className="site-container contact-options-grid">
          <div className="contact-booking">
            <p className="eyebrow">YOUR NEXT STEP</p>
            <h2 id="contact-options-heading">Ready when you are.</h2>
            <p>Our online appointment request is the best place to start. Choose a service, share your vehicle details, and let us know your preferred time.</p>
            <ul className="contact-checklist">
              <li><Icon name="check" />Know the service? Choose it from the list.</li>
              <li><Icon name="check" />Not sure? Describe what you've noticed.</li>
              <li><Icon name="check" />Check whether your saved appointment is confirmed or awaiting review.</li>
            </ul>
            <Link className="button button-primary" to="/appointment">Request an appointment <Icon name="arrow" /></Link>
            <p className="contact-booking-note">Visit only after your appointment has a confirmed status.</p>
          </div>
          <aside className="contact-hours" aria-labelledby="contact-hours-heading">
            <div className="contact-hours-heading"><Icon name="clock" /><span className="contact-placeholder-tag">{verified ? "Confirmed hours" : "Hours awaiting confirmation"}</span></div>
            <h3 id="contact-hours-heading">Shop hours</h3>
            <p>{verified ? `Times shown in ${hours.data.timezone}` : hours.loading ? "Checking the shop's saved hours…" : "Operating hours are awaiting confirmation."}</p>
            <dl>
              {weekdays.map(([day, key]) => <div key={key}><dt>{day}</dt><dd>{verified ? hours.data.weeklyHours[key].length ? hours.data.weeklyHours[key].map(timeRange).join(", ") : "Closed" : "To be confirmed"}</dd></div>)}
            </dl>
            {verified && hours.data.breaks.length > 0 && <p className="contact-hours-note"><strong>Shop breaks:</strong> {hours.data.breaks.map(timeRange).join(", ")}</p>}
            {verified && closedDates.length > 0 && <div className="contact-closed-dates"><h4>Upcoming closed dates</h4><ul>{closedDates.slice(0, 12).map(date => <li key={date}>{formatBookingDate(date)}</li>)}</ul>{closedDates.length > 12 && <p>Check the appointment calendar for other unavailable dates.</p>}</div>}
            {hours.error && <p className="contact-hours-note" role="status">{hours.error}</p>}
            {!hours.loading && !verified && <button type="button" className="button button-secondary contact-hours-retry" onClick={hours.refresh}>Retry shop hours</button>}
            <p className="contact-hours-note">{verified ? "These hours come from the shop's saved schedule. Appointment availability also depends on service duration, reservations, and other blocked time." : "No day is advertised as open or closed until the saved hours have been confirmed. Check the appointment calendar for request availability."}</p>
          </aside>
        </div>
      </section>

      <section className="site-container contact-help section-pad">
        <Icon name="wrench" />
        <div><h2>Not sure where to start?</h2><p>Explore basic maintenance and repairs & diagnostics to find the right starting point for your vehicle.</p></div>
        <Link className="text-link" to="/services">Explore services <Icon name="arrow" /></Link>
      </section>
      <BookingBanner />
    </main>
  );
}
