import { Link } from "react-router-dom";
import { BookingBanner, Icon, PageHero } from "../components/CustomerUI";
import "../styles/Services.css";

const services = [
  {
    name: "Oil Change",
    category: "Everyday maintenance",
    icon: "oil",
    description: "Give your engine the attention it needs. Regular oil and filter changes are a simple part of caring for your vehicle over the long run.",
    symptoms: "An upcoming maintenance interval, an oil-change reminder, or uncertainty about your last service.",
    discussion: "Your vehicle’s recommended oil, filter replacement, and a maintenance interval suited to its needs.",
  },
  {
    name: "Air Filter Change",
    category: "Help your engine breathe",
    icon: "filter",
    description: "A clean engine air filter helps keep dirt and debris out of the intake. We can help you understand when it is time for a replacement.",
    symptoms: "A visibly dirty filter, a scheduled maintenance interval, or a change in how your engine runs.",
    discussion: "The condition of your engine air filter and the appropriate replacement for your vehicle.",
  },
  {
    name: "Brake Repairs",
    category: "Confidence at every stop",
    icon: "brakes",
    description: "Squeaks, vibration, or a change in pedal feel deserve attention. Tell us what you are experiencing so we can discuss the next steps.",
    symptoms: "New braking noises, vibration when stopping, a warning light, or a change in stopping performance.",
    discussion: "An inspection of the concern, the condition of braking components, and recommended repair options.",
  },
  {
    name: "AC & Heating Repair",
    category: "Comfort through the seasons",
    icon: "climate",
    description: "When the cabin will not cool down or warm up, your daily drive can feel longer. Let us know what your heating or air conditioning is doing.",
    symptoms: "Weak airflow, air that will not reach the right temperature, or unusual sounds from the system.",
    discussion: "The symptoms, checks to identify the cause, and suitable repair options for your climate system.",
  },
  {
    name: "Engine Diagnostics",
    category: "Understand what is happening",
    icon: "engine",
    description: "A warning light is a starting point, not a complete diagnosis. Share what you have noticed so we can help you understand the issue before discussing a repair.",
    symptoms: "A check-engine light, rough running, stalling, or a noticeable change in performance.",
    discussion: "Diagnostic checks, what the findings mean, and which next steps make sense for your vehicle.",
  },
];

export default function Services() {
  return (
    <main className="customer-page services-page">
      <PageHero
        eyebrow="What we do"
        title="Care for the road ahead."
        description="From routine maintenance to a problem that needs a closer look, start with the service your vehicle needs. We’ll talk through the next steps with you."
      />

      <section className="site-container section-pad" aria-labelledby="services-heading">
        <div className="services-section-intro">
          <div>
            <p className="eyebrow">Our services</p>
            <h2 id="services-heading">Five ways we can help.</h2>
          </div>
          <p>Know exactly what you need? Choose a service below. Still figuring it out? Describe the concern in your appointment request.</p>
        </div>

        <div className="services-grid">
          {services.map((service, index) => (
            <article className={`services-detail-card${index === 4 ? " services-detail-card--wide" : ""}`} key={service.name}>
              <div className="services-card-intro">
                <div className="services-card-top">
                  <span className="services-icon-box"><Icon name={service.icon} /></span>
                  <span className="services-card-number" aria-hidden="true">0{index + 1}</span>
                </div>
                <p className="services-category">{service.category}</p>
                <h3>{service.name}</h3>
                <p className="services-description">{service.description}</p>
              </div>
              <div className="services-card-detail">
                <dl className="services-details">
                  <div>
                    <dt><Icon name="check" /> When to get in touch</dt>
                    <dd>{service.symptoms}</dd>
                  </div>
                  <div>
                    <dt><Icon name="chat" /> What we’ll discuss</dt>
                    <dd>{service.discussion}</dd>
                  </div>
                </dl>
                <Link className="services-book-link" to="/appointment" aria-label={`Request an appointment for ${service.name}`}>
                  Request an appointment <Icon name="arrow" />
                </Link>
              </div>
            </article>
          ))}
        </div>

        <aside className="services-help" aria-labelledby="services-help-heading">
          <span className="services-help-icon"><Icon name="chat" /></span>
          <div>
            <h2 id="services-help-heading">Not sure where to start?</h2>
            <p>You do not have to diagnose it yourself. Choose “Other / Not Sure” when booking and tell us what you have noticed.</p>
          </div>
          <Link to="/appointment" className="text-link">Tell us about your vehicle <Icon name="arrow" /></Link>
        </aside>
      </section>

      <BookingBanner />
    </main>
  );
}
