// Where the conversation stands, as FACTS for the AI (never wording): is this a brand-new chat, a
// chat in progress, or a customer coming back after a while, and what was going on before.
// The AI uses this to treat a "hello" in the middle of a chat as a check-in, not a restart, and
// to welcome a returning customer back to what they were doing.

// After this long without a message the customer is "returning" rather than mid-conversation.
export const RETURNING_AFTER_MS = Number(process.env.RETURNING_AFTER_MINUTES || 30) * 60 * 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

function toTime(value) {
  if (value == null || value === "") return null;
  const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** "45 seconds", "12 minutes", "5 hours", "2 days" */
export function humanGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * @param previousActivityAt  server-recorded time of this shopper's previous message (trusted)
 * @param clientLastActivityAt the browser's time of its last message (used only when the server has none)
 */
export function describeContinuity({ previousActivityAt, clientLastActivityAt, history = [], recap = null, cart = null, checkout = null, now = Date.now() } = {}) {
  let last = toTime(previousActivityAt);
  if (last == null) {
    const fromClient = toTime(clientLastActivityAt);
    // a browser clock is not trusted for anything in the future or absurdly old
    if (fromClient != null && fromClient <= now && now - fromClient <= MAX_AGE_MS) last = fromClient;
  }
  const hasHistory = Array.isArray(history) && history.some((t) => t?.role === "user");
  const gapMs = last != null ? Math.max(0, now - last) : null;

  let state;
  if (gapMs == null) state = hasHistory ? "ongoing" : "new";
  else if (gapMs >= RETURNING_AFTER_MS) state = "returning";
  else state = hasHistory || recap ? "ongoing" : "new";

  const cartItems = Array.isArray(cart?.items) ? cart.items.map((i) => i?.product_title || i?.title).filter(Boolean).slice(0, 5) : [];
  const productsShown = Array.isArray(recap?.productsShown) ? recap.productsShown.slice(0, 5) : [];
  const checkoutStep = checkout?.step && checkout.step !== "cart" ? checkout.step : "";
  return {
    state,
    gap: gapMs != null ? humanGap(gapMs) : "",
    lastCustomerMessage: typeof recap?.lastUserMessage === "string" ? recap.lastUserMessage.slice(0, 160) : "",
    productsShown,
    cartItems,
    checkoutStep,
  };
}

/** The LIVE CONTEXT lines for the system prompt. */
export function continuityPromptBlock(c) {
  if (!c) return "";
  const lines = [];
  if (c.state === "new") lines.push("CONVERSATION: this is the start of a new chat.");
  else if (c.state === "ongoing") lines.push(`CONVERSATION: a chat IN PROGRESS${c.gap ? ` (previous message ${c.gap} ago)` : ""}. You have already greeted this customer.`);
  else lines.push(`CONVERSATION: the customer is COMING BACK after ${c.gap || "a while"} to an earlier chat with you.`);
  if (c.state !== "new") {
    if (c.lastCustomerMessage) lines.push(`- Their last message before this one: "${c.lastCustomerMessage}"`);
    if (c.productsShown.length) lines.push(`- Products you showed them earlier (background only, NOT the current topic; do not offer them again unless the customer refers to them): ${c.productsShown.join(" | ")}`);
  }
  if (c.cartItems.length) lines.push(`- In their cart now: ${c.cartItems.join(" | ")}`);
  if (c.checkoutStep) lines.push(`- Their checkout is in progress (step: ${c.checkoutStep}).`);
  return lines.join("\n");
}

// An earlier recap is carried forward only while the chat is still the same conversation (not after a long pause).
function freshRecap(previous, now) {
  const at = toTime(previous?.at);
  return at != null && now - at < RETURNING_AFTER_MS;
}

/** What to remember about this turn for the next one. */
export function buildRecap({ userMessage = "", products = [], previous = null, now = Date.now() } = {}) {
  const shown = (Array.isArray(products) ? products : []).map((p) => p?.title).filter(Boolean).slice(0, 5);
  return {
    lastUserMessage: String(userMessage || "").trim().slice(0, 160),
    productsShown: shown.length ? shown : Array.isArray(previous?.productsShown) && freshRecap(previous, now) ? previous.productsShown.slice(0, 5) : [],
    at: new Date(now),
  };
}