import { changedCart } from "../agent/factGuard.js";
import crypto from "node:crypto";
import { confirmsOrder as regexConfirmsOrder, paymentChoice as regexPaymentChoice, billingRelationshipIntent as regexBillingRelationshipIntent, wantsOrderPreview as regexWantsOrderPreview } from "../services/checkoutIntent.js";
import { normalizeCartSnapshot } from "../services/cartSnapshot.js";
import { resolveShoppingGender, detectRecipientIntent, wantsTravelRecommendations } from "../services/conversationProfile.js";
import { deduplicateAddress } from "../services/shippingAddressService.js";
import * as shopifyService from "../tools/shopifyService.js";
import { getOrderLookupAuth } from "../services/orderLookupAuth.js";
import { orderBelongsTo, parseOrderNumber } from "../services/shopifyOrderLookupService.js";
import { upsertCheckoutSession, getCheckoutSession } from "../services/checkoutSessionService.js";
import { sendOrderConfirmationEmail } from "../services/emailService.js";
import { listFreeSlots, createBooking } from "../services/bookingService.js";
import { quoteShopifyAdminOrder, listShopifyShippingRates } from "../services/shopifyOrderService.js";
import { admin, analytics } from "./ecommerce/analytics.js";
import { extractCustomerDetailsFromHistory, extractExcludedKeywordsFromMessage, resolveAddIntentFromContext } from "./ecommerce/historyHints.js";
import { extractAppliedDiscountFromHistory, readCheckoutMemory, withQuoteTimeout, writeCheckoutMemory } from "./ecommerce/pricing.js";
import { DEFAULT_AGENT_NAME, agentNameFor, buildComparisonChecklist, buildConversationalReply, buildShopOwnerComparisonReply, buildShopOwnerSelectionReply, comparisonToolPayload, formatPriceLabel, isOpinionOrPraiseQuestion, toCard } from "./ecommerce/replies.js";
import { CARD_MIN_CONFIDENCE, MAX_CARDS, compactProduct, createShopifyAdminOrder, defaultOrderLookup, extractRequestedCategories, getCachedCatalogSummary, getCatalogSummary, getPrepaidDiscountOffer, getProductDetails, getStoreShopifyDiscounts, searchShopifyProducts, searchShopifyProductsMany } from "./ecommerce/shared.js";
import { narrowVariantsByStorage } from "../tools/shopify/words.js";
import { buildSystemPrompt } from "./ecommerce/systemPrompt.js";
import { toolDefinitions } from "./ecommerce/toolDefinitions.js";
import { catalogHandlers } from "./ecommerce/handlers/catalog.js";
import { cartHandlers } from "./ecommerce/handlers/cart.js";
import { offersHandlers } from "./ecommerce/handlers/offers.js";
import { checkoutHandlers, REUSE_ADDRESS_WORDS } from "./ecommerce/handlers/checkout.js";
import { ordersHandlers } from "./ecommerce/handlers/orders.js";
import { complaintHandlers } from "./ecommerce/handlers/complaints.js";
import { billingHandlers } from "./ecommerce/handlers/billing.js";
if (!globalThis.crypto) globalThis.crypto = crypto;

const MAX_CART_ACTIONS = 4;

/**
 * Kept for compatibility. There is deliberately NO hardcoded word list here any more: greetings,
 * capability questions, "what do you sell" and items the store does not carry are all handled by
 * the model plus live Shopify data (search results / list_categories), never by canned regexes.
 */
export function classifyConversationalTurn() {
  return null;
}






function createSession(storeId, context = {}, dependencies = {}) {
  context = { ...context, cart: normalizeCartSnapshot(context.cart) };
  const submitOrder = dependencies.submitOrder || createShopifyAdminOrder;
  const quoteOrder = dependencies.quoteOrder || quoteShopifyAdminOrder;
  // Rates come from the same Shopify calculation as the quote. When a quote service is injected
  // (tests / alternative backends), its availableShippingRates are used.
  const loadShippingRates =
    dependencies.shippingRates ||
    (dependencies.quoteOrder
      ? async (shop, options) => (await dependencies.quoteOrder(shop, options))?.availableShippingRates || []
      : listShopifyShippingRates);
  const bookings = dependencies.bookings || { listFreeSlots, createBooking };
  const prepaidOffer = dependencies.prepaidOffer || getPrepaidDiscountOffer;
  const loadDiscounts = dependencies.loadDiscounts || getStoreShopifyDiscounts;
  const sendConfirmation =
    dependencies.sendConfirmation || sendOrderConfirmationEmail;
  const loadCheckout = dependencies.loadCheckout || getCheckoutSession;
  const saveCheckout = dependencies.saveCheckout || upsertCheckoutSession;
  // Order status / details lookup (email-OTP for guests). Injectable for tests.
  const orderAuth = dependencies.orderAuth || getOrderLookupAuth();
  const orderLookup = dependencies.orderLookup || defaultOrderLookup;
  const foundProducts = new Map();
  const actions = [];
  // searches that found nothing to sell this turn (shown to the owner as Catalog insights)
  const missedSearches = [];
  let fallbackSpeech = "";
  // undefined = unchanged this turn; "" = back to mirroring; "en" | "hi" | "hinglish" = chosen by the customer.
  let languageChoice;
  const lang = context.replyLanguage || "en";
  const isHindi = lang === "hi" || lang === "hinglish";
  const rawProfileForGender = {
    ...(context.checkout?.profile || {}),
    ...(context.profile || {}),
    customerName:
      context.customer?.name ||
      context.customer?.displayName ||
      context.checkout?.shipping?.name ||
      (context.profile || context.checkout?.profile || {})?.customerName ||
      "",
  };
  const defaultGender =
    resolveShoppingGender(
      context.userMessage,
      context.history,
      rawProfileForGender,
    ) ||
    context.inferredGender ||
    "";
  const storeCurrency =
    context.storeCurrency || context.cart?.currency || "USD";
  const userMessage = context.userMessage || "";
  const history = context.history || [];
  // llmMode: an AI model is driving this turn. Then the MODEL decides the customer's intent (which tool,
  // payment method, whether they confirmed) through tool arguments; keyword/regex intent parsing is used
  // only as the offline fallback when no AI provider is available.
  const llmMode = context.llmMode === true;
  const intentArgs = { current: {} };
  const normalizePaymentArg = (v) => {
    const m = String(v || "").toLowerCase();
    return m === "cod" || m === "prepaid" ? m : "";
  };
  const paymentChoice = (text = "") =>
    llmMode && text === userMessage ? normalizePaymentArg(intentArgs.current.paymentMethod) : regexPaymentChoice(text);
  const confirmsOrder = (text = "", step) =>
    llmMode && text === userMessage ? intentArgs.current.customerConfirmed === true : regexConfirmsOrder(text, step);
  // With the AI, the billing answer is normally its tool call. But when the previous reply WAS the billing question, a short clear answer
  // ("haan same hai", "yes same", "different") is read here too: a real run called set_shipping_address again for "haan same hai" and the
  // shopper got the same billing question back, in a loop (2026-11-21).
  const billingRelationshipIntent = (text = "", lastAssistant) =>
    llmMode ? ((lastAssistant && /\bbilling\b|बिलिंग/i.test(String(lastAssistant))) || /\bbilling\b|बिलिंग/i.test(String(text)) ? regexBillingRelationshipIntent(text, lastAssistant) : "") : regexBillingRelationshipIntent(text, lastAssistant);
  const wantsOrderPreview = (text = "", lastAssistant) =>
    llmMode ? false : regexWantsOrderPreview(text, lastAssistant);
  const travelRequest = !llmMode && wantsTravelRecommendations(
    userMessage,
    history,
    context.profile || context.checkout?.profile || {},
  );
  const autoExcluded = extractExcludedKeywordsFromMessage(userMessage);
  const addIntent = llmMode
    ? { isAddIntent: false, productName: "", variantName: "" }
    : resolveAddIntentFromContext(userMessage, history, storeId, context.clientId);
  const historyCustomer = extractCustomerDetailsFromHistory(
    history,
    userMessage,
  );
  const historyDiscount = extractAppliedDiscountFromHistory(
    history,
    userMessage,
  );
  const memSession = readCheckoutMemory(storeId, context.clientId) || {};
  const convTurn = classifyConversationalTurn(userMessage);

  const addedItemsThisTurn = [];
  const needsVariantItemsThisTurn = [];
  const isCartCurrentlyEmpty =
    Array.isArray(context.cart?.items) && context.cart.items.length === 0;
  const isVerifiedLoggedIn = Boolean(
    context.customerLoggedIn ||
    context.verifiedCustomerId ||
    (context.customer && context.customer.id) ||
    (memSession?.loggedIn && memSession?.loginMethod === "shopify_customer") ||
    (context.checkout?.loggedIn && context.checkout?.loginMethod === "shopify_customer")
  );
  const wasOrderAlreadyPlaced = Boolean(
    (memSession?.discountClearedAfterOrder || context.checkout?.discountClearedAfterOrder) && !historyDiscount,
  );
  const wasGuestResetAfterOrder = Boolean(
    !isVerifiedLoggedIn &&
    (memSession?.guestDetailsClearedAfterOrder || context.checkout?.guestDetailsClearedAfterOrder) &&
    !historyCustomer.street &&
    !historyCustomer.phone &&
    !historyCustomer.email
  );
  // "checkout karna hai, Cash on Delivery": a payment method stated plainly with the checkout request is kept (the AI's tool for that step
  // has no payment field, so it was lost and "COD ya online?" was asked again later, live 2026-11-23). The careful text check skips
  // questions and refusals ("COD available hai?", "COD nahi").
  const immediatePaymentChoice = paymentChoice(userMessage) || (llmMode && context.cart?.items?.length ? regexPaymentChoice(userMessage) : "");

  const localSession = {
    shippingSource:
      !context.checkout?.shipping?.address1 &&
      !memSession.shipping?.address1 &&
      context.customer?.defaultAddress
        ? "account"
        : null,
    ...memSession,
    ...(context.checkout || {}),
    ...(immediatePaymentChoice ? { selectedPaymentMethod: immediatePaymentChoice } : {}),
    appliedDiscount:
      isCartCurrentlyEmpty || wasOrderAlreadyPlaced
        ? null
        : memSession?.appliedDiscount || context.checkout?.appliedDiscount || historyDiscount || null,
    shippingMethod:
      isCartCurrentlyEmpty || wasOrderAlreadyPlaced
        ? "standard"
        : context.checkout?.shippingMethod || memSession?.shippingMethod || "standard",
    shippingCost:
      isCartCurrentlyEmpty || wasOrderAlreadyPlaced
        ? 0
        : context.checkout?.shippingCost ?? memSession?.shippingCost ?? 0,
    shipping: wasGuestResetAfterOrder
      ? null
      : context.checkout?.shipping ||
        memSession?.shipping ||
        (context.customer?.defaultAddress
          ? {
              name:
                context.customer.name ||
                context.customer.displayName ||
                context.customer.defaultAddress.name ||
                "",
              phone:
                context.customer.phone ||
                context.customer.defaultAddress.phone ||
                "",
              email: context.customer.email || "",
              address1: context.customer.defaultAddress.address1 || "",
              address2: context.customer.defaultAddress.address2 || "",
              city: context.customer.defaultAddress.city || "",
              province: context.customer.defaultAddress.province || "",
              zip: context.customer.defaultAddress.zip || "",
              country: context.customer.defaultAddress.country || "",
            }
          : null),
    billing: wasGuestResetAfterOrder
      ? null
      : context.checkout?.billing || memSession?.billing || null,
    billingSameAsShipping: wasGuestResetAfterOrder
      ? null
      : context.checkout?.billingSameAsShipping !== undefined
        ? context.checkout.billingSameAsShipping
        : memSession?.billingSameAsShipping !== undefined
          ? memSession.billingSameAsShipping
          : context.customer?.defaultAddress
            ? true
            : undefined,
    customer: wasGuestResetAfterOrder
      ? null
      : context.checkout?.customer ||
        memSession?.customer ||
        (context.customer
          ? {
              id: context.customer.id || null,
              name: context.customer.name || context.customer.displayName || null,
              email: context.customer.email || null,
              phone: context.customer.phone || null,
            }
          : null),
    step: wasGuestResetAfterOrder
      ? "cart"
      : context.checkout?.step ||
        memSession?.step ||
        (context.customer?.defaultAddress ? "review" : "cart"),
  };

  const customerFirstName =
    localSession.shipping?.name ||
    localSession.customer?.name ||
    historyCustomer.name ||
    "";

  const seenProductIds = new Set();
  const seenProductTitles = new Set();

  for (const h of history || []) {
    if (h.role === "assistant" && h.content) {
      const boldMatches = h.content.match(/\*\*([^*]+)\*\*/g);
      if (boldMatches) {
        for (const m of boldMatches) {
          const clean = m.replace(/\*\*/g, "").toLowerCase().trim();
          if (
            clean.length >= 3 &&
            !/^(?:price|size|color|option|orbi|cart|total|coupon|discount|subtotal|shipping|features|highlights|details|note)$/i.test(
              clean,
            )
          ) {
            seenProductTitles.add(clean);
          }
        }
      }
    }
  }

  const userTurns = (history || []).filter((h) => h.role === "user");
  const turnSeed = userTurns.length;

  if (convTurn) {
    const prebuilt = buildConversationalReply(
      convTurn,
      lang,
      customerFirstName,
          agentNameFor(context),
    );
    if (prebuilt) {
      fallbackSpeech = prebuilt;
    }
  }

  if (immediatePaymentChoice && context.cart?.items?.length && memSession?.selectedPaymentMethod !== immediatePaymentChoice) {
    queueMicrotask(() => safeUpsert({ selectedPaymentMethod: immediatePaymentChoice }).catch(() => {}));
  }

  async function safeUpsert(patch) {
    if (
      (patch.shipping ||
        patch.billing ||
        patch.shippingMethod ||
        patch.billingNeedsUpdate ||
        Object.hasOwn(patch, "billingSameAsShipping") ||
        Object.hasOwn(patch, "appliedDiscount")) &&
      !Object.hasOwn(patch, "orderQuote")
    )
      patch = { ...patch, orderQuote: null };
    if (patch.shipping || patch.billing)
      patch = { ...patch, addressUpdatedAt: new Date() };
    Object.assign(localSession, patch);
    writeCheckoutMemory(storeId, context.clientId, localSession);

    const snapshotWithMeta = {
      ...(context.cart || localSession.lastCartSnapshot || {}),
      _checkoutMeta: {
        appliedDiscount: localSession.appliedDiscount || null,
        discountClearedAfterOrder: Boolean(
          localSession.discountClearedAfterOrder,
        ),
        guestDetailsClearedAfterOrder: Boolean(
          localSession.guestDetailsClearedAfterOrder,
        ),
        discountAmount: localSession.discountAmount || 0,
        finalTotal: localSession.finalTotal ?? null,
        shippingMethod: localSession.shippingMethod || "standard",
        shippingCost: localSession.shippingCost ?? 0,
        selectedPaymentMethod: localSession.selectedPaymentMethod || null,
        shipping: localSession.shipping || null,
        billing: localSession.billing || null,
        billingSameAsShipping:
          localSession.billingSameAsShipping !== undefined
            ? localSession.billingSameAsShipping
            : null,
        customer: localSession.customer || null,
        updatedAt: Date.now(),
      },
    };
    localSession.lastCartSnapshot = snapshotWithMeta;

    try {
      await saveCheckout(storeId, context.clientId || "anon", {
        ...patch,
        lastCartSnapshot: snapshotWithMeta,
      });
    } catch {}
    return localSession;
  }

  // The store's own shipping rates for this cart + address, fetched from Shopify once per
  // cart/address combination. The cheapest rate is pre-selected; the shopper can switch.
  function shippingRatesKey(session) {
    const a = session?.shipping || {};
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({
        a: [a.address1, a.city, a.province, a.zip, a.countryCode || a.country].map((v) => String(v || "").toLowerCase()),
        i: (context.cart?.items || []).map((i) => [String(i.variant_id || i.id || ""), Number(i.quantity)]),
        c: context.cart?.currency || "",
      }))
      .digest("hex")
      .slice(0, 20);
  }

  async function ensureShippingRates(session) {
    if (!session?.shipping?.address1 || !context.cart?.items?.length) return session?.shippingRates || [];
    const key = shippingRatesKey(session);
    let rates = session.shippingRatesKey === key && Array.isArray(session.shippingRates) ? session.shippingRates : null;
    if (!rates) {
      try {
        rates = await withQuoteTimeout(loadShippingRates(storeId, {
          items: context.cart.items,
          shipping: deduplicateAddress(session.shipping),
          email: session.shipping.email || session.customer?.email || "",
          currency: context.cart?.currency || "",
          countryCode: context.cart?.country || "",
          shopCurrency: context.storeCurrency || "",
        }));
        if (!Array.isArray(rates)) rates = [];
      } catch (error) {
        console.warn("[shipping] could not load Shopify shipping rates:", String(error?.message || error).slice(0, 200));
        return session.shippingRates || [];
      }
    }
    const current = session.shippingRate?.handle
      ? rates.find((r) => r.handle === session.shippingRate.handle) || null
      : null;
    const chosen = current || rates[0] || null;
    if (session.shippingRatesKey !== key || (chosen?.handle || "") !== (session.shippingRate?.handle || "")) {
      session.shippingRates = rates;
      session.shippingRatesKey = key;
      session.shippingRate = chosen;
      await safeUpsert({
        shippingRates: rates,
        shippingRatesKey: key,
        shippingRate: chosen,
        shippingMethod: chosen ? chosen.title : "standard",
        shippingCost: chosen ? chosen.price : 0,
      });
    }
    return rates;
  }

  function findShippingRate(rates = [], wanted = "") {
    const w = String(wanted || "").trim().toLowerCase();
    if (!w) return null;
    return (
      rates.find((r) => r.handle.toLowerCase() === w || r.title.toLowerCase() === w) ||
      rates.find((r) => r.title.toLowerCase().includes(w) || w.includes(r.title.toLowerCase())) ||
      null
    );
  }

  // When the cart is empty because an order was JUST placed, never say "cart is empty".
  async function orderJustPlacedReply() {
    let prev = null;
    try { prev = (await safeGet())?.lastOrderResult; } catch { /* ignore */ }
    if (!prev?.orderName) return null;
    const total = formatPriceLabel(prev.total, prev.currency || storeCurrency);
    fallbackSpeech = isHindi
      ? `Tumhara order **${prev.orderName}** (Total: **${total}**) pehle hi place ho chuka hai. Kuch aur dekhna chahoge?`
      : `Your order **${prev.orderName}** (Total: **${total}**) has already been placed. Would you like to look at anything else?`;
    return { status: "order_already_placed", orderId: prev.orderName, total: prev.total, currency: prev.currency };
  }

  async function safeGet() {
    const fromMem = readCheckoutMemory(storeId, context.clientId);
    if (fromMem) {
      Object.assign(localSession, fromMem);
    }
    const clearedFlag = Boolean(
      localSession.discountClearedAfterOrder ||
      fromMem?.discountClearedAfterOrder,
    );
    try {
      const doc = await loadCheckout(storeId, context.clientId || "anon");
      if (doc) {
        const meta = doc.lastCartSnapshot?._checkoutMeta || {};
        Object.assign(localSession, {
          ...doc,
          discountClearedAfterOrder:
            clearedFlag || Boolean(meta.discountClearedAfterOrder),
          guestDetailsClearedAfterOrder: Boolean(
            localSession.guestDetailsClearedAfterOrder ||
              doc.guestDetailsClearedAfterOrder ||
              meta.guestDetailsClearedAfterOrder,
          ),
          appliedDiscount:
            clearedFlag ||
            meta.discountClearedAfterOrder ||
            isCartCurrentlyEmpty
              ? null
              : localSession.appliedDiscount ||
                meta.appliedDiscount ||
                historyDiscount ||
                null,
          shippingMethod:
            clearedFlag || meta.discountClearedAfterOrder || isCartCurrentlyEmpty
              ? localSession.shippingMethod || "standard"
              : doc.shippingMethod || meta.shippingMethod || localSession.shippingMethod || "standard",
          shippingCost:
            clearedFlag || meta.discountClearedAfterOrder || isCartCurrentlyEmpty
              ? localSession.shippingCost ?? 0
              : doc.shippingCost ?? meta.shippingCost ?? localSession.shippingCost ?? 0,
          shipping:
            !isVerifiedLoggedIn &&
            (localSession.guestDetailsClearedAfterOrder || meta.guestDetailsClearedAfterOrder)
              ? null
              : deduplicateAddress(
                  doc.shipping || meta.shipping || localSession.shipping || {},
                ),
          billing:
            !isVerifiedLoggedIn &&
            (localSession.guestDetailsClearedAfterOrder || meta.guestDetailsClearedAfterOrder)
              ? null
              : doc.billing || meta.billing || localSession.billing || null,
          billingSameAsShipping:
            !isVerifiedLoggedIn &&
            (localSession.guestDetailsClearedAfterOrder || meta.guestDetailsClearedAfterOrder)
              ? null
              : doc.billingSameAsShipping !== undefined
                ? doc.billingSameAsShipping
                : meta.billingSameAsShipping !== undefined
                  ? meta.billingSameAsShipping
                  : localSession.billingSameAsShipping !== undefined
                    ? localSession.billingSameAsShipping
                    : null,
          customer:
            !isVerifiedLoggedIn &&
            (localSession.guestDetailsClearedAfterOrder || meta.guestDetailsClearedAfterOrder)
              ? null
              : localSession.customer || meta.customer || doc.customer || null,
        });
      }
    } catch {}
    if (
      !localSession.appliedDiscount &&
      historyDiscount &&
      !localSession.discountClearedAfterOrder &&
      !isCartCurrentlyEmpty
    ) {
      localSession.appliedDiscount = historyDiscount;
    }
    return localSession;
  }

  let suppressCardsThisTurn = false;
  // The shopper asked for a person this turn: whatever was found for earlier topics must not be shown as if it were the answer.
  let personRequested = false;

  // The products the shopper was really SHOWN (the cards of the final reply, in the order they appeared), first-shown order, kept apart from
  // the recency list above which forgets the earliest after 10. Compact (title, price, category) so a long chat stays cheap in tokens.
  function recordShown(cards) {
    const list = (Array.isArray(cards) ? cards : []).filter((p) => p && p.title);
    if (!list.length) return;
    const ledger = Array.isArray(readCheckoutMemory(storeId, context.clientId)?.shownLedger) ? [...readCheckoutMemory(storeId, context.clientId).shownLedger] : [];
    const seen = new Set(ledger.map((e) => String(e.title).toLowerCase().trim()));
    for (const p of list) {
      const k = String(p.title).toLowerCase().trim();
      if (seen.has(k)) continue;
      seen.add(k);
      ledger.push({ title: p.title, price: p.price, currency: p.currency, category: p.category });
    }
    writeCheckoutMemory(storeId, context.clientId, { shownLedger: ledger.slice(0, 30) });
  }

  function rememberForCards(products) {
    for (const product of products) {
      if ((product.matchConfidence ?? 1) >= CARD_MIN_CONFIDENCE) {
        foundProducts.set(product.id || product.title, product);
        if (product.id) seenProductIds.add(String(product.id));
        if (product.title)
          seenProductTitles.add(product.title.toLowerCase().trim());
      }
    }
    if (foundProducts.size > 0) {
      const prevShown =
        readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
      const mergedMap = new Map();
      for (const p of [...foundProducts.values(), ...prevShown]) {
        if (p && p.title) {
          const k = String(p.title).toLowerCase().trim();
          if (!mergedMap.has(k)) {
            mergedMap.set(k, {
              id: p.id,
              title: p.title,
              handle: p.handle,
              category: p.category,
              price: p.price,
              currency: p.currency,
              description: p.description,
              features: p.features,
              stylistNote: p.stylistNote,
              image: p.image || p.variants?.find((v) => v.image)?.image || null,
              imageAlt: p.imageAlt || p.title,
              url: p.url,
              variants: p.variants,
            });
          }
        }
      }
      writeCheckoutMemory(storeId, context.clientId, {
        // 30, not 10: a chat looks at several kinds of product, and the phones shown four searches ago must still come back as cards
        // (and be fact-checked) when the shopper asks about them again (real storefront, 2026-11-21)
        lastShownProducts: [...mergedMap.values()].slice(0, 30),
      });
    }
  }

  async function resolveConversationProducts() {
    const memList =
      readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
    const byTitle = new Map();
    for (const p of memList) {
      if (p && p.title) {
        byTitle.set(String(p.title).toLowerCase().trim(), p);
      }
    }

    const historyTitles = [];
    for (let i = (history || []).length - 1; i >= 0; i--) {
      const h = history[i];
      if (h?.role !== "assistant" || !h.content) continue;
      const bolds = [...String(h.content).matchAll(/\*\*([^*]+)\*\*/g)].map(
        (m) => m[1].trim(),
      );
      const bullets = [
        ...String(h.content).matchAll(
          /^(?:[-•]|\d+[.)])\s+([^($\n]+?)\s*\((?:[$₹]|Rs\.?\s*)?\d+/gm,
        ),
      ].map((m) => m[1].replace(/\*\*/g, "").trim());
      for (const cand of [...bullets, ...bolds]) {
        const clean = cand.replace(/\([^)]*\)\s*$/, "").trim();
        if (
          clean.length >= 4 &&
          !/^(?:size\s+\w+|xs|s|m|l|xl|xxl|total|subtotal|discount|shipping|delivery|billing|order|chat\d+|orbi|coverage|return|claim)$/i.test(
            clean,
          ) &&
          !historyTitles.some((t) => t.toLowerCase() === clean.toLowerCase())
        ) {
          historyTitles.push(clean);
        }
      }
    }

    const catalogSummary = getCachedCatalogSummary?.(storeId);
    const catalogProducts = Array.isArray(catalogSummary?.products)
      ? catalogSummary.products
      : [];

    for (const title of historyTitles) {
      const key = title.toLowerCase();
      const existing = byTitle.get(key);
      if (
        existing &&
        existing.description &&
        Array.isArray(existing.variants) &&
        existing.image
      )
        continue;

      let found = catalogProducts.find(
        (p) => String(p.title || "").toLowerCase() === key,
      );
      if (!found) {
        try {
          const searched = await searchShopifyProducts(storeId, title);
          found =
            searched.find((p) => String(p.title || "").toLowerCase() === key) ||
            searched[0];
        } catch {}
      }
      if (found) {
        byTitle.set(key, {
          ...existing,
          ...found,
          image: found.image || existing?.image || null,
        });
      }
    }

    const enriched = [];
    for (const p of byTitle.values()) {
      if (p.description && Array.isArray(p.variants) && p.image) {
        enriched.push(p);
      } else {
        const fromCat = catalogProducts.find(
          (cp) =>
            String(cp.title || "").toLowerCase() ===
            String(p.title || "").toLowerCase(),
        );
        if (fromCat) {
          enriched.push({
            ...p,
            ...fromCat,
            image: fromCat.image || p.image || null,
          });
        } else {
          try {
            const searched = await searchShopifyProducts(storeId, p.title);
            enriched.push(searched[0] || p);
          } catch {
            enriched.push(p);
          }
        }
      }
    }
    return enriched;
  }

  function matchProductsFromConversation(msg = "", convProducts = []) {
    if (!msg || !Array.isArray(convProducts) || convProducts.length === 0)
      return [];
    const lowerMsg = String(msg)
      .toLowerCase()
      .replace(/['’]s\b/g, "s")
      .replace(/\ba[\s-]*line\b/g, "aline");
    const msgNormalized = lowerMsg.replace(/[^a-z0-9]+/g, " ");
    const msgTokens = msgNormalized.split(/\s+/).filter(Boolean);

    const COMMON_TITLE_NOISE = new Set([
      "womens",
      "women",
      "mens",
      "men",
      "kids",
      "the",
      "and",
      "with",
      "for",
      "new",
      "classic",
    ]);

    const prodTokenLists = convProducts.map((p) => {
      const tNorm = String(p.title || "")
        .toLowerCase()
        .replace(/['’]s\b/g, "s")
        .replace(/\ba[\s-]*line\b/g, "aline")
        .replace(/[^a-z0-9]+/g, " ");
      return tNorm
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !COMMON_TITLE_NOISE.has(w));
    });

    const docFreq = new Map();
    for (const list of prodTokenLists) {
      for (const w of new Set(list)) {
        docFreq.set(w, (docFreq.get(w) || 0) + 1);
      }
    }

    const matched = [];
    for (let idx = 0; idx < convProducts.length; idx++) {
      const prod = convProducts[idx];
      const tokens = prodTokenLists[idx];
      const distinctive = tokens.filter(
        (w) =>
          convProducts.length === 1 ||
          (docFreq.get(w) || 0) < convProducts.length,
      );
      const checkTokens = distinctive.length > 0 ? distinctive : tokens;

      let hits = 0;
      let firstPos = Infinity;
      for (const tok of checkTokens) {
        const pos = msgTokens.findIndex(
          (m) =>
            m === tok ||
            (tok.length >= 4 &&
              m.length >= 4 &&
              (m.startsWith(tok) || tok.startsWith(m))),
        );
        if (pos !== -1) {
          hits++;
          const charPos = msgNormalized.indexOf(msgTokens[pos]);
          if (charPos !== -1 && charPos < firstPos) firstPos = charPos;
        }
      }
      if (hits > 0) {
        matched.push({ product: prod, hits, firstPos });
      }
    }

    return matched
      .sort((a, b) => a.firstPos - b.firstPos || b.hits - a.hits)
      .map((m) => m.product);
  }

  function isComparisonQuestion(msg = "", convProducts = []) {
    const lower = String(msg || "")
      .toLowerCase()
      .trim();
    if (!lower) return false;
    if (
      /\b(shipping|express|standard|cod|cash\s+on\s+delivery|prepaid|online\s+payment|billing|address|english|hindi)\b/i.test(
        lower,
      )
    ) {
      return false;
    }
    const matched = matchProductsFromConversation(lower, convProducts);
    if (matched.length >= 2) return true;

    const hasCompCue =
      /\b(compare|comparison|vs\.?|versus|difference\s+between|farak|which\s+one\s+is\s+(?:better|best|good|more\s+comfortable)|kaunsa\s+(?:sahi|shi|acha|accha|best|lena|leni)|konsa\s+(?:sahi|shi|acha|accha|best|lena|leni)|inmein\s+se\s+(?:kaunsa|konsa)|inme\s+se\s+(?:kaunsa|konsa)|dono\s+mein\s+se)\b/i.test(
        lower,
      ) ||
      (/\b(ya|or)\b/i.test(lower) &&
        /\b(sahi|shi|rahega|rhega|rahegi|rhegi|better|best|good|acha|accha|comfortable|suit)\b/i.test(
          lower,
        ));

    return hasCompCue && (convProducts.length >= 2 || matched.length >= 1);
  }

  function isProductSelectionOrFollowUp(msg = "", convProducts = []) {
    const lower = String(msg || "")
      .toLowerCase()
      .trim();
    if (!lower || convProducts.length === 0) return false;
    if (addIntent.isAddIntent || autoExcluded.length > 0) return false;
    if (
      /\b(show\s+me\s+more|more\s+options|other\s+options|something\s+else|anything\s+else|kuch\s+aur|aur\s+dikhao|alag\s+dikhao|dusra\s+dikhao|do\s+you\s+have|looking\s+for|searing\s+for|searching\s+for)\b/i.test(
        lower,
      )
    ) {
      return false;
    }
    const matched = matchProductsFromConversation(lower, convProducts);
    if (matched.length !== 1) return false;
    // The message names ANOTHER product ("how much is the Savannah Maxi Dress?" while the Twilight Plum Ribbon Dress was shown): sharing the word
    // "dress" is not a selection. Capitalised words that no shown product has, or two or more unfamiliar content words, mean a different product.
    const known = new Set(convProducts.flatMap((p) => String(p.title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
    const FILLER = new Set(["how", "much", "what", "which", "price", "cost", "does", "this", "that", "with", "have", "show", "tell", "about", "think", "like", "good", "best", "will", "would", "your", "there", "size", "color", "colour", "stock", "available", "please", "want", "need", "also", "more", "just", "some", "from", "into", "they", "them", "than", "then", "when", "where"]);
    const originalWords = String(msg || "").split(/[^A-Za-z0-9']+/).filter(Boolean);
    const unfamiliar = originalWords.filter((w, i) => i > 0 && w.length >= 4 && !known.has(w.toLowerCase().replace(/'s$/, "")) && !FILLER.has(w.toLowerCase()));
    if (unfamiliar.some((w) => /^[A-Z]/.test(w)) || unfamiliar.length >= 2) return false;

    const hasSelectionOrFollowUpCue =
      /\b(i\s+think|i\s+feel|i\s+like|i\s+prefer|will\s+be\s+good|would\s+be\s+good|is\s+good|looks\s+good|sounds\s+good|sahi\s+rahega|shi\s+rhega|sahi\s+rahegi|shi\s+rhegi|sahi\s+hai|shi\s+h|acha\s+hai|accha\s+hai|pasand|final|le\s+lete|leni\s+hai|lena\s+hai|go\s+with|choose|pick|tell\s+me|about|baare|fabric|material|stretch|stretchable|comfortable|size|sizes|stock|kaisa|kaisi|ksa|ksi)\b/i.test(
        lower,
      );
    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    return hasSelectionOrFollowUpCue || wordCount <= 7;
  }

  function isImageRequest(msg = "") {
    const v = String(msg || "").toLowerCase();
    return (
      /\b(images?|imgs?|photos?|photu|pics?|pictures?|tasveer|tasvir|foto|snaps?)\b/.test(
        v,
      ) ||
      /\b(?:dikha|dikhao|dikhaiye|dikhana|dekhna|dekhni|show)\b[^.?!]{0,20}\b(?:iska|iski|isko|uska|uski|usko|this|that|it)\b/.test(
        v,
      )
    );
  }

  async function buildCardProductByName(name = "") {
    const clean = String(name || "").trim();
    if (!clean) return null;
    try {
      const result = await getProductDetails(storeId, clean);
      const p = result?.product;
      if (!p) return null;
      return {
        id: p.id || p.title,
        handle: p.handle,
        title: p.title,
        category: p.category,
        price: p.price,
        currency: p.currency,
        description: p.description,
        features: p.features,
        image: p.image,
        imageAlt: p.imageAlt || p.title,
        url: p.url,
        variants: Array.isArray(p.variants) ? p.variants : [],
        matchConfidence: result.matchConfidence ?? 0.85,
      };
    } catch {
      return null;
    }
  }

  async function attachCardForName(name = "") {
    if (foundProducts.size > 0) return;
    const card = await buildCardProductByName(name);
    if (!card) return;
    suppressCardsThisTurn = false;
    rememberForCards([card]);
  }

  async function handleImageRequest(explicitNames = []) {
    if (!isImageRequest(userMessage)) return null;
    if (addIntent.isAddIntent) return null;
    const convProducts = await resolveConversationProducts();
    if (convProducts.length === 0) return null;

    const lower = String(userMessage).toLowerCase();
    let targets = matchProductsFromConversation(userMessage, convProducts);
    if (targets.length === 0) {
      if (/\b(all|sab|saare|saari|sabhi|dono|both|every)\b/.test(lower)) {
        targets = convProducts.slice(0, 4);
      } else if (
        /\b(second|2nd|dusra|dusri|doosra|doosri)\b/.test(lower) &&
        convProducts[1]
      ) {
        targets = [convProducts[1]];
      } else if (
        /\b(third|3rd|teesra|teesri|tisra)\b/.test(lower) &&
        convProducts[2]
      ) {
        targets = [convProducts[2]];
      } else {
        targets = [convProducts[0]];
      }
    }
    targets = targets.slice(0, 4);

    const ready = [];
    for (const t of targets) {
      const hasImage = t.image || (t.variants || []).some((v) => v.image);
      if (hasImage) {
        ready.push(t);
        continue;
      }
      const fresh = await buildCardProductByName(t.title);
      ready.push(fresh ? { ...t, ...fresh } : t);
    }

    suppressCardsThisTurn = false;
    foundProducts.clear();
    rememberForCards(ready.map((r) => ({ ...r, matchConfidence: 1 })));
    const others = convProducts.filter(
      (p) => !ready.some((r) => r.title === p.title),
    );
    writeCheckoutMemory(storeId, context.clientId, {
      lastShownProducts: [...ready, ...others].slice(0, 30),
    });

    const titles = ready.map((r) => r.title).join(", ");
    fallbackSpeech = isHindi
      ? `Ye rahi **${titles}** ki image/photo dost! Neeche card me dekh lo. Kaisi lagi? Size ya colour batao toh main stock check kar doon.`
      : `Here you go, **${titles}**! You can see the photo on the card below. Want me to check sizes or colours for you?`;
    return {
      status: "ok",
      mode: "image_request",
      products: ready.map((r) => compactProduct(r, { brief: false })),
      note: "Customer asked to SEE the product. Its Product Card with the image is already displayed below your reply. Say so in one or two warm lines. Never say you cannot show images or ask them to visit the website.",
    };
  }

  async function handleConversationalFollowUp(explicitNames = []) {
    // With an AI model the model picks compare/details/image tools itself.
    if (llmMode) return null;
    const imageReply = await handleImageRequest(explicitNames);
    if (imageReply) return imageReply;
    const convProducts = await resolveConversationProducts();

    if (
      isComparisonQuestion(userMessage, convProducts) ||
      explicitNames.length >= 2
    ) {
      let compared = matchProductsFromConversation(userMessage, convProducts);
      if (compared.length < 2 && explicitNames.length >= 2) {
        const groups = await searchShopifyProductsMany(storeId, explicitNames, {
          defaultGender,
        });
        const fetched = groups.map((g) => g.products?.[0]).filter(Boolean);
        for (const f of fetched) {
          if (!compared.some((c) => c.title === f.title)) compared.push(f);
        }
      }

      if (compared.length === 1 && convProducts.length >= 2) {
        const second = convProducts.find((p) => p.title !== compared[0].title);
        if (second) compared.push(second);
      }
      if (compared.length === 0 && convProducts.length >= 2) {
        compared = convProducts.slice(0, 2);
      }

      if (compared.length >= 2) {
        const pair = compared.slice(0, Math.min(4, compared.length));
        suppressCardsThisTurn = false;
        foundProducts.clear();
        const withChecklist = buildComparisonChecklist(pair, 5);
        rememberForCards(withChecklist);
        fallbackSpeech = buildShopOwnerComparisonReply(withChecklist, {
          lang,
          userMessage,
          history,
        });
        return {
          status: "ok",
          mode: "conversational_comparison",
          comparedProducts: withChecklist.map((p) => p.title),
          ...comparisonToolPayload(withChecklist),
        };
      }
    }

    if (isProductSelectionOrFollowUp(userMessage, convProducts)) {
      const matched = matchProductsFromConversation(userMessage, convProducts);
      const chosen = matched[0];
      if (chosen) {
        const alreadyShownInHistory = history.length > 0;
        suppressCardsThisTurn = false;
        foundProducts.clear();
        rememberForCards([chosen]);
        const others = convProducts.filter((p) => p.title !== chosen.title);
        writeCheckoutMemory(storeId, context.clientId, {
          lastShownProducts: [chosen, ...others].slice(0, 30),
        });

        fallbackSpeech = buildShopOwnerSelectionReply(chosen, {
          lang,
          userMessage,
          history,
          alreadyShown: alreadyShownInHistory,
        });
        return {
          status: "ok",
          mode: "conversational_selection",
          product: compactProduct(chosen, { brief: false }),
          note: "Customer asked about the product(s) above. Answer their actual question from these facts only (options are sizes/colours with stock).",
        };
      }
    }

    return null;
  }

  function normalizeGenderArg(val = "") {
    const v = String(val || "")
      .toLowerCase()
      .trim();
    if (/^(?:men|mens|man|male|gents|gent|ladka|ladke)$/.test(v))
      return "men";
    if (/^(?:women|womens|woman|female|ladies|lady|ladki)$/.test(v))
      return "women";
    if (/^(?:kids?|children|child|baby|boys?|girls?)$/.test(v)) return "kids";
    return "";
  }

  function hasAskedShoppingClarification() {
    return (history || [])
      .slice(-4)
      .some(
        (h) =>
          h?.role === "assistant" &&
          /\b(apne\s+liye|kisi\s+aur\s+ke\s+liye|someone\s+else|yourself|gents.*ladies|men'?s.*women'?s|kis\s+tarah\s+ka)\b/i.test(
            String(h.content || ""),
          ),
      );
  }

  function isGenderComplaintTurn(msg = "") {
    const v = String(msg || "").toLowerCase();
    return (
      (/\b(why|kyu|kyun|kyon|kse|kaise)\b/.test(v) &&
        /\b(ladka|ladki|women|womens|men|mens|ladies|gents|girl|boy)\b/.test(
          v,
        ) &&
        /\b(pta|pata|know|show|dikha|dikhai|recommend)\b/.test(v)) ||
      /\b(kse\s+pta|kaise\s+pata)\s+ki\s+(?:main\s+)?(?:ladka|ladki)\b/i.test(v)
    );
  }

  function hasKnownCustomerName() {
    const profileObj = {
      ...(context.checkout?.profile || {}),
      ...(context.profile || {}),
    };
    return Boolean(
      (
        customerFirstName ||
        context.customer?.name ||
        context.customer?.displayName ||
        profileObj.customerName ||
        ""
      ).trim(),
    );
  }

  function resolveVerifiedSelfGender(args = {}) {
    if (defaultGender) return defaultGender;
    const aiDecidedGender = normalizeGenderArg(args.gender);
    if (hasKnownCustomerName() && aiDecidedGender) {
      return aiDecidedGender;
    }
    return "";
  }

  function storeHasApparel() {
    // Data-driven: only a store whose own products carry men/women/kids wording is treated as gendered.
    return Boolean(shopifyService.isStoreGendered?.(storeId));
  }

  function evaluateShoppingDiscoveryNeed(args = {}) {
    // With an AI model, asking who it is for / Gents vs Ladies is the model's call (see prompt).
    if (llmMode) return null;
    if (!storeHasApparel()) return null;
    const lower = String(userMessage || "")
      .toLowerCase()
      .trim();
    if (!lower) return null;
    if (travelRequest || addIntent.isAddIntent || autoExcluded.length > 0)
      return null;
    if (
      /\b(pregnant|pregnancy|maternity|motherhood|expecting|baby\s+bump|garbhwati)\b/i.test(
        `${userMessage} ${(history || []).map((h) => h?.content || "").join(" ")}`,
      )
    ) {
      return null;
    }

    if (isGenderComplaintTurn(lower) && !defaultGender) {
      suppressCardsThisTurn = true;
      foundProducts.clear();
      fallbackSpeech = "";
      return {
        status: "needs_clarification",
        clarifyStage: "gender_complaint_recovery",
        products: [],
        instruction_for_ai:
          "Apologize for assuming gender without asking. Do NOT show products. Ask if they are shopping for themselves or someone else, and Gents (Men's) vs Ladies (Women's). Reply in the customer's language.",
        instruction:
          "The customer pointed out you showed the wrong gendered collection. Apologize warmly, do NOT show products, ask recipient (self vs someone else) and Gents vs Ladies.",
      };
    }

    const explicitCats = extractRequestedCategories(userMessage, storeId);
    const profileObj = {
      ...(context.checkout?.profile || {}),
      ...(context.profile || {}),
    };
    const msgRecipient = detectRecipientIntent(userMessage);
    let effectiveRecipient = msgRecipient || profileObj.recipient || "";
    if (!effectiveRecipient) {
      for (const h of [...(history || [])].reverse()) {
        if (h?.role === "user" && h.content) {
          const r = detectRecipientIntent(h.content);
          if (r) {
            effectiveRecipient = r;
            break;
          }
        }
      }
    }

    const verifiedSelfGender = resolveVerifiedSelfGender(args);
    const effectiveGender =
      defaultGender ||
      (effectiveRecipient === "self" ? verifiedSelfGender : "") ||
      "";

    if (explicitCats.length > 0) {
      // data-driven: a category counts only when this store's own products in it are labelled men/women/kids
      const allGenderSensitive = explicitCats.every((c) =>
        Boolean(shopifyService.isCategoryGendered?.(storeId, c)),
      );
      const hasSpecificProductWords =
        /\b(oxford|linen|flannel|polo|denim|leather|aviator|chronograph|rose\s+gold|savannah|teal|maroon|navy|black|white|blue|red|green|yellow|beige|size|under|below|\d+)\b/i.test(
          lower,
        );
      if (
        allGenderSensitive &&
        !effectiveGender &&
        !hasSpecificProductWords &&
        !hasAskedShoppingClarification()
      ) {
        if (!effectiveRecipient) {
          suppressCardsThisTurn = true;
          foundProducts.clear();
          fallbackSpeech = "";
          return {
            status: "needs_clarification",
            clarifyStage: "recipient_and_gender",
            requestedCategories: explicitCats,
            products: [],
            instruction_for_ai:
              "They asked for a gendered apparel category without saying who it is for. Do NOT show products. Ask self vs someone else and Gents vs Ladies, in their language.",
            instruction:
              "Gender-sensitive category without recipient/gender. Do NOT guess. Ask apne liye vs kisi aur, and Gents vs Ladies. No product list yet.",
          };
        }
        if (effectiveRecipient === "gift") {
          suppressCardsThisTurn = true;
          foundProducts.clear();
          fallbackSpeech = "";
          return {
            status: "needs_clarification",
            clarifyStage: "gender",
            recipient: "someone_else",
            requestedCategories: explicitCats,
            products: [],
            instruction_for_ai:
              "Shopping for someone else — ask Gents vs Ladies only. Do NOT show products. Reply in their language.",
            instruction:
              "Need Gents vs Ladies for a gift. Do NOT show products; ask warmly.",
          };
        }
        if (effectiveRecipient === "self" && !verifiedSelfGender) {
          suppressCardsThisTurn = true;
          foundProducts.clear();
          fallbackSpeech = "";
          return {
            status: "needs_clarification",
            clarifyStage: "gender",
            recipient: "self",
            requestedCategories: explicitCats,
            products: [],
            instruction_for_ai:
              "Shopping for themselves — gender unknown. Ask Gents vs Ladies only. Do NOT show products. Reply in their language.",
            instruction:
              "Self shopping but Gents/Ladies unknown. Do NOT guess. Ask Gents or Ladies.",
          };
        }
      }
      return null;
    }

    if (
      !effectiveRecipient &&
      !effectiveGender &&
      !hasAskedShoppingClarification()
    ) {
      suppressCardsThisTurn = true;
      foundProducts.clear();
      fallbackSpeech = "";
      return {
        status: "needs_clarification",
        clarifyStage: "recipient",
        products: [],
        instruction_for_ai:
          "Do NOT show products. Ask if shopping for themselves or someone else, and what kind of item they are looking for. Reply in their language.",
        instruction:
          "Recipient and category unknown. Do NOT list products. Ask apne liye vs kisi aur ke liye and what kind of item they want.",
      };
    }

    if (effectiveRecipient === "gift" && !defaultGender) {
      suppressCardsThisTurn = true;
      foundProducts.clear();
      fallbackSpeech = "";
      return {
        status: "needs_clarification",
        clarifyStage: "gender",
        recipient: "someone_else",
        products: [],
        instruction_for_ai:
          "They are shopping for someone else. Do NOT show products. Ask Gents/Ladies/Kids and what kind of item they are looking for. Reply in their language.",
        instruction:
          "The customer is shopping for someone else but has not said Gents/Ladies/Kids. Do NOT show products. Ask warmly.",
      };
    }

    if (effectiveRecipient === "self" && !effectiveGender) {
      suppressCardsThisTurn = true;
      foundProducts.clear();
      fallbackSpeech = "";
      return {
        status: "needs_clarification",
        clarifyStage: "gender",
        recipient: "self",
        products: [],
        instruction_for_ai:
          "Warmly ask whether they want Gents (Men's) or Ladies (Women's) collection, and what kind of item they'd like to see.",
        instruction:
          "The customer is shopping for themselves, but Gents vs Ladies and category are not known yet. Warmly ask without dumping a category list.",
      };
    }

    return null;
  }

  function rebuildMultiAddFallbackSpeech() {
    if (
      addedItemsThisTurn.length === 0 &&
      needsVariantItemsThisTurn.length === 0
    )
      return;

    if (addedItemsThisTurn.length > 0 && needsVariantItemsThisTurn.length > 0) {
      const addedList = addedItemsThisTurn
        .map((i) => `**${i.label}** (${i.priceStr})`)
        .join(", ");
      const needLines = needsVariantItemsThisTurn
        .map(
          (n) =>
            `• **${n.title}**${n.priceStr ? ` (${n.priceStr})` : ""}: available in ${n.label}s **${n.optListStr}**`,
        )
        .join("\n");

      fallbackSpeech = isHindi
        ? `Are wah, sab kuch pasand aa gaya! Maine ${addedList} toh abhi aapke cart mein add kar diya hai!\n\nBas in कपड़ों (apparels) ke liye mujhe size bata do taaki main inhe bhi turant add kar doon:\n${needLines}\nBatao dost, inke liye kaunsa size add karoon?`
        : `I love that you're getting the full set! I've already added ${addedList} to your cart!\n\nJust let me know which size you'd like for these so I can add them right away too:\n${needLines}\nWhich size should I pick for you?`;
      return;
    }

    if (addedItemsThisTurn.length > 1) {
      const addedList = addedItemsThisTurn
        .map((i) => `**${i.label}** (${i.priceStr})`)
        .join(", ");
      fallbackSpeech = isHindi
        ? `Done dost! Maine ${addedList} aapke cart mein add kar diye hain! Batao, ab checkout ki taraf chalein ya kuch aur bhi dekhna hai?`
        : `All done! I've added ${addedList} to your cart! Would you like to head to checkout now or keep exploring?`;
      return;
    }

    if (needsVariantItemsThisTurn.length > 1) {
      const needLines = needsVariantItemsThisTurn
        .map(
          (n) =>
            `• **${n.title}**${n.priceStr ? ` (${n.priceStr})` : ""}: ${n.label}s **${n.optListStr}**`,
        )
        .join("\n");
      fallbackSpeech = isHindi
        ? `Bilkul dost! In sabko cart mein add karne ke liye bas mujhe apna size bata do:\n${needLines}\nBatao yaar, kaunsa size lock karoon?`
        : `I'd love to add all of these to your cart! Just let me know which size you need for:\n${needLines}\nWhich size should I add for you?`;
    }
  }

  // ---- shared helpers for the secure order tools (lookup + cancellation) ----
  const orderReply = (status, extra, instruction, en, hi) => {
    fallbackSpeech = isHindi ? hi : en;
    return { status, ...extra, instruction_for_ai: instruction };
  };
  const orderWho = { shop: storeId, clientId: context.clientId };
  const looksLikeYesNo = (text) =>
    /^(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|haan|han|ha|haa|ji|nahi|nahin|nhi|na|theek hai|thik hai|confirm|confirmed)[\s.!]*$/i.test(String(text || "").trim());

  // Verified? Owned? Found? Used by every tool that touches a real order.
  const resolveOrderTarget = async (rawNumber) => {
    const customerGid = context.verifiedCustomerId || null;
    const verifiedEmail = await orderAuth.getVerifiedEmail(orderWho);
    if (!customerGid && !verifiedEmail) {
      return { error: orderReply("verification_required", {},
        "The customer is NOT verified (or their verification is gone because the chat was cleared), so share nothing and do nothing with any order. Explain you need to verify them first: ask for the email used on the order, then call send_order_otp with it.",
        "I need to verify you first. Please share the email used on the order and I'll send a code.",
        "Pehle aapko verify karna hoga. Order ka email bata do, main code bhejungi.") };
    }
    const gaveNumber = rawNumber != null && String(rawNumber).trim() !== "";
    const orderNumber = gaveNumber ? parseOrderNumber(rawNumber) : (await orderAuth.getLastOrder(orderWho)) || "";
    if (!orderNumber) {
      return { error: orderReply("need_order_number", {},
        "Ask the customer for their order number (like #1001).",
        "Please share your order number (like #1001).",
        "Apna order number bata do (jaise #1001).") };
    }
    let order = null;
    try {
      order = await orderLookup.findOrder(storeId, orderNumber);
    } catch (err) {
      console.error("[order-lookup] Shopify lookup failed:", err?.message || err);
      return { error: orderReply("unavailable", {},
        "Order service is temporarily unavailable. Apologise briefly and ask them to try again in a moment or contact the store. Do not invent anything.",
        "I couldn't reach the order system. Please try again in a moment.",
        "Abhi order system se connect nahi ho paya. Thodi der baad try karo.") };
    }
    if (!order || !orderBelongsTo(order, { customerGid, verifiedEmail })) {
      return { error: orderReply("not_found", { orderNumber },
        `No order ${orderNumber} was found for this verified customer. Share nothing about it and do not say whether it exists for anyone else. Ask them to re-check the number.`,
        `I couldn't find order ${orderNumber} for your account. Please check the number.`,
        `Mujhe order ${orderNumber} aapke account mein nahi mila. Number check kar lo.`) };
    }
    return { order, orderNumber };
  };

  const notCancellableReply = (order, can) => {
    const name = order.name;
    if (can.reason === "already_cancelled") {
      return orderReply("not_cancellable", { orderName: name, reason: "already_cancelled" },
        `Order ${name} is already cancelled. Tell the customer that.`,
        `Order ${name} is already cancelled.`, `Order ${name} pehle se cancel ho chuka hai.`);
    }
    return orderReply("not_cancellable", { orderName: name, reason: can.reason, fulfillmentStatus: can.fulfillmentStatus || null },
      `Order ${name} has already been shipped or is being fulfilled, so it can no longer be cancelled. Explain this kindly. Tell them that once the order is delivered they can ask for a return, exchange or refund through the store. Do not promise any outcome for that.`,
      `Order ${name} has already been shipped, so it can't be cancelled now. After delivery you can request a return, exchange or refund.`,
      `Order ${name} ship ho chuka hai, isliye ab cancel nahi ho sakta. Delivery ke baad return, exchange ya refund ke liye request kar sakte ho.`);
  };

  const handlers = {};
  // The tool handlers live in ./ecommerce/handlers/. `ctx` is everything they share with this session;
  // values that change during the turn are read and written through getters and setters.
  const ctx = {
    LANGUAGE_CHOICE_CODES,
    MAX_CART_ACTIONS,
    WIDEN_SEARCH_NOTE,
    actions,
    missedSearches,
    markPersonRequest: () => { personRequested = true; },
    addIntent,
    addedItemsThisTurn,
    autoExcluded,
    billingRelationshipIntent,
    bookings,
    confirmsOrder,
    context,
    convTurn,
    customerFirstName,
    defaultGender,
    ensureShippingRates,
    evaluateShoppingDiscoveryNeed,
    get fallbackSpeech() { return fallbackSpeech; }, set fallbackSpeech(value) { fallbackSpeech = value; },
    findShippingRate,
    foundProducts,
    handleConversationalFollowUp,
    handlers,
    history,
    historyCustomer,
    isHindi,
    isVerifiedLoggedIn,
    lang,
    get languageChoice() { return languageChoice; }, set languageChoice(value) { languageChoice = value; },
    llmMode,
    loadDiscounts,
    localSession,
    looksLikeYesNo,
    needsVariantItemsThisTurn,
    normalizeGenderArg,
    notCancellableReply,
    orderAuth,
    orderJustPlacedReply,
    orderLookup,
    orderReply,
    orderWho,
    paymentChoice,
    prepaidOffer,
    quoteOrder,
    rebuildMultiAddFallbackSpeech,
    rememberForCards,
    resolveOrderTarget,
    resolveVerifiedSelfGender,
    safeGet,
    safeUpsert,
    seenProductIds,
    seenProductTitles,
    sendConfirmation,
    storeCurrency,
    storeId,
    submitOrder,
    get suppressCardsThisTurn() { return suppressCardsThisTurn; }, set suppressCardsThisTurn(value) { suppressCardsThisTurn = value; },
    travelRequest,
    turnSeed,
    userMessage,
    wantsOrderPreview,
  };
  Object.assign(handlers, catalogHandlers(ctx), cartHandlers(ctx), offersHandlers(ctx), checkoutHandlers(ctx), ordersHandlers(ctx), billingHandlers(ctx), complaintHandlers(ctx));

  let latestCheckout = localSession;

  const originalHandlers = { ...handlers };
  for (const [name, fn] of Object.entries(originalHandlers)) {
    handlers[name] = async (args) => {
      const actionOffset = actions.length;
      let out;
      try {
        out = await fn(args);
      } catch (error) {
        if (!/Cart prices are missing/.test(error.message)) throw error;
        fallbackSpeech = isHindi
          ? "Cart ki price details missing hain. Cart refresh karo, phir main sahi total aur order preview dikhaungi."
          : "Some cart prices are missing. Refresh your cart so I can show the correct total and order preview.";
        out = { status: "cart_refresh_required" };
      }
      if (
        actions
          .slice(actionOffset)
          .some((action) => action.type === "checkout_ready") &&
        ![
          "mark_checkout_ready",
          "set_shipping_address",
          "set_billing_same_as_shipping",
          "place_order",
        ].includes(name)
      ) {
        // mark_checkout_ready replaces any card another handler just pushed, so there is
        // exactly one (Shopify-priced) preview per turn.
        const reviewOut = await originalHandlers.mark_checkout_ready();
        if (reviewOut && typeof out === "object" && out !== null) {
          out = { ...out, ...reviewOut };
        }
      }
      try {
        latestCheckout = await safeGet();
      } catch {}
      return out;
    };
  }

  // The shopper told the assistant to put a product in the cart, yet the turn ended without a cart action (a model that
  // only chatted, or asked for an option the shopper had already named). When exactly one product is on the table and its
  // option is clear from the shopper's own words, put it in the cart. Returns true when the cart was changed.
  // "checkout karo, wahi pichle order wala address use kar lo": the model started the checkout and said the old address was set, but never
  // set it (live, 2026-11-22), so the order had no address and no tax. The address of this chat's last order is put on the checkout.
  async function ensureAddressReuse() {
    if (actions.some((a) => a?.type === "set_shipping_address")) return false;
    if (!REUSE_ADDRESS_WORDS.test(userMessage)) return false;
    const aboutAddress = /\b(?:address|addres|adress|pata|ship\w*|deliver\w*|bhej\w*)\b|पता|डिलीवरी|भेज/i.test(userMessage) || actions.some((a) => a?.type === "begin_checkout");
    if (!aboutAddress) return false;
    const current = await safeGet();
    if (!current?.lastOrderShipping?.address1 || current?.shipping?.address1) return false;
    await handlers.set_shipping_address({});
    return actions.some((a) => a?.type === "set_shipping_address");
  }

  async function ensureRequestedAdd() {
    if (changedCart(actions)) return false;
    const words = (text) => String(text || "").toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
    const messageWords = new Set(words(userMessage));
    const pool = foundProducts.size > 0 ? [...foundProducts.values()] : Array.isArray(context.probeProducts) ? context.probeProducts : [];
    let named = pool.filter((p) => {
      const titleWords = words(p.title).filter((w) => w.length > 2);
      return titleWords.length > 0 && titleWords.filter((w) => messageWords.has(w)).length >= Math.min(2, titleWords.length);
    });
    // "Dell wala black mein add kar do": one word of the message that belongs to exactly one product this chat has (its brand or model,
    // never a word several products share like "mouse") names that product. A live run with the Dell, Logitech and HP mice on screen
    // added nothing and asked "checkout karna hai?" (2026-11-22).
    // The products on the shopper's screen come first (the quick search for this message can add other items of the same brand).
    const uniquelyNamed = (list) => {
      const byTitle = new Map();
      for (const p of list) if (p?.title && !byTitle.has(p.title)) byTitle.set(p.title, p);
      const owners = new Map();
      for (const p of byTitle.values()) for (const w of new Set(words(p.title).filter((x) => x.length > 2 && !/^\d+$/.test(x)))) owners.set(w, [...(owners.get(w) || []), p]);
      const hits = new Set();
      for (const w of messageWords) if (owners.get(w)?.length === 1) hits.add(owners.get(w)[0]);
      return hits.size === 1 ? [...hits] : [];
    };
    // "ek power bank chahiye, Ambrane wala black mein cart mein daal do": "power" and "bank" are in all three titles; the word only one of
    // them has (Ambrane) decides (live 2026-11-23: nothing was added and the colour was asked again).
    if (named.length > 1) {
      const narrowed = uniquelyNamed(named);
      if (narrowed.length === 1) named = narrowed;
    }
    if (named.length === 0) {
      const shownNow = readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
      named = uniquelyNamed(shownNow);
      if (named.length === 0) named = uniquelyNamed([...pool, ...shownNow]);
    }
    // Nothing named in the message ("haan black wala add kar do"): the product the last reply was about is the one meant, when that
    // reply talked about exactly one of the products this chat showed (a real run added nothing here, 2026-11-22).
    let discussed = [];
    if (named.length === 0) {
      const lastReply = String([...history].reverse().find((h) => h?.role === "assistant" && h?.content)?.content || "").toLowerCase();
      const shown = readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [];
      discussed = lastReply ? shown.filter((p) => p?.title && lastReply.includes(String(p.title).toLowerCase())) : [];
      if (discussed.length !== 1) discussed = [];
    }
    let candidates = named.length > 0 ? named : discussed.length === 1 ? discussed : pool;
    // Two products can share most of a name ("Running Sneakers - Black" and "Men's Running Sneakers - Black"): the one whose WHOLE title the
    // shopper wrote is the one they mean (the longest, when more than one title appears in the message).
    if (candidates.length > 1) {
      const squash = (text) => words(text).join(" ");
      const said = " " + squash(userMessage) + " ";
      const whole = candidates.filter((p) => said.includes(" " + squash(p.title) + " "));
      if (whole.length >= 1) candidates = [whole.sort((a, b) => squash(b.title).length - squash(a.title).length)[0]];
    }
    if (candidates.length !== 1) return false;
    const product = candidates[0];
    const variants = Array.isArray(product.variants) ? product.variants.filter((v) => v.sellable !== false) : [];
    if (variants.length === 0) return false;
    // The variant is always named when the shopper said it or when only one is left: a search narrowed to "Gold" keeps one variant here
    // while the product has three, and an add without the name came back "which colour?" and nothing was added (live, 2026-11-22).
    let variantName = variants.length === 1 ? String(variants[0].title || "") : "";
    if (variants.length === 1 && /^default title$/i.test(variantName)) variantName = "";
    if (variants.length > 1) {
      const scored = variants
        .map((v) => ({ v, hits: words(v.title).filter((w) => messageWords.has(w)).length }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      if (scored.length === 0 || (scored.length > 1 && scored[0].hits === scored[1].hits)) return false;
      variantName = scored[0].v.title;
    }
    // "add 2 Running Sneakers": the number the shopper said, never a silent 1
    const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const said = String(userMessage || "").toLowerCase().match(/\b(?:add|put|buy|get|want|need|order|take)\s+(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    const wanted = said ? Number(said[1]) || NUMBER_WORDS[said[1]] || 1 : 1;
    await handlers.add_to_cart({ productName: product.title, variantName, quantity: wanted });
    return actions.some((a) => a?.type === "add_to_cart");
  }

  async function routeKnownIntent() {
    if (convTurn?.type === "categories_list") {
      await handlers.list_categories();
      return true;
    }
    if (
      /\b(?:angry|upset|naraz|gussa)\b/i.test(userMessage) &&
      /\b(?:gift|dress|suggest|recommend)\b/i.test(userMessage) &&
      ((context.profile || context.checkout?.profile)?.recipient === "gift" ||
        history.some(
          (turn) =>
            turn.role === "user" && /girlfriend|wife|gift/i.test(turn.content),
        ))
    ) {
      fallbackSpeech = isHindi
        ? "Samajh gayi. Chalo kuch personal aur thoughtful chunte hain. Unhe kya pasand hai ya roz kis cheez ka use karte hain?"
        : "I hear you. Let's make the gift feel personal. What do they enjoy or use often?";
      return true;
    }
    if (
      /\b(?:let me (?:speak|finish)|wait.*(?:speak|finish)|meri baat sun|bolne do)\b/i.test(
        userMessage,
      )
    ) {
      fallbackSpeech = isHindi
        ? "Bilkul, aaram se apni baat poori karo."
        : "Of course, take your time. I'm listening.";
      return true;
    }
    if (/\b(?:my|mera|meri)\s+gender\b|know\s+my\s+gender/i.test(userMessage)) {
      const gender =
        context.profile?.gender || context.checkout?.profile?.gender;
      fallbackSpeech = gender
        ? `You told me you're ${gender === "men" ? "a guy" : "a woman"}. I'll keep that preference for your own shopping.`
        : "You haven't told me your gender. I won't infer it from your name; I can show unisex essentials or use the clothing preference you choose.";
      return true;
    }
    if (
      /\b(?:where|how)\b.*\b(?:find|found|get|got|obtain|obtained|come|came)\b.*\baddress\b|\baddress\b.*\b(?:from|source)\b/i.test(
        userMessage,
      )
    ) {
      const session = await safeGet();
      const source = session.shippingSource;
      fallbackSpeech =
        source === "checkout"
          ? isHindi
            ? "Yeh address tumne is checkout mein share kiya tha. Main tumhara latest saved checkout address use kar rahi hoon."
            : "You shared this address during checkout. I'm using your latest saved checkout address."
          : source === "account" || source === "shopify"
            ? isHindi
              ? "Yeh tumhare Shopify account ka saved default delivery address hai."
              : "This is the default delivery address saved on your Shopify account."
            : isHindi
              ? "Yeh current checkout mein saved hai; iska original source mere paas confirm nahi hai. Chaho toh address check ya update kar lete hain."
              : "It's saved in your current checkout. I can't verify where it was originally entered. We can check or update it together.";
      return true;
    }
    if (
      /\b(?:shipping|delivery|express|standard)\b/i.test(userMessage) &&
      /\b(?:why|how much|cost|charge|fee|expensive|difference|kitna|mehenga|options)\b/i.test(
        userMessage,
      )
    ) {
      await handlers.get_shipping_options();
      return true;
    }
    if (
      /^(?:(?:yes|yeah|please|okay)[,\s]+)?(?:(?:i(?:'ll| will| would)?\s+)?(?:prefer|want|choose|use|select|keep|go with|switch to)\s+)?(?:the\s+)?(?:standard|express)(?:\s+(?:shipping|delivery))?(?:\s+please)?[.!\s]*$/i.test(
        userMessage.trim(),
      )
    ) {
      await handlers.set_shipping_method({
        shippingRate: /express/i.test(userMessage) ? "express" : "standard",
      });
      return true;
    }
    const pending = await safeGet();
    const lastAssistant =
      [...history].reverse().find((turn) => turn.role === "assistant")
        ?.content || "";
    const choice = paymentChoice(userMessage);
    const mentionsCheckoutWord =
      /\b(?:check\s*out|checkout)\b/i.test(userMessage) &&
      !/\b(?:don't|do not|cancel|not now)\b/i.test(userMessage);
    const orderReviewShownInHistory =
      /order\s+(?:preview|review)|payable\s+total|delivery\s*:|cash\s+on\s+delivery.*online\s+payment/i.test(
        lastAssistant,
      );

    // If the user says "checkout" (even with "cod", e.g. "haan check out kro cod krr do") and the Order Review
    // has NOT been shown yet in the conversation, ALWAYS show the full Order Review first via begin_checkout!
    if (mentionsCheckoutWord && !orderReviewShownInHistory) {
      if (choice) {
        await safeUpsert({ selectedPaymentMethod: choice });
      }
      await handlers.begin_checkout();
      return true;
    }

    const explicitOrder = confirmsOrder(userMessage, "cart") && !choice;
    const promptedConfirmation =
      confirmsOrder(userMessage, pending.step) &&
      /(?:confirm|place).*(?:order|updated total)|(?:COD|online payment).*(?:which|prefer|would)|(?:would|kaunsa|choose).*(?:COD|online payment)/i.test(
        lastAssistant,
      );
    if (choice || explicitOrder || promptedConfirmation) {
      await handlers.place_order({
        paymentMethod: choice || pending.selectedPaymentMethod,
      });
      return true;
    }
    if (mentionsCheckoutWord) {
      await handlers.begin_checkout();
      return true;
    }
    if (
      /\b(?:saved\s+address.*different|(?:change|update|replace).*address|(?:different|new)\s+(?:delivery|shipping)\s+address)\b/i.test(
        userMessage,
      ) &&
      !/\d/.test(userMessage) &&
      !/\b(?:billing|how|what|can|could)\b/i.test(userMessage)
    ) {
      await handlers.request_shipping_update();
      return true;
    }
    if (
      /\b(?:twice|duplicate|repeated|repeat|do\s+baar)\b/i.test(userMessage) &&
      /address|street|colony|road/i.test(userMessage)
    ) {
      await handlers.set_shipping_address({});
      return true;
    }
    if (
      /\b(?:what|show|tell|read|check|know)\b.*\b(?:my\s+)?(?:shipping|delivery|saved|current|billing)?\s*address\b|mera\s+address/i.test(
        userMessage,
      )
    ) {
      await handlers.get_checkout_details();
      return true;
    }
    if (
      /\b(?:order\s+(?:preview|review|summary|details)|(?:preview|review)\s+(?:my|the|this)?\s*order)\b/i.test(
        userMessage,
      ) &&
      // Only a safety net for the PRE-purchase review. If they talk about an order already placed (an order
      // number, status, "placed/purchased"), or the cart is empty, leave it to the model + show_preview.
      !/#\s*\d{3,}|\b(?:placed|purchased|bought|ordered|status|track(?:ing)?|delivered|shipped|cancel\w*|kiya\s+tha|liya\s+tha)\b/i.test(userMessage) &&
      Array.isArray(context.cart?.items) &&
      context.cart.items.length > 0
    ) {
      await handlers.mark_checkout_ready();
      return true;
    }
    if (/\b(?:why|check|show)\b.*\btotal\b/i.test(userMessage)) {
      await handlers.get_cart();
      return true;
    }
    const billingIntent = billingRelationshipIntent(userMessage, lastAssistant);
    if (billingIntent === "different" && !/\d/.test(userMessage)) {
      await handlers.request_billing_update();
      return true;
    }
    if (billingIntent === "same") {
      await handlers.set_billing_same_as_shipping();
      return true;
    }
    if (billingIntent === "question" && /\bbilling\b/i.test(userMessage)) {
      await handlers.get_checkout_details();
      return true;
    }
    if (isGenderComplaintTurn(userMessage)) {
      evaluateShoppingDiscoveryNeed({});
      if (fallbackSpeech) return true;
    }
    if (travelRequest) {
      await handlers.get_recommendations({
        keywords: [],
        count: 6,
      });
      return true;
    }
    const convFollowUp = await handleConversationalFollowUp();
    if (convFollowUp) return true;
    if (!llmMode && isOpinionOrPraiseQuestion(userMessage)) {
      const praised = await handlers.evaluate_product_look();
      if (praised) return true;
    }
    return false;
  }

  // Checkout steps whose meaning is unambiguous from the conversation STATE, not from vocabulary:
  // answering the billing question, picking a payment method, or asking to see the order review.
  // They run before the model so a short "yes" can never be answered with the same question again.
  // It only chooses WHICH tool runs; the shopper-facing numbers still come from Shopify.
  async function routeCheckoutIntent({ billingOnly = false } = {}) {
    if (!context.cart?.items?.length) return false;
    const pending = await safeGet();
    if (!pending.shipping?.address1) return false;
    const lastAssistant =
      [...history].reverse().find((turn) => turn.role === "assistant")?.content || "";
    const billingIntent = billingRelationshipIntent(userMessage, lastAssistant);
    if (billingIntent === "same" && !(billingOnly && pending.billingConfirmed)) {
      await handlers.set_billing_same_as_shipping();
      return true;
    }
    if (billingIntent === "different" && !/\d/.test(userMessage) && !(billingOnly && pending.billingNeedsUpdate)) {
      await handlers.request_billing_update();
      return true;
    }
    if (billingOnly) return false;
    const aboutPlacedOrder = /#\s*\d{3,}|\b(?:placed|purchased|bought|ordered|status|track(?:ing)?|delivered|shipped|cancel\w*|history|previous|last)\b/i.test(userMessage);
    if (!aboutPlacedOrder && wantsOrderPreview(userMessage, lastAssistant) && (pending.billingConfirmed || pending.billingSameAsShipping !== false)) {
      await handlers.mark_checkout_ready({ force: true });
      return true;
    }
    const choice = paymentChoice(userMessage);
    if (choice && (pending.billingConfirmed || pending.billing?.address1 || pending.billingSameAsShipping === true)) {
      await handlers.place_order({ paymentMethod: choice });
      return true;
    }
    return false;
  }

  async function autoRecoverProducts(_rawUserMsg = "", _rawAssistantText = "") {
    const lastAssistant =
      [...history].reverse().find((turn) => turn.role === "assistant")
        ?.content || "";
    if (context.cart?.items?.length) {
      const pending = await safeGet();
      const choice = paymentChoice(userMessage);
      const effectiveStep =
        pending.step === "cart" &&
        pending.shipping?.address1 &&
        (pending.billing?.address1 || pending.billingSameAsShipping !== false)
          ? "ready"
          : pending.step;
      if (
        confirmsOrder(userMessage, "review") &&
        /Shopify calculated|Shopify ke verified total/i.test(lastAssistant) &&
        pending.orderQuote?.status === "review_required"
      ) {
        await handlers.place_order({ paymentMethod: pending.selectedPaymentMethod || "cod" });
        return Boolean(fallbackSpeech);
      }
      if (
        pending.shipping?.address1 &&
        (choice ||
          (confirmsOrder(userMessage, effectiveStep) &&
            (pending.selectedPaymentMethod ||
              /\b(?:cash\s+on\s+delivery|cod)\b/i.test(lastAssistant))))
      ) {
        await handlers.place_order({
          paymentMethod: choice || pending.selectedPaymentMethod || "cod",
        });
        return Boolean(fallbackSpeech);
      }
    }
    if (convTurn) {
      foundProducts.clear();
      const prebuilt = buildConversationalReply(
        convTurn,
        lang,
        customerFirstName,
          agentNameFor(context),
      );
      if (prebuilt) {
        fallbackSpeech = prebuilt;
        return true;
      }
      return false;
    }

    if (!llmMode && isOpinionOrPraiseQuestion(userMessage)) {
      const praised = await handlers.evaluate_product_look();
      if (praised) return true;
    }

    if (addIntent.isAddIntent && addIntent.productName) {
      await handlers.add_to_cart({
        productName: addIntent.productName,
        variantName: addIntent.variantName || "",
        quantity: 1,
      });
      return Boolean(fallbackSpeech);
    }

    const explicitCatsInMsg = extractRequestedCategories(userMessage, storeId).filter(
      (cat) => !autoExcluded.some((ex) => cat.includes(ex)),
    );
    if (explicitCatsInMsg.length > 0) {
      await handlers.get_recommendations({
        keywords: explicitCatsInMsg,
        excludeKeywords: autoExcluded,
        gender: defaultGender,
        count: 6,
      });
      return foundProducts.size > 0 || Boolean(fallbackSpeech);
    }

    const isShoppingOrOccasionAsk =
      /\b(dikhao|dikhaiye|kuch|kch|options?|products?|items?|chahiye|chaiye|paas|alava|alawa|more|another|other)\b/i.test(
        userMessage,
      );
    if (autoExcluded.length === 0 && !isShoppingOrOccasionAsk) {
      return false;
    }

    const catalogCats = (context.catalogCategories || [])
      .map((c) => String(c || "").trim())
      .filter(Boolean);
    let fallbackKeywords;
    if (catalogCats.length > 0) {
      const shift = turnSeed % catalogCats.length;
      fallbackKeywords = [
        ...catalogCats.slice(shift),
        ...catalogCats.slice(0, shift),
      ].slice(0, 4);
    } else {
      fallbackKeywords = [];
    }

    await handlers.get_recommendations({
      keywords: fallbackKeywords,
      excludeKeywords: autoExcluded,
      gender: defaultGender,
      count: 6,
    });

    return foundProducts.size > 0;
  }

  // Each tool call exposes its own arguments to the intent helpers above (the model's reading of
  // the customer's intent), restored afterwards so nested tool calls never leak arguments.
  for (const [name, inner] of Object.entries(handlers)) {
    if (typeof inner !== "function") continue;
    handlers[name] = async (...callArgs) => {
      const previous = intentArgs.current;
      const first = callArgs[0];
      intentArgs.current = first && typeof first === "object" ? first : {};
      try {
        return await inner(...callArgs);
      } finally {
        intentArgs.current = previous;
      }
    };
  }

  // Tools the store owner switched off refuse to run, whatever asked for them.
  for (const name of context.disabledTools || []) {
    if (typeof handlers[name] !== "function") continue;
    handlers[name] = async () => ({
      status: "disabled",
      note: "The store owner has switched this capability off. Tell the customer plainly that you cannot do this here and, if useful, suggest they use the store's website or contact the store.",
    });
  }

  for (const name of ["get_discounts_and_offers", "get_warranty_and_policy"]) {
    const inner = handlers[name];
    if (typeof inner !== "function") continue;
    handlers[name] = async (args) => {
      const out = await inner(args);
      if (args?.productName) await attachCardForName(args.productName);
      return out;
    };
  }
  return {
    handlers,
    routeKnownIntent,
    routeCheckoutIntent,
    autoRecoverProducts,
    ensureRequestedAdd,
    ensureAddressReuse,
    // the checkout as saved (a guard checks a reply's claim against it)
    safeCheckoutState: () => safeGet(),
    // the code really on this checkout (a reply may only say a discount is applied when one is)
    appliedDiscountCode: () => String(localSession.appliedDiscount?.code || ""),
    // How many actions this session has made, and a way to put back the actions of a tool that an earlier AI provider already
    // ran this turn (the turn's side-effect ledger, see core/toolsNode.js), so the shopper still gets them.
    actionCount: () => actions.length,
    recordShown,
    // Where a cancellation the customer started stands ("awaiting_confirmation" / "awaiting_reason" / ""), read from the verified order session.
    pendingCancelStage: async () => (await orderAuth.getPendingCancel(orderWho))?.stage || "",
    // Cards of the products this chat showed most recently (from the chat's own memory), for a reply that talks about them again
    // without a new search ("show me again what you found", "is the Nike in size 9?").
    // the products themselves (description, features, options): what a reply about them may be checked against
    recentlyShownProducts: () => readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || [],
    recentlyShownCards: () => (readCheckoutMemory(storeId, context.clientId)?.lastShownProducts || []).map((p) => toCard(p)),
    restoreActions: (list) => { for (const a of Array.isArray(list) ? list : []) actions.push(a); },
    result: () => ({
      speculativeProducts: Array.isArray(context.probeProducts) && !personRequested
        ? context.probeProducts.slice(0, MAX_CARDS).map((p) => toCard(narrowVariantsByStorage(p, userMessage)))
        : [],
      products:
        convTurn || suppressCardsThisTurn || personRequested
          ? []
          : [...foundProducts.values()].slice(0, MAX_CARDS).map(toCard),
      // The order review card lists the store's real Shopify shipping rates for this address.
      actions: actions.map((a) =>
        a?.type === "checkout_ready"
          ? {
              ...a,
              shippingRates: a.shippingRates || localSession.shippingRates || [],
              shippingMethod: localSession.shippingRate?.title || a.shippingMethod,
            }
          : a,
      ),
      checkout: latestCheckout,
      missed: missedSearches.filter((m) => m.term).slice(0, 5),
      fallbackSpeech,
      ...(languageChoice !== undefined ? { languageChoice } : {}),
    }),
  };
}

const LANGUAGE_CHOICE_CODES = { english: "en", hindi: "hi", hinglish: "hinglish", auto: "" };

export { buildComparisonChecklist, buildShopOwnerComparisonReply, comparisonToolPayload, DEFAULT_AGENT_NAME };

// Told to the model (never to the customer) when a search found little but the store has more.
const WIDEN_SEARCH_NOTE =
  "Nothing could be bought under this exact word, but the store does stock the categories in moreInStore. ONLY if the customer asked for a broad kind of thing (a department such as electronics or clothing), ALSO call search_products with searchTerms for the categories in moreInStore that are the same kind of thing, so they see real in-stock options. If they asked for one specific item (a kurta, a TV, a belt), do NOT widen: say honestly it is not available and offer only the closest item of the same type. Never show items of a different kind to fill a gap (a belt when they asked for a kurta). A qualifier such as travel, office, small or leather does not make it a different kind: when the exact variant is missing, show the plain item of the same type (any bag for a travel bag) and say it is the closest. Never read this category list out to the customer.";


export default {
  analytics,
  admin,
  buildSystemPrompt,
  toolDefinitions,
  createSession,
  getCatalogSummary,
  getCachedCatalogSummary,
  emptyResult: () => ({ products: [], actions: [] }),
};

export { isOpinionOrPraiseQuestion };
