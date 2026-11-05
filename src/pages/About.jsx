import { Link } from "react-router-dom";
import { Icon, PageHero, BookingBanner } from "../components/CustomerUI";
import "../styles/AboutContact.css";

const values = [
  { number: "01", icon: "chat", title: "Keep it clear.", text: "Straightforward explanations help you understand what your vehicle needs and why it matters." },
  { number: "02", icon: "wrench", title: "Care for the details.", text: "From a routine service to an unfamiliar noise, we approach each concern with attention and care." },
  { number: "03", icon: "car", title: "Put people first.", text: "Your questions, your plans, and your comfort with the next step are part of the conversation." },
];

const steps = [
  { title: "Tell us what's going on", text: "Share your vehicle details, the service you need, or the symptoms you've noticed." },
  { title: "Find a time that works", text: "Request an appointment online. The shop reviews your preferred date and time before confirming." },
  { title: "Understand the next step", text: "Talk through your concerns and the proposed work so you can make an informed decision." },
];

export default function About() {
  return (
    <main className="customer-page about-page">
      <PageHero
        eyebrow="ABOUT ED'S AUTO SHOP"
        title="Good service starts with a conversation."
        description="Car care should feel approachable. We're here to make the next step clearer, from everyday maintenance to the problem you can't quite put into words."
      />

      <section className="site-container section-pad about-introduction" aria-labelledby="about-intro-heading">
        <div>
          <p className="eyebrow">THE WAY WE SEE IT</p>
          <h2 id="about-intro-heading">Your vehicle matters.<br />So does your peace of mind.</h2>
          <p>Welcome to Ed's Auto Shop. We offer a focused range of maintenance and repair services, including oil changes, engine air filter replacement, brake repairs, AC and heating repair, and engine diagnostics.</p>
          <p>Whether you know exactly what you need or just know something feels different, you can start with a simple appointment request. Tell us what you're experiencing, and we'll take it from there.</p>
          <Link className="text-link" to="/services">Explore our services <Icon name="arrow" /></Link>
        </div>
        <aside className="about-mission" aria-labelledby="about-mission-heading">
          <div className="about-mission-mark"><Icon name="wrench" /></div>
          <p className="eyebrow">OUR MISSION</p>
          <h3 id="about-mission-heading">Make car care easier to understand.</h3>
          <p>Our goal is simple: thoughtful service, clear communication, and practical guidance that helps you care for your vehicle with confidence.</p>
          <div className="about-mission-bottom"><span>YOUR CAR. YOUR QUESTIONS.</span><span>LET'S TALK.</span></div>
        </aside>
      </section>

      <section className="about-values-section section-pad" aria-labelledby="about-values-heading">
        <div className="site-container">
          <div className="about-section-heading">
            <div><p className="eyebrow">WHAT GUIDES US</p><h2 id="about-values-heading">A straightforward approach.</h2></div>
            <p>No complicated promises. Just a few principles that shape how we want every visit to feel.</p>
          </div>
          <div className="about-values-grid">
            {values.map((value) => (
              <article className="about-value" key={value.number}>
                <div className="about-value-top"><Icon name={value.icon} /><span>{value.number}</span></div>
                <h3>{value.title}</h3><p>{value.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="site-container section-pad about-process" aria-labelledby="about-process-heading">
        <div><p className="eyebrow">HERE FOR THE WHOLE CONVERSATION</p><h2 id="about-process-heading">From “what's that noise?”<br />to a clear next step.</h2></div>
        <ol className="about-steps">
          {steps.map((step, index) => (
            <li key={step.title}><span className="about-step-number">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>
          ))}
        </ol>
      </section>
      <BookingBanner />
    </main>
  );
}
