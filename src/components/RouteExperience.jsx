import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

const titles = { "/": "Auto Repair & Maintenance", "/services": "Our Services", "/about": "About Us", "/contact": "Contact Us", "/appointment": "Request an Appointment", "/mechanic": "Staff Dashboard" };

export default function RouteExperience() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  useEffect(() => {
    document.title = `${titles[pathname] || "Auto Care"} | Ed’s Auto Shop`;
    if (previousPath.current !== pathname) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    previousPath.current = pathname;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);
  return null;
}
