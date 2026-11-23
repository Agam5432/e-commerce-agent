import { reportError } from "../observability/errors.js";
import { replyLedger } from "../services/replyLedger.js";
import { Router } from "express";
import crypto from "node:crypto";
import StoreIntegration from "../models/StoreIntegration.js";
import { runAgent, sanitizeHistory, generateGreeting, generateSuggestions, describeAttachments, isFallbackAnswer } from "../agent/agent.js";
import { createVoiceToken, TOKEN_PURPOSES } from "../services/voiceTokenService.js";
import { resolveShopifyCustomer } from "../services/shopifyCustomerService.js";
import { getOrderLookupAuth } from "../services/orderLookupAuth.js";
import { guestCustomer, verifiedCustomerGid, resolveClientId } from "../services/customerContext.js";
import { resolveTurnLanguage, isLanguageCode } from "../services/language.js";
import { createChatRateLimiter, createShopBudget, visitorIdentity } from "../http/hardening.js";
import { abandonCheckoutInProgress, forgetConversation } from "../services/checkoutSessionService.js";
import { forgetCheckoutMemory } from "../industries/ecommerce/pricing.js";
import { chatRefFor, markChatCleared } from "../services/conversationLog.js";
import { loadAttachments, mediaForAI, MAX_FILES } from "../services/attachmentService.js";
import { holdForTeam, staffMessagesSince } from "../services/handoff.js";
import { getAgentSettings } from "../admin/settings.js";
import supportProxyRoutes from "./supportProxyRoutes.js";
import { normalizeCartSnapshot } from "../services/cartSnapshot.js";
import { cartInStoreCurrency } from "../services/cartPricing.js";

// Per shopper (signed customer id, or their network): one shopper cannot run up the bill.
const chatLimiter = createChatRateLimiter({ name: "chat" });
const greetingLimiter = createChatRateLimiter({ name: "greeting" });
// minting a voice session and clearing a chat are cheap but must not be hammered
const voiceTokenLimiter = createChatRateLimiter({ name: "voice-token", limit: Number(process.env.LIGHT_RATE_LIMIT) || 20 });
const resetLimiter = createChatRateLimiter({ name: "reset-chat", limit: Number(process.env.LIGHT_RATE_LIMIT) || 20 });
const suggestionLimiter = createChatRateLimiter({ name: "suggestions", limit: Number(process.env.SUGGESTION_RATE_LIMIT) || 40 });
// the chat window asks for the team's replies every few seconds while it waits for one
const staffPollLimiter = createChatRateLimiter({ name: "staff-poll", limit: Number(process.env.STAFF_POLL_RATE_LIMIT) || 40 });
// Per store, whoever asks: every route that makes an AI call counts against the same budget.
const aiBudget = createShopBudget({ name: "ai" });

const router = Router();

export function verifyAppProxySignature(queryString) {
  const secret =
    process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;

  const params = new URLSearchParams(queryString);
  const signature = params.get("signature");

  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  params.delete("signature");

  // Preserve repeated query parameters, as Shopify requires.
  const grouped = new Map();

  for (const [key, value] of params.entries()) {
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }

  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest();

  const received = Buffer.from(signature, "hex");

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

// The store a standalone website (outside Shopify) talks to. Off unless PUBLIC_STOREFRONT_SHOP is set.
// Visitors there are always guests: no Shopify login is ever claimed, so no personal order data is reachable
// without the email code, exactly as for a guest on the Shopify storefront.
export function publicStorefrontShop(env = process.env) {
  const shop = String(env.PUBLIC_STOREFRONT_SHOP || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : "";
}

async function authenticatePublicStorefront(req, res, next) {
  try {
    const shop = publicStorefrontShop();
    if (!shop) return res.status(404).json({ error: "Not found." });
    const integration = await StoreIntegration.exists({ platform: "shopify", storeDomain: shop, status: "active" });
    if (!integration) return res.status(403).json({ error: "Shop is not connected." });
    req.verifiedShop = shop;
    req.proxyCustomerId = "";
    return next();
  } catch (error) {
    console.error("Public storefront authentication error:", error.message);
    return res.status(500).json({ error: "Unable to authenticate shop." });
  }
}

async function authenticateAppProxy(req, res, next) {
  if (req.baseUrl === "/public") return authenticatePublicStorefront(req, res, next);
  try {
    const queryString = req.originalUrl.split("?")[1] || "";

    if (!verifyAppProxySignature(queryString)) {
      return res.status(401).json({ error: "Invalid Shopify proxy signature." });
    }

    const params = new URLSearchParams(queryString);
    const shop = (params.get("shop") || "").toLowerCase();
    const timestamp = Number(params.get("timestamp"));

    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).json({ error: "Invalid shop domain." });
    }

    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now - timestamp) > 300
    ) {
      return res.status(401).json({ error: "Expired Shopify proxy request." });
    }

    const integration = await StoreIntegration.exists({
      platform: "shopify",
      storeDomain: shop,
      status: "active",
    });

    if (!integration) {
      return res.status(403).json({ error: "Shop is not connected." });
    }

    req.verifiedShop = shop;
    req.proxyCustomerId = (params.get("logged_in_customer_id") || "").trim();
    return next();
  } catch (error) {
    console.error("App Proxy authentication error:", error.message);
    return res.status(500).json({ error: "Unable to authenticate shop." });
  }
}

router.use(authenticateAppProxy);

// The widget asks here for the address of this backend when the store's theme setting "Chat backend URL" is empty,
// so a merchant does not have to paste it (the voice and upload connections go to this address directly).
function publicApiUrl() {
  try {
    const url = new URL(String(process.env.APP_URL || ""));
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

// The catalog for a standalone website: the cards a shopper browses (published, sellable), numeric ids
// so the page can keep its own cart. Cached by the catalog layer; nothing here is private store data.
const productsLimiter = createChatRateLimiter({ name: "public-products", limit: Number(process.env.LIGHT_RATE_LIMIT) || 20 });
const numericId = (gid) => String(gid || "").split("/").pop();
router.get("/products", productsLimiter, async (req, res) => {
  try {
    const { getCatalogSummary } = await import("../tools/shopify/catalog.js");
    const summary = await getCatalogSummary(req.verifiedShop);
    if (summary.error) return res.status(502).json({ error: "Catalog is not available right now." });
    const products = (summary.allProducts || summary.products || [])
      .filter((p) => p.published !== false && p.status === "ACTIVE")
      .map((p) => ({
        id: numericId(p.id),
        title: p.title,
        handle: p.handle,
        category: p.category || "",
        vendor: p.vendor || "",
        image: p.image || null,
        price: p.price,
        currency: p.currency || summary.currency,
        description: String(p.description || "").slice(0, 400),
        variants: (p.variants || []).map((v) => ({
          id: numericId(v.id),
          title: v.title,
          price: v.price,
          compareAtPrice: v.compareAtPrice || null,
          image: v.image || null,
          inStock: Boolean(v.sellable),
        })),
      }))
      .filter((p) => p.variants.length > 0);
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ store: summary.storeName || "", currency: summary.currency, categories: summary.categories || [], products });
  } catch (error) {
    console.error("public products failed:", error.message);
    return res.status(500).json({ error: "Catalog is not available right now." });
  }
});

router.get("/", (req, res) => {
  return res.json({
    success: true,
    shop: req.verifiedShop,
    apiUrl: publicApiUrl(),
    message: "Shopify App Proxy authentication successful.",
  });
});

// live help from a person (audio call, callback): is anyone free, ask, cancel, join, pick a time
router.use("/support", supportProxyRoutes);

router.post("/voice-token", voiceTokenLimiter, ...aiBudget, (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    // one token per voice call or per upload, used once, carrying who asked (as the proxy saw them)
    const purpose = req.body?.purpose === undefined ? "voice" : req.body.purpose;
    // a call token is only handed out by /support/token, bound to one call
    if (!TOKEN_PURPOSES.includes(purpose) || purpose === "support") return res.status(400).json({ error: "Unknown token purpose." });
    return res.json({ token: createVoiceToken(req.verifiedShop, { customerId: req.proxyCustomerId, purpose, visitor: visitorIdentity(req) }) });
  } catch (error) {
    console.error("Voice token error:", error.message);
    return res.status(500).json({ error: "Unable to start voice right now." });
  }
});

// The cart as the store prices it: the widget's own cart panel shows this instead of the storefront's market currency.
router.post("/cart-view", resetLimiter, async (req, res) => {
  try {
    const cart = normalizeCartSnapshot(req.body?.cart);
    if (!cart) return res.status(400).json({ error: "A cart is needed." });
    res.set("Cache-Control", "no-store");
    return res.json({ cart: await cartInStoreCurrency(req.verifiedShop, cart) });
  } catch (error) {
    console.warn("cart-view failed:", String(error?.message || error).slice(0, 160));
    return res.status(500).json({ error: "Unable to price the cart." });
  }
});

// The shopper cleared their chat (or it expired): forget the verified email so they must verify again.
router.post("/reset-chat", resetLimiter, async (req, res) => {
  try {
    const { clientId, cart, byShopper } = req.body ?? {};
    const verifiedCustomerId = verifiedCustomerGid(req.proxyCustomerId);
    const resolvedClientId = resolveClientId({ clientId, shop: req.verifiedShop, cartToken: cart?.token, customerId: verifiedCustomerId });
    await getOrderLookupAuth().clearVerification({ shop: req.verifiedShop, clientId: resolvedClientId });
    // The shopper cleared their screen: the store keeps its copy, marked as cleared, and the next message starts a new conversation.
    if (byShopper === true) await markChatCleared(req.verifiedShop, chatRefFor(req.verifiedShop, resolvedClientId)).catch(() => {});
    // a cleared chat also forgets what was discussed (no "welcome back" about it later)
    await forgetConversation(req.verifiedShop, resolvedClientId).catch(() => {});
    if (byShopper === true) {
      await abandonCheckoutInProgress(req.verifiedShop, resolvedClientId).catch(() => {});
      forgetCheckoutMemory(req.verifiedShop, resolvedClientId);
    }
    return res.json({ success: true });
  } catch (error) {
    console.warn("reset-chat failed:", error.message);
    return res.json({ success: false });
  }
});

// The team's replies since the window last asked, and whether a person has the chat.
router.post("/staff-messages", staffPollLimiter, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { clientId, cart, since } = req.body ?? {};
    const verifiedCustomerId = verifiedCustomerGid(req.proxyCustomerId);
    const resolvedClientId = resolveClientId({ clientId, shop: req.verifiedShop, cartToken: cart?.token, customerId: verifiedCustomerId });
    return res.json(await staffMessagesSince({ shop: req.verifiedShop, clientId: resolvedClientId, since: typeof since === "string" ? since : "" }));
  } catch (error) {
    console.warn("staff-messages failed:", error.message);
    return res.json({ handedOff: false, watch: false, messages: [] });
  }
});

// The chat's opening message, written by the AI for this store, customer and time of day.
router.post("/greeting", greetingLimiter, ...aiBudget, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { localHour, languageChoice, clientId } = req.body ?? {};
    let customerName = "";
    if (req.proxyCustomerId) {
      try {
        const verified = await resolveShopifyCustomer(req.verifiedShop, req.proxyCustomerId);
        customerName = verified?.customer?.firstName || verified?.customer?.name || "";
      } catch {
        /* greet without a name */
      }
    }
    const greeting = await generateGreeting(req.verifiedShop, {
      customerName,
      localHour: Number.isInteger(Number(localHour)) ? Number(localHour) : undefined,
      languageChoice: isLanguageCode(languageChoice) ? languageChoice : "",
    });
    // the opening line is a reply this chat was really sent
    if (greeting && typeof clientId === "string") {
      const who = { clientId: resolveClientId({ clientId, shop: req.verifiedShop, customerId: verifiedCustomerGid(req.proxyCustomerId) }) };
      void replyLedger().remember(req.verifiedShop, who, greeting).catch(() => {});
    }
    return res.json({ greeting });
  } catch (error) {
    console.warn("greeting failed:", error.message);
    return res.json({ greeting: "" });
  }
});

// Three short things the shopper might tap next, written by the AI from the last exchange.
router.post("/suggestions", suggestionLimiter, ...aiBudget, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const { lastUser, answer, recent, languageChoice } = req.body ?? {};
  try {
    const suggestions = await generateSuggestions(req.verifiedShop, {
      lastUser: text(lastUser, 300),
      answer: text(answer, 600),
      recent: (Array.isArray(recent) ? recent : []).map((item) => text(item, 40)).filter(Boolean).slice(0, 10),
      languageChoice: isLanguageCode(languageChoice) ? languageChoice : "",
    });
    return res.json({ suggestions });
  } catch (error) {
    console.warn("suggestions failed:", error.message);
    return res.json({ suggestions: [] });
  }
});

/** What the AI is told about the files the shopper attached (never shown to the shopper). */
export function buildAttachmentNote(files, description, { viewed } = {}) {
  const count = (kind) => files.filter((f) => f.kind === kind).length;
  const viewable = count("image") + count("pdf");
  const seen = Number.isInteger(viewed) ? viewed : viewable;
  const parts = [];
  if (viewable) {
    parts.push(
      description
        ? `The customer attached ${count("image")} photo(s) and ${count("pdf")} PDF(s). What they show: ${description}. Use this to help: for a product photo, search the store for similar products and show real ones; for a problem with an order or product, help or offer to pass it to the store team. Never claim to see more than described.`
        : "The customer attached photo(s) or a PDF that you cannot view right now. Say so honestly, ask them to describe it in words, and mention the store team can see the file."
    );
    if (description && seen < viewable) parts.push(`Only ${seen} of the ${viewable} were looked at; if the others matter, ask what they show. The store team can see all of them.`);
  }
  if (count("video")) parts.push(`The customer also attached ${count("video")} video(s). You cannot watch videos: say so, and tell them the store team can see it.`);
  return parts.length ? `[${parts.join(" ")}]` : "";
}

router.post("/chat", chatLimiter, ...aiBudget, async (req, res) => {
  const {
    message,
    history,
    cart,
    checkout,
    customer,
    clientId,
    languageChoice,
    lastActivityAt,
    attachments,
  } = req.body ?? {};

  const attachmentIds = Array.isArray(attachments) ? attachments.filter((id) => typeof id === "string").slice(0, MAX_FILES) : [];
  if (
    typeof message !== "string" ||
    (!message.trim() && !attachmentIds.length) ||
    message.length > 2000
  ) {
    return res.status(400).json({
      error: "Message must be a non-empty string of 2000 characters or fewer.",
    });
  }

  try {
    const verifiedCustomerId = verifiedCustomerGid(req.proxyCustomerId);
    const resolvedClientId = resolveClientId({ clientId, shop: req.verifiedShop, cartToken: cart?.token, customerId: verifiedCustomerId });
    let resolvedCustomer = guestCustomer(customer);
    let resolvedLoggedIn = Boolean(verifiedCustomerId);
    let shopifyLoginSource = verifiedCustomerId ? "shopify_session" : "none";
    if (verifiedCustomerId) resolvedCustomer = { ...resolvedCustomer, id: verifiedCustomerId };

    if (req.proxyCustomerId) {
      try {
        const verified = await resolveShopifyCustomer(
          req.verifiedShop,
          req.proxyCustomerId
        );
        if (verified.loggedIn) {
          resolvedLoggedIn = true;
          resolvedCustomer = verified.customer || resolvedCustomer;
          shopifyLoginSource = verified.source || "shopify_session";
        }
      } catch (err) {
        console.warn("Shopify customer verify fallback:", err.message);
      }
    }

    // Files the shopper attached: read back only if they belong to this shop and visitor, described once
    // for the agent, and recorded with the message so the store team can see them.
    const stored = attachmentIds.length ? await loadAttachments({ shop: req.verifiedShop, chatRef: chatRefFor(req.verifiedShop, resolvedClientId), ids: attachmentIds }) : [];
    // A person from the store has this chat: the AI stays silent, the team sees the message, and the window waits for their reply.
    const held = await holdForTeam({
      shop: req.verifiedShop,
      clientId: resolvedClientId,
      text: message.trim(),
      attachments: stored.map((f) => ({ id: String(f._id), name: f.name, kind: f.kind, mime: f.mime, size: f.size })),
      settings: await getAgentSettings(req.verifiedShop).catch(() => ({})),
    }).catch((error) => {
      console.warn("handoff check failed:", error.message);
      return false;
    });
    if (held) {
      return res.json({ clientId: resolvedClientId, chatRef: chatRefFor(req.verifiedShop, resolvedClientId), answer: "", handedOff: true, products: [], actions: [], cart: null, checkout: null });
    }
    // the AI looks at a few photos/PDFs (MAX_FILES_TO_AI), not every file, to keep each turn's cost bounded
    const { media, viewed } = await mediaForAI(stored);
    const description = media.length ? await describeAttachments(media, message.trim()) : "";
    const note = buildAttachmentNote(stored, description, { viewed });
    const spoken = message.trim() || "(the customer sent files without a message)";

    const result = await runAgent(
      note ? `${spoken}\n\n${note}` : spoken,
      req.verifiedShop,
      sanitizeHistory(history),
      "ecommerce",
      {
        cart: cart && typeof cart === "object" ? cart : null,
        checkout: checkout && typeof checkout === "object" ? checkout : null,
        customer: resolvedCustomer,
        verifiedCustomerId,
        clientId: resolvedClientId,
        customerLoggedIn: resolvedLoggedIn,
        shopifyLoginSource,
        ...resolveTurnLanguage({ message, languageChoice }),
        // backup only: the server's own record of the previous message wins
        clientLastActivityAt: Number.isFinite(Number(lastActivityAt)) ? Number(lastActivityAt) : null,
        loggedMessage: message.trim(),
        attachments: stored.map((f) => ({ id: String(f._id), name: f.name, kind: f.kind, mime: f.mime, size: f.size })),
      }
    );

    return res.json({
      clientId: resolvedClientId,
      // public reference of this chat (the widget puts it on the cart so orders can be attributed)
      chatRef: chatRefFor(req.verifiedShop, resolvedClientId),
      answer: result.answer,
      // no AI could answer: the widget says so in the shopper's own language
      ...(isFallbackAnswer(result.answer) ? { fallback: true } : {}),
      products: result.products || [],
      actions: result.actions || [],
      cart: result.cart || null,
      checkout: result.checkout || null,
      ...(result.languageChoice !== undefined ? { languageChoice: result.languageChoice } : {}),
      // where the time went, on a development server only (never in production)
      ...(result.timing && process.env.NODE_ENV !== "production" ? { timing: result.timing } : {}),
    });
  } catch (error) {
    console.error("Proxy chat error:", error.message);
    reportError(error, { scope: "chat", tags: { shop: req.verifiedShop } });
    return res.status(500).json({
      error: "Unable to answer right now. Please try again.",
    });
  }
});

export default router;