import { useCallback, useEffect, useRef, useState } from "react";

async function api(path, { method = "GET", body, csrfToken } = {}) {
  const response = await fetch(`/api/mechanic${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-Mechanic-CSRF": csrfToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export default function useMechanicSession() {
  const [sessionKey, setSessionKey] = useState(0);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [logoutPending, setLogoutPending] = useState(false);
  const logoutToken = useRef("");
  const [message, setMessage] = useState("");
  const current = useRef(null);
  const generation = useRef(0);
  const channel = useRef(null);

  const clear = useCallback((message = "") => {
    generation.current += 1; // Discard replies from before logout/revalidation.
    setSessionKey((key) => key + 1);
    current.current = null;
    setSession(null);
    setChecking(false);
    setMessage(message);
  }, []);

  const accept = useCallback((data) => {
    current.current = data;
    setSession(data);
    setChecking(false);
  }, []);

  const request = useCallback(async (path, options = {}) => {
    const version = generation.current;
    try {
      const data = await api(path, { ...options, csrfToken: current.current?.csrfToken });
      if (version !== generation.current) throw new Error("Session changed. Please try again.");
      return data;
    } catch (err) {
      if (version === generation.current && err.status === 401) clear("Your session expired. Please sign in again.");
      throw err;
    }
  }, [clear]);

  const signIn = useCallback(async (password) => {
    const version = ++generation.current;
    const data = await api("/login", { method: "POST", body: { password } });
    if (version === generation.current) {
      setSessionKey((key) => key + 1);
      setMessage("");
      accept(data);
    }
  }, [accept]);

  const signOut = useCallback(async () => {
    // Hide private data immediately, even while logout is in flight.
    const csrfToken = current.current?.csrfToken || logoutToken.current;
    logoutToken.current = csrfToken;
    setLogoutPending(true);
    clear();
    channel.current?.postMessage("signed-out");
    try {
      await api("/logout", { method: "POST", csrfToken });
      logoutToken.current = "";
      setLogoutPending(false);
      channel.current?.postMessage("signed-out");
    } catch (err) {
      if (err.status === 401) {
        logoutToken.current = "";
        setLogoutPending(false);
        return;
      }
      setMessage("Sign-out could not be confirmed. Please retry sign-out before leaving this device.");
      // Keep the token in memory for a retry; never restore private UI.
      throw err;
    }
  }, [clear]);

  useEffect(() => {
    let active = true;
    async function validate() {
      clear();
      setChecking(true);
      const version = generation.current;
      if (logoutToken.current) {
        setChecking(false);
        document.body.classList.remove("staff-session-checking");
        return;
      }
      try {
        const data = await api("/session"); // A read never renews idle time.
        if (active && version === generation.current) accept(data);
      } catch (err) {
        if (active && version === generation.current) clear(err.status === 401 ? "Please sign in to continue." : "Could not verify your session. Please sign in again.");
      } finally {
        if (active && document.visibilityState === "visible") document.body.classList.remove("staff-session-checking");
      }
    }
    function conceal() {
      // Hide synchronously before a browser back/forward-cache snapshot.
      document.body.classList.add("staff-session-checking");
      clear();
    }
    function visibility() {
      if (document.visibilityState === "hidden") conceal();
      else void validate();
    }
    function pageShow(event) { if (event.persisted) void validate(); }
    void validate();
    window.addEventListener("pagehide", conceal);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visibility);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("mechanic-session");
      channel.current.onmessage = () => clear("Signed out. Please sign in again.");
    }
    return () => {
      active = false;
      generation.current += 1;
      window.removeEventListener("pagehide", conceal);
      window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", visibility);
      document.body.classList.remove("staff-session-checking");
      channel.current?.close();
      channel.current = null;
    };
  }, [accept, clear]);

  useEffect(() => {
    if (!session) return;
    const deadline = Math.min(session.idleExpiresAt, session.expiresAt);
    const timer = setTimeout(() => clear("Your session expired. Please sign in again."), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [session, clear]);

  const authenticated = !!session;
  useEffect(() => {
    if (!authenticated) return;
    let lastSent = 0;
    let pending = false;
    async function activity(event) {
      if (!event.isTrusted || document.visibilityState !== "visible" || pending || Date.now() - lastSent < 30_000) return;
      if (Date.now() >= Math.min(current.current?.idleExpiresAt ?? 0, current.current?.expiresAt ?? 0)) {
        clear("Your session expired. Please sign in again.");
        return;
      }
      lastSent = Date.now();
      pending = true;
      const version = generation.current;
      try {
        const data = await request("/activity", { method: "POST" });
        if (version === generation.current) accept(data);
      } catch { /* A 401 clears the session; network failures never extend it. */ }
      finally { pending = false; }
    }
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    return () => { for (const event of events) window.removeEventListener(event, activity); };
  // Only attach while authenticated, not after every activity reply.
  }, [authenticated, accept, clear, request]);

  return { session, sessionKey, checking, message, request, signIn, signOut, logoutPending };
}
