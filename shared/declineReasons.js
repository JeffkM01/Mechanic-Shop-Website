// These describe a shop's inability to fulfill a request, not a scheduling
// conflict or a promise that a replacement appointment has been offered.
export const DECLINE_EXPLANATION_MIN = 10;
export const DECLINE_EXPLANATION_MAX = 1000;
export const DECLINE_MESSAGE_MAX = 1200;
export const DECLINE_NEXT_STEPS = "Please reply to the shop’s notification email to discuss your vehicle’s needs and possible next steps. No different appointment time has been offered or confirmed.";

export const DECLINE_REASONS = Object.freeze([
  { id: "service_not_offered", label: "Service not offered by the shop", explanation: "We’re unable to accept this request because the requested service is not offered by the shop." },
  { id: "outside_capabilities", label: "Vehicle or repair outside shop capabilities", explanation: "We’re unable to accept this request because the vehicle or repair is outside the shop’s capabilities." },
  { id: "unable_to_accommodate", label: "Unable to accommodate the request", explanation: "We’re unable to accommodate this service request. Please contact the shop to discuss your vehicle’s needs." },
  { id: "parts_unavailable", label: "Parts unavailable and service cannot reasonably be performed", explanation: "We’re unable to obtain the necessary parts, so the requested service cannot reasonably be performed." },
  { id: "other", label: "Other — explanation required", explanation: "" },
].map(reason => Object.freeze(reason)));

export function getDeclineReason(category) {
  return DECLINE_REASONS.find(reason => reason.id === category);
}

export function getDeclinePreview(category, explanation = "") {
  const reason = getDeclineReason(category);
  if (!reason) return "";
  const extra = typeof explanation === "string" ? explanation.trim() : "";
  return reason.id === "other" ? extra : `${reason.explanation}${extra ? ` ${extra}` : ""}`;
}

export function validateDeclineReason(input) {
  const fields = {};
  const plain = input !== null && typeof input === "object" && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input));
  if (!plain || Object.keys(input).some(key => !["category", "explanation"].includes(key))) {
    return { error: "Provide a decline reason and customer-facing explanation.", fields: { "decline.category": "Choose a reason category before declining this request." } };
  }
  const reason = getDeclineReason(input.category);
  if (!reason) fields["decline.category"] = "Choose one of the listed decline reasons.";
  const raw = input.explanation === undefined ? "" : input.explanation;
  if (typeof raw !== "string") fields["decline.explanation"] = "Enter the customer-facing explanation as text.";
  else {
    const text = raw.trim();
    if ((reason?.id === "other" || text) && text.length < DECLINE_EXPLANATION_MIN) {
      fields["decline.explanation"] = `Provide an explanation of at least ${DECLINE_EXPLANATION_MIN} characters so the customer understands the reason.`;
    } else if (text.length > DECLINE_EXPLANATION_MAX) {
      fields["decline.explanation"] = `Keep the additional explanation to ${DECLINE_EXPLANATION_MAX} characters or fewer.`;
    } else if ([...raw].some(character => {
      const code = character.codePointAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })) {
      fields["decline.explanation"] = "Remove unsupported control characters from the explanation.";
    }
  }
  if (Object.keys(fields).length) return { error: "Please review the decline reason and explanation.", fields };
  const explanation = getDeclinePreview(reason.id, raw);
  if (explanation.length > DECLINE_MESSAGE_MAX) return { error: "Please shorten the customer-facing decline message.", fields: { "decline.explanation": `Keep the complete message to ${DECLINE_MESSAGE_MAX} characters or fewer.` } };
  return { value: { category: reason.id, explanation } };
}
