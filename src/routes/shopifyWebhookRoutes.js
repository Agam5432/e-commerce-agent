// Shopify webhooks beyond app/uninstalled: the three mandatory privacy topics and orders/create (so
// orders that came out of a chat are counted for the store owner). Every request is checked with
// Shopify's signature first; the store comes from the signed headers, never from the body.
import crypto from "node:crypto";
import { reportError } from "../observability/errors.js";
import { webhookQueue } from "../services/webhookQueue.js";
import { verifyShopifyWebhookHmac, isValidShopDomain } from "./shopifyOAuthRoutes.js";
import { normalizeShopDomain } from "../services/storeIntegrationService.js";
import { eraseCustomer, eraseShop, fulfillDataRequest } from "../services/dataPrivacy.js";
import { recordEvent } from "../services/conversationLog.js";
import ecommerce from "../industries/ecommerce.js";
import Conversation from "../models/Conversation.js";
import Event from "../models/Event.js";
import { AI_ORDER_TAG, CHAT_REF_ATTRIBUTE } from "../services/shopifyOrderService.js";
import { adminGraphql } from "../services/shopifyAdminService.js";

const ATTRIBUTION_WINDOW_MS = Number(process.env.ATTRIBUTION_WINDOW_DAYS || 7) * 86400_000;

/** The delivery's id: X-Shopify-Webhook-Id, or (if a proxy dropped it) a hash of what was signed. */
export function deliveryId(header, raw, topic, shop) {
  const given = String(header("X-Shopify-Webhook-Id") || "").trim();
  if (/^[A-Za-z0-9._:-]{8,120}$/.test(given)) return given;
  return `sha:${crypto.createHash("sha256").update(`${shop}\n${topic}\n`).update(raw ?? "").digest("hex")}`;
}

/**
 * Turns "handle this verified webhook" into an Express handler: signature, store, then the work.
 * With the database up, the delivery is written down and answered 200 at once; the work runs right
 * after, and is retried by us if it fails (see webhookQueue.js). A delivery seen before is skipped.
 * Without the database the work is done before answering, and a failure answers 500 so Shopify retries.
 */
export function webhookHandler(work, { verify = verifyShopifyWebhookHmac, kind = "", queue = webhookQueue() } = {}) {
  if (kind) queue.register(kind, work);
  return async (req, res) => {
    const header = (name) => req.get?.(name) || req.headers?.[name.toLowerCase()];
    const raw = req.rawBody ?? req.body;
    if (!verify(raw, header("X-Shopify-Hmac-Sha256"))) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }
    const shop = normalizeShopDomain(header("X-Shopify-Shop-Domain"));
    if (!isValidShopDomain(shop)) return res.status(400).json({ error: "Invalid shop domain in webhook." });
    const topic = String(header("X-Shopify-Topic") || "");
    const body = req.body || {};
    try {
      if (kind && queue.durable()) {
        const id = deliveryId(header, raw, topic, shop);
        if ((await queue.accept({ id, kind, shop, topic, body })) === "duplicate") return res.status(200).json({ ok: true, duplicate: true });
        res.status(200).json({ ok: true });
        // after the answer: Shopify does not wait for this
        setImmediate(() => queue.run(id).catch((error) => console.error("[webhook] run failed:", String(error?.message || error).slice(0, 200))));
        return undefined;
      }
      await work({ shop, topic, body });
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("[webhook] failed:", String(error?.message || error).slice(0, 200));
      reportError(error, { scope: "webhook" });
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  };
}

/** customers/data_request, customers/redact, shop/redact (one URL; the topic header says which). */
export async function handleComplianceTopic({ shop, topic, body }, deps = {}) {
  const run = {
    erase: deps.eraseCustomer || eraseCustomer,
    request: deps.fulfillDataRequest || fulfillDataRequest,
    shop: deps.eraseShop || eraseShop,
  };
  if (topic === "customers/redact") return run.erase(shop, { customer: body.customer, ordersToRedact: body.orders_to_redact || [] });
  if (topic === "customers/data_request") return run.request(shop, body);
  if (topic === "shop/redact") return run.shop(shop);
  throw new Error(`Unhandled compliance topic: ${topic}`);
}

/**
 * orders/create: an order that carries the chat reference (set by the agent on its own orders, or on
 * the cart by the widget) is counted as an order from that chat, if the chat was recent enough.
 * The same order seen twice (agent + webhook) is counted once.
 */
export async function attributeShopifyOrder(shop, order = {}, deps = {}) {
  const { Conversation: Convo = Conversation, Event: Events = Event, record = recordEvent, analytics = ecommerce.analytics } = deps;
  const ref = (order.note_attributes || []).find((a) => a?.name === CHAT_REF_ATTRIBUTE)?.value;
  if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(ref) || !order.name) return { attributed: false };

  const placedAt = Date.parse(order.created_at) || Date.now();
  const conversation = await Convo.findOne({ shop, chatRef: ref, lastMessageAt: { $gte: new Date(placedAt - ATTRIBUTION_WINDOW_MS) } }).sort({ lastMessageAt: -1 }).lean();
  if (!conversation) return { attributed: false };

  const money = order.total_price_set?.shop_money;
  // Shopify's own figure, in the store's currency: what revenue is counted from
  const inStoreCurrency = money?.amount !== undefined && money?.currency_code ? { shopTotal: Number(money.amount) || 0, shopCurrency: String(money.currency_code) } : {};
  const created = await record({
    shop,
    type: "order_placed",
    dedupeKey: `order:${order.name}`,
    conversationId: conversation._id,
    chatRef: ref,
    at: new Date(placedAt),
    props: {
      orderName: String(order.name),
      total: Number(money?.amount ?? order.total_price) || 0,
      currency: String(money?.currency_code || order.currency || ""),
      // The agent tags its orders "COD" or "Online-Payment". Shopify's gateway for a cash-on-delivery draft order is
      // just "manual", which the dashboard would show as "Manual": the tag says what the shopper chose.
      paymentMethod: (() => {
        const tags = String(order.tags || "").split(",").map((t) => t.trim().toLowerCase());
        if (tags.includes("cod")) return "cod";
        if (tags.includes("online-payment")) return "online";
        return (order.payment_gateway_names || []).join(",").slice(0, 60);
      })(),
      // an order that is already cancelled when we first hear of it (a late or retried delivery) must not count as revenue
      ...(order.cancelled_at ? { cancelledAt: new Date(Date.parse(order.cancelled_at) || Date.now()) } : {}),
      items: Array.isArray(order.line_items) ? order.line_items.length : 0,
      discountAmount: Number(order.total_discounts) || 0,
      source: String(order.tags || "").split(",").map((t) => t.trim()).includes(AI_ORDER_TAG) ? "agent" : "assisted",
      ...inStoreCurrency,
    },
  });
  // The agent logged this order first, in the shopper's currency: add Shopify's store-currency amount to it.
  if (!created && inStoreCurrency.shopCurrency) {
    await Events.updateOne({ shop, dedupeKey: `order:${order.name}` }, { $set: { "props.shopTotal": inStoreCurrency.shopTotal, "props.shopCurrency": inStoreCurrency.shopCurrency } });
  }
  const rank = analytics?.outcomes?.order_placed || 0;
  if (created && !order.cancelled_at && rank > (conversation.outcomeRank || 0)) {
    await Convo.updateOne({ _id: conversation._id, shop, outcomeRank: { $lt: rank } }, { $set: { outcome: "order_placed", outcomeRank: rank } });
  }
  return { attributed: true, counted: created };
}

/**
 * orders/cancelled: the order stays in the list (the owner still sees it, marked cancelled from Shopify's own
 * status) but stops counting as an order or as revenue. Only this store's event for this order is touched, and
 * only once (the same delivery twice changes nothing). An order that never came from a chat has no event: no-op.
 */
export async function markOrderCancelled(shop, order = {}, deps = {}) {
  const { Event: Events = Event, analytics = ecommerce.analytics } = deps;
  if (!order.name) return { updated: false };
  const at = new Date(Date.parse(order.cancelled_at) || Date.now());
  const done = await Events.updateOne(
    { shop, type: analytics?.revenue?.event || "order_placed", dedupeKey: `order:${order.name}`, "props.cancelledAt": { $exists: false } },
    { $set: { "props.cancelledAt": at, "props.cancelReason": String(order.cancel_reason || "").slice(0, 40) } },
  );
  return { updated: (done?.modifiedCount || 0) > 0 };
}

// What Shopify itself says about one order right now: whether it is cancelled, how it was paid and how much was
// refunded, in the store's own currency. Refunds are never worked out from anything else.
export const ORDER_STATE_QUERY = `query OrderState($id: ID!) {
  order(id: $id) {
    id name cancelledAt displayFinancialStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    totalRefundedSet { shopMoney { amount currencyCode } }
    customAttributes { key value }
  }
}`;
const orderGid = (value) => (/^\d+$/.test(String(value ?? "")) ? `gid://shopify/Order/${value}` : String(value ?? ""));
const cents = (value) => Math.round((Number(value) || 0) * 100);

/**
 * Writes Shopify's CURRENT state of one order onto this store's event for it. It sets values, it never adds to them,
 * so a delivery repeated, late or out of order (create, cancel, refund in any sequence) ends in the same place.
 * @returns {Promise<{reconciled: boolean, reason?: string, order?: object}>} "no_event" when the order was never recorded here.
 */
export async function reconcileOrder(shop, orderId, deps = {}) {
  const { Event: Events = Event, graphql = adminGraphql, analytics = ecommerce.analytics } = deps;
  const id = orderGid(orderId);
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(id)) return { reconciled: false, reason: "no_order_id" };
  const order = (await graphql(shop, ORDER_STATE_QUERY, { id }))?.order;
  if (!order?.name) return { reconciled: false, reason: "order_not_found" };
  const total = order.totalPriceSet?.shopMoney;
  const refunded = order.totalRefundedSet?.shopMoney;
  const status = String(order.displayFinancialStatus || "").toUpperCase();
  const set = { "props.financialStatus": status.toLowerCase().replace(/_/g, " "), "props.reconciledAt": new Date() };
  if (total?.currencyCode && total.amount != null) {
    set["props.shopTotal"] = Number(total.amount) || 0;
    set["props.shopCurrency"] = String(total.currencyCode);
    if (refunded?.amount != null && (!refunded.currencyCode || refunded.currencyCode === total.currencyCode)) {
      set["props.refundedTotal"] = Number(refunded.amount) || 0;
      // refunded in full, or the payment was voided: not an order any more
      set["props.refundedInFull"] = status === "REFUNDED" || status === "VOIDED" || (cents(total.amount) > 0 && cents(refunded.amount) >= cents(total.amount));
    }
  }
  if (order.cancelledAt) set["props.cancelledAt"] = new Date(Date.parse(order.cancelledAt) || Date.now());
  const done = await Events.updateOne({ shop, type: analytics?.revenue?.event || "order_placed", dedupeKey: `order:${order.name}` }, { $set: set });
  return done?.matchedCount ? { reconciled: true, order } : { reconciled: false, reason: "no_event", order };
}

/**
 * orders/create and orders/cancelled: make sure the order's event exists (so a cancel that is processed first still
 * leaves a cancelled event behind, and the create that follows cannot revive it), then take Shopify's current state.
 * The state read is best effort here: the delivery itself already carries the cancellation.
 */
export async function handleOrderEvent(shop, order = {}, deps = {}) {
  const attribution = await attributeShopifyOrder(shop, order, deps);
  if (order.cancelled_at) await markOrderCancelled(shop, order, deps);
  const state = await (deps.reconcile || reconcileOrder)(shop, order.admin_graphql_api_id || order.id, deps).catch((error) => {
    console.warn(`[webhook] order state for ${order.name || order.id} not read: ${String(error?.message || error).slice(0, 160)}`);
    return { reconciled: false, reason: "state_unavailable" };
  });
  return { ...attribution, reconciled: state.reconciled };
}

/**
 * refunds/create: the refund itself carries only an order id, so the refund total is read from Shopify. If the order
 * is not recorded yet but did come from a chat, its orders/create has not been processed: fail so the delivery is
 * retried later. Any other order is not ours and is left alone.
 */
export async function handleRefund(shop, refund = {}, deps = {}) {
  const state = await (deps.reconcile || reconcileOrder)(shop, refund.order_id, deps);
  if (state.reason === "no_event" && (state.order?.customAttributes || []).some((a) => a?.key === CHAT_REF_ATTRIBUTE && /^[A-Za-z0-9_-]{10,40}$/.test(String(a.value)))) {
    throw new Error(`Refund for ${state.order.name} arrived before the order was recorded; will retry.`);
  }
  return state;
}

export const complianceWebhook = webhookHandler((ctx) => handleComplianceTopic(ctx), { kind: "compliance" });
export const ordersCreateWebhook = webhookHandler(({ shop, body }) => handleOrderEvent(shop, body), { kind: "orders-create" });
export const ordersCancelledWebhook = webhookHandler(({ shop, body }) => handleOrderEvent(shop, body), { kind: "orders-cancelled" });
export const refundsCreateWebhook = webhookHandler(({ shop, body }) => handleRefund(shop, body), { kind: "refunds-create" });
