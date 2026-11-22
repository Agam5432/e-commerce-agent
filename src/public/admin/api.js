// The only place that talks to the backend. Every call carries the Shopify session token, which is what
// tells the server which store this is: nothing else (the address, the body) can choose the store.
export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/** The session token Shopify's App Bridge hands to the page (it refreshes itself). */
const defaultToken = async () => {
  // the call window (console.html) has no Shopify session token: it sets its own (see support.js configureConsole)
  if (typeof globalThis.__orbiToken === "function") return globalThis.__orbiToken();
  const shopify = globalThis.shopify;
  if (typeof shopify?.idToken !== "function") throw new ApiError("Open this app from your Shopify admin.", 401);
  return shopify.idToken();
};

export function withQuery(path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export function createClient({ getToken = defaultToken, fetchImpl = (url, init) => globalThis.fetch(url, init), base = "/admin/api", timeoutMs = 30_000 } = {}) {
  const headers = async (extra = {}) => ({ Authorization: `Bearer ${await getToken()}`, "ngrok-skip-browser-warning": "true", ...extra });
  const unreachable = () => new ApiError("Could not reach the server. Check your connection and try again.", 0);
  const tooSlow = () => new ApiError("The server took too long to answer. Try again in a moment.", 0);

  /** One call, with a time limit. A 401 is retried once with a fresh token: the session token is short-lived, and
   * a refused call changed nothing, so it is safe to repeat. */
  async function send(url, init, again = true) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, { ...init, headers: await init.headers(), signal: controller?.signal });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw error?.name === "AbortError" ? tooSlow() : unreachable();
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.status === 401 && again) return send(url, init, false);
    return response;
  }

  async function request(method, path, { query, body } = {}) {
    const response = await send(withQuery(base + path, query), {
      method,
      headers: () => headers(body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.error || data?.errors?.[0]?.message || data?.errors?.[0] || "Something went wrong. Try again.";
      throw new ApiError(String(message), response.status, data);
    }
    return data;
  }

  /** A photo, video or PDF, fetched with the token (an image tag cannot send one). */
  async function file(path) {
    const response = await send(base + path, { method: "GET", headers: () => headers() });
    if (!response.ok) throw new ApiError("This file is not available any more.", response.status);
    return response.blob();
  }

  return {
    file,
    get: (path, query) => request("GET", path, { query }),
    put: (path, body) => request("PUT", path, { body }),
    patch: (path, body) => request("PATCH", path, { body }),
    post: (path, body = {}) => request("POST", path, { body }),
    delete: (path) => request("DELETE", path),
  };
}

export const api = createClient();

// One small function per backend route, so pages never build addresses themselves.
const id = encodeURIComponent;
export const getMe = () => api.get("/me");
export const getOverview = (range) => api.get("/overview", { ...range });
export const getConversations = (query) => api.get("/conversations", query);
export const getConversation = (cid) => api.get(`/conversations/${id(cid)}`);
export const getAttachment = (aid) => api.file(`/attachments/${id(aid)}`);
export const setConversationStatus = (cid, status) => api.patch(`/conversations/${id(cid)}`, { status });
export const setConversationNote = (cid, note) => api.patch(`/conversations/${id(cid)}`, { note });
export const setCase = (cid, supportCase) => api.patch(`/conversations/${id(cid)}`, { case: supportCase });
export const sendReply = (cid, text) => api.post(`/conversations/${id(cid)}/reply`, { text });
export const setHandoff = (cid, active) => api.post(`/conversations/${id(cid)}/handoff`, { active });
export const markChatRead = (cid) => api.post(`/conversations/${id(cid)}/read`, {});
export const getAttention = () => api.get("/attention");
export const getSupportState = () => api.get("/support/state");
export const getBookings = (query = {}) => api.get("/bookings", query);
export const getBookingSlots = () => api.get("/bookings/slots");
export const confirmBooking = (bid) => api.post(`/bookings/${id(bid)}/confirm`);
export const rescheduleBooking = (bid, startAt) => api.post(`/bookings/${id(bid)}/reschedule`, { startAt });
export const closeBooking = (bid, status, note) => api.post(`/bookings/${id(bid)}/close`, { status, ...(note !== undefined ? { note } : {}) });
export const getOrders = (query) => api.get("/orders", { ...query });
export const getOrder = (name) => api.get(`/orders/${id(String(name).replace(/\D/g, ""))}`);
export const getPerformance = (range) => api.get("/performance", { ...range });
export const getComplaints = (query) => api.get("/complaints", query);
export const getComplaint = (cid) => api.get(`/complaints/${id(cid)}`);
export const retryComplaintEmail = (cid) => api.post(`/complaints/${id(cid)}/retry-email`, {});
export const resolveComplaint = (cid) => api.post(`/complaints/${id(cid)}/resolve`, {});
export const getSettings = () => api.get("/settings");
export const saveSettings = (settings, expectedVersion) => api.put("/settings", { settings, expectedVersion });
export const getSettingsHistory = () => api.get("/settings/history");
export const getCustomers = (query) => api.get("/customers", query);
export const getCustomer = (cid) => api.get(`/customers/${id(cid)}`);
export const erasePerson = (cid) => api.delete(`/customers/${id(cid)}`);
export const getCallAnalytics = (range) => api.get("/call-analytics", { ...range });
export const getCallLog = (query) => api.get("/call-log", query);
export const getCallDetail = (cid) => api.get(`/call-log/${id(cid)}`);
