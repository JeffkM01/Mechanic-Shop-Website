import { Link } from "react-router-dom";
import { getService, getAppointmentLink } from "../../shared/services.js";
import { BookingBanner, Icon } from "../components/CustomerUI";
import ServiceCatalogStatus from "../components/ServiceCatalogStatus";
import useServiceCatalog from "../hooks/useServiceCatalog";
import "../styles/Home.css";

const featuredChoices = [
  { name: "Oil Change", tag: "EVERYDAY MAINTENANCE" },
  { name: "Brake Repairs", tag: "STOP WITH CONFIDENCE" },
  { name: "Engine Diagnostics", tag: "GET A CLEARER PICTURE" },
];
const reasons = [
  { icon: "chat", title: "Real conversations.", text: "Tell us what you’re noticing. We’ll listen, explain the options, and keep you in the loop." },
  { icon: "wrench", title: "Care with a purpose.", text: "From everyday maintenance to an unexpected repair, the focus stays on what your vehicle needs." },
  { icon: "calendar", title: "A clear next step.", text: "Request a time that works for you and check your appointment’s saved status before your visit." },
];

export default function Home() {
  const catalog = useServiceCatalog();
  const eligible = catalog.services.filter(service => !service.appointmentOnly && !service.provisional);
  const featured = featuredChoices.map(choice => ({ ...choice, service: getService(choice.name, eligible) })).filter(choice => choice.service);
  for (const service of eligible) {
    if (featured.length >= 3) break;
    if (!featured.some(choice => choice.service.name === service.name)) featured.push({ service, tag: service.category === "maintenance" ? "BASIC MAINTENANCE" : "REPAIRS & DIAGNOSTICS" });
  }
  return (
    <main className="customer-page home-page">
      <section className="home-hero">
        <div className="site-container home-hero-grid">
          <div className="home-hero-copy">
            <p className="eyebrow">ED’S AUTO SHOP · AUTO REPAIR & MAINTENANCE</p>
            <h1>Good care.<br />For the road<br /><span>ahead.</span></h1>
            <p className="home-hero-description">Your car is part of your everyday life. Let’s keep it that way—with thoughtful repairs, routine maintenance, and straightforward service.</p>
            <div className="home-hero-actions"><Link className="button button-primary" to="/appointment">Book an appointment <Icon name="arrow" /></Link><Link className="home-hero-secondary text-link" to="/services">Explore our services</Link></div>
            <p className="home-hero-note"><span /> A simple request. A personal response.</p>
          </div>
          <div className="home-hero-visual">
            <img src="/images/workshop.webp" width="1536" height="1024" alt="A car with its hood open in a warmly lit automotive workshop" fetchPriority="high" />
            <div className="home-photo-caption"><span className="home-caption-mark"><Icon name="wrench" /></span><div><span>IT’S ABOUT MORE THAN THE CAR.</span><strong>It’s about what’s ahead.</strong></div></div>
            <span className="home-photo-label">MAINTAIN. REPAIR. KEEP MOVING.</span>
          </div>
        </div>
        <div className="site-container home-hero-bottom"><span><b>01</b> Routine maintenance</span><span><b>02</b> Repairs & diagnostics</span><span><b>03</b> Clear communication</span></div>
      </section>

      <section className="section-pad home-services" aria-labelledby="home-services-title">
        <div className="site-container">
          <div className="section-heading"><div><p className="eyebrow">WHAT WE DO</p><h2 id="home-services-title">Everyday care.<br />When you need it.</h2></div><div><p>From the routine to the unexpected,<br className="desktop-break" /> find the right place to start.</p><Link className="text-link" to="/services">Explore our service categories <Icon name="arrow" /></Link></div></div>
          <ServiceCatalogStatus catalog={catalog} />
          <div className="home-service-grid">{featured.map(({ service, tag }, index) => (
            <article className="home-service-card" key={service.name}>
              <div className="home-card-top"><Icon name={service.icon} /><span>0{index + 1}</span></div>
              <p className="home-card-tag">{tag}</p><h3>{service.name}</h3><p>{service.description}</p>
              <Link className="text-link" to={getAppointmentLink(service.name, catalog.services)}>Request {service.name.toLowerCase()} <Icon name="arrow" /></Link>
            </article>
          ))}</div>
          <div className="home-more-services"><span>Explore <Link to="/services#basic-maintenance">basic maintenance</Link> and <Link to="/services#repairs-diagnostics">repairs & diagnostics</Link>.</span><Icon name="car" /></div>
        </div>
      </section>

      <section className="home-approach section-pad" aria-labelledby="home-approach-title">
        <div className="site-container home-approach-grid">
          <div className="home-approach-heading"><p className="eyebrow">THE ED’S APPROACH</p><h2 id="home-approach-title">Auto care.<br />With people<br />at the center.</h2><p>No one knows your everyday drive better than you. We start by listening—and work toward a clear way forward.</p><Link className="text-link" to="/about">Get to know the shop <Icon name="arrow" /></Link></div>
          <div className="home-reasons">{reasons.map(reason => <article key={reason.title}><span className="home-reason-icon"><Icon name={reason.icon} /></span><div><h3>{reason.title}</h3><p>{reason.text}</p></div></article>)}</div>
        </div>
      </section>

      <section className="home-steps section-pad" aria-labelledby="home-steps-title">
        <div className="site-container"><div className="section-heading"><div><p className="eyebrow">FROM HERE TO YOUR NEXT VISIT</p><h2 id="home-steps-title">A little less guesswork.</h2></div><Link className="text-link" to="/appointment">Start your request <Icon name="arrow" /></Link></div>
          <ol className="home-step-grid"><li><span>01 /</span><h3>Tell us about your car.</h3><p>Choose a service, describe what you’re noticing, and share a preferred time.</p></li><li><span>02 /</span><h3>Check your appointment status.</h3><p>We’ll show whether your appointment is confirmed or awaiting mechanic review.</p></li><li><span>03 /</span><h3>Plan your next step.</h3><p>Wait for confirmation before visiting. Have a question? Check our contact page.</p></li></ol>
        </div>
      </section>
      <BookingBanner />
    </main>
  );
}
