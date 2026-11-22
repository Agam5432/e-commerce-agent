// The reason a customer gave for cancelling is kept against that store's order and shown to the owner.
// Uses a throwaway local MongoDB (skipped when none is installed). Shopify itself is SCRIPTED here: this is a
// MOCK/AUTOMATED test, not a real-store verification.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTempMongo } from "./helpers/tempMongo.js";
import ecommerce from "../src/industries/ecommerce.js";
import Event from "../src/models/Event.js";
import { createOrderLookupAuth, createMemoryStore } from "../src/services/orderLookupAuth.js";
import { orderDetails } from "../src/admin/orderDetails.js";
import { markOrderCancelled } from "../src/routes/shopifyWebhookRoutes.js";
import { orderDetailView } from "../src/public/admin/lib/orders.js";

const A = "alpha.myshopify.com";
const B = "beta.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";
const analytics = { revenue: { event: "order_placed" } };

before(async () => { if (mongo.available) await Event.init(); });
after(async () => { await mongo.stop?.(); });
beforeEach(async () => { if (mongo.available) await Event.deleteMany({}); });

const money = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: "INR" } });
const order = (name = "#1002") => ({
  id: "gid://shopify/Order/555", name, createdAt: "2026-10-20T10:00:00Z", cancelledAt: null, cancelReason: null, closedAt: null,
  email: "buyer@example.com", currencyCode: "INR", displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", returnStatus: "NO_RETURN",
  paymentGatewayNames: ["Cash on Delivery (COD)"], discountCodes: [], customer: { id: "gid://shopify/Customer/7", email: "buyer@example.com" },
  subtotalPriceSet: money(900), totalShippingPriceSet: money(0), totalTaxSet: money(0), totalDiscountsSet: money(0), totalPriceSet: money(900), totalRefundedSet: money(0),
  lineItems: { nodes: [{ title: "Linen Shirt", variantTitle: "L", quantity: 1, originalUnitPriceSet: money(900), discountedUnitPriceSet: money(900) }] }, fulfillments: [],
});

function session(shop, shopifyOrder, { cancelStatus = "cancelled" } = {}) {
  const store = createMemoryStore(() => 1_800_000_000_000);
  const auth = createOrderLookupAuth({ store, now: () => 1_800_000_000_000, isEmailConfigured: () => true, devLog: false, sendEmail: async () => ({ ok: true }) });
  const cancelCalls = [];
  const orderLookup = {
    findOrder: async () => shopifyOrder,
    cancelOrder: async (_s, o, opts) => { cancelCalls.push(opts); return { status: cancelStatus, order: o }; },
  };
  const make = (message) => ecommerce.createSession(shop, { clientId: "c1", chatRef: "chat-abc-1234567", userMessage: message, history: [], replyLanguage: "en", verifiedCustomerId: "gid://shopify/Customer/7", customerLoggedIn: true }, { orderAuth: auth, orderLookup, loadCheckout: async () => null, saveCheckout: async () => null });
  return { make, cancelCalls };
}

async function cancelThrough(s, reasonText) {
  await s.make("cancel 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  return s.make(reasonText).handlers.cancel_order({ reason: reasonText });
}
const placed = (shop, name = "#1002") => Event.create({ shop, type: "order_placed", at: new Date(), dedupeKey: `order:${name}`, props: { orderName: name, total: 900, currency: "INR", source: "agent" }, expiresAt: new Date(Date.now() + 1e9) });
const lookup = (o) => ({ findOrder: async () => o });

test("the customer's exact words are stored against the store's order, once, and shown to the owner", { skip }, async () => {
  await placed(A);
  const s = session(A, order());
  const text = "galat product order kiya tha, size bhi sahi nahi";
  assert.equal((await cancelThrough(s, text)).status, "cancelled");
  assert.equal(s.cancelCalls[0].reason, text);

  const rows = await Event.find({ type: "order_cancel_reason" }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shop, A);
  assert.equal(rows[0].props.reason, text, "original Hinglish text, not rewritten");
  assert.equal(rows[0].props.via, "ai_assistant");

  const found = await orderDetails(A, "1002", { analytics, lookup: lookup({ ...order(), cancelledAt: "2026-10-29T10:00:00Z", cancelReason: "CUSTOMER" }) });
  assert.equal(found.customerCancel.reason, text);
  const view = orderDetailView(found, { timezone: "Asia/Kolkata" });
  assert.equal(view.cancelReason, text);
  assert.equal(view.cancelledThrough, "AI Assistant");
  assert.match(view.cancelNote, /^Cancelled /);
});

test("the reason survives Shopify's cancelled webhook, a repeat webhook and reading it again (refresh/restart)", { skip }, async () => {
  await placed(A);
  await cancelThrough(session(A, order()), "ordered the wrong product");
  const hook = { name: "#1002", cancelled_at: "2026-10-29T10:00:00Z", cancel_reason: "customer" };
  await markOrderCancelled(A, hook);
  await markOrderCancelled(A, hook);
  for (let i = 0; i < 2; i++) {
    const found = await orderDetails(A, "1002", { analytics, lookup: lookup(order()) });
    assert.equal(found.customerCancel.reason, "ordered the wrong product");
  }
  assert.equal(await Event.countDocuments({ type: "order_cancel_reason" }), 1, "no duplicate record");
});

test("a second cancel attempt for the same order updates the one record instead of adding another", { skip }, async () => {
  await placed(A);
  await cancelThrough(session(A, order(), { cancelStatus: "processing" }), "too expensive");
  await cancelThrough(session(A, order()), "found it cheaper elsewhere");
  const rows = await Event.find({ type: "order_cancel_reason" }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props.reason, "found it cheaper elsewhere");
  assert.equal(rows[0].props.cancelStatus, "cancelled");
});

test("a cancel Shopify refused keeps no reason (nothing was cancelled)", { skip }, async () => {
  await placed(A);
  assert.equal((await cancelThrough(session(A, order(), { cancelStatus: "failed" }), "changed my mind")).status, "cancel_failed");
  assert.equal(await Event.countDocuments({ type: "order_cancel_reason" }), 0);
});

test("store isolation: another store never sees the reason, even for the same order number", { skip }, async () => {
  await placed(A);
  await placed(B);
  await cancelThrough(session(A, order()), "only store A should see this");
  assert.equal((await orderDetails(A, "1002", { analytics, lookup: lookup(order()) })).customerCancel.reason, "only store A should see this");
  const other = await orderDetails(B, "1002", { analytics, lookup: lookup(order()) });
  assert.equal(other.customerCancel, undefined);
  assert.equal(JSON.stringify(other).includes("only store A"), false);
  assert.equal(orderDetailView(other).cancelReason, "");
});

test("a cancel confirmed through the chat marks the order's analytics event cancelled at once, without waiting for the orders/cancelled webhook", { skip }, async () => {
  await placed(A, "#1002");
  const s = session(A, order());
  assert.equal((await cancelThrough(s, "changed my mind")).status, "cancelled");
  const ev = await Event.findOne({ shop: A, type: "order_placed", dedupeKey: "order:#1002" }).lean();
  assert.ok(ev.props.cancelledAt, "the event carries cancelledAt");
  assert.equal(ev.props.cancelReason, "customer");
});
