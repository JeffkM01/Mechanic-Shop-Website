import { useEffect, useState } from "react";

const RECIPIENT = "contact@edsautoshop.com";

async function publicConfiguration() {
  const response = await fetch("/api/appointment-email-test", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Optional appointment email test is unavailable.");
  return response.json();
}

// Retain only the public mode and the reviewed inbox. Run IDs and provider
// credentials never belong in customer/staff page state or browser storage.
export default function useAppointmentEmailTest(request = null) {
  const [configuration, setConfiguration] = useState(null);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return null;
      return request ? request("/appointment-email-test") : publicConfiguration();
    })
      .then(data => {
        if (!active) return;
        setConfiguration(data?.enabled === true && data.recipient === RECIPIENT ? { recipient: RECIPIENT } : null);
      })
      .catch(() => { if (active) setConfiguration(null); });
    return () => { active = false; };
  }, [request]);
  return configuration;
}
