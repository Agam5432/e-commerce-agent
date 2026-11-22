import crypto from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = crypto;
import OrderSubmission from "../models/OrderSubmission.js";
import { adminGraphql, ShopifyRequestError } from "./shopifyAdminService.js";
import { normalizeAddressForShopify } from "./shopifyAddress.js";
import { normalizeCartSnapshot, requireCartPricing } from "./cartSnapshot.js";

export const VARIANTS_QUERY = `query CheckoutVariants($ids: [ID!]!, $country: CountryCode, $shopper: Boolean!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    ... on ProductVariant {
      id price inventoryQuantity inventoryPolicy inventoryItem { tracked }
      product { status publishedAt }
      contextualPricing(context: { country: $country }) @include(if: $shopper) { price { amount currencyCode } }
    }
  }
}`;

// When the cart is not in the store's own currency (Shopify Markets), the draft must be priced in
// the shopper's currency and market, or the quote, payment link and email would all disagree with the cart.
export function presentmentInput(options = {}, shopCurrency = null) {
  const cur = String(options.currency || "").toUpperCase();
  const country = String(options.countryCode || options.shopperCountry || "").toUpperCase();
  if (!cur) return {};
  // The currency of the cart is ALWAYS sent, also when it is the store's own. Left out, Shopify prices the order in the
  // currency of the market of the delivery country (a USD cart delivered to India came back in rupees at the India
  // market's own prices), and the quote, the order and the email stopped matching what the shopper saw.
  const inShopCurrency = Boolean(shopCurrency) && cur === String(shopCurrency).toUpperCase();
  return { presentmentCurrencyCode: cur, ...(!inShopCurrency && /^[A-Z]{2}$/.test(country) ? { marketRegionCountryCode: country } : {}) };
}
// The store's OWN shipping rate (from Shopify's availableShippingRates for this cart and address).
// No rate chosen yet => no shipping line, Shopify applies none. Never a hardcoded fee.
export function shippingLineInput(rate) {
  if (!rate || !rate.handle) return null;
  const amount = Number(rate.price);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    shippingRateHandle: String(rate.handle),
    title: String(rate.title || "Shipping"),
    ...(rate.currency ? { priceWithCurrency: { amount: amount.toFixed(2), currencyCode: String(rate.currency).toUpperCase() } } : {}),
  };
}

export function mapShippingRates(rates = []) {
  return (Array.isArray(rates) ? rates : [])
    .map((r) => ({
      handle: String(r?.handle || ""),
      title: String(r?.title || "").trim(),
      price: Number(r?.price?.amount),
      currency: String(r?.price?.currencyCode || "").toUpperCase(),
    }))
    .filter((r) => r.handle && r.title && Number.isFinite(r.price) && r.price >= 0)
    .sort((a, b) => a.price - b.price || a.title.localeCompare(b.title));
}

export const CUSTOMER_QUERY = `query OrderCustomer($query: String!) {
  customers(first: 5, query: $query) { nodes { id email } }
}`;
export const CHECKOUT_ACCESS_QUERY = `query CheckoutAccess {
  orders(first: 1) { nodes { id } }
}`;
export const CUSTOMER_CREATE = `mutation OrderCustomerCreate($input: CustomerInput!) {
  customerCreate(input: $input) { customer { id } userErrors { field message } }
}`;
const ORDER_FIELDS = `id name displayFinancialStatus customer { id }
  totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  taxesIncluded
  taxLines { title ratePercentage priceSet { shopMoney { amount } presentmentMoney { amount currencyCode } } }`;
const DRAFT_FIELDS = `id invoiceUrl totalPrice totalTax currencyCode taxesIncluded
  totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  taxLines { title ratePercentage priceSet { shopMoney { amount } presentmentMoney { amount currencyCode } } }
  subtotalPrice totalShippingPrice totalDiscountsSet { shopMoney { amount } presentmentMoney { amount currencyCode } } status order { ${ORDER_FIELDS} }`;
// Same input as a draft order, but nothing is created in the store: Shopify only
// calculates subtotal, shipping, discounts, tax lines and the payable total.
export const DRAFT_CALCULATE = `mutation AgentDraftCalculate($input: DraftOrderInput!) {
  draftOrderCalculate(input: $input) {
    calculatedDraftOrder {
      currencyCode taxesIncluded
      subtotalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
      taxLines { title ratePercentage priceSet { shopMoney { amount } presentmentMoney { amount currencyCode } } }
      availableShippingRates { handle title price { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;
export const DRAFT_CREATE = `mutation AgentDraftCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { ${DRAFT_FIELDS} } userErrors { field message }
  }
}`;
export const DRAFT_COMPLETE = `mutation AgentDraftComplete($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: true) {
    draftOrder { ${DRAFT_FIELDS} } userErrors { field message }
  }
}`;
export const DRAFT_LOOKUP = `query AgentDraftLookup($query: String!) {
  draftOrders(first: 2, query: $query) { nodes { ${DRAFT_FIELDS} } }
}`;
// A draft's tags are copied to the order made from it: the way to find an order whose draft can no longer be read.
export const ORDER_BY_TAG = `query AgentOrderByTag($query: String!) {
  orders(first: 1, query: $query) { nodes { ${ORDER_FIELDS} } }
}`;
export const DRAFT_BY_ID = `query AgentDraftById($id: ID!) {
  draftOrder(id: $id) { ${DRAFT_FIELDS} }
}`;

// Draft tags must fit Shopify's 40-character limit. Use the same stable tag
// when creating and reconciling a checkout after a lost response.
// Marks the Shopify orders the agent placed itself (also used to tell them apart in the dashboard).
export const AI_ORDER_TAG = "Orbi-AI-Order";
// Order/cart attribute that carries the chat reference, so Shopify's orders/create webhook can tell which chat an order came from.
export const CHAT_REF_ATTRIBUTE = "ai_chat_ref";

export function checkoutRequestTag(requestId) {
  return `orbi-${crypto.createHash("sha256").update(String(requestId)).digest("hex").slice(0, 32)}`;
}

function checked(payload, name) {
  if (payload?.userErrors?.length) {
    throw new ShopifyRequestError(`${name}: ${payload.userErrors.map(e => `${(e.field || []).join(".")}: ${e.message}`).join("; ")}`, { code: "CHECKOUT_REJECTED" });
  }
  if (!payload?.draftOrder?.id) throw new ShopifyRequestError(`${name}: missing Shopify response.`, { uncertain: true });
  return payload.draftOrder;
}

export function normalizeOrderItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("Cart must contain 1–100 items.");
  const cart = normalizeCartSnapshot({ items });
  requireCartPricing(cart);
  const combined = new Map();
  for (const item of cart.items) {
    // Ajax cart IDs/prices are integers in minor units. Never guess from magnitude.
    const rawId = String(item.variant_id || item.variantId || item.id || "");
    const id = /^\d+$/.test(rawId) ? `gid://shopify/ProductVariant/${rawId}` : rawId;
    const quantity = Number(item.quantity);
    const price = Number(item.original_price ?? item.price);
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) throw new Error("A real Shopify variant ID is required for every cart item.");
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) throw new Error("Quantity must be between 1 and 50.");
    if (!Number.isSafeInteger(price) || price < 0) throw new Error("Cart prices must be in minor currency units.");
    const existing = combined.get(id);
    if (existing && existing.price !== price) throw new Error("Conflicting prices for the same variant.");
    const totalQuantity = quantity + (existing?.quantity || 0);
    if (totalQuantity > 50) throw new Error("Quantity must be between 1 and 50 per variant.");
    combined.set(id, { id, quantity: totalQuantity, price });
  }
  return [...combined.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function addressInput(raw) {
  const address = normalizeAddressForShopify(raw);
  if (!address.firstName || !address.address1 || !address.city || !address.zip || !address.countryCode) {
    throw new Error("Complete name, street, city, postal code and country are required.");
  }
  return Object.fromEntries(Object.entries({
    firstName: address.firstName, lastName: address.lastName,
    address1: address.address1, address2: address.address2,
    city: address.city, provinceCode: address.provinceCode,
    countryCode: address.countryCode, zip: address.zip, phone: address.phone,
  }).filter(([, value]) => value));
}

const money2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amountOf = (set) => {
  const v = set?.presentmentMoney?.amount ?? set?.shopMoney?.amount;
  return v == null ? null : Number(v);
};
const currencyOf = (set, fallback) => set?.presentmentMoney?.currencyCode ?? set?.shopMoney?.currencyCode ?? fallback;

function mapTaxLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    title: String(line.title || "Tax"),
    ratePercent: line.ratePercentage == null ? null : Number(line.ratePercentage),
    amount: amountOf(line.priceSet) ?? 0,
  }));
}

// One breakdown shape for quotes, drafts and finished orders so the preview card, chat
// text and confirmation email can never disagree. `otherCharges` is whatever Shopify
// includes in the payable total beyond subtotal + shipping + tax (for example duties
// or import fees); it is shown to the shopper instead of being silently dropped.
export function buildBreakdown({ subtotal, shippingCost, tax, total, discountAmount = 0, currency, taxLines = [], taxesIncluded = false }) {
  const t = money2(total);
  let sub = money2(subtotal);
  const ship = money2(shippingCost);
  const tx = money2(tax);
  const taxExtra = taxesIncluded ? 0 : tx;
  let other = money2(t - sub - ship - taxExtra);
  let disc = money2(discountAmount);
  // Shopify sometimes reports the subtotal before an order-level discount. A negative gap is exactly
  // that discount, so show it as a discount instead of as a negative "other charge".
  if (other <= -0.01) {
    disc = money2(Math.max(disc, -other));
    sub = money2(sub + other); // from here on subtotal is always AFTER discounts
    other = 0;
  }
  // Tax that Shopify added to the total but did not list as a tax line (import tax, duties on duties...).
  const itemized = money2((Array.isArray(taxLines) ? taxLines : []).reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
  const unitemizedTax = Math.abs(tx - itemized) >= 0.01 && tx > itemized ? money2(tx - itemized) : 0;
  // A stated rate that cannot explain the amount (e.g. "18%" on a tax that is 36% of the goods) is
  // reported so the assistant says so plainly instead of repeating a rate that does not add up.
  const base = money2(sub - (disc > 0 && sub > 0 ? 0 : 0) + (taxesIncluded ? 0 : ship));
  const topRate = Math.max(0, ...(Array.isArray(taxLines) ? taxLines : []).map((l) => Number(l.ratePercent) || 0));
  const impliedRate = !taxesIncluded && base > 0 ? Number(((tx / base) * 100).toFixed(2)) : null;
  const taxLooksUnusual = Boolean(topRate > 0 && impliedRate != null && impliedRate > topRate * 1.25 + 0.5);
  return {
    subtotal: sub, shippingCost: ship, tax: tx, total: t, currency,
    discountAmount: disc, taxLines, taxesIncluded: Boolean(taxesIncluded),
    otherCharges: Math.abs(other) >= 0.01 ? other : 0,
    itemizedTax: itemized, unitemizedTax, impliedTaxRatePercent: impliedRate, taxLooksUnusual,
  };
}

// Plain rows that always add up to the payable total. The chat text, the Order Review card and the
// confirmation email all read these, and the assistant quotes them instead of doing its own maths.
export function breakdownRows(q = {}) {
  const rows = [];
  const gross = money2((Number(q.subtotal) || 0) + (Number(q.discountAmount) || 0));
  rows.push({ key: "items", label: q.discountAmount > 0 ? "Items (before discount)" : "Items subtotal", amount: q.discountAmount > 0 ? gross : money2(q.subtotal) });
  if (q.discountAmount > 0) rows.push({ key: "discount", label: "Discount", amount: -money2(q.discountAmount) });
  rows.push({ key: "shipping", label: "Shipping", amount: money2(q.shippingCost) });
  if (!q.taxesIncluded && Number(q.tax) > 0) {
    const lines = Array.isArray(q.taxLines) ? q.taxLines : [];
    for (const l of lines) rows.push({ key: "tax", label: `${l.title || "Tax"}${l.ratePercent != null ? ` ${l.ratePercent}%` : ""}`, amount: money2(l.amount) });
    if (q.unitemizedTax > 0) rows.push({ key: "tax_other", label: "Other taxes/duties Shopify added (not itemized)", amount: q.unitemizedTax });
    if (!lines.length && !q.unitemizedTax) rows.push({ key: "tax", label: "Tax", amount: money2(q.tax) });
  }
  if (Number(q.otherCharges) > 0) rows.push({ key: "other", label: "Other charges Shopify added (duties/fees)", amount: money2(q.otherCharges) });
  const sum = money2(rows.reduce((t, r) => t + r.amount, 0));
  return { rows, sum, total: money2(q.total), reconciles: Math.abs(sum - money2(q.total)) < 0.02 || Boolean(q.taxesIncluded) };
}

// Customer-facing prepaid discount -> the order-level discount Shopify applies to the draft.
// Used by the quote AND the real draft so the preview, payment link and email can never disagree.
export function prepaidDiscountInput(offer) {
  if (!offer?.hasDiscount) return null;
  const title = String(offer.title || offer.code || "Prepaid discount").slice(0, 60);
  if (Number(offer.discountPercent) > 0) return { title, valueType: "PERCENTAGE", value: Number(offer.discountPercent) };
  if (Number(offer.flatAmount ?? offer.discountAmount) > 0) return { title, valueType: "FIXED_AMOUNT", value: Number(offer.flatAmount ?? offer.discountAmount) };
  return null;
}

// A fixed discount amount is a number in the STORE's currency. Applied to a cart in another currency Shopify would read it as
// that currency, which mixes two currencies in one total. Nothing is converted: such an order is refused instead.
export function assertDiscountCurrency(discount, cartCurrency, shopCurrency) {
  const cart = String(cartCurrency || "").toUpperCase();
  const shop = String(shopCurrency || "").toUpperCase();
  if (discount?.valueType === "FIXED_AMOUNT" && cart && shop && cart !== shop) {
    throw new ShopifyRequestError("A fixed-amount discount is in the store's currency and cannot be applied to a cart in a different currency.", { code: "CHECKOUT_REJECTED" });
  }
}

function draftQuote(draft) {
  return buildBreakdown({
    subtotal: amountOf(draft.subtotalPriceSet) ?? draft.subtotalPrice,
    shippingCost: amountOf(draft.totalShippingPriceSet) ?? draft.totalShippingPrice,
    tax: amountOf(draft.totalTaxSet) ?? draft.totalTax,
    total: amountOf(draft.totalPriceSet) ?? draft.totalPrice,
    discountAmount: amountOf(draft.totalDiscountsSet) || 0,
    currency: currencyOf(draft.totalPriceSet, draft.currencyCode), taxLines: mapTaxLines(draft.taxLines), taxesIncluded: draft.taxesIncluded,
  });
}

// The finished Shopify order is the source of truth for every amount shown after checkout.
function orderBreakdown(draft) {
  const order = draft.order;
  const total = amountOf(order.totalPriceSet);
  const tax = amountOf(order.totalTaxSet);
  const subtotal = amountOf(order.subtotalPriceSet);
  if (total == null || tax == null || subtotal == null) return draftQuote(draft);
  return buildBreakdown({
    subtotal, tax, total, shippingCost: amountOf(order.totalShippingPriceSet) ?? 0,
    discountAmount: amountOf(order.totalDiscountsSet) ?? 0, currency: currencyOf(order.totalPriceSet),
    taxLines: mapTaxLines(order.taxLines), taxesIncluded: order.taxesIncluded,
  });
}

function completedResult(draft) {
  if (!draft.order?.id) throw new ShopifyRequestError("Shopify has not confirmed an order.", { uncertain: true });
  return {
    status: "ok", shopifyOrderCreated: true, shopifyOrderId: draft.order.id,
    orderName: draft.order.name, customerId: draft.order.customer?.id || null,
    financialStatus: draft.order.displayFinancialStatus,
    ...orderBreakdown(draft),
  };
}

// The unique index is created before the first claim, including on a fresh install.
const repository = {
  async claim(shop, key) {
    await OrderSubmission.init();
    try {
      return { owned: true, record: (await OrderSubmission.create({ shop, key, requestId: crypto.randomUUID(), status: "processing" })).toObject() };
    } catch (error) {
      if (error.code !== 11000) throw error;
      const record = await OrderSubmission.findOne({ shop, key }).lean();
      if (record?.status === "failed") {
        const retry = await OrderSubmission.findOneAndUpdate({ shop, key, status: "failed" }, { $set: { status: "processing", error: null } }, { new: true }).lean();
        if (retry) return { owned: true, record: retry };
      }
      return { owned: false, record };
    }
  },
  async save(shop, key, patch) {
    await OrderSubmission.updateOne({ shop, key }, { $set: patch });
  },
  async claimReview(shop, key) {
    return Boolean(await OrderSubmission.findOneAndUpdate({ shop, key, status: "review" }, { $set: { status: "processing" } }));
  },
};

export function createOrderService({ graphql = adminGraphql, submissions = repository } = {}) {
  return async function createShopifyAdminOrder(shop, options = {}) {
    const items = normalizeOrderItems(options.items);
    const shipping = addressInput(options.shipping);
    const billing = options.billingSameAsShipping !== false ? shipping : addressInput(options.billing);
    const email = String(options.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid customer email is required for checkout.");
    if (!["cod", "prepaid"].includes(options.paymentMethod)) throw new Error("Choose COD or online payment.");
    if (!options.clientId || ["anon", "voice"].includes(options.clientId)) throw new Error("Refresh the storefront to start a personal checkout session.");
    const discountCodes = [...new Set([options.appliedDiscount?.code].filter(Boolean).map(String))];
    const key = crypto.createHash("sha256").update(JSON.stringify({
      clientId: options.clientId, attempt: options.checkoutAttemptId || "", cartToken: options.cartToken || "",
      items, shipping, billing, email, customerId: options.customerId || "",
      payment: options.paymentMethod, shippingRate: options.shippingRate?.handle || "", discountCodes, prepaid: options.paymentMethod === "prepaid" ? prepaidDiscountInput(options.prepaidOffer) : null,
    })).digest("hex");
    let { owned, record } = await submissions.claim(shop, key);
    if (!record) throw new Error("Unable to claim checkout. Please try again.");
    if (record.status === "complete") {
      if (record.result?.status === "payment_required" && record.result.draftOrderId) {
        const paid = (await graphql(shop, DRAFT_BY_ID, { id: record.result.draftOrderId }))?.draftOrder;
        if (paid?.order?.id) {
          const result = completedResult(paid);
          await submissions.save(shop, key, { result });
          return { ...result, replayed: true };
        }
        if (!paid) {
          // The draft cannot be read, but the shopper may have paid: look for the order itself before anything else.
          const order = (await graphql(shop, ORDER_BY_TAG, { query: `tag:${checkoutRequestTag(record.requestId)}` }))?.orders?.nodes?.[0];
          if (order?.id) {
            const result = completedResult({ order });
            await submissions.save(shop, key, { result });
            return { ...result, replayed: true };
          }
          // Shopify no longer has the draft (the merchant deleted it): its payment link is dead, so a repeat
          // request starts one fresh payment draft instead of handing the shopper a link that cannot work.
          await submissions.save(shop, key, { status: "failed", error: "The payment draft no longer exists in Shopify.", draftId: null, mutationStartedAt: null });
          ({ owned, record } = await submissions.claim(shop, key));
          if (!record) throw new Error("Unable to claim checkout. Please try again.");
        }
      }
      if (record.status === "complete") return { ...record.result, replayed: true };
    }
    if (!owned && record.status === "processing" && Date.now() - new Date(record.updatedAt).getTime() < 60000) {
      return { status: "processing", note: "This checkout is already processing. Wait before trying again." };
    }
    let draft;
    let mutationStarted = Boolean(record.mutationStartedAt);
    try {
      if (!owned || record.draftId) {
        const data = record.draftId
          ? await graphql(shop, DRAFT_BY_ID, { id: record.draftId })
          : await graphql(shop, DRAFT_LOOKUP, { query: `tag:${checkoutRequestTag(record.requestId)} OR tag:orbi-request-${record.requestId}` });
        draft = data?.draftOrder || data?.draftOrders?.nodes?.[0];
        if (draft?.order?.id) {
          const result = completedResult(draft);
          await submissions.save(shop, key, { status: "complete", result });
          return { ...result, replayed: true };
        }
        if (!draft && !owned) {
          return { status: "unknown", note: "Shopify's response is still unconfirmed. Check Shopify Admin before submitting another order." };
        }
        if (record.status === "review" && options.acceptedQuoteKey !== key) {
          return { ...record.result, replayed: true };
        }
        if (record.status === "review" && !(await submissions.claimReview(shop, key))) {
          return { status: "processing" };
        }
      }
      if (!draft) {
        const shopperCountry = String(options.countryCode || options.shopperCountry || "").toUpperCase();
        const data0 = await graphql(shop, VARIANTS_QUERY, { ids: items.map(i => i.id), country: shopperCountry || null, shopper: false });
        const inShopCurrency = String(data0.shop.currencyCode).toUpperCase() === String(options.currency || "").toUpperCase();
        if (!inShopCurrency && !/^[A-Z]{2}$/.test(shopperCountry)) throw new Error("The cart is in a different currency than the store. Refresh the page so I can price your order in your market.");
        const data = inShopCurrency ? data0 : await graphql(shop, VARIANTS_QUERY, { ids: items.map(i => i.id), country: shopperCountry, shopper: true });
        for (const item of items) {
          const variant = data.nodes.find(v => v?.id === item.id);
          if (!variant || variant.product.status !== "ACTIVE" || !variant.product.publishedAt) throw new Error("A cart product is no longer published. Refresh the cart.");
          // Same-currency carts compare with the base price; Markets carts with Shopify's price for the shopper's country.
          const unit = inShopCurrency ? Number(variant.price) : (String(variant.contextualPricing?.price?.currencyCode).toUpperCase() === String(options.currency).toUpperCase() ? Number(variant.contextualPricing.price.amount) : NaN);
          if (Math.round(unit * 100) !== item.price) throw new Error("A product price has changed. Refresh the cart before ordering.");
          if (variant.inventoryItem.tracked && variant.inventoryPolicy !== "CONTINUE" && variant.inventoryQuantity < item.quantity) throw new Error("A selected variant has insufficient stock. Update your cart.");
        }
        assertDiscountCurrency(options.paymentMethod === "prepaid" ? prepaidDiscountInput(options.prepaidOffer) : null, options.currency, data0.shop.currencyCode);
        // Fail before creating a draft/customer when Shopify blocks the Order
        // object. Access scopes alone do not grant protected customer data access.
        await graphql(shop, CHECKOUT_ACCESS_QUERY);
        let customerId = options.customerId;
        if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(customerId || "")) {
          const found = await graphql(shop, CUSTOMER_QUERY, { query: `email:${JSON.stringify(email)}` });
          customerId = found.customers.nodes.find(c => c.email?.toLowerCase() === email)?.id;
          if (!customerId) {
            const created = await graphql(shop, CUSTOMER_CREATE, { input: { email, firstName: shipping.firstName, lastName: shipping.lastName } });
            customerId = created.customerCreate?.customer?.id;
            if (!customerId) throw new ShopifyRequestError(created.customerCreate?.userErrors?.map(e => e.message).join("; ") || "Unable to create the Shopify customer.");
          }
        }
        // Shopify validates discount eligibility, calculates taxes and totals, and
        // associates the actual customer. Never manufacture a custom price/order.
        const shippingLine = shippingLineInput(options.shippingRate);
        const input = {
          email, purchasingEntity: { customerId },
          shippingAddress: shipping, billingAddress: billing,
          lineItems: items.map(i => ({ variantId: i.id, quantity: i.quantity })),
          ...(shippingLine ? { shippingLine } : {}),
          discountCodes, acceptAutomaticDiscounts: true,
          ...presentmentInput(options, data0.shop.currencyCode),
          ...(options.paymentMethod === "prepaid" && prepaidDiscountInput(options.prepaidOffer) ? { appliedDiscount: prepaidDiscountInput(options.prepaidOffer) } : {}),
          ...(options.chatRef ? { customAttributes: [{ key: CHAT_REF_ATTRIBUTE, value: String(options.chatRef).slice(0, 40) }] } : {}),
          tags: [AI_ORDER_TAG, checkoutRequestTag(record.requestId), options.paymentMethod === "cod" ? "COD" : "Online-Payment"],
          note: `Placed via Orbi AI Shopping Assistant. Payment: ${options.paymentMethod}. ${String(options.customerNotes || "").slice(0, 500)}`,
        };
        await submissions.save(shop, key, { mutationStartedAt: new Date() });
        mutationStarted = true;
        draft = checked((await graphql(shop, DRAFT_CREATE, { input }))?.draftOrderCreate, "Checkout");
        await submissions.save(shop, key, { draftId: draft.id });
      }
      if (options.paymentMethod === "prepaid") {
        if (!draft.invoiceUrl) throw new ShopifyRequestError("Shopify did not return a payment link.");
        const result = { status: "payment_required", shopifyOrderCreated: false, draftOrderId: draft.id, checkoutUrl: draft.invoiceUrl, ...draftQuote(draft) };
        await submissions.save(shop, key, { status: "complete", result });
        return result;
      }
      const quote = draftQuote(draft);
      if (options.acceptedQuoteKey !== key && Math.abs(quote.total - Number(options.finalTotal)) > 0.01) {
        const result = { status: "review_required", quoteKey: key, ...quote, note: "Shopify recalculated the total including valid discounts and tax. Confirm the updated total to place the order." };
        await submissions.save(shop, key, { status: "review", result });
        return result;
      }
      // COD is an unpaid, unfulfilled Shopify order. Online payments use the
      // hosted invoice above; never call complete with paymentPending:false.
      draft = checked((await graphql(shop, DRAFT_COMPLETE, { id: draft.id }))?.draftOrderComplete, "Place order");
      const result = completedResult(draft);
      await submissions.save(shop, key, { status: "complete", result });
      return result;
    } catch (error) {
      const uncertain = mutationStarted && (error.uncertain || !(error instanceof ShopifyRequestError));
      try { await submissions.save(shop, key, { status: uncertain ? "unknown" : "failed", error: error.message }); } catch { /* Preserve the original error; never fall back to a local order. */ }
      throw error;
    }
  };
}

export const createShopifyAdminOrder = createOrderService();

// Shopify-calculated preview (no draft order is created). Used before the single Order
// Review so tax, shipping, discounts and the payable total are shown up front.
export function createOrderQuoteService({ graphql = adminGraphql } = {}) {
  return async function quoteShopifyAdminOrder(shop, options = {}) {
    const items = normalizeOrderItems(options.items);
    const shipping = addressInput(options.shipping);
    const billing = options.billingSameAsShipping !== false ? shipping : addressInput(options.billing);
    const email = String(options.email || "").trim().toLowerCase();
    const discountCodes = [...new Set([options.appliedDiscount?.code].filter(Boolean).map(String))];
    const shippingLine = shippingLineInput(options.shippingRate);
    const shippingCost = shippingLine ? Number(options.shippingRate.price) : 0;
    const input = {
      ...(email ? { email } : {}),
      shippingAddress: shipping, billingAddress: billing,
      lineItems: items.map(i => ({ variantId: i.id, quantity: i.quantity })),
      ...(shippingLine ? { shippingLine } : {}),
      discountCodes, acceptAutomaticDiscounts: true,
      ...presentmentInput(options, options.shopCurrency),
    };
    const prepaidInput = options.paymentMethod === "prepaid" ? prepaidDiscountInput(options.prepaidOffer) : null;
    assertDiscountCurrency(prepaidInput, options.currency, options.shopCurrency);
    if (prepaidInput) input.appliedDiscount = prepaidInput;
    const payload = (await graphql(shop, DRAFT_CALCULATE, { input }))?.draftOrderCalculate;
    if (payload?.userErrors?.length) {
      throw new ShopifyRequestError(`Quote: ${payload.userErrors.map(e => e.message).join("; ")}`, { code: "QUOTE_REJECTED" });
    }
    const calc = payload?.calculatedDraftOrder;
    const total = amountOf(calc?.totalPriceSet);
    if (total == null) throw new ShopifyRequestError("Quote: missing Shopify response.");
    const lineTotal = items.reduce((sum, i) => sum + (i.price * i.quantity) / 100, 0);
    const subtotal = amountOf(calc.subtotalPriceSet) ?? lineTotal;
    const breakdown = buildBreakdown({
      subtotal, shippingCost: amountOf(calc.totalShippingPriceSet) ?? shippingCost, tax: amountOf(calc.totalTaxSet) ?? 0,
      total, discountAmount: Math.max(0, lineTotal - subtotal), currency: currencyOf(calc.totalPriceSet, calc.currencyCode),
      taxLines: mapTaxLines(calc.taxLines), taxesIncluded: calc.taxesIncluded,
    });
    // What the storefront cart said the goods cost vs what Shopify priced them at for this destination.
    const storefrontSubtotal = money2(lineTotal);
    const priceDiffersFromStorefront = !prepaidInput && !options.appliedDiscount && !discountCodes.length && Math.abs(breakdown.subtotal - storefrontSubtotal) >= 0.01;
    if (breakdown.taxLooksUnusual || breakdown.unitemizedTax > 0 || breakdown.otherCharges > 0 || priceDiffersFromStorefront) {
      console.warn("[quote] unusual Shopify quote", JSON.stringify({ shop, storefrontSubtotal, subtotal: breakdown.subtotal, shipping: breakdown.shippingCost, tax: breakdown.tax, itemizedTax: breakdown.itemizedTax, unitemizedTax: breakdown.unitemizedTax, otherCharges: breakdown.otherCharges, impliedTaxRatePercent: breakdown.impliedTaxRatePercent, taxLines: breakdown.taxLines, total: breakdown.total, destination: shipping.countryCode }));
    }
    return { ...breakdown, storefrontSubtotal, priceDiffersFromStorefront, availableShippingRates: mapShippingRates(calc.availableShippingRates) };
  };
}

// The shipping rates THIS store offers for this cart and address, straight from Shopify
// (Settings > Shipping and delivery). Cheapest first. Nothing is created in the store.
export function createShippingRatesService({ graphql = adminGraphql } = {}) {
  return async function listShopifyShippingRates(shop, options = {}) {
    const items = normalizeOrderItems(options.items);
    const shipping = addressInput(options.shipping);
    const email = String(options.email || "").trim().toLowerCase();
    const input = {
      ...(email ? { email } : {}),
      shippingAddress: shipping,
      lineItems: items.map((i) => ({ variantId: i.id, quantity: i.quantity })),
      ...presentmentInput(options, options.shopCurrency),
    };
    const payload = (await graphql(shop, DRAFT_CALCULATE, { input }))?.draftOrderCalculate;
    if (payload?.userErrors?.length) {
      throw new ShopifyRequestError(`Shipping rates: ${payload.userErrors.map((e) => e.message).join("; ")}`, { code: "RATES_REJECTED" });
    }
    const rates = mapShippingRates(payload?.calculatedDraftOrder?.availableShippingRates);
    const cartCurrency = String(options.currency || "").toUpperCase();
    // Shopify lists a rate only in the STORE's currency (Express = USD 20). In a shopper's own currency the same rate costs
    // what Shopify itself prices it at for that market (INR 2,000), so ask Shopify for that figure; never convert it here.
    if (!cartCurrency || rates.every((r) => r.currency === cartCurrency)) return rates;
    const priced = [];
    for (const rate of rates) {
      try {
        const one = (await graphql(shop, DRAFT_CALCULATE, { input: { ...input, shippingLine: { shippingRateHandle: rate.handle, title: rate.title } } }))?.draftOrderCalculate;
        const shown = one?.calculatedDraftOrder?.totalShippingPriceSet?.presentmentMoney;
        const amount = Number(shown?.amount);
        if (one?.userErrors?.length || !Number.isFinite(amount) || String(shown?.currencyCode || "").toUpperCase() !== cartCurrency) throw new Error("no price in the cart currency");
        priced.push({ ...rate, shopPrice: rate.price, shopCurrency: rate.currency, price: amount, currency: cartCurrency });
      } catch (error) {
        console.warn("[shipping] left out a rate Shopify would not price in", cartCurrency, ":", rate.title, String(error?.message || error).slice(0, 120));
      }
    }
    return priced;
  };
}

export const listShopifyShippingRates = createShippingRatesService();
export const quoteShopifyAdminOrder = createOrderQuoteService();