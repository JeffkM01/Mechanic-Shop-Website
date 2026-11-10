import { useCallback, useEffect, useRef, useState } from "react";
import { prepareManagementLink } from "../utils/managementLink.js";

const INVALID_ACCESS = "This appointment-management link is no longer valid. Please contact the shop for help.";
const UNCERTAIN = "We couldn't confirm whether the cancellation was completed. Please refresh your appointment status before trying again.";

async function api(id, { method = "GET", body, csrfToken, exchange = false, action = "" } = {}) {
  const response = await fetch(`/api/customer/appointments/${id}${exchange ? "/exchange" : action ? `/${action}` : ""}`, {
    method, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-Appointment-CSRF": csrfToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "The request could not be completed.");
    error.status = response.status;
    error.code = data.code;
    error.fields = data.fields;
    throw error;
  }
  return data;
}

export default function useCustomerAppointment() {
  const [access] = useState(prepareManagementLink);
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [actionError, setActionError] = useState("");
  const [fields, setFields] = useState({});
  const [logoutPending, setLogoutPending] = useState(false);
  const [accessClosed, setAccessClosed] = useState(false);
  const current = useRef(null);
  const generation = useRef(0);
  const closed = useRef(false);
  const logoutToken = useRef("");
  const channel = useRef(null);

  const clear = useCallback(() => {
    generation.current += 1;
    current.current = null;
    setData(null);
    setBusy(false);
  }, []);

  const invalidate = useCallback(() => {
    clear();
    setChecking(false);
    setUnavailable(true);
    setMessage(INVALID_ACCESS);
  }, [clear]);

  const accept = useCallback((next) => {
    if (next?.appointment?.id !== access?.appointmentId
      || !["pending", "confirmed", "declined", "cancelled"].includes(next?.appointment?.status)
      || typeof next.csrfToken !== "string" || !/^[A-Za-z\d_-]{43}$/.test(next.csrfToken)
      || !Number.isFinite(new Date(next.sessionExpiresAt).getTime()) || new Date(next.sessionExpiresAt).getTime() <= Date.now()) {
      invalidate();
      return false;
    }
    current.current = next;
    setData(next);
    setChecking(false);
    setUnavailable(false);
    setMessage("");
    setActionError("");
    setFields({});
    setUncertain(false);
    return true;
  }, [access, invalidate]);

  const refresh = useCallback(async ({ initial = false } = {}) => {
    if (!access || access.invalid || closed.current) {
      invalidate();
      return;
    }
    const version = ++generation.current;
    setChecking(true);
    try {
      const next = initial ? await access.requestAccess(api) : await api(access.appointmentId);
      if (version === generation.current && document.visibilityState !== "hidden") accept(next);
    } catch (error) {
      if (version !== generation.current) return;
      if ([401, 403, 404].includes(error.status)) invalidate();
      else {
        if (!current.current) setUnavailable(true);
        setChecking(false);
        setMessage(error.status === 429 ? "Too many access attempts. Please wait a moment before checking your appointment again, or contact the shop." : "Your appointment status could not be verified. Please try refreshing its status or contact the shop.");
      }
    } finally {
      if (version === generation.current && document.visibilityState !== "hidden") document.body.classList.remove("customer-session-checking");
    }
  }, [access, accept, invalidate]);

  const cancel = useCallback(async (reason) => {
    if (!current.current || busy || uncertain || checking || closed.current) return false;
    const version = generation.current;
    setBusy(true);
    setActionError("");
    setFields({});
    try {
      const next = await api(access.appointmentId, { method: "POST", action: "cancel", body: reason, csrfToken: current.current.csrfToken });
      if (version !== generation.current) return false;
      if (next?.appointment?.status !== "cancelled") {
        setUncertain(true);
        setActionError(UNCERTAIN);
        return false;
      }
      if (!accept(next)) return false;
      channel.current?.postMessage("appointment-changed");
      return true;
    } catch (error) {
      if (version !== generation.current) return false;
      if ([401, 403, 404].includes(error.status)) invalidate();
      else if (!error.status || error.status >= 500) {
        setUncertain(true);
        setActionError(UNCERTAIN);
      } else if (error.status === 409) {
        setUncertain(true);
        setActionError("This appointment has changed or online cancellation is no longer available. Refresh its status before taking another action.");
      } else {
        setFields(error.fields || {});
        setActionError(error.status === 429 ? "Too many requests. Please wait before trying again." : error.message);
      }
      return false;
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }, [access, accept, busy, checking, invalidate, uncertain]);

  const closeAccess = useCallback(async () => {
    const csrfToken = current.current?.csrfToken || logoutToken.current;
    logoutToken.current = csrfToken;
    closed.current = true;
    setAccessClosed(true);
    setLogoutPending(true);
    clear();
    setChecking(false);
    setUnavailable(true);
    setMessage("Appointment access has been closed on this device.");
    channel.current?.postMessage("access-closed");
    try {
      await api(access.appointmentId, { method: "POST", action: "logout", csrfToken });
      logoutToken.current = "";
      setLogoutPending(false);
    } catch (error) {
      if (error.status === 401) {
        logoutToken.current = "";
        setLogoutPending(false);
      } else {
        setMessage("Appointment details are hidden, but closing access could not be confirmed. Please retry closing access before leaving this device.");
      }
    }
  }, [access, clear]);

  useEffect(() => {
    let active = true;
    function conceal() {
      // Synchronous CSS conceals the DOM before a back/forward-cache snapshot.
      document.body.classList.add("customer-session-checking");
      clear();
    }
    function visibility() {
      if (document.visibilityState === "hidden") conceal();
      else if (!closed.current) void refresh();
    }
    function pageShow(event) { if (event.persisted && !closed.current) void refresh(); }
    // Start the asynchronous session check after the subscription is installed.
    // A StrictMode setup that is immediately cleaned up never starts an extra
    // exchange or changes state after it has been discarded.
    void Promise.resolve().then(() => { if (active) void refresh({ initial: true }); });
    window.addEventListener("pagehide", conceal);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visibility);
    if (access?.appointmentId && typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(`appointment-access-${access.appointmentId}`);
      channel.current.onmessage = event => {
        if (event.data === "access-closed") {
          closed.current = true;
          setAccessClosed(true);
          invalidate();
        } else if (event.data === "appointment-changed") {
          conceal();
          if (document.visibilityState !== "hidden") void refresh();
        }
      };
    }
    return () => {
      active = false;
      generation.current += 1;
      current.current = null;
      window.removeEventListener("pagehide", conceal);
      window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", visibility);
      document.body.classList.remove("customer-session-checking");
      channel.current?.close();
      channel.current = null;
    };
  }, [access, clear, invalidate, refresh]);

  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(invalidate, Math.max(0, new Date(data.sessionExpiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [data, invalidate]);

  return { data, checking, unavailable, message, busy, uncertain, actionError, fields, logoutPending, refresh, cancel, closeAccess, canRefresh: Boolean(access?.appointmentId && !access.invalid && !accessClosed) };
}
