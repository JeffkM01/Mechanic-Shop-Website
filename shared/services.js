// One catalog for public service cards, booking choices, and API validation.
// Provisional suggestions are requestable, but availability must be confirmed
// by Edward before they are advertised as established shop services.
export const SERVICE_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "maintenance",
    label: "Basic Maintenance",
    description: "Everyday care for your next mile. Explore routine maintenance and ask about the provisional options marked below.",
  }),
  Object.freeze({
    id: "repairs",
    label: "Repairs & Diagnostics",
    description: "A warning light, an unfamiliar sound, or a change in how your car feels? Start with the concern you have noticed.",
  }),
]);

export const SERVICES = Object.freeze([
  { name: "Oil Change", category: "maintenance", icon: "oil", description: "Routine oil and filter care to help you keep up with your vehicle’s maintenance schedule." },
  { name: "Tire Rotation", category: "maintenance", icon: "tire", description: "Ask whether tire rotation is available for your vehicle to help manage uneven tread wear.", provisional: true },
  { name: "Cabin Air Filter Replacement", category: "maintenance", icon: "filter", description: "Ask about replacing the filter that helps keep dust and debris out of your cabin airflow.", provisional: true },
  { name: "Engine Air Filter Replacement", category: "maintenance", icon: "filter", description: "Check the engine intake filter and discuss a replacement to help keep dirt and debris out.", legacyNames: ["Air Filter Change"] },
  { name: "Wiper Blade Replacement", category: "maintenance", icon: "wiper", description: "Replacement blades suited to your vehicle to help clear rain and improve visibility." },
  { name: "Brake Repairs", category: "repairs", icon: "brakes", description: "Tell us about squeaks, vibration, or a change in pedal feel so we can discuss inspection and repair options." },
  { name: "AC & Heating Repair", category: "repairs", icon: "climate", description: "Share concerns about weak airflow or cabin temperature and discuss checks for your climate system." },
  { name: "Engine Diagnostics", category: "repairs", icon: "engine", description: "Make sense of warning lights or changes in engine performance before deciding on a repair." },
  { name: "Other / Not Sure", category: "repairs", icon: "chat", description: "Describe the concern in your appointment request.", appointmentOnly: true },
].map((service) => Object.freeze({
  provisional: false,
  appointmentOnly: false,
  active: true,
  ...service,
  legacyNames: Object.freeze(service.legacyNames || []),
})));

// Keep historical names valid for old clients and records. Do not migrate or
// silently rewrite the service field stored in existing appointments.
export const ACCEPTED_SERVICE_NAMES = Object.freeze(
  SERVICES.flatMap((service) => [service.name, ...service.legacyNames]),
);

export function isValidServiceName(name, catalog = SERVICES) {
  if (typeof name !== "string") return false;
  const service = getService(name, catalog);
  return Boolean(service && service.active !== false);
}

export function getService(name, catalog = SERVICES) {
  return catalog.find((service) => service.name === name || service.legacyNames?.includes(name));
}

export function getServiceSelection(search, catalog = SERVICES) {
  const name = new URLSearchParams(search).get("service");
  const service = getService(name, catalog);
  return service?.active !== false ? service?.name || "" : "";
}

export function getAppointmentLink(name, catalog = SERVICES) {
  const service = getService(name, catalog);
  return service && service.active !== false ? `/appointment?${new URLSearchParams({ service: service.name })}` : "/appointment";
}

// Edward has approved automatic eligibility only for wiper replacement. Global
// automation, verified hours/capacity, availability and daily limits still apply.
export function requiresMechanicApproval(service) {
  return !service || service.name !== "Wiper Blade Replacement"
    || service.category !== "maintenance" || service.provisional === true;
}
