import { useCallback, useEffect, useRef, useState } from "react";
import { isBookingDate } from "../utils/bookingDates";

const CACHE_MS = 30_000;

async function getJson(url, signal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Availability could not be checked. Please try again.");
    error.code = body.code;
    throw error;
  }
  return body;
}

export default function useBookingAvailability(service, date) {
  const [viewMonth, setViewMonth] = useState("");
  const [calendarRevision, setCalendarRevision] = useState(0);
  const [dayRevision, setDayRevision] = useState(0);
  const [calendarEntry, setCalendarEntry] = useState(null);
  const [dayEntry, setDayEntry] = useState(null);
  const cache = useRef(new Map());
  const calendarController = useRef(null);
  const dayController = useRef(null);
  const calendarKey = `${service}|${viewMonth}|${calendarRevision}`;
  const dayKey = `${service}|${date}|${dayRevision}`;

  const read = useCallback(async (type, serviceName, value, signal, force = false) => {
    const key = `${type}|${serviceName}|${value}`;
    const cached = cache.current.get(key);
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.data;
    const query = new URLSearchParams({ service: serviceName });
    if (value) query.set(type === "month" ? "month" : "date", value);
    const data = await getJson(`/api/availability${type === "month" ? "/calendar" : ""}?${query}`, signal);
    if (type === "month") {
      if (!/^\d{4}-\d{2}$/.test(data.month) || !isBookingDate(data.today) || !isBookingDate(data.firstDate)
        || !isBookingDate(data.lastDate) || data.lastDate < data.firstDate || !Array.isArray(data.days) || !data.timezone) {
        throw new Error("Calendar availability could not be verified. Please retry.");
      }
    } else if (data.date !== value || !Array.isArray(data.slots) || !data.timezone
      || data.slots.some(slot => !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || !Number.isFinite(Date.parse(slot.startAt)))) {
      throw new Error("Appointment times could not be verified. Please retry.");
    }
    if (signal.aborted) throw new DOMException("Availability request cancelled", "AbortError");
    cache.current.set(key, { checkedAt: Date.now(), data });
    if (type === "month") cache.current.set(`month|${serviceName}|${data.month}`, { checkedAt: Date.now(), data });
    if (cache.current.size > 100) cache.current.delete(cache.current.keys().next().value);
    return data;
  }, []);

  useEffect(() => {
    if (!service) return;
    const controller = new AbortController();
    calendarController.current = controller;
    read("month", service, viewMonth, controller.signal)
      .then(data => { if (!controller.signal.aborted) setCalendarEntry({ key: calendarKey, service, data }); })
      .catch(error => {
        if (!controller.signal.aborted && viewMonth && error.code === "MONTH_OUT_OF_RANGE") {
          // Recover if the shop-local day or configured horizon changed while
          // this tab was open. The server chooses the new initial month.
          for (const key of cache.current.keys()) if (key.startsWith(`month|${service}|`)) cache.current.delete(key);
          setViewMonth("");
          return;
        }
        if (!controller.signal.aborted) setCalendarEntry(previous => ({ key: calendarKey, service, data: previous?.service === service ? previous.data : null, error: error.message }));
      });
    return () => controller.abort();
  }, [service, viewMonth, calendarKey, read]);

  useEffect(() => {
    if (!service || !date) return;
    const controller = new AbortController();
    dayController.current = controller;
    read("day", service, date, controller.signal)
      .then(data => { if (!controller.signal.aborted) setDayEntry({ key: dayKey, data }); })
      .catch(error => { if (!controller.signal.aborted) setDayEntry({ key: dayKey, error: error.message }); });
    return () => {
      controller.abort();
      // Also abort a forced review/submission refresh for this old selection.
      dayController.current?.abort();
    };
  }, [service, date, dayKey, read]);

  useEffect(() => () => { calendarController.current?.abort(); dayController.current?.abort(); }, []);

  const refreshDay = useCallback(async () => {
    if (!service || !date) return null;
    dayController.current?.abort();
    const controller = new AbortController();
    dayController.current = controller;
    try {
      const data = await read("day", service, date, controller.signal, true);
      if (controller.signal.aborted) return null;
      setDayEntry({ key: dayKey, data });
      setCalendarEntry(previous => previous?.service === service && previous.data ? {
        ...previous,
        data: { ...previous.data, days: previous.data.days.map(day => day.date === date ? { ...day, available: data.slots.length > 0 } : day) },
      } : previous);
      return data;
    } catch (error) {
      if (controller.signal.aborted || error.name === "AbortError") return null;
      setDayEntry({ key: dayKey, error: error.message });
      throw error;
    }
  }, [service, date, dayKey, read]);

  const refreshMonth = useCallback(() => {
    for (const key of cache.current.keys()) if (key.startsWith(`month|${service}|`)) cache.current.delete(key);
    setCalendarRevision(value => value + 1);
  }, [service]);

  const retryDay = useCallback(() => {
    cache.current.delete(`day|${service}|${date}`);
    setDayRevision(value => value + 1);
  }, [service, date]);

  const resetMonth = useCallback(() => { setViewMonth(""); }, []);
  const invalidate = useCallback(() => {
    for (const key of cache.current.keys()) if (key.includes(`|${service}|`)) cache.current.delete(key);
    setCalendarRevision(value => value + 1);
    setDayRevision(value => value + 1);
  }, [service]);

  useEffect(() => {
    function onFocus() { if (service) refreshMonth(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [service, refreshMonth]);

  const currentCalendar = calendarEntry?.key === calendarKey ? calendarEntry : null;
  const calendarData = calendarEntry?.service === service ? calendarEntry.data : null;
  const currentDay = dayEntry?.key === dayKey ? dayEntry : null;
  return {
    month: viewMonth || calendarData?.month || "",
    calendarData,
    days: currentCalendar && !currentCalendar.error ? currentCalendar.data?.days || [] : [],
    calendarLoading: Boolean(service && !currentCalendar),
    calendarError: currentCalendar?.error || "",
    dayData: currentDay?.data || null,
    dayLoading: Boolean(service && date && !currentDay),
    dayError: currentDay?.error || "",
    setViewMonth, resetMonth, refreshMonth, refreshDay, retryDay, invalidate,
  };
}
