import { useRef, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import Brand from "./Brand";
import { Icon } from "./CustomerUI";
import "../styles/Navbar.css";

function Navigation() {
  const [open, setOpen] = useState(false);
  const toggle = useRef(null);
  function handleKeyDown(event) {
    if (event.key === "Escape" && open) {
      setOpen(false);
      toggle.current?.focus();
    }
  }
  return (
    <header className="site-header" onKeyDown={handleKeyDown}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="header-note"><div className="site-container"><span>AUTO CARE. CLEAR COMMUNICATION.</span><span>LET’S KEEP YOU MOVING <Icon name="arrow" /></span></div></div>
      <div className="site-container nav-container">
        <Brand />
        <button ref={toggle} className="nav-toggle" type="button" aria-expanded={open} aria-controls="customer-navigation" onClick={() => setOpen(!open)}><Icon name={open ? "close" : "menu"} /><span>{open ? "Close menu" : "Open menu"}</span></button>
        <nav id="customer-navigation" className={`nav-card${open ? " is-open" : ""}`} aria-label="Main navigation">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/services">Services</NavLink>
          <NavLink to="/about">About Us</NavLink>
          <NavLink to="/contact">Contact Us</NavLink>
          <Link className="button button-primary nav-booking" to="/appointment">Book an appointment <Icon name="arrow" /></Link>
        </nav>
      </div>
    </header>
  );
}

export default function Navbar() {
  const { pathname } = useLocation();
  return <Navigation key={pathname} />;
}
