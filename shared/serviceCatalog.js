import { SERVICE_CATEGORIES, SERVICES } from "./services.js";

export const SERVICE_CATALOG_MAX = 50;
export const SERVICE_NAME_MAX = 50;
export const SERVICE_DESCRIPTION_MAX = 300;
export const SERVICE_ICONS = Object.freeze(["oil", "tire", "filter", "wiper", "brakes", "climate", "engine", "chat", "wrench"]);

export function getServiceCatalog(settings) {
  // Only a missing legacy field may use the initial catalog. An explicitly
  // invalid saved value must fail validation rather than restore old offerings.
  return settings?.serviceCatalog === undefined ? SERVICES : settings.serviceCatalog;
}

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const allowed = ["name", "category", "icon", "description", "active", "provisional", "appointmentOnly", "legacyNames"];
const reservedNames = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"].map(name => name.toLowerCase()));

function validName(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= SERVICE_NAME_MAX
    && /^[\p{L}\p{N}][\p{L}\p{N} &'()/+:-]*$/u.test(value)
    && !reservedNames.has(value.toLowerCase());
}

// Names and aliases are durable identities because historical appointments
// store the original service string. Deactivate instead of deleting/renaming.
export function validateServiceCatalog(catalog, previousCatalog) {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > SERVICE_CATALOG_MAX) throw new Error(`Keep between 1 and ${SERVICE_CATALOG_MAX} services, including inactive services.`);
  const names = new Set();
  const result = catalog.map(service => {
    if (!plain(service) || Object.keys(service).some(key => !allowed.includes(key))) throw new Error("Provide only the listed service fields.");
    if (!validName(service.name)) throw new Error(`Service names must be 1–${SERVICE_NAME_MAX} characters without dots, dollar signs, control characters, or reserved names.`);
    if (!SERVICE_CATEGORIES.some(category => category.id === service.category)) throw new Error("Choose Basic Maintenance or Repairs & Diagnostics.");
    if (!SERVICE_ICONS.includes(service.icon)) throw new Error("Choose a supported service icon.");
    if (typeof service.description !== "string" || !service.description.trim() || service.description !== service.description.trim()
      || service.description.length > SERVICE_DESCRIPTION_MAX || [...service.description].some(character => {
        const code = character.codePointAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })) throw new Error(`Provide a service description of 1–${SERVICE_DESCRIPTION_MAX} characters without control characters.`);
    for (const key of ["active", "provisional", "appointmentOnly"]) if (typeof service[key] !== "boolean") throw new Error("Service availability flags must be true or false.");
    if (!Array.isArray(service.legacyNames) || service.legacyNames.length > 5 || service.legacyNames.some(name => !validName(name))) throw new Error("Provide valid historical service names.");
    for (const name of [service.name, ...service.legacyNames]) {
      const folded = name.toLowerCase();
      if (names.has(folded)) throw new Error("Service names and historical aliases must be unique, including inactive services.");
      names.add(folded);
    }
    return { name: service.name, category: service.category, icon: service.icon, description: service.description,
      active: service.active, provisional: service.provisional, appointmentOnly: service.appointmentOnly, legacyNames: [...service.legacyNames] };
  });
  if (previousCatalog) {
    for (const original of previousCatalog) {
      const retained = result.find(service => service.name === original.name);
      if (!retained || JSON.stringify(retained.legacyNames) !== JSON.stringify(original.legacyNames || [])) throw new Error("Keep existing service names and historical aliases. Deactivate a service to remove it from new bookings.");
    }
    for (const service of result) if (!previousCatalog.some(original => original.name === service.name) && service.legacyNames.length) throw new Error("New services cannot claim historical service aliases.");
  }
  return result;
}
