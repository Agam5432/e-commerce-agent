/**
 * Read-only order status / details lookup.
 *
 * Everything returned comes straight from Shopify (nothing is hard-coded).
 * Two guarantees live here, away from the AI so they cannot be talked around:
 *   1. OWNERSHIP  - an order is only returned if it belongs to the verified
 *                   identity (logged-in Shopify customer id, or the email that
 *                   passed OTP verification).
 *   2. MINIMUM DISCLOSURE - only the detail groups the shopper asked for are
 *                   put into the result the AI sees ("status" asks return the
 *                   status only, "all" returns everything).
 */
import { adminGraphql } from "./shopifyAdminService.js";
import { formatMoney } from "../utils/money.js";

const MONEY = "{ shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }";
const ADDRESS = "{ name address1 address2 city province zip country phone }";

export const ORDER_LOOKUP_QUERY = `query OrderStatusLookup($query: String!) {
  orders(first: 5, query: $query) {
    nodes {
      id name createdAt processedAt cancelledAt cancelReason closedAt
      email phone currencyCode
      displayFinancialStatus displayFulfillmentStatus returnStatus
      paymentGatewayNames discountCodes
      customer { id email }
      subtotalPriceSet ${MONEY}
      totalShippingPriceSet ${MONEY}
      totalTaxSet ${MONEY}
      totalDiscountsSet ${MONEY}
      totalPriceSet ${MONEY}
      totalRefundedSet ${MONEY}
      shippingLine { title originalPriceSet ${MONEY} }
      shippingAddress ${ADDRESS}
      billingAddress ${ADDRESS}
      lineItems(first: 50) {
        nodes { title variantTitle quantity originalUnitPriceSet ${MONEY} discountedUnitPriceSet ${MONEY} }
      }
      fulfillments(first: 10) {
        status displayStatus createdAt estimatedDeliveryAt inTransitAt deliveredAt
        trackingInfo { company number url }
      }
    }
  }
}`;

// The verified shopper's own recent orders, newest first, with only what a summary needs. The store's
// time zone comes back in the same call so "today" means the store's today.
export const ORDER_LIST_QUERY = `query MyOrders($query: String!, $first: Int!) {
  shop { ianaTimezone }
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage }
    nodes {
      id name createdAt cancelledAt email
      displayFinancialStatus displayFulfillmentStatus
      customer { id email }
      totalPriceSet ${MONEY}
      lineItems(first: 5) { nodes { title quantity } }
    }
  }
}`;

export const ORDER_CANCEL = `mutation OrderCancelByCustomer($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    job { id done }
    orderCancelUserErrors { field message code }
  }
}`;

/**
 * Store rule: an order can be cancelled only while it has NOT been fulfilled/shipped.
 * After shipping it is a return / exchange / refund matter instead.
 */
export function cancellability(order) {
  if (!order) return { ok: false, reason: "not_found" };
  if (order.cancelledAt) return { ok: false, reason: "already_cancelled" };
  const fulfillmentStatus = String(order.displayFulfillmentStatus || "").toUpperCase();
  if ((order.fulfillments || []).length > 0 || ["FULFILLED", "PARTIALLY_FULFILLED", "IN_PROGRESS"].includes(fulfillmentStatus)) {
    return { ok: false, reason: "already_shipped", fulfillmentStatus: humanize(fulfillmentStatus) };
  }
  if (fulfillmentStatus && fulfillmentStatus !== "UNFULFILLED") {
    return { ok: false, reason: "not_cancellable", fulfillmentStatus: humanize(fulfillmentStatus) };
  }
  return { ok: true };
}

// money is still held for PARTIALLY_REFUNDED too (a cancel must refund what remains: real #1036 kept USD 10 after a USD 5 refund)
export const isPaidOrder = (order) => ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(String(order?.displayFinancialStatus || "").toUpperCase());

/** Detail groups the AI can ask for. */
export const ORDER_FIELD_GROUPS = [
  "status",
  "tracking",
  "items",
  "payment",
  "total",
  "shipping_address",
  "billing_address",
  "shipping_method",
  "order_date",
  "contact",
  "discount",
];
const DEFAULT_FIELDS = ["status"];

const ALIASES = {
  delivery: "tracking",
  shipment: "tracking",
  shipping_status: "tracking",
  track: "tracking",
  products: "items",
  item: "items",
  price: "total",
  amount: "total",
  address: "shipping_address",
  delivery_address: "shipping_address",
  billing: "billing_address",
  date: "order_date",
  placed_on: "order_date",
  phone: "contact",
  email: "contact",
  coupon: "discount",
  discounts: "discount",
  payment_status: "payment",
  order_status: "status",
};

const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ek: "1", do: "2", teen: "3", char: "4", chaar: "4", paanch: "5", panch: "5", chhe: "6", saat: "7", aath: "8", nau: "9", shunya: "0",
};

/** "#1001", "order 1001", "1001", "one zero zero one" -> "1001". Returns "" when unusable. */
export function parseOrderNumber(input) {
  let text = String(input ?? "").trim().toLowerCase();
  text = text.replace(/[\u0966-\u096F]/g, (ch) => String(ch.charCodeAt(0) - 0x0966));
  if (!/\d/.test(text)) {
    const words = text.split(/[^a-z]+/).filter(Boolean);
    if (words.length && words.every((w) => w in NUMBER_WORDS)) text = words.map((w) => NUMBER_WORDS[w]).join("");
  }
  text = text
    .replace(/\b(order|number|no|id|num)\b\.?/g, " ")
    .replace(/[#\s]+/g, "")
    .trim();
  return /^[a-z0-9][a-z0-9-]{0,29}$/.test(text) ? text : "";
}

const normName = (name) => String(name || "").toLowerCase().replace(/[#\s]/g, "");
function nameMatches(orderName, wanted) {
  const n = normName(orderName);
  const w = normName(wanted);
  if (!n || !w) return false;
  if (n === w) return true;
  // "1001" should find "#1001" and also "ORD-1001" (store prefix/suffix), but never "#11001".
  if (/^\d+$/.test(w)) return n.match(/(\d+)$/)?.[1] === w;
  return false;
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** True only when the order belongs to the verified identity. */
export function orderBelongsTo(order, { customerGid, verifiedEmail } = {}) {
  if (!order) return false;
  if (customerGid && order.customer?.id && order.customer.id === customerGid) return true;
  const email = normalizeEmail(verifiedEmail);
  if (!email) return false;
  return [order.email, order.customer?.email].some((candidate) => normalizeEmail(candidate) === email);
}

export function createOrderLookupService({ graphql = adminGraphql, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  /** Returns the raw Shopify order node or null. Does NOT check ownership. */
  async function findOrder(shop, orderNumber) {
    const wanted = parseOrderNumber(orderNumber);
    if (!wanted) return null;
    const queries = /^\d+$/.test(wanted) ? [`name:#${wanted}`, `name:${wanted}`] : [`name:${wanted}`, `name:#${wanted}`];
    for (const query of queries) {
      const data = await graphql(shop, ORDER_LOOKUP_QUERY, { query });
      const hit = (data?.orders?.nodes || []).find((node) => nameMatches(node.name, wanted));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Cancels an UNFULFILLED order (items go back to stock; paid orders are refunded to the
   * original payment method). Shopify runs the cancel as a background job, so the result is
   * confirmed by re-reading the order.
   */
  async function cancelOrder(shop, order, { reason = "", refund = false, notifyCustomer = true } = {}) {
    let uncertain = false;
    try {
      const data = await graphql(shop, ORDER_CANCEL, {
        orderId: order.id,
        reason: "CUSTOMER",
        refund: Boolean(refund),
        restock: true,
        notifyCustomer: Boolean(notifyCustomer),
        staffNote: `Cancelled by the customer via the AI assistant. Reason: ${String(reason).slice(0, 400)}`,
      });
      const errors = data?.orderCancel?.orderCancelUserErrors || [];
      if (errors.length) return { status: "failed", message: errors.map((e) => e.message).join("; ") };
    } catch (err) {
      if (!err?.uncertain) return { status: "failed", message: String(err?.message || err) };
      uncertain = true; // response lost: the cancel may still have gone through
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(attempt === 0 ? 400 : 700);
      const fresh = await findOrder(shop, order.name).catch(() => null);
      if (fresh?.cancelledAt) return { status: "cancelled", order: fresh };
    }
    return { status: uncertain ? "unconfirmed" : "processing" };
  }

  /**
   * The verified shopper's own orders (newest first). Shopify is asked for that customer's or that
   * email's orders, and every result is checked against the identity again before it is returned.
   */
  async function listOrders(shop, { customerGid = null, verifiedEmail = null, limit = 50 } = {}) {
    const customerNumber = String(customerGid || "").match(/(\d+)$/)?.[1] || "";
    const email = normalizeEmail(verifiedEmail);
    const query = customerNumber ? `customer_id:${customerNumber}` : email ? `email:"${email.replace(/"/g, "")}"` : "";
    if (!query) return { timezone: "UTC", orders: [], hasMore: false };
    const data = await graphql(shop, ORDER_LIST_QUERY, { query, first: Math.min(Math.max(Number(limit) || 50, 1), 100) });
    const orders = (data?.orders?.nodes || []).filter((o) => orderBelongsTo(o, { customerGid, verifiedEmail }));
    return { timezone: data?.shop?.ianaTimezone || "UTC", orders, hasMore: Boolean(data?.orders?.pageInfo?.hasNextPage) };
  }

  return { findOrder, cancelOrder, listOrders };
}

// ---------------------------------------------------------------------------
// Presentation helpers (no invented data: everything is derived from the order)
// ---------------------------------------------------------------------------

function humanize(value) {
  const text = String(value ?? "").trim();
  return text ? text.toLowerCase().replace(/_/g, " ") : null;
}

function money(set) {
  // what the shopper paid in: an order placed in rupees on a dollar store shows rupees, as the checkout, the e-mail and the chat did
  const m = set?.presentmentMoney?.amount != null ? set.presentmentMoney : set?.shopMoney;
  if (!m || m.amount == null) return null;
  return { amount: Number(m.amount), currency: m.currencyCode, display: formatMoney(Number(m.amount), m.currencyCode) };
}

function date(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    iso: d.toISOString(),
    display: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d),
  };
}

function address(addr) {
  if (!addr) return null;
  const lines = [addr.address1, addr.address2, [addr.city, addr.province, addr.zip].filter(Boolean).join(", "), addr.country].filter(Boolean);
  return { name: addr.name || null, phone: addr.phone || null, lines, display: lines.join(", ") };
}

function fulfillmentView(f) {
  const tracking = (f.trackingInfo || []).filter((t) => t && (t.number || t.url)).map((t) => ({
    carrier: t.company || null,
    trackingNumber: t.number || null,
    trackingUrl: t.url || null,
  }));
  return {
    shipmentStatus: humanize(f.displayStatus || f.status),
    shippedOn: date(f.createdAt)?.display || null,
    inTransitSince: date(f.inTransitAt)?.display || null,
    estimatedDelivery: date(f.estimatedDeliveryAt)?.display || null,
    deliveredOn: date(f.deliveredAt)?.display || null,
    tracking,
  };
}

const BUILDERS = {
  status: (o) => {
    const fulfillments = o.fulfillments || [];
    const cancelled = Boolean(o.cancelledAt);
    return {
      orderStatus: cancelled ? "cancelled" : o.closedAt ? "completed" : "open",
      cancelled: cancelled ? { on: date(o.cancelledAt)?.display || null, reason: humanize(o.cancelReason) } : null,
      paymentStatus: humanize(o.displayFinancialStatus),
      fulfillmentStatus: humanize(o.displayFulfillmentStatus),
      shipmentStatus: fulfillments.length ? fulfillments.map((f) => humanize(f.displayStatus || f.status)) : "not shipped yet",
      returnStatus: humanize(o.returnStatus),
    };
  },
  tracking: (o) => {
    const fulfillments = o.fulfillments || [];
    return fulfillments.length
      ? { shipments: fulfillments.map(fulfillmentView) }
      : { shipments: [], note: "No shipment has been created for this order yet, so there is no tracking information." };
  },
  items: (o) => ({
    items: (o.lineItems?.nodes || []).map((li) => ({
      title: li.title,
      variant: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
      quantity: li.quantity,
      unitPrice: money(li.discountedUnitPriceSet) || money(li.originalUnitPriceSet),
    })),
  }),
  payment: (o) => ({
    paymentStatus: humanize(o.displayFinancialStatus),
    paymentMethod: (o.paymentGatewayNames || []).length ? o.paymentGatewayNames : null,
    refunded: money(o.totalRefundedSet),
  }),
  total: (o) => ({
    subtotal: money(o.subtotalPriceSet),
    shipping: money(o.totalShippingPriceSet),
    tax: money(o.totalTaxSet),
    discount: money(o.totalDiscountsSet),
    total: money(o.totalPriceSet),
    refunded: money(o.totalRefundedSet),
  }),
  shipping_address: (o) => ({ shippingAddress: address(o.shippingAddress) }),
  billing_address: (o) => ({ billingAddress: address(o.billingAddress) }),
  shipping_method: (o) => ({
    shippingMethod: o.shippingLine ? { name: o.shippingLine.title || null, price: money(o.shippingLine.originalPriceSet) } : null,
  }),
  order_date: (o) => ({ placedOn: date(o.createdAt)?.display || null }),
  contact: (o) => ({ email: o.email || o.customer?.email || null, phone: o.phone || o.shippingAddress?.phone || null }),
  discount: (o) => ({ discountCodes: o.discountCodes?.length ? o.discountCodes : null, totalDiscount: money(o.totalDiscountsSet) }),
};

/** Maps whatever the AI sent to valid groups. "all" expands to every group. */
export function resolveFields(fields) {
  const list = (Array.isArray(fields) ? fields : fields ? [fields] : []).map((f) => String(f).toLowerCase().trim());
  if (list.includes("all") || list.includes("everything") || list.includes("full")) return [...ORDER_FIELD_GROUPS];
  const mapped = list.map((f) => (ORDER_FIELD_GROUPS.includes(f) ? f : ALIASES[f])).filter(Boolean);
  const unique = [...new Set(mapped)];
  return unique.length ? unique : [...DEFAULT_FIELDS];
}

/** Builds the (minimal) result the AI may use. Only requested groups are included. */
export function projectOrder(order, fields) {
  const shown = resolveFields(fields);
  const details = {};
  for (const group of shown) Object.assign(details, BUILDERS[group](order));
  return {
    orderName: order.name,
    shown,
    notShown: ORDER_FIELD_GROUPS.filter((g) => !shown.includes(g)),
    details,
  };
}

/**
 * Generic, display-ready "preview card" for ANY existing order. The widget renders every preview with one
 * renderer (title, badge, items, sections of label/value rows, totals), so nothing here is tied to one question.
 * `fields` uses the same detail groups as get_order_details (default: everything the customer may want to see).
 */
export function buildOrderPreview(order, fields = ["all"]) {
  const shown = resolveFields(fields);
  const d = {};
  for (const group of shown) Object.assign(d, BUILDERS[group](order));
  const show = (g) => shown.includes(g);
  const rows = (list) => list.filter(([, v]) => v != null && v !== "").map(([label, value]) => ({ label, value: String(value) }));
  const sections = [];

  if (show("status")) {
    const shipments = Array.isArray(d.shipmentStatus) ? d.shipmentStatus.join(", ") : d.shipmentStatus;
    sections.push({
      heading: "Status",
      rows: rows([
        ["Order", d.cancelled ? `Cancelled${d.cancelled.on ? ` on ${d.cancelled.on}` : ""}${d.cancelled.reason ? ` (${d.cancelled.reason})` : ""}` : d.orderStatus],
        ["Payment", d.paymentStatus],
        ["Delivery", d.fulfillmentStatus],
        ["Shipment", shipments],
        ["Return", d.returnStatus],
      ]),
    });
  }
  if (show("tracking") && Array.isArray(d.shipments)) {
    if (!d.shipments.length) sections.push({ heading: "Tracking", rows: rows([["Tracking", "Not shipped yet"]]) });
    d.shipments.forEach((sh, i) => {
      const t = sh.tracking?.[0] || {};
      sections.push({
        heading: d.shipments.length > 1 ? `Shipment ${i + 1}` : "Tracking",
        rows: rows([
          ["Status", sh.shipmentStatus],
          ["Shipped on", sh.shippedOn],
          ["Courier", t.carrier],
          ["Tracking no.", t.trackingNumber],
          ["Track", t.trackingUrl],
          ["Expected delivery", sh.estimatedDelivery],
          ["Delivered on", sh.deliveredOn],
        ]),
      });
    });
  }
  if (show("payment") && !show("status")) {
    sections.push({
      heading: "Payment",
      rows: rows([
        ["Status", d.paymentStatus],
        ["Method", Array.isArray(d.paymentMethod) ? d.paymentMethod.join(", ") : d.paymentMethod],
        ["Refunded", d.refunded?.display],
      ]),
    });
  }
  if (show("payment") && show("status") && d.paymentMethod) {
    sections[0]?.rows.push({ label: "Method", value: [].concat(d.paymentMethod).join(", ") });
  }
  if (show("shipping_address") && d.shippingAddress) {
    sections.push({ heading: "Delivery address", rows: rows([["Name", d.shippingAddress.name], ["Address", d.shippingAddress.display], ["Phone", d.shippingAddress.phone]]) });
  }
  if (show("billing_address") && d.billingAddress) {
    sections.push({ heading: "Billing address", rows: rows([["Name", d.billingAddress.name], ["Address", d.billingAddress.display]]) });
  }
  if (show("shipping_method") && d.shippingMethod) {
    sections.push({ heading: "Shipping method", rows: rows([["Method", d.shippingMethod.name], ["Charge", d.shippingMethod.price?.display]]) });
  }
  if (show("order_date") && d.placedOn) sections.push({ heading: "Order date", rows: rows([["Placed on", d.placedOn]]) });
  if (show("contact")) sections.push({ heading: "Contact", rows: rows([["Email", d.email], ["Phone", d.phone]]) });
  if (show("discount") && d.discountCodes) sections.push({ heading: "Discount", rows: rows([["Code", [].concat(d.discountCodes).join(", ")]]) });

  const totals = [];
  if (show("total")) {
    const t = (label, m, extra = {}) => m?.display && totals.push({ label, value: m.display, ...extra });
    t("Subtotal", d.subtotal);
    if (d.discount?.amount) t("Discount", d.discount);
    t("Shipping", d.shipping);
    if (d.tax?.amount) t("Tax", d.tax);
    t("Total", d.total, { strong: true });
    if (d.refunded?.amount) t("Refunded", d.refunded);
  }

  const badge = d.cancelled ? "Cancelled" : d.fulfillmentStatus || d.orderStatus || null;
  return {
    kind: "order",
    title: `Order ${order.name}`,
    badge: badge ? String(badge) : null,
    items: show("items") ? (d.items || []).map((i) => ({ title: i.title, variant: i.variant, quantity: i.quantity, price: i.unitPrice?.display || null })) : [],
    sections: sections.filter((x) => x.rows.length),
    totals,
  };
}
// ---------------------------------------------------------------------------
// "How many orders have I placed?" summary
// ---------------------------------------------------------------------------
const localDay = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const dayNumber = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / 86400000;

/**
 * Counts for today / the last 7 / the last 30 days (calendar days in the store's time zone) and a short
 * line per recent order. Cancelled orders are listed but not counted as placed orders in the totals.
 */
export function summarizeOrders(orders = [], { timezone = "UTC", now = Date.now(), recent = 10 } = {}) {
  let tz = timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  const today = dayNumber(localDay(now, tz));
  const counts = { today: 0, last7Days: 0, last30Days: 0, total: 0, cancelled: 0 };
  for (const o of orders) {
    if (o.cancelledAt) { counts.cancelled += 1; continue; }
    const age = today - dayNumber(localDay(o.createdAt, tz));
    counts.total += 1;
    if (age === 0) counts.today += 1;
    if (age < 7) counts.last7Days += 1;
    if (age < 30) counts.last30Days += 1;
  }
  const items = (o) => (o.lineItems?.nodes || []).map((li) => `${li.quantity} x ${li.title}`);
  return {
    timezone: tz,
    counts,
    recentOrders: orders.slice(0, recent).map((o) => ({
      orderName: o.name,
      placedOn: localDay(o.createdAt, tz),
      status: o.cancelledAt ? "cancelled" : humanize(o.displayFulfillmentStatus),
      payment: humanize(o.displayFinancialStatus),
      total: money(o.totalPriceSet)?.display || null,
      items: items(o),
    })),
  };
}