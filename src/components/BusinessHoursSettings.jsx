import { useRef } from "react";
import { TimeField } from "./SchedulingFields";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function intervalError(intervals) {
  if (intervals.length > 24) return "Use no more than 24 intervals.";
  const minutes = (time, end = false) => {
    if (end && time === "24:00") return 1440;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) return null;
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  };
  const times = intervals.map(({ start, end }) => [minutes(start), minutes(end, true)]);
  if (times.some(([start, end]) => start === null || end === null)) return "Enter a valid opening and closing time for every interval.";
  if (times.some(([start, end]) => start >= end)) return "Closing time must be after opening time within the same shop day.";
  const ordered = [...times].sort((a, b) => a[0] - b[0]);
  if (ordered.some((time, index) => index > 0 && time[0] < ordered[index - 1][1])) return "Intervals cannot overlap. Adjust the start or end time before saving.";
  return "";
}

export default function BusinessHoursSettings({ draft, onChange, disabled }) {
  const previousHours = useRef({});

  function changeDay(day, intervals) {
    onChange({ weeklyHours: { ...draft.weeklyHours, [day]: intervals } });
  }
  function toggleDay(day, open) {
    if (open) changeDay(day, previousHours.current[day] || [{ start: "08:00", end: "17:00" }]);
    else {
      previousHours.current[day] = draft.weeklyHours[day].map(interval => ({ ...interval }));
      changeDay(day, []);
    }
  }
  function changeInterval(day, index, field, value) {
    changeDay(day, draft.weeklyHours[day].map((interval, position) => position === index ? { ...interval, [field]: value } : interval));
  }
  function changeBreak(index, field, value) {
    onChange({ breaks: draft.breaks.map((interval, position) => position === index ? { ...interval, [field]: value } : interval) });
  }
  const breakError = intervalError(draft.breaks);

  return <div className="staff-settings-sections">
    <section className="staff-settings-card" aria-labelledby="staff-weekly-heading">
      <div className="staff-settings-heading"><p className="staff-kicker">YOUR WEEK AT A GLANCE</p><h2 id="staff-weekly-heading">Weekly business hours</h2><p>Set the working intervals for each shop day. Closed days do not offer customer appointment times.</p></div>
      <p className="staff-settings-note">Times use the shop timezone: <strong>{draft.timezone}</strong>. An interval must end later on the same day. For a midnight closing, enter <strong>12:00 AM (next day)</strong>.</p>
      {!draft.businessHoursVerified && <p className="staff-settings-warning">These hours have not been verified. Review the actual schedule before acknowledging verification in Booking Settings.</p>}
      <div className="staff-weekly-hours">{weekdays.map((day, dayIndex) => {
        const key = String(dayIndex);
        const intervals = draft.weeklyHours[key];
        const error = intervalError(intervals);
        return <fieldset key={day} className="staff-day" disabled={disabled} aria-describedby={error ? `staff-day-error-${key}` : undefined}>
          <legend>{day}</legend>
          <div className="staff-day-status"><label className="staff-check"><input type="checkbox" aria-label={`${day} open`} checked={intervals.length > 0} onChange={event => toggleDay(key, event.target.checked)} /><span>{intervals.length ? "Open" : "Closed"}</span></label>{!intervals.length && <span className="staff-muted">No appointment availability</span>}</div>
          {intervals.length > 0 && <div className="staff-day-intervals">{intervals.map((interval, index) => <div className="staff-interval" key={index}>
            <TimeField label={`${day} opening time ${index + 1}`} value={interval.start} onChange={value => changeInterval(key, index, "start", value)} disabled={disabled} />
            <TimeField label={`${day} closing time ${index + 1}`} value={interval.end} onChange={value => changeInterval(key, index, "end", value)} disabled={disabled} allowEnd />
            <button className="staff-button staff-button-quiet" type="button" aria-label={`Remove ${day} interval ${index + 1}`} onClick={() => changeDay(key, intervals.filter((_, position) => position !== index))}>Remove interval</button>
          </div>)}
            <button className="staff-button staff-button-secondary" type="button" onClick={() => changeDay(key, [...intervals, { start: "", end: "" }])} disabled={intervals.length >= 24}>{`Add ${day} interval`}</button>
          </div>}
          {error && <p className="staff-field-error" id={`staff-day-error-${key}`} role="alert">{day}: {error}</p>}
        </fieldset>;
      })}</div>
      <p className="staff-settings-note">Changing hours or breaks clears their verification until you explicitly verify the updated schedule. Existing held and confirmed appointments remain protected; conflicting changes cannot be saved.</p>
    </section>

    <section className="staff-settings-card" aria-labelledby="staff-breaks-heading">
      <div className="staff-settings-heading"><p className="staff-kicker">A LITTLE ROOM IN THE DAY</p><h2 id="staff-breaks-heading">Recurring daily breaks</h2><p>Breaks apply shop-wide on every open day. They are not assigned to individual weekdays.</p></div>
      <fieldset className="staff-breaks" disabled={disabled}>
        <legend className="staff-sr-only">Recurring shop-wide breaks</legend>
        {draft.breaks.length === 0 && <p className="staff-empty">No recurring breaks are configured.</p>}
        {draft.breaks.map((interval, index) => <div className="staff-interval" key={index}>
          <TimeField label={`Break start time ${index + 1}`} value={interval.start} onChange={value => changeBreak(index, "start", value)} disabled={disabled} />
          <TimeField label={`Break end time ${index + 1}`} value={interval.end} onChange={value => changeBreak(index, "end", value)} disabled={disabled} allowEnd />
          <button className="staff-button staff-button-quiet" type="button" aria-label={`Remove break ${index + 1}`} onClick={() => onChange({ breaks: draft.breaks.filter((_, position) => position !== index) })}>Remove break</button>
        </div>)}
        <button className="staff-button staff-button-secondary" type="button" onClick={() => onChange({ breaks: [...draft.breaks, { start: "", end: "" }] })} disabled={draft.breaks.length >= 24}>Add break</button>
      </fieldset>
      {breakError && <p className="staff-field-error" role="alert">Breaks: {breakError}</p>}
      <p className="staff-settings-note">A service and its buffer must fit around each break. Breaks must end after they start and cannot overlap one another.</p>
    </section>
  </div>;
}
