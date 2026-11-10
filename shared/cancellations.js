export const CANCELLATION_MESSAGE_MAX = 1000;
export const CANCELLATION_EXPLANATION_MIN = 10;
export const CANCELLATION_EXPLANATION_MAX = 1200;

export const CUSTOMER_CANCELLATION_REASONS = Object.freeze([
  { id: "plans_changed", label: "My plans changed" },
  { id: "time_no_longer_works", label: "The appointment time no longer works" },
  { id: "service_not_needed", label: "I no longer need the service" },
  { id: "another_provider", label: "I found another service provider" },
  { id: "other", label: "Other" },
  { id: "prefer_not_to_say", label: "Prefer not to say" },
].map(reason => Object.freeze(reason)));

export const MECHANIC_CANCELLATION_REASONS = Object.freeze([
  { id: "shop_closed", label: "Shop unexpectedly closed", explanation: "We need to cancel your appointment because the shop will be unexpectedly closed. Please contact us to discuss another visit." },
  { id: "mechanic_unavailable", label: "Mechanic unavailable", explanation: "We need to cancel your appointment because the mechanic is unavailable. Please contact us to discuss another visit." },
  { id: "supplies_unavailable", label: "Parts or supplies unavailable", explanation: "We need to cancel your appointment because the required parts or supplies are unavailable. Please contact us to discuss another visit." },
  { id: "equipment_unavailable", label: "Equipment unavailable", explanation: "We need to cancel your appointment because the required equipment is unavailable. Please contact us to discuss another visit." },
  { id: "other", label: "Other — explanation required", explanation: "" },
].map(reason => Object.freeze(reason)));

export function getCancellationPreview(category, explanation = "") {
  const reason = MECHANIC_CANCELLATION_REASONS.find(item => item.id === category);
  if (!reason) return "";
  const extra = typeof explanation === "string" ? explanation.trim() : "";
  return reason.id === "other" ? extra : `${reason.explanation}${extra ? ` ${extra}` : ""}`;
}

export function validateCancellation(actor, input = {}) {
  const fields = {};
  const customer = actor === "customer";
  const plain = input !== null && typeof input === "object" && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input));
  const allowed = customer ? ["category", "message"] : ["category", "explanation"];
  if (!["customer", "mechanic"].includes(actor) || !plain || Object.keys(input).some(key => !allowed.includes(key))) {
    return { error: "Provide a valid cancellation reason.", fields: { "cancellation.category": "Choose one of the listed cancellation reasons." } };
  }
  const category = customer && (input.category === undefined || input.category === "") ? "prefer_not_to_say" : input.category;
  const reasons = customer ? CUSTOMER_CANCELLATION_REASONS : MECHANIC_CANCELLATION_REASONS;
  const reason = reasons.find(item => item.id === category);
  if (!reason) fields["cancellation.category"] = "Choose one of the listed cancellation reasons.";
  const key = customer ? "message" : "explanation";
  const raw = input[key] === undefined ? "" : input[key];
  if (typeof raw !== "string") fields[`cancellation.${key}`] = "Enter this message as text.";
  else {
    const text = raw.trim();
    if (!customer && (reason?.id === "other" || text) && text.length < CANCELLATION_EXPLANATION_MIN) {
      fields[`cancellation.${key}`] = `Provide at least ${CANCELLATION_EXPLANATION_MIN} characters so the customer understands the reason.`;
    } else if (raw.length > CANCELLATION_MESSAGE_MAX) {
      fields[`cancellation.${key}`] = `Keep this message to ${CANCELLATION_MESSAGE_MAX} characters or fewer.`;
    } else if ([...raw].some(character => {
      const code = character.codePointAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })) {
      fields[`cancellation.${key}`] = "Remove unsupported control characters from this message.";
    }
  }
  if (Object.keys(fields).length) return { error: "Please review the cancellation reason and message.", fields };
  if (customer) return { value: { category: reason.id, ...(raw.trim() ? { message: raw.trim() } : {}) } };
  const explanation = getCancellationPreview(reason.id, raw);
  if (explanation.length > CANCELLATION_EXPLANATION_MAX) {
    return { error: "Please shorten the customer-facing cancellation message.", fields: { "cancellation.explanation": `Keep the complete message to ${CANCELLATION_EXPLANATION_MAX} characters or fewer.` } };
  }
  return { value: { category: reason.id, explanation } };
}
