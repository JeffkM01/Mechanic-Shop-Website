import { validateServiceCatalog } from "../../shared/serviceCatalog.js";

// A catalog outage must not silently restore old services or allow a stale
// offering to become a new booking choice.
export function parsePublicServiceCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.services)) {
    throw new Error("Current services could not be verified. Please retry.");
  }
  const services = value.services.length ? validateServiceCatalog(value.services) : [];
  if (services.some(service => !service.active)) throw new Error("Current services could not be verified. Please retry.");
  return { revision: value.revision, services };
}
