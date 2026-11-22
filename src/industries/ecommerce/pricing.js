// Checkout memory for one visitor, Shopify order quotes, and the order total maths (subtotal, coupon, shipping).
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import crypto from "node:crypto";
import { normalizeCartSnapshot, requireCartPricing } from "../../services/cartSnapshot.js";
import { sliceHistoryAfterLastOrder } from "../../services/shippingAddressService.js";
import { formatMoney } from "../../utils/money.js";
import { formatPriceLabel } from "./replies.js";

const checkoutMemoryStore = new Map();
const CHECKOUT_MEMORY_TTL_MS = 45 * 60 * 1000;

function readCheckoutMemory(storeId, clientId) {
  if (!clientId || ["anon", "voice"].includes(clientId)) return null;
  const now = Date.now();
  const specificKey = `${storeId}::${clientId || "anon"}`;

  const specific = checkoutMemoryStore.get(specificKey);
  if (specific && now - specific.updatedAt < CHECKOUT_MEMORY_TTL_MS) {
    return specific.data;
  }
  checkoutMemoryStore.delete(specificKey);

  return null;
}

// The shopper cleared their chat: a checkout they had started in it is dropped from this server's memory too.
export function forgetCheckoutMemory(storeId, clientId) {
  checkoutMemoryStore.delete(`${storeId}::${clientId || "anon"}`);
}

function writeCheckoutMemory(storeId, clientId, patch = {}) {
  if (!clientId || ["anon", "voice"].includes(clientId)) return patch;
  const now = Date.now();
  const specificKey = `${storeId}::${clientId || "anon"}`;

  const existing = checkoutMemoryStore.get(specificKey)?.data || {};

  const merged = {
    ...existing,
    ...patch,
    shipping: patch.shipping
      ? { ...(existing.shipping || {}), ...patch.shipping }
      : existing.shipping || null,
    billing: patch.billing
      ? { ...(existing.billing || {}), ...patch.billing }
      : existing.billing || null,
    billingSameAsShipping:
      patch.billingSameAsShipping !== undefined
        ? patch.billingSameAsShipping
        : existing.billingSameAsShipping !== undefined
          ? existing.billingSameAsShipping
          : null,
    customer: patch.customer
      ? { ...(existing.customer || {}), ...patch.customer }
      : existing.customer || null,
    appliedDiscount:
      patch.appliedDiscount !== undefined
        ? patch.appliedDiscount
        : existing.appliedDiscount || null,
    shippingMethod:
      patch.shippingMethod !== undefined
        ? patch.shippingMethod
        : existing.shippingMethod || "standard",
    shippingCost:
      patch.shippingCost !== undefined
        ? patch.shippingCost
        : (existing.shippingCost ?? 0),
  };

  checkoutMemoryStore.delete(specificKey);
  checkoutMemoryStore.set(specificKey, { data: merged, updatedAt: now });
  if (checkoutMemoryStore.size > 1000)
    checkoutMemoryStore.delete(checkoutMemoryStore.keys().next().value);
  return merged;
}

function extractAppliedDiscountFromHistory(history = [], userMessage = "") {
  const activeHistory = sliceHistoryAfterLastOrder(history);
  const allMsgs = [
    ...(activeHistory || []).map((h) => String(h?.content || "")),
    String(userMessage || ""),
  ];

  let found = null;
  for (const text of allMsgs) {
    if (
      /Order\s+ID:\s*\*\*#TS-|order\s+(?:has\s+been\s+placed|is\s+confirmed|placed\s+successfully)|order\s+.*\b(?:place|confirm)\s+ho\s+gaya|Shopify\s+mein\s+place\s+ho\s+gaya|confirmed\s+in\s+Shopify|cleared\s+out\s+all\s+items|cart\s+is\s+now\s+empty|cart\s+bilkul\s+khali|cart\s+ab\s+khali|खाली\s+हो\s+गया/i.test(
        text,
      )
    ) {
      found = null;
      continue;
    }
    const appliedMatch = text.match(
      /applied\s+coupon\s+\*\*([A-Z0-9_-]+)\*\*[\s\S]*?\((\d+)%\s*off\)/i,
    );
    if (appliedMatch) {
      found = {
        code: appliedMatch[1].toUpperCase(),
        title: appliedMatch[1].toUpperCase(),
        percent: Number(appliedMatch[2]) || 0,
        amount: 0,
        isFreeShipping: false,
      };
      continue;
    }

    const freeShipMatch = text.match(
      /applied\s+coupon\s+\*\*([A-Z0-9_-]+)\*\*[\s\S]*?Free\s+Shipping/i,
    );
    if (freeShipMatch) {
      found = {
        code: freeShipMatch[1].toUpperCase(),
        title: freeShipMatch[1].toUpperCase(),
        percent: 0,
        amount: 0,
        isFreeShipping: true,
      };
      continue;
    }
  }
  return found;
}

// A slow Shopify response must never freeze the checkout: the preview waits at most this long.
const QUOTE_TIMEOUT_MS = Number(process.env.SHOPIFY_QUOTE_TIMEOUT_MS) || 8000;
function withQuoteTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Shopify quote timed out")), QUOTE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Identifies exactly what a Shopify quote was calculated for. When any of it changes the
// stored quote is stale and the preview is refreshed (and may be shown again).
function previewQuoteKey({ cart, shipping, billing, session, pricing, prepaid = null }) {
  const pick = (a) => [a?.address1, a?.address2, a?.city, a?.province, a?.zip, a?.country, a?.countryCode].map((v) => String(v || "").trim().toLowerCase());
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      items: (cart?.items || []).map((i) => [String(i.variant_id || i.id || ""), Number(i.quantity), Number(i.original_price ?? i.price)]),
      ship: pick(shipping),
      bill: session?.billingSameAsShipping !== false ? "same" : pick(billing),
      method: pricing?.shippingRate?.handle || "",
      discount: pricing?.appliedDiscount?.code || pricing?.appliedDiscount?.title || "",
      prepaid: prepaid ? [prepaid.valueType, prepaid.value] : null,
    }))
    .digest("hex")
    .slice(0, 24);
}

// Facts about a Shopify quote that the shopper must not be left to discover later. Every number
// here comes straight from the quote; no reason or tax rule is invented.
function quoteNotes(quote, isHindi, destinationCountry = "") {
  if (!quote) return "";
  const cur = quote.currency || "USD";
  const notes = [];
  if (quote.priceDiffersFromStorefront) {
    const dest = destinationCountry ? ` ${isHindi ? "ke liye" : "for delivery to"} ${destinationCountry}` : "";
    notes.push(isHindi
      ? `Dhyan do: Shopify in items ko${dest} **${formatPriceLabel(quote.subtotal, cur)}** mein price kar raha hai, jabki storefront cart par **${formatPriceLabel(quote.storefrontSubtotal, cur)}** dikh raha tha.`
      : `Heads-up: Shopify prices these items at **${formatPriceLabel(quote.subtotal, cur)}**${dest}, while the storefront cart showed **${formatPriceLabel(quote.storefrontSubtotal, cur)}**.`);
  }
  if (quote.unitemizedTax > 0) {
    notes.push(isHindi
      ? `Shopify ne listed tax lines ke upar **${formatPriceLabel(quote.unitemizedTax, cur)}** aur tax/duty joda hai jo alag se itemize nahi hua.`
      : `Shopify added **${formatPriceLabel(quote.unitemizedTax, cur)}** of further tax/duties on top of the listed tax lines, and did not itemize it.`);
  }
  if (quote.taxLooksUnusual && quote.impliedTaxRatePercent != null) {
    notes.push(isHindi
      ? `Total tax order ka lagbhag **${quote.impliedTaxRatePercent}%** hai, jo listed rate se zyada hai.`
      : `The total tax works out to about **${quote.impliedTaxRatePercent}%** of the order, which is higher than the listed rate.`);
  }
  return notes.length ? ` ${notes.join(" ")}` : "";
}

function computeOrderPricing(cart, session, storeCurrency = "USD") {
  cart = normalizeCartSnapshot(cart);
  requireCartPricing(cart);
  const cur = cart?.currency || storeCurrency || "USD";
  const rawSubtotal = Number(
    (
      (cart?.original_total_price ??
        (cart?.items || []).reduce(
          (sum, item) =>
            sum +
            Number(item.original_price ?? item.price ?? 0) *
              Number(item.quantity || 0),
          0,
        )) / 100
    ).toFixed(2),
  );

  // Shipping is the store's own Shopify rate chosen for this checkout (see ensureShippingRates).
  const shippingRate =
    session?.shippingRate && session.shippingRate.handle ? session.shippingRate : null;
  const shippingMethod = shippingRate ? shippingRate.title : "standard";

  const applied =
    session?.appliedDiscount ||
    session?.lastCartSnapshot?._checkoutMeta?.appliedDiscount ||
    null;

  const isFreeShipping = Boolean(applied?.isFreeShipping);
  const shippingCost =
    shippingRate && !isFreeShipping ? Number(Number(shippingRate.price || 0).toFixed(2)) : 0;
  const shippingLabel = shippingRate
    ? `${shippingRate.title} (${shippingCost > 0 ? formatMoney(shippingCost, cur) : "FREE"})`
    : "Shipping (calculated by the store once the address is known)";

  if (!applied || (!applied.code && !applied.title)) {
    const finalWithShip = Number((rawSubtotal + shippingCost).toFixed(2));
    return {
      currency: cur,
      rawSubtotal,
      discountedSubtotal: rawSubtotal,
      hasCoupon: false,
      appliedDiscount: null,
      couponDiscountAmount: 0,
      couponPercent: 0,
      isFreeShipping: false,
      shippingMethod,
      shippingRate,
      shippingCost,
      shippingLabel,
      totalSavings: 0,
      totalAfterCoupon: finalWithShip,
    };
  }

  let couponPercent = Number(applied.percent) || 0;
  let couponDiscountAmount = 0;

  // A code limited to some items discounts only those cart lines (the ones it covered when it was applied).
  const scoped = Array.isArray(applied.scopeVariantIds) ? new Set(applied.scopeVariantIds.map(String)) : null;
  const discountableBase = scoped
    ? Number(((cart?.items || []).filter((item) => scoped.has(String(item.variant_id ?? item.id ?? ""))).reduce((sum, item) => sum + Number(item.final_line_price ?? item.line_price ?? 0), 0) / 100).toFixed(2))
    : rawSubtotal;
  if (!isFreeShipping && rawSubtotal > 0) {
    if (couponPercent > 0) {
      couponDiscountAmount = Number(
        ((Math.min(discountableBase, rawSubtotal) * couponPercent) / 100).toFixed(2),
      );
    } else if (Number(applied.amount) > 0) {
      couponDiscountAmount = Math.min(
        rawSubtotal,
        Number(Number(applied.amount).toFixed(2)),
      );
      couponPercent = Math.round((couponDiscountAmount / rawSubtotal) * 100);
    }
  }

  const discountedSubtotal = Math.max(
    0,
    Number((rawSubtotal - couponDiscountAmount).toFixed(2)),
  );
  const totalAfterCoupon = Math.max(
    0,
    Number((discountedSubtotal + shippingCost).toFixed(2)),
  );

  return {
    currency: cur,
    rawSubtotal,
    discountedSubtotal,
    hasCoupon: couponDiscountAmount > 0 || isFreeShipping,
    appliedDiscount: {
      ...applied,
      percent: couponPercent,
      amount: couponDiscountAmount,
      isFreeShipping,
    },
    couponDiscountAmount,
    couponPercent,
    isFreeShipping,
    shippingMethod,
    shippingRate,
    shippingCost,
    shippingLabel,
    totalSavings: couponDiscountAmount,
    totalAfterCoupon,
  };
}

export { readCheckoutMemory, writeCheckoutMemory, extractAppliedDiscountFromHistory, withQuoteTimeout, previewQuoteKey, quoteNotes, computeOrderPricing, checkoutMemoryStore, CHECKOUT_MEMORY_TTL_MS, QUOTE_TIMEOUT_MS };
