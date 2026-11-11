import { useId, useState } from "react";
import { SERVICE_CATEGORIES, requiresMechanicApproval } from "../../shared/services.js";
import { getServiceCatalog } from "../../shared/serviceCatalog.js";
import ServiceCatalogEditor from "./ServiceCatalogEditor";

const policies = [
  { key: "capacity", label: "Simultaneous appointment capacity", min: 1, max: 20, description: "Maximum appointments that can occupy the shop at the same time, including their buffers." },
  { key: "maxAutomaticPerDay", label: "Maximum automatic confirmations per day", min: 0, max: 100, description: "Daily limit for automatically confirmed appointments. Additional eligible requests remain pending." },
  { key: "minimumNoticeHours", label: "Minimum advance notice (hours)", min: 0, max: 720, description: "How much notice a customer must give when submitting a new appointment request." },
  { key: "bookingHorizonDays", label: "Booking horizon (days)", min: 1, max: 365, description: "How far ahead customers can request appointments, using the shop’s local calendar dates." },
  { key: "startIncrementMinutes", label: "Appointment start increment (minutes)", min: 5, max: 120, description: "Spacing between offered start times. This must divide evenly into a 24-hour day, such as 15, 30, or 60 minutes." },
  { key: "bufferMinutes", label: "Appointment buffer (minutes)", min: 0, max: 120, description: "Extra time reserved after an appointment for cleanup or preparation." },
  { key: "pendingHoldHours", label: "Pending request hold duration (hours)", min: 1, max: 168, description: "How long a pending request provisionally reserves its time. The request stays on file after the hold expires." },
];

function numericValue(event) {
  return event.target.value === "" ? "" : Number(event.target.value);
}

export default function BookingSettings({ draft, onChange, disabled }) {
  const id = useId();
  const [confirmAutomation, setConfirmAutomation] = useState(false);
  const verified = draft.businessHoursVerified && draft.capacityVerified;
  const catalog = getServiceCatalog(draft);

  function changeRule(name, patch) {
    onChange({ serviceRules: { ...draft.serviceRules, [name]: { ...draft.serviceRules[name], ...patch } } });
  }
  function requestAutomation(enabled) {
    if (!enabled) { onChange({ automaticBookingEnabled: false }); setConfirmAutomation(false); }
    else setConfirmAutomation(true);
  }

  return <div className="staff-settings-sections">
    <ServiceCatalogEditor draft={draft} onChange={onChange} disabled={disabled} />
    <section className="staff-settings-card" aria-labelledby="staff-policy-heading">
      <div className="staff-settings-heading"><p className="staff-kicker">SPACE FOR THE WORK</p><h2 id="staff-policy-heading">Capacity & booking policies</h2><p>These values are loaded from the saved shop configuration. Changes can affect the dates and times customers see.</p></div>
      <p className="staff-settings-warning">Existing held and confirmed appointments remain protected. The server rejects capacity or calendar changes that conflict with reservations.</p>
      <fieldset className="staff-policy-fields" disabled={disabled}>
        <legend className="staff-sr-only">Booking policies</legend>
        {policies.map(({ key, label, min, max, description }) => <label className="staff-field" key={key}>
          <span>{label}</span><input type="number" name={key} min={min} max={max} step="1" value={draft[key]} onChange={event => onChange({ [key]: numericValue(event) })} aria-describedby={`${id}-${key}`} required />
          <span className="staff-field-help" id={`${id}-${key}`}>{description} Allowed range: {min}–{max}.</span>
        </label>)}
        <label className="staff-field staff-policy-wide"><span>Shop timezone</span><input type="text" name="timezone" value={draft.timezone} maxLength={100} onChange={event => onChange({ timezone: event.target.value })} aria-describedby={`${id}-timezone`} required /><span className="staff-field-help" id={`${id}-timezone`}>Use an IANA timezone, such as America/Chicago. Changing it clears hours verification and is blocked while upcoming appointments are held or confirmed. Customer times use this timezone.</span></label>
      </fieldset>
    </section>

    <section className="staff-settings-card" aria-labelledby="staff-duration-heading">
      <div className="staff-settings-heading"><p className="staff-kicker">ESTIMATE THE VISIT</p><h2 id="staff-duration-heading">Service duration estimates</h2><p>Booking estimates reserve time; they are not guaranteed repair completion times. Edward still needs to confirm the actual estimates and provisional service availability.</p></div>
      <p className="staff-settings-note">New availability uses updated estimates. Existing appointments retain their booked duration and buffer snapshots.</p>
      {SERVICE_CATEGORIES.map(category => <fieldset className="staff-service-category" key={category.id} disabled={disabled}>
        <legend>{category.label}</legend>
        <div className="staff-service-settings">{catalog.filter(service => service.category === category.id).map(service => {
          const rule = draft.serviceRules[service.name];
          const manualOnly = requiresMechanicApproval(service);
          return <article className="staff-service-rule" key={service.name}>
            <div className="staff-service-rule-heading"><h3>{service.name}</h3>{service.active === false && <span className="staff-badge staff-badge-neutral">Inactive</span>}{service.provisional && <span className="staff-badge staff-badge-provisional">Provisional</span>}</div>
            <label className="staff-field"><span>Estimated duration (minutes)</span><input type="number" aria-label={`${service.name} duration (minutes)`} min="5" max="720" step="1" value={rule.durationMinutes} onChange={event => changeRule(service.name, { durationMinutes: numericValue(event) })} required /><span className="staff-field-help">Booking estimate · 5–720 minutes</span></label>
            {manualOnly ? <p className="staff-approval-policy"><strong>Mechanic approval required.</strong> {category.id === "repairs" ? "Repairs & Diagnostics always require Edward’s approval." : "Edward requires approval for this service. Only Wiper Blade Replacement is eligible for automatic confirmation."}</p>
              : <><label className="staff-check"><input type="checkbox" aria-label={`${service.name} requires mechanic approval`} checked={rule.requiresApproval} onChange={event => changeRule(service.name, { requiresApproval: event.target.checked })} /><span>Require mechanic approval</span></label><p className="staff-field-help">Turning this off only makes the service eligible when automatic booking is explicitly enabled and all other safeguards are satisfied.</p></>}
          </article>;
        })}</div>
      </fieldset>)}
    </section>

    <section className="staff-settings-card" aria-labelledby="staff-automation-heading">
      <div className="staff-settings-heading"><p className="staff-kicker">YOU STAY IN CONTROL</p><h2 id="staff-automation-heading">Verification & automatic booking</h2><p>Automatic booking is disabled by default. Opening or saving this page never verifies business information or enables automation on its own.</p></div>
      <div className="staff-automation-status"><span>Automatic booking in this configuration</span><strong className={`staff-badge ${draft.automaticBookingEnabled ? "staff-badge-active" : "staff-badge-neutral"}`}>{draft.automaticBookingEnabled ? "Enabled" : "Disabled"}</strong></div>
      <fieldset className="staff-verification-fields" disabled={disabled}>
        <legend className="staff-sr-only">Explicit business verification</legend>
        <label className="staff-check staff-check-detailed"><input type="checkbox" aria-label="Business hours verified" aria-describedby={`${id}-hours-ack`} checked={draft.businessHoursVerified} onChange={event => onChange({ businessHoursVerified: event.target.checked })} /><span><strong>Business hours verified</strong><span id={`${id}-hours-ack`}>I have personally confirmed that the displayed timezone, weekly hours, and recurring shop-wide breaks reflect the real shop schedule. This is my acknowledgment, not an automatic check.</span></span></label>
        <label className="staff-check staff-check-detailed"><input type="checkbox" aria-label="Capacity verified" aria-describedby={`${id}-capacity-ack`} checked={draft.capacityVerified} onChange={event => onChange({ capacityVerified: event.target.checked })} /><span><strong>Capacity verified</strong><span id={`${id}-capacity-ack`}>I have personally confirmed that the simultaneous appointment capacity reflects the staff and equipment actually available.</span></span></label>
        <label className="staff-check staff-check-detailed"><input type="checkbox" aria-label="Automatic booking enabled" checked={draft.automaticBookingEnabled} disabled={!draft.automaticBookingEnabled && !verified} onChange={event => requestAutomation(event.target.checked)} /><span><strong>Automatic booking enabled</strong><span>Only eligible Wiper Blade Replacement requests may be confirmed automatically, after both verification acknowledgments, explicit enablement, an available slot, and the daily automatic limit check.</span></span></label>
      </fieldset>
      {!verified && <p className="staff-settings-warning">Automatic booking cannot be enabled until Edward explicitly verifies both the hours and capacity. Requests remain pending whenever either verification is missing.</p>}
      {confirmAutomation && !draft.automaticBookingEnabled && <section className="staff-inline-confirm" role="group" aria-labelledby="staff-enable-automation-heading">
        <h3 id="staff-enable-automation-heading">Enable automatic booking?</h3><p>After you save, the backend may automatically confirm eligible Wiper Blade Replacement requests against verified hours and capacity. All other services still require approval. Daily limits and atomic conflict checks still apply.</p><p>This changes the draft only. Review the configuration and choose Save Changes to apply it.</p>
        <div className="staff-inline-actions"><button type="button" className="staff-button staff-button-primary" disabled={disabled || !verified} onClick={() => { onChange({ automaticBookingEnabled: true }); setConfirmAutomation(false); }}>Enable automatic booking</button><button type="button" className="staff-button staff-button-secondary" disabled={disabled} onClick={() => setConfirmAutomation(false)}>Keep automatic booking off</button></div>
      </section>}
      <p className="staff-settings-note">Oil Change, Cabin Air Filter Replacement, Suspension Repair, and all services other than eligible Wiper Blade Replacement require mechanic approval. The backend alone decides each saved appointment’s status.</p>
    </section>
  </div>;
}
