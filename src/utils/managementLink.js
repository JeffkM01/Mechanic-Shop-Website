const APPOINTMENT_ID = /^[a-f\d]{24}$/i;
const MANAGEMENT_TOKEN = /^[A-Za-z\d_-]{43}$/;
let preparedAccess = null;

// Only fragments may carry a credential. Query references identify the scoped
// HttpOnly session to check; they never authorize access themselves.
export function parseManagementLink(href) {
  const url = new URL(href, "https://management.invalid");
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const queryHasCredential = [...query.keys()].some(key => /token|secret|credential|authorization/i.test(key));
  if (url.hash) {
    const id = fragment.get("id") || "";
    const token = fragment.get("token") || "";
    const exactKeys = [...fragment.keys()].length === 2 && fragment.getAll("id").length === 1 && fragment.getAll("token").length === 1;
    const valid = !queryHasCredential && exactKeys && APPOINTMENT_ID.test(id) && MANAGEMENT_TOKEN.test(token);
    return { appointmentId: valid ? id.toLowerCase() : "", token: valid ? token : "", invalid: !valid };
  }
  const id = query.get("appointment") || "";
  const valid = !queryHasCredential && query.getAll("appointment").length === 1 && APPOINTMENT_ID.test(id);
  return { appointmentId: valid ? id.toLowerCase() : "", token: "", invalid: !valid };
}

export function createManagementAccess({ appointmentId, invalid, token: credential }) {
  let token = credential;
  let exchange = null;
  return {
    appointmentId,
    invalid,
    requestAccess(request) {
      if (exchange) return exchange;
      if (!token) return request(appointmentId);
      const credential = token;
      token = ""; // Discard the bearer before initiating any network work.
      // React StrictMode may mount twice while the exchange is in flight. Share
      // that one request, but never keep its private response as a module cache.
      exchange = Promise.resolve().then(() => request(appointmentId, { method: "POST", body: { token: credential }, exchange: true }));
      exchange = exchange.finally(() => { exchange = null; });
      return exchange;
    },
  };
}

// Call at application bootstrap, before rendering customer content. The raw
// fragment is scrubbed even for malformed links and is never put in storage.
export function prepareManagementLink(location = window.location, history = window.history) {
  if (location.pathname !== "/manage-appointment") return null;
  const cleanId = new URLSearchParams(location.search).get("appointment");
  if (preparedAccess && !location.hash && location.search === (cleanId ? `?appointment=${cleanId}` : "") && preparedAccess.appointmentId === (cleanId || "")) return preparedAccess;
  const parsed = parseManagementLink(location.href);
  const cleanUrl = `${location.pathname}${parsed.appointmentId ? `?appointment=${parsed.appointmentId}` : ""}`;
  history.replaceState(history.state, "", cleanUrl);
  preparedAccess = createManagementAccess(parsed);
  return preparedAccess;
}
