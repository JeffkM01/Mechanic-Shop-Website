import { Link } from "react-router-dom";

const paths = {
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  wrench: <path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z" />,
  oil: <><path d="M4 9h10l3 4-3 5H4V9Zm0 0L2 6m5 0h5m-2 0v3m7 4 3-4h2" /><path d="M20 15s-2 3-2 4a2 2 0 0 0 4 0c0-1-2-4-2-4Z" /></>,
  filter: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 8v8m5-8v8m5-8v8" /></>,
  brakes: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><path d="m12 3 2 4m7 5-4 2m-5 7-2-4m-7-5 4-2" /></>,
  climate: <><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m13 9-4 1 1 4M4 14l4 1-1 4m13-9-4-1 1-4" /></>,
  engine: <><path d="M5 9h3l2-3h7v4h4v8h-4l-2 2H8l-3-3V9Zm-3 1v6M8 3h7m-4 0v3" /><path d="m12 10-2 4h5l-2 3" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  chat: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 2v6m10-6v6M3 11h18m-14 5h3m4 0h3" /></>,
  phone: <path d="m7 3 3 5-3 2a16 16 0 0 0 7 7l2-3 5 3-1 4C10 23 1 14 3 4l4-1Z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
  pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m5 5 14 14M5 19 19 5" />,
  car: <><path d="m4 10 2-6h12l2 6M3 10h18v8H3v-8Zm2 8v3m14-3v3M6 14h2m8 0h2" /></>,
};

export function Icon({ name, className = "" }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.wrench}</svg>;
}

export function PageHero({ eyebrow, title, description, children }) {
  return (
    <header className="page-hero">
      <div className="site-container page-hero-inner">
        <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
        <div className="page-hero-description"><p>{description}</p>{children}</div>
      </div>
    </header>
  );
}

export function BookingBanner() {
  return (
    <section className="booking-banner section-pad">
      <div className="site-container booking-banner-inner">
        <div><p className="eyebrow">LET’S GET YOU MOVING</p><h2>Your next mile starts here.</h2><p>Tell us what your car needs. We’ll take it from there.</p></div>
        <div className="booking-banner-action"><Link className="button button-primary" to="/appointment">Request an appointment <Icon name="arrow" /></Link><span>Requests are confirmed by the mechanic.</span></div>
      </div>
    </section>
  );
}
