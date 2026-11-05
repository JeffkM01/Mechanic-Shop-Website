import { Link } from "react-router-dom";
import "../styles/Footer.css";

export default function Footer() {
  return (
    <footer className="site-footer">
      <span>Ed's Auto Shop</span>
      <Link to="/mechanic">Staff Login</Link>
    </footer>
  );
}
