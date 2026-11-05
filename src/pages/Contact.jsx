import { Link } from "react-router-dom";
import { Icon, PageHero, BookingBanner } from "../components/CustomerUI";
import "../styles/AboutContact.css";

export default function Contact() {
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
          <p className="contact-placeholder-note"><Icon name="chat" /><span><strong>Contact details are being confirmed.</strong> The phone, email, address, and hours below are clearly marked placeholders. Please use our online appointment request for now.</span></p>
        </div>
        <div className="contact-cards">
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="phone" /><span className="contact-placeholder-tag">Placeholder</span></div>
            <h3>Give us a call</h3>
            <p className="contact-detail-value">(555) 010-2020</p>
            <p>Example phone number. The shop's real number is not yet confirmed.</p>
          </article>
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="mail" /><span className="contact-placeholder-tag">Placeholder</span></div>
            <h3>Send an email</h3>
            <p className="contact-detail-value contact-email">hello@edsautoshop.example</p>
            <p>Example email address. This inbox is not monitored.</p>
          </article>
          <article className="contact-card">
            <div className="contact-card-top"><Icon name="pin" /><span className="contact-placeholder-tag">Placeholder</span></div>
            <h3>Visit the shop</h3>
            <p className="contact-detail-value">[Street address]<br /><span>[City, State ZIP]</span></p>
            <p>Address to be confirmed. Please verify the location before visiting.</p>
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
              <li><Icon name="check" />Wait for the mechanic to confirm your request.</li>
            </ul>
            <Link className="button button-primary" to="/appointment">Request an appointment <Icon name="arrow" /></Link>
            <p className="contact-booking-note">Submitting a request does not confirm an appointment.</p>
          </div>
          <aside className="contact-hours" aria-labelledby="contact-hours-heading">
            <div className="contact-hours-heading"><Icon name="clock" /><span className="contact-placeholder-tag">Placeholder hours</span></div>
            <h3 id="contact-hours-heading">Plan your visit.</h3>
            <p>Hours to be confirmed</p>
            <dl>
              <div><dt>Monday – Friday</dt><dd>To be confirmed</dd></div>
              <div><dt>Saturday</dt><dd>To be confirmed</dd></div>
              <div><dt>Sunday</dt><dd>No appointments</dd></div>
            </dl>
            <p className="contact-hours-note">Sunday appointments are unavailable. Other operating hours and walk-in availability have not yet been confirmed.</p>
          </aside>
        </div>
      </section>

      <section className="site-container contact-help section-pad">
        <Icon name="wrench" />
        <div><h2>Not sure where to start?</h2><p>Get to know our five core services and find the right starting point for your vehicle.</p></div>
        <Link className="text-link" to="/services">Explore services <Icon name="arrow" /></Link>
      </section>
      <BookingBanner />
    </main>
  );
}
