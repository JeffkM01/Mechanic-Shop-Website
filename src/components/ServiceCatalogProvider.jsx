import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ServiceCatalogContext } from "../hooks/useServiceCatalog.js";
import { parsePublicServiceCatalog } from "../utils/publicServiceCatalog.js";

export default function ServiceCatalogProvider({ children }) {
  const { pathname } = useLocation();
  const [entry, setEntry] = useState({ services: null, revision: null, loading: true, error: "", requestedPath: pathname, loadedPath: null });
  const controller = useRef(null);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setEntry(current => ({ ...current, requestedPath: pathname, loading: true, error: "" }));
    try {
      const response = await fetch("/api/services", { signal: request.signal, cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Current services could not be loaded.");
      const next = parsePublicServiceCatalog(await response.json());
      if (version !== sequence.current || request.signal.aborted) return;
      setEntry({ ...next, requestedPath: pathname, loadedPath: pathname, loading: false, error: "" });
    } catch {
      if (version === sequence.current && !request.signal.aborted) {
        setEntry(current => ({ ...current, requestedPath: pathname, loading: false, error: "Current services could not be loaded. Please retry or contact the shop." }));
      }
    }
  }, [pathname]);

  const cancelRefresh = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void refresh(); });
    function onFocus() { void refresh(); }
    function onPageShow(event) { if (event.persisted) void refresh(); }
    function onVisibility() { if (document.visibilityState === "visible") void refresh(); }
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      cancelRefresh();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelRefresh, refresh]);

  const currentRoute = entry.requestedPath === pathname;
  const loaded = currentRoute && entry.loadedPath === pathname && entry.services !== null;
  const ready = loaded && !entry.loading && !entry.error;
  const value = useMemo(() => ({
    services: ready ? entry.services : [],
    revision: entry.revision,
    loaded,
    ready,
    loading: !currentRoute || entry.loading,
    error: currentRoute ? entry.error : "",
    refresh,
  }), [currentRoute, entry, loaded, ready, refresh]);

  return <ServiceCatalogContext.Provider value={value}>{children}</ServiceCatalogContext.Provider>;
}
