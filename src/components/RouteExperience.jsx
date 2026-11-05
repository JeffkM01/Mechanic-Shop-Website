import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const titles = { "/": "Auto Repair & Maintenance", "/services": "Our Services", "/about": "About Us", "/contact": "Contact Us", "/appointment": "Request an Appointment", "/mechanic": "Staff Dashboard" };

export default function RouteExperience() {
  const { pathname, hash } = useLocation();
  const previousPath = useRef(pathname);
  useEffect(() => {
    document.title = `${titles[pathname] || "Auto Care"} | Ed’s Auto Shop`;
    if (previousPath.current !== pathname) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    previousPath.current = pathname;
    // React Router links can enter a category from another page as well as
    // move between categories. Resolve the hash after the target has mounted.
    let target;
    try {
      target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    } catch {
      target = null;
    }
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }, [pathname, hash]);
  return null;
}
