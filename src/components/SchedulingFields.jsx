import { useId } from "react";
import { formatBookingDate, formatBookingTime, isBookingDate, parseDisplayDate, parseDisplayTime } from "../utils/bookingDates";

// Text controls keep the displayed format explicit across browsers. Invalid
// intermediate edits stay in the draft so Discard Changes can restore them.
export function DateField({ label, value = "", onChange, disabled = false, required = false }) {
  const id = useId();
  const display = isBookingDate(value) ? formatBookingDate(value) : value;
  const invalid = Boolean(value && !isBookingDate(value));
  return <label className="staff-field">{label}<span className="staff-field-format" id={`${id}-format`}>MM/DD/YYYY</span>
    <input type="text" inputMode="numeric" placeholder="MM/DD/YYYY" value={display} disabled={disabled} required={required}
      aria-label={label} aria-describedby={`${id}-format`} aria-invalid={invalid || undefined} maxLength={10} onChange={event => onChange(parseDisplayDate(event.target.value) || event.target.value)} />
    {invalid && <span className="staff-field-error">Enter a valid date as MM/DD/YYYY.</span>}
  </label>;
}

export function TimeField({ label, value = "", onChange, disabled = false, required = true, allowEnd = false }) {
  const id = useId();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value) || (allowEnd && value === "24:00");
  const display = valid ? formatBookingTime(value) : value;
  const invalid = Boolean(value && !valid);
  return <label className="staff-field">{label}<span className="staff-field-format" id={`${id}-format`}>12-hour time · AM/PM{allowEnd ? " · midnight may end the day" : ""}</span>
    <input type="text" placeholder="8:00 AM" value={display} disabled={disabled} required={required} aria-invalid={invalid || undefined}
      aria-label={label} aria-describedby={`${id}-format`} maxLength={28} onChange={event => onChange(parseDisplayTime(event.target.value, allowEnd) || event.target.value)} />
    {invalid && <span className="staff-field-error">Enter a time such as 8:00 AM{allowEnd ? " or 12:00 AM (next day)" : ""}.</span>}
  </label>;
}
