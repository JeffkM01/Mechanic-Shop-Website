import { Link } from "react-router-dom";
import { SERVICE_CATEGORIES, getAppointmentLink } from "../../shared/services.js";
import { BookingBanner, Icon, PageHero } from "../components/CustomerUI";
import ServiceCatalogStatus from "../components/ServiceCatalogStatus";
import useServiceCatalog from "../hooks/useServiceCatalog";
import "../styles/Services.css";

function sectionId(category) {
  return category.id === "maintenance" ? "basic-maintenance" : "repairs-diagnostics";
}

export default function Services() {
  const catalog = useServiceCatalog();
  return (
    <main className="customer-page services-page">
      <PageHero
        eyebrow="What we do"
        title="Care for the road ahead."
        description="Routine upkeep or a concern that needs a closer look? Explore maintenance, repairs, and diagnostics, then tell us what your vehicle needs."
      />

      <div className="site-container services-content">
        <nav className="services-category-nav" aria-label="Service categories">
          <span>FIND YOUR STARTING POINT</span>
          <div>{SERVICE_CATEGORIES.map((category) => (
            <a key={category.id} href={`#${sectionId(category)}`}>{category.label} <Icon name="arrow" /></a>
          ))}</div>
        </nav>

        <aside className="services-availability" aria-labelledby="services-availability-heading">
          <Icon name="chat" />
          <div>
            <h2 id="services-availability-heading">A note on availability.</h2>
            <p>Services marked provisional are awaiting availability confirmation. Repairs and diagnostics require mechanic review. Check your appointment’s saved status before visiting.</p>
          </div>
        </aside>

        <ServiceCatalogStatus catalog={catalog} />

        {SERVICE_CATEGORIES.map((category, categoryIndex) => (
          <section className="services-section" tabIndex={-1} id={sectionId(category)} key={category.id} aria-labelledby={`${category.id}-heading`}>
            <div className="services-section-intro">
              <div><p className="eyebrow">0{categoryIndex + 1} / CAR CARE</p><h2 id={`${category.id}-heading`}>{category.label}</h2></div>
              <p>{category.description}</p>
            </div>
            <div className="services-grid">
              {catalog.services.filter(service => service.category === category.id && !service.appointmentOnly).map((service, index) => (
                <article className="services-detail-card" key={service.name}>
                  <div className="services-card-top">
                    <span className="services-icon-box"><Icon name={service.icon} /></span>
                    <span className="services-card-number" aria-hidden="true">0{index + 1}</span>
                  </div>
                  {service.provisional && <p className="services-provisional">Provisional · confirm availability</p>}
                  <h3>{service.name}</h3>
                  <p className="services-description">{service.description}</p>
                  <Link className="services-book-link" to={getAppointmentLink(service.name, catalog.services)} aria-label={`Request an appointment for ${service.name}`}>
                    Request this service <Icon name="arrow" />
                  </Link>
                </article>
              ))}
            </div>
          </section>
        ))}

        <aside className="services-help" aria-labelledby="services-help-heading">
          <span className="services-help-icon"><Icon name="chat" /></span>
          <div><h2 id="services-help-heading">Not sure where to start?</h2><p>You do not have to diagnose it yourself. Describe what you have noticed in your appointment request, and the mechanic can review your concern.</p></div>
          <Link to="/appointment" className="text-link">Tell us about your vehicle <Icon name="arrow" /></Link>
        </aside>
      </div>
      <BookingBanner />
    </main>
  );
}
