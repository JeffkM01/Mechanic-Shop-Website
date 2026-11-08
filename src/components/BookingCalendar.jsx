import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./CustomerUI";
import {
  addDays, addMonths, dateWeekday, formatBookingDate, isBookingDate, monthDays, monthLabel,
} from "../utils/bookingDates";
import "../styles/BookingCalendar.css";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function sameDayInMonth(date, month) {
  const dates = monthDays(month).filter(Boolean);
  return dates[Math.min(Number(date.slice(-2)), dates.length) - 1] || null;
}

export default function BookingCalendar({
  month, today, firstDate, lastDate, days = [], selectedDate,
  loading, error, onMonthChange, onSelectDate, onRetry, disabled = false,
}) {
  const id = useId();
  const [activeDate, setActiveDate] = useState(null);
  const buttons = useRef(new Map());
  const pendingFocus = useRef(null);
  const dates = monthDays(month);
  const hasBounds = isBookingDate(firstDate) && isBookingDate(lastDate) && firstDate <= lastDate;
  const inBounds = (date) => hasBounds && date >= firstDate && date <= lastDate;
  const statuses = useMemo(() => new Map(days
    .filter((day) => isBookingDate(day.date) && typeof day.available === "boolean")
    .map((day) => [day.date, day.available])), [days]);
  const focusDate = [activeDate, selectedDate, today, ...dates].find((date) => date && dates.includes(date) && inBounds(date));
  const previousMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const canPrevious = !disabled && hasBounds && previousMonth && previousMonth >= firstDate.slice(0, 7) && previousMonth <= lastDate.slice(0, 7);
  const canNext = !disabled && hasBounds && nextMonth && nextMonth <= lastDate.slice(0, 7) && nextMonth >= firstDate.slice(0, 7);
  const bookableDates = dates.filter((date) => date && inBounds(date));
  const hasUnknownDates = bookableDates.some((date) => !statuses.has(date));
  const noAvailableDates = bookableDates.length > 0 && !hasUnknownDates && bookableDates.every((date) => statuses.get(date) === false);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target?.startsWith(`${month}-`) && buttons.current.get(target)) {
      buttons.current.get(target).focus();
      pendingFocus.current = null;
    }
  }, [month, firstDate, lastDate]);

  function navigateMonth(target) {
    pendingFocus.current = null;
    setActiveDate(null);
    onMonthChange(target);
  }

  function handleKeyDown(event, date) {
    if (!hasBounds || disabled) return;
    let target;
    switch (event.key) {
      case "ArrowLeft": target = addDays(date, -1); break;
      case "ArrowRight": target = addDays(date, 1); break;
      case "ArrowUp": target = addDays(date, -7); break;
      case "ArrowDown": target = addDays(date, 7); break;
      case "Home": target = addDays(date, -dateWeekday(date)); break;
      case "End": target = addDays(date, 6 - dateWeekday(date)); break;
      case "PageUp": target = sameDayInMonth(date, addMonths(month, -1)); break;
      case "PageDown": target = sameDayInMonth(date, addMonths(month, 1)); break;
      default: return;
    }
    event.preventDefault();
    if (!target) return;
    target = target < firstDate ? firstDate : target > lastDate ? lastDate : target;
    setActiveDate(target);
    if (target.slice(0, 7) !== month) {
      pendingFocus.current = target;
      onMonthChange(target.slice(0, 7));
    } else buttons.current.get(target)?.focus();
  }

  if (!dates.length) {
    return (
      <div className="booking-calendar booking-calendar-placeholder" aria-busy={Boolean(loading)}>
        <Icon name="calendar" />
        <p>{loading ? "Checking the shop calendar…" : "Choose a service to see available dates."}</p>
        {error && <div className="booking-calendar-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry} disabled={disabled}>Try again</button></div>}
      </div>
    );
  }

  return (
    <section className="booking-calendar" aria-label="Appointment date" aria-busy={Boolean(loading)}>
      <div className="booking-calendar-header">
        <h3 id={`${id}-month`} aria-live="polite">{monthLabel(month)}</h3>
        <div className="booking-calendar-navigation">
          <button type="button" aria-label="Previous month" disabled={!canPrevious} onClick={() => navigateMonth(previousMonth)}><Icon name="arrow" className="booking-calendar-previous" /></button>
          <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => navigateMonth(nextMonth)}><Icon name="arrow" /></button>
        </div>
      </div>
      <p id={`${id}-help`} className="booking-calendar-instructions">Choose an available date. <span className="booking-calendar-sr-only">Use arrow keys to move by day or week, Home and End within a week, and Page Up and Page Down between months.</span></p>
      <table className="booking-calendar-grid" role="grid" aria-labelledby={`${id}-month`} aria-describedby={`${id}-help`}>
        <thead><tr>{weekdays.map((weekday) => <th key={weekday} scope="col"><abbr title={weekday}>{weekday.slice(0, 2)}</abbr></th>)}</tr></thead>
        <tbody>{Array.from({ length: 6 }, (_, week) => (
          <tr key={week}>{dates.slice(week * 7, week * 7 + 7).map((date, index) => {
            if (!date) return <td key={`blank-${index}`} />;
            const allowed = inBounds(date);
            const checking = allowed && !error && (loading || !statuses.has(date));
            const available = allowed && !checking && !error && statuses.get(date) === true;
            const selected = selectedDate === date;
            const status = !allowed ? "Outside the booking window" : checking ? "Availability being checked" : error ? "Availability could not be loaded" : available ? "Available" : "Unavailable";
            const className = ["booking-calendar-day", available ? "is-available" : checking ? "is-checking" : "is-unavailable", selected && "is-selected", date === today && "is-today"].filter(Boolean).join(" ");
            return (
              <td key={date} aria-selected={selected}>
                <button
                  type="button"
                  ref={(node) => { if (node) buttons.current.set(date, node); else buttons.current.delete(date); }}
                  className={className}
                  disabled={!allowed}
                  aria-disabled={!available || disabled}
                  aria-pressed={selected}
                  aria-current={date === today ? "date" : undefined}
                  aria-label={`${formatBookingDate(date)}. ${status}${date === today ? ". Today" : ""}${selected ? ". Selected" : ""}${disabled && allowed ? ". Booking controls temporarily disabled" : ""}.`}
                  tabIndex={focusDate === date && !disabled ? 0 : -1}
                  onFocus={() => setActiveDate(date)}
                  onKeyDown={(event) => handleKeyDown(event, date)}
                  onClick={() => { if (available && !disabled) onSelectDate(date); }}
                >
                  <span>{Number(date.slice(-2))}</span>
                  <span className="booking-calendar-day-marker" aria-hidden="true">{selected ? <Icon name="check" /> : available ? "•" : checking ? "…" : "–"}</span>
                </button>
              </td>
            );
          })}</tr>
        ))}</tbody>
      </table>
      <div className="booking-calendar-legend" aria-label="Calendar legend">
        <span><b className="booking-calendar-legend-available" aria-hidden="true">•</b> Available</span>
        <span><b aria-hidden="true">–</b> Unavailable</span>
        {loading && <span><b aria-hidden="true">…</b> Checking</span>}
      </div>
      <div className="booking-calendar-status" role="status">{loading ? "Checking availability…" : error ? "" : hasUnknownDates ? "Availability has not loaded yet." : noAvailableDates ? "No available dates this month. Try another month or contact the shop." : ""}</div>
      {error && <div className="booking-calendar-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry} disabled={disabled}>Try again</button></div>}
    </section>
  );
}
