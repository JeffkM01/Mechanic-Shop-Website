import { Link } from "react-router-dom";
import "../styles/ServiceCatalog.css";

export default function ServiceCatalogStatus({ catalog, empty = true }) {
  if (catalog.loading) return <div className="service-catalog-status" role="status">Loading current services…</div>;
  if (catalog.error) return <section className="service-catalog-status service-catalog-error" aria-label="Current services unavailable">
    <p role="alert">{catalog.error}</p><div><button type="button" className="button button-secondary" onClick={catalog.refresh}>Retry services</button><Link className="text-link" to="/contact">Contact the shop</Link></div>
  </section>;
  if (empty && !catalog.services.length) return <div className="service-catalog-status"><p>No services are accepting online requests right now. Contact the shop to discuss your vehicle.</p><Link className="text-link" to="/contact">Contact the shop</Link></div>;
  return null;
}
