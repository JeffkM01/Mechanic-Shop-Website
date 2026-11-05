import { Link } from "react-router-dom";
import { Icon } from "./CustomerUI";

export default function Brand() {
  return (
    <Link className="shop-brand" to="/" aria-label="Ed's Auto Shop home">
      <span className="shop-brand-mark"><Icon name="wrench" /></span>
      <span><strong>ED’S<span className="shop-brand-dot">.</span></strong><small>AUTO SHOP</small></span>
    </Link>
  );
}
