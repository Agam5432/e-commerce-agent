// Getting a turn ready: which tools fit the moment, data fetched up front, the language note, and the greeting and suggestion prompts.
// Part of agent.js (which re-exports all of it); moved here unchanged.
import { getAgentSettings } from "../../admin/settings.js";
import { DEFAULT_AGENT_NAME } from "../../industries/ecommerce.js";
import { getOrderLookupAuth } from "../../services/orderLookupAuth.js";
import { recallVisitor } from "../../services/visitorMemory.js";
import { probeCatalog } from "../../tools/shopifyService.js";
import { PROBE_BUDGET_MS } from "./config.js";

// Checkout/cart-mutation tools are useless (and ~2k tokens per LLM call) while the cart is
// provably empty and no checkout has started. Shown again the moment a cart or checkout exists.
const CHECKOUT_ONLY_TOOLS = new Set([
  "set_shipping_address", "set_billing_address", "set_billing_same_as_shipping", "request_billing_update",
  "set_shipping_method", "get_shipping_options", "mark_checkout_ready", "get_tax_details",
  "check_prepaid_discount", "place_order", "begin_checkout", "get_checkout_details", "clear_cart",
  "update_cart_item", "apply_discount_or_offer",
]);

function pruneToolsForState(tools, context, options) {
  const off = new Set(context.disabledTools || []);
  if (off.size) tools = tools.filter((t) => !off.has(t?.function?.name || t?.name));
  const cartKnownEmpty = Array.isArray(context.cart?.items) && context.cart.items.length === 0;
  const checkout = options.checkout || {};
  const checkoutActive = Boolean(
    checkout.shipping || checkout.billing || checkout.orderQuote || checkout.selectedPaymentMethod || checkout.appliedDiscount
  );
  if (!cartKnownEmpty || checkoutActive) return tools;
  return tools.filter((t) => !CHECKOUT_ONLY_TOOLS.has(t?.function?.name || t?.name));
}

/** Resolves to `value`, or to `fallback` if it takes longer than `ms` (the work keeps running). */
export function withinBudget(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Everything the first LLM call needs, fetched IN PARALLEL: catalog summary, the shopper's
 * email-OTP/order state (ONE database read), and the live catalog probe for this message. The probe
 * gets a time budget: if Shopify is slow, the turn goes on without it (it still warms the cache).
 */
export function prefetchTurnData(config, storeId, userMessage, options = {}) {
  const auth = (() => {
    try {
      return getOrderLookupAuth();
    } catch {
      return null;
    }
  })();
  const who = { shop: storeId, clientId: options.clientId || "anon" };
  const cached = typeof config.getCachedCatalogSummary === "function" ? config.getCachedCatalogSummary(storeId) : null;
  const wantProbe = !options.deterministicOnly && String(userMessage || "").trim().length > 0;
  const chatState = !auth
    ? Promise.resolve({ verifiedEmail: "", lastOrderNumber: "" })
    : typeof auth.getChatState === "function"
      ? auth.getChatState(who).catch(() => ({ verifiedEmail: "", lastOrderNumber: "" }))
      : Promise.all([auth.getVerifiedEmail(who).catch(() => ""), auth.getLastOrder(who).catch(() => "")])
          .then(([verifiedEmail, lastOrderNumber]) => ({ verifiedEmail, lastOrderNumber }));
  // how long each part took (the slowest one decides how long the shopper waits before the AI is even asked)
  const parts = {};
  const t0 = Date.now();
  const timed = (name, promise) => Promise.resolve(promise).finally(() => { parts[name] = Date.now() - t0; });
  return Promise.all([
    timed("catalog", cached || typeof config.getCatalogSummary !== "function"
      ? Promise.resolve(cached)
      : config.getCatalogSummary(storeId).catch(() => null)),
    timed("chatState", chatState),
    timed("probe", wantProbe ? withinBudget(probeCatalog(storeId, userMessage), PROBE_BUDGET_MS, null) : Promise.resolve(null)),
    timed("settings", getAgentSettings(storeId)),
    // what the store already knows about this browser's visitor (never blocks the turn)
    timed("visitor", options.clientId ? withinBudget(recallVisitor(storeId, options.clientId, { customerRef: options.verifiedCustomerId || null }).catch(() => null), 1500, null) : Promise.resolve(null)),
  ]).then(([summary, state, probe, settings, memory]) => ({
    parts,
    summary,
    settings,
    memory,
    verifiedEmail: state?.verifiedEmail || "",
    lastOrder: state?.lastOrderNumber || "",
    probe,
  }));
}

// The model reads the customer's language itself (no keyword lists): mirror this message, unless the
// customer explicitly chose a language (then that choice is passed as lang with locked=true).
export function withLanguageNote(message, lang, locked = false) {
  if (locked && lang) {
    const name = lang === "hi" ? "Hindi (Devanagari)" : lang === "hinglish" ? "Hinglish (Roman letters)" : "English";
    return `${message}\n\n[The customer chose to talk in ${name}. Reply in ${name}.]`;
  }
  return `${message}\n\n[Reply in the language of THIS message, whatever language the earlier messages and your own earlier replies were in: if it is English, reply only in English with no Hindi or Hinglish words; if it is Hinglish (Hindi in Roman letters), reply in Hinglish written in Roman letters only, never in Devanagari; only if THIS message itself contains Devanagari letters, reply in Hindi. A message with no language of its own (only an e-mail, a number, a code, a name or an address) is answered in the language of the customer's earlier messages.]`;
}

function partOfDay(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "";
  if (hour < 5) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

export function buildGreetingPrompt({ storeName = "", customerName = "", localHour, languageChoice = "", agentName = "" } = {}) {
  const first = String(customerName || "").trim().split(/\s+/)[0] || "";
  const when = partOfDay(Number(localHour));
  const lang = languageChoice === "hi"
    ? "Write it in Hindi (Devanagari script)."
    : languageChoice === "hinglish"
      ? "Write it in Hinglish (Hindi in Roman letters)."
      : languageChoice === "en"
        ? "Write it in English."
        : "Write it in English only (no Hindi or Hinglish words), and mention in a few words that they can also chat in Hindi or Hinglish.";
  return [
    `You are ${agentName || DEFAULT_AGENT_NAME}, the shop assistant of ${storeName || "this online store"}: a warm friend who also runs the shop.`,
    "A customer has just opened the chat. Write the very first message they will see.",
    first ? `Their name is ${first}; greet them by name.` : "You do not know their name; do not invent one.",
    when ? `It is ${when} for them.` : "",
    lang,
    "One or two short sentences, friendly and natural, ending with an easy question about what they are looking for. Do not name or invent any product, price, offer or discount. No emojis. Output only the message.",
  ].filter(Boolean).join(" ");
}

export function buildSuggestionsPrompt({ storeName = "", categories = [], lastUser = "", answer = "", recent = [], languageChoice = "" } = {}) {
  const lang = languageChoice === "hi" ? "Hindi (Devanagari)" : languageChoice === "hinglish" ? "Hinglish (Hindi in Roman letters)" : languageChoice === "en" ? "English" : "the language of the shopper's last message (English if there is none)";
  return [
    `You help shoppers of ${storeName || "an online store"} keep the chat going by suggesting what they might tap next.`,
    categories.length ? `The store sells: ${categories.slice(0, 12).join(", ")}.` : "",
    lastUser ? `The shopper just said: "${String(lastUser).slice(0, 300)}"` : "The chat has just opened and the shopper has said nothing yet.",
    answer ? `The assistant replied: "${String(answer).slice(0, 500)}"` : "",
    recent.length ? `Do not repeat or rephrase these earlier suggestions: ${recent.slice(0, 10).map((r) => `"${r}"`).join(", ")}.` : "",
    `Write exactly 3 different suggestions in ${lang}, each written as the shopper would say it (first person, at most 5 words). They must make sense right after this reply and must be things a store assistant can really help with (finding or comparing products, price, delivery, returns, offers, cart, order status). Do not mention any product, price or offer that is not in the text above. No emojis.`,
    "Output only a JSON array of 3 strings.",
  ].filter(Boolean).join(" ");
}

export function parseSuggestions(text, recent = []) {
  let list = [];
  try {
    const match = String(text || "").match(/\[[\s\S]*\]/);
    list = match ? JSON.parse(match[0]) : [];
  } catch {
    list = [];
  }
  const seen = new Set(recent.map((r) => String(r).toLowerCase()));
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const value = typeof item === "string" ? item.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (value.length >= 2 && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      out.push(value);
    }
  }
  return out.slice(0, 3);
}

export { CHECKOUT_ONLY_TOOLS, pruneToolsForState, partOfDay };
