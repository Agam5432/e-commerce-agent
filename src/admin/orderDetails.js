// One order for the owner's Orders page: what Shopify says about it (items, amounts, payment and delivery
// status), shown only for orders that came from this store's chats. The list gets the two statuses from
// one batched Shopify call, so a slow or refused Shopify never breaks the list.
import { adminGraphql } from "../services/shopifyAdminService.js";
import { createOrderLookupService, parseOrderNumber } from "../services/shopifyOrderLookupService.js";
import Event from "../models/Event.js";

const STATUS_QUERY = `query OrderStatuses($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    nodes { name cancelledAt displayFinancialStatus displayFulfillmentStatus }
  }
}`;

export class OrderLookupError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const money = (set) => {
  const m = set?.shopMoney;
  return m && m.amount != null ? { amount: Number(m.amount), currency: m.currencyCode || "" } : null;
};
const word = (value) => String(value || "").toLowerCase().replace(/_/g, " ").trim() || null;
const digitsOf = (name) => String(name || "").match(/(\d+)\s*$/)?.[1] || "";
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const address = (a) => {
  if (!a) return null;
  const lines = [a.address1, a.address2, [a.city, a.province, a.zip].filter(Boolean).join(", "), a.country].filter(Boolean);
  return { name: a.name || "", phone: a.phone || "", lines };
};

/** Plain facts for the screen from a Shopify order node. */
export function presentOrder(node) {
  const lines = (node.lineItems?.nodes || []).map((li) => {
    const unit = money(li.discountedUnitPriceSet) || money(li.originalUnitPriceSet);
    return {
      title: li.title || "",
      variant: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
      quantity: li.quantity || 0,
      unitPrice: unit,
      lineTotal: unit ? { amount: Math.round(unit.amount * (li.quantity || 0) * 100) / 100, currency: unit.currency } : null,
    };
  });
  return {
    name: node.name || "",
    shopifyId: String(node.id || "").match(/(\d+)$/)?.[1] || "",
    createdAt: node.createdAt || null,
    cancelledAt: node.cancelledAt || null,
    cancelReason: word(node.cancelReason),
    closedAt: node.closedAt || null,
    paymentStatus: word(node.displayFinancialStatus),
    fulfillmentStatus: word(node.displayFulfillmentStatus),
    returnStatus: word(node.returnStatus),
    gateways: node.paymentGatewayNames || [],
    discountCodes: node.discountCodes || [],
    email: node.email || node.customer?.email || "",
    phone: node.phone || node.shippingAddress?.phone || "",
    items: lines,
    amounts: {
      subtotal: money(node.subtotalPriceSet),
      shipping: money(node.totalShippingPriceSet),
      tax: money(node.totalTaxSet),
      discounts: money(node.totalDiscountsSet),
      total: money(node.totalPriceSet),
      refunded: money(node.totalRefundedSet),
    },
    shippingMethod: node.shippingLine?.title || "",
    shippingAddress: address(node.shippingAddress),
    billingAddress: address(node.billingAddress),
    shipments: (node.fulfillments || []).map((f) => ({
      status: word(f.displayStatus || f.status),
      shippedAt: f.createdAt || null,
      estimatedDeliveryAt: f.estimatedDeliveryAt || null,
      deliveredAt: f.deliveredAt || null,
      tracking: (f.trackingInfo || []).filter((t) => t && (t.number || t.url)).map((t) => ({ company: t.company || "", number: t.number || "", url: t.url || "" })),
    })),
  };
}

/** The order the chat recorded, matched by the number in its name ("#1042" and "1042" are the same). */
async function recordedOrder(shop, number, { analytics, Events }) {
  const rows = await Events.find({ shop, type: analytics.revenue?.event || "order_placed", "props.orderName": { $regex: `(^|[^0-9])${escapeRegex(number)}$` } }).sort({ at: -1 }).limit(1).lean();
  return rows[0] || null;
}

const fail = (error) => {
  if (error?.code === "SHOPIFY_ACCESS_DENIED" || /access denied|access scope|not approved|protected.customer.data/i.test(String(error?.message))) {
    return new OrderLookupError("Shopify has not allowed this app to read order details yet.", 502);
  }
  return new OrderLookupError("Shopify did not answer. Try again in a moment.", 502);
};

/**
 * @returns {Promise<{recorded: object, order: object | null, notice: string} | null>} null when this store's chats never placed that order
 */
export async function orderDetails(shop, name, { analytics = {}, lookup = createOrderLookupService(), Events = Event } = {}) {
  const number = digitsOf(parseOrderNumber(name));
  if (!number || number.length > 12) throw new OrderLookupError("That order number is not valid.", 400);
  const recorded = await recordedOrder(shop, number, { analytics, Events });
  if (!recorded) return null;
  const mine = { at: recorded.at, conversationId: recorded.conversationId ? String(recorded.conversationId) : null, ...recorded.props };
  const customerCancel = await customerCancellation(shop, number, Events);
  let node;
  try {
    node = await lookup.findOrder(shop, number);
  } catch (error) {
    throw fail(error);
  }
  const extra = customerCancel ? { customerCancel } : {};
  return node
    ? { recorded: mine, order: presentOrder(node), notice: "", ...extra }
    : { recorded: mine, order: null, notice: "Shopify could not find this order. It may have been deleted there.", ...extra };
}

/** Why the customer cancelled, in their own words, kept by the assistant (this store's record only). */
async function customerCancellation(shop, number, Events) {
  const rows = await Events.find({ shop, type: "order_cancel_reason", "props.orderName": { $regex: `(^|[^0-9])${escapeRegex(number)}$` } }).sort({ at: -1 }).limit(1).lean();
  const row = rows.find((r) => r?.type === "order_cancel_reason");
  if (!row?.props?.reason) return null;
  return { reason: String(row.props.reason), at: row.at || null, via: row.props.via || "ai_assistant", conversationId: row.conversationId ? String(row.conversationId) : null };
}

/**
 * Payment and delivery status for a page of orders, by order name. Anything Shopify cannot tell is simply absent.
 * @returns {Promise<Record<string, {payment: string | null, fulfillment: string | null, cancelled: boolean}>>}
 */
export async function orderStatuses(shop, names, { graphql = adminGraphql, waitMs = 4000 } = {}) {
  const numbers = [...new Set((names || []).map(digitsOf).filter(Boolean))].slice(0, 50);
  if (!numbers.length) return {};
  const ask = graphql(shop, STATUS_QUERY, { query: numbers.map((n) => `name:#${n}`).join(" OR "), first: numbers.length });
  let timer;
  try {
    const data = await Promise.race([ask, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
    ask.catch(() => {});
    const out = {};
    for (const n of data?.orders?.nodes || []) {
      const key = digitsOf(n.name);
      if (key) out[key] = { payment: word(n.displayFinancialStatus), fulfillment: word(n.displayFulfillmentStatus), cancelled: Boolean(n.cancelledAt) };
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
