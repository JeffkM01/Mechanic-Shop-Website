// Public booking rules and pure input validation. No address lookup, provider
// access, credentials, or customer data belongs in this policy object.
export const DEFAULT_MOBILE_TRAVEL_BUFFER_MINUTES = 75;
export const DEFAULT_MOBILE_BOOKING_POLICY = Object.freeze({
  travelBufferMinutes: DEFAULT_MOBILE_TRAVEL_BUFFER_MINUTES,
  requiresMechanicApproval: true,
});
export const MOBILE_LOCATION_LIMITS = Object.freeze({ city: 80, state: 2, postalCode: 10 });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasControls = value => typeof value === "string" && [...value].some(character => {
  const code = character.codePointAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});

export function validateMobileBookingPolicy(value = null) {
  if (value === null || value === undefined) return null;
  if (!plain(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "travelBufferMinutes") || !Object.hasOwn(value, "requiresMechanicApproval")
    || !Number.isInteger(value.travelBufferMinutes) || value.travelBufferMinutes < 0 || value.travelBufferMinutes > 120
    || value.requiresMechanicApproval !== true) throw new Error("Mobile booking policy requires a valid travel allowance and mechanic approval.");
  return Object.freeze({ travelBufferMinutes: value.travelBufferMinutes, requiresMechanicApproval: true });
}

export function prepareMobileLocation(input) {
  const fields = {};
  const source = plain(input) ? input : {};
  const city = typeof source.city === "string" ? source.city.trim() : "";
  const state = typeof source.state === "string" ? source.state.trim().toUpperCase() : "";
  const postalCode = typeof source.postalCode === "string" ? source.postalCode.trim() : "";
  if (!city || city.length > MOBILE_LOCATION_LIMITS.city || hasControls(source.city)) fields.city = "Enter your service city (up to 80 characters).";
  if (!["MO", "IL"].includes(state) || hasControls(source.state)) fields.state = "Select Missouri or Illinois for a coverage review.";
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode) || hasControls(source.postalCode)) fields.postalCode = "Enter a five-digit ZIP code, optionally followed by four digits.";
  if (Object.keys(fields).length) return { error: "Please correct the service location details.", fields };
  // Format validation does not establish that the city/ZIP is in the service
  // area, matches the state, or is reachable. Mechanic review remains required.
  return { value: { city, state, postalCode } };
}

export function prepareMobileReview(input, minimumTravelBufferMinutes) {
  if (!plain(input) || Object.keys(input).some(key => !["locationConfirmed", "travelConfirmed", "travelBufferMinutes"].includes(key))) {
    return { error: "Provide the mobile location, travel acknowledgments, and reserved travel allowance.", fields: {} };
  }
  const fields = {};
  if (input.locationConfirmed !== true) fields.locationConfirmed = "Confirm that coverage, the private service address, and site access have been reviewed.";
  if (input.travelConfirmed !== true) fields.travelConfirmed = "Confirm that the route and travel time have been reviewed.";
  if (!Number.isInteger(minimumTravelBufferMinutes) || minimumTravelBufferMinutes < 0 || minimumTravelBufferMinutes > 120) {
    fields.travelBufferMinutes = "The saved travel allowance could not be verified. Refresh this request before approving it.";
  } else if (!Number.isInteger(input.travelBufferMinutes) || input.travelBufferMinutes < minimumTravelBufferMinutes || input.travelBufferMinutes > 120) {
    fields.travelBufferMinutes = `Reserve at least ${minimumTravelBufferMinutes} minutes and at most 120 minutes for travel.`;
  }
  if (Object.keys(fields).length) return { error: "Review the mobile visit before confirming this appointment.", fields };
  return { value: { locationConfirmed: true, travelConfirmed: true, travelBufferMinutes: input.travelBufferMinutes } };
}
