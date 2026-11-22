import { Link } from "react-router-dom";
import Brand from "./Brand";
import { Icon } from "./CustomerUI";
import "../styles/Footer.css";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-container">
        <div className="footer-main">
          <div className="footer-brand"><Brand /><p>Thoughtful care for your car.<br />A straightforward way forward.</p></div>
          <nav aria-label="Footer navigation"><h2>EXPLORE THE SHOP</h2><Link to="/services">Our services</Link><Link to="/about">About Ed’s</Link><Link to="/contact">Contact & shop details</Link><Link to="/privacy">Privacy information</Link><Link to="/cancellation-policy">Cancellation policy</Link></nav>
          <div className="footer-visit"><h2>PLAN YOUR NEXT VISIT</h2><p>Start with an appointment request.<br />We’ll confirm the details with you.</p><Link className="text-link" to="/appointment">Let’s talk about your car <Icon name="arrow" /></Link></div>
        </div>
        <div className="footer-bottom"><span>© {new Date().getFullYear()} Ed’s Auto Shop. All rights reserved.</span><Link className="staff-login" to="/mechanic">Staff Login <Icon name="arrow" /></Link></div>
      </div>
    </footer>
  );
}
