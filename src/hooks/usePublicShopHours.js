import { useCallback, useEffect, useRef, useState } from "react";
import { parsePublicShopHours } from "../utils/publicShopHours.js";

export default function usePublicShopHours() {
  const [entry, setEntry] = useState({ data: null, loading: true, error: "" });
  const controller = useRef(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setEntry({ data: null, loading: true, error: "" });
    try {
      const response = await fetch("/api/shop-hours", { signal: request.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Shop hours could not be verified.");
      const data = parsePublicShopHours(await response.json());
      if (version === sequence.current && !request.signal.aborted) setEntry({ data, loading: false, error: "" });
    } catch {
      if (version === sequence.current && !request.signal.aborted) setEntry({ data: null, loading: false, error: "Operating hours could not be verified. Please retry or contact the shop before visiting." });
    }
  }, []);
  const cancel = useCallback(() => { sequence.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void refresh(); });
    const focus = () => { void refresh(); };
    const pageShow = event => { if (event.persisted) void refresh(); };
    const visibility = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false; cancel();
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancel, refresh]);
  return { ...entry, refresh };
}
