import { useId, useRef, useState } from "react";
import { SERVICE_CATEGORIES } from "../../shared/services.js";
import { getServiceCatalog, SERVICE_CATALOG_MAX, SERVICE_DESCRIPTION_MAX, SERVICE_ICONS, SERVICE_NAME_MAX, validateServiceCatalog } from "../../shared/serviceCatalog.js";

const emptyService = { name: "", category: "repairs", description: "", duration: "", icon: "wrench" };

export default function ServiceCatalogEditor({ draft, onChange, disabled }) {
  const id = useId();
  const [entry, setEntry] = useState(emptyService);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const errorBox = useRef(null);
  const catalog = getServiceCatalog(draft);

  function updateEntry(key, value) {
    setEntry(current => ({ ...current, [key]: value }));
    setError(""); setNotice("");
  }

  function changeAvailability(name, active) {
    onChange({ serviceCatalog: catalog.map(service => service.name === name ? { ...service, active } : service) });
    setError("");
    setNotice(`${name} is ${active ? "active" : "inactive"} in this draft. Review and save to update customer booking choices.`);
  }

  function addService(event) {
    event.preventDefault();
    if (disabled) return;
    let message = "";
    const service = {
      name: entry.name.trim(), category: entry.category, description: entry.description.trim(), icon: entry.icon,
      active: true, provisional: false, appointmentOnly: false, legacyNames: [],
    };
    const durationMinutes = entry.duration === "" ? NaN : Number(entry.duration);
    try { validateServiceCatalog([...catalog, service], catalog); }
    catch (failure) { message = failure.message; }
    if (!message && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 720)) message = "Provide a whole-minute booking estimate from 5 to 720 minutes.";
    if (!message && !confirmed) message = "Confirm that the shop offers this service before adding it.";
    if (message) {
      setError(message); setNotice("");
      // The summary is announced and focused even when the rejected value is
      // a duplicate historical alias rather than a native input constraint.
      requestAnimationFrame(() => errorBox.current?.focus());
      return;
    }
    onChange({
      serviceCatalog: [...catalog, service],
      serviceRules: { ...draft.serviceRules, [service.name]: { durationMinutes, requiresApproval: true } },
    });
    setEntry(emptyService); setConfirmed(false); setError("");
    setNotice(`${service.name} added to the draft with mechanic approval required. Review and save to publish this service.`);
  }

  return <section className="staff-settings-card" aria-labelledby={`${id}-heading`}>
    <div className="staff-settings-heading"><p className="staff-kicker">YOUR SHOP’S SERVICES</p><h2 id={`${id}-heading`}>Service catalog</h2><p>Add services the shop offers, or deactivate a service to remove it from new customer requests. Existing appointments and their service names stay on file.</p></div>
    <p className="staff-settings-note">All changes stay in this draft until you review and save. Service names and historical aliases are permanent; deactivate an old service and add a new one when its name changes.</p>
    {error && <p className="staff-settings-error" role="alert" ref={errorBox} tabIndex={-1}>{error}</p>}
    {notice && <p className="staff-settings-notice" role="status">{notice}</p>}
    <ul className="staff-service-catalog" aria-label="Current service catalog">
      {catalog.map(service => <li className="staff-service-catalog-item" key={service.name}>
        <div><h3>{service.name}</h3><p>{service.description}</p><span className={`staff-badge ${service.active === false ? "staff-badge-neutral" : "staff-badge-active"}`}>{service.active === false ? "Inactive" : "Active"}</span>{service.provisional && <span className="staff-badge staff-badge-provisional">Provisional</span>}{service.appointmentOnly && <span className="staff-field-help">Appointment selection only</span>}</div>
        <button type="button" className="staff-button staff-button-secondary" disabled={disabled} onClick={() => changeAvailability(service.name, service.active === false)}>{service.active === false ? "Reactivate" : "Deactivate"} {service.name}</button>
      </li>)}
    </ul>
    <form onSubmit={addService} noValidate className="staff-service-add" aria-labelledby={`${id}-add-heading`}>
      <h3 id={`${id}-add-heading`}>Add a service</h3><p className="staff-field-help">New services require mechanic approval. Booking estimates reserve time and do not set a price. Keep the description accurate and leave prices out until Edward confirms them.</p>
      <fieldset disabled={disabled || catalog.length >= SERVICE_CATALOG_MAX} className="staff-service-add-fields">
        <legend className="staff-sr-only">New service details</legend>
        <label className="staff-field"><span>Service name</span><input type="text" name="serviceName" aria-label="Service name" aria-describedby={`${id}-name-help`} maxLength={SERVICE_NAME_MAX} value={entry.name} onChange={event => updateEntry("name", event.target.value)} required /><span className="staff-field-help" id={`${id}-name-help`}>Up to {SERVICE_NAME_MAX} characters. Names must be unique, including inactive services.</span></label>
        <label className="staff-field"><span>Service category</span><select aria-label="Service category" value={entry.category} onChange={event => updateEntry("category", event.target.value)}>{SERVICE_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
        <label className="staff-field staff-settings-wide"><span>Customer description</span><textarea rows={3} aria-label="Customer description" aria-describedby={`${id}-description-help`} maxLength={SERVICE_DESCRIPTION_MAX} value={entry.description} onChange={event => updateEntry("description", event.target.value)} required /><span className="staff-field-help" id={`${id}-description-help`}>Up to {SERVICE_DESCRIPTION_MAX} characters. This description will appear on the customer website.</span></label>
        <label className="staff-field"><span>New service duration (minutes)</span><input type="number" aria-label="New service duration (minutes)" aria-describedby={`${id}-duration-help`} min="5" max="720" step="1" value={entry.duration} onChange={event => updateEntry("duration", event.target.value)} required /><span className="staff-field-help" id={`${id}-duration-help`}>An estimated booking duration from 5 to 720 minutes.</span></label>
        <label className="staff-field"><span>Service icon</span><select aria-label="Service icon" value={entry.icon} onChange={event => updateEntry("icon", event.target.value)}>{SERVICE_ICONS.map(icon => <option key={icon} value={icon}>{icon === "wrench" ? "Wrench" : icon.charAt(0).toUpperCase() + icon.slice(1)}</option>)}</select></label>
        <label className="staff-check staff-check-detailed staff-settings-wide"><input type="checkbox" aria-label="I confirm the shop offers this service" aria-describedby={`${id}-offer-help`} checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setError(""); }} /><span><strong>I confirm the shop offers this service</strong><span id={`${id}-offer-help`}>Adding a service will make it available to customers after the reviewed settings are saved.</span></span></label>
        <button type="submit" className="staff-button staff-button-secondary">Add service to draft</button>
      </fieldset>
      {catalog.length >= SERVICE_CATALOG_MAX && <p className="staff-settings-warning">The catalog has reached its {SERVICE_CATALOG_MAX}-service limit, including inactive services. Existing records are retained.</p>}
    </form>
  </section>;
}
