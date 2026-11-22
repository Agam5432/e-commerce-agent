// orders/cancelled and refunds/create, as the HTTP handlers see them: signature, store, duplicates, retries, and the rules each applies.
// Shopify and the queue's storage are SCRIPTED here (AUTOMATED / MOCK TESTED): this proves the app side of a delivery, not that Shopify
// sends it. (The real database order-sequence cases live in oneChatPerPerson.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { webhookHandler, deliveryId, handleOrderEvent, handleRefund, markOrderCancelled, reconcileOrder } from "../src/routes/shopifyWebhookRoutes.js";
import { createWebhookQueue } from "../src/services/webhookQueue.js";

process.env.SHOPIFY_CLIENT_SECRET = "test-secret-for-webhook-signatures";
const SHOP = "techstore-test.myshopify.com";
const sign = (raw) => crypto.createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest("base64");
const analytics = { revenue: { event: "order_placed" } };

/** A request as Express hands it over: the raw bytes, the parsed body and the headers. */
function request(payload, { topic, shop = SHOP, webhookId = "evt-1234567890", hmac, tamper = false } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { "x-shopify-hmac-sha256": hmac ?? sign(tamper ? Buffer.from("{}") : raw), "x-shopify-shop-domain": shop, "x-shopify-topic": topic, ...(webhookId ? { "x-shopify-webhook-id": webhookId } : {}) };
  return { rawBody: raw, body: payload, headers, get: (n) => headers[n.toLowerCase()] };
}
const response = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

/** A queue that only remembers ids: accept() says "duplicate" the second time. run() is awaited by the tests themselves. */
function memoryQueue() {
  const seen = new Set(); const jobs = new Map();
  return { seen, jobs, register() {}, durable: () => true, async accept(job) { if (seen.has(job.id)) return "duplicate"; seen.add(job.id); jobs.set(job.id, job); return "queued"; }, async run() {} };
}

test("orders/cancelled: a correctly signed delivery is accepted and queued under Shopify's delivery id; a repeat of it is answered 200 and not queued again", async () => {
  const queue = memoryQueue();
  const handler = webhookHandler(async () => {}, { kind: "orders-cancelled", queue });
  const payload = { id: 11, name: "#1042", cancelled_at: "2026-11-16T10:00:00Z", cancel_reason: "customer" };

  const first = response(); await handler(request(payload, { topic: "orders/cancelled" }), first);
  assert.equal(first.code, 200); assert.deepEqual(first.body, { ok: true });
  assert.equal(queue.jobs.get("evt-1234567890").shop, SHOP);
  assert.equal(queue.jobs.get("evt-1234567890").topic, "orders/cancelled");

  const again = response(); await handler(request(payload, { topic: "orders/cancelled" }), again);
  assert.equal(again.code, 200); assert.equal(again.body.duplicate, true);
  assert.equal(queue.jobs.size, 1, "the same delivery is stored once");
});

test("a wrong or missing signature is refused with 401 and nothing is queued or worked on", async () => {
  for (const topic of ["orders/cancelled", "refunds/create"]) {
    const queue = memoryQueue(); let worked = 0;
    const handler = webhookHandler(async () => { worked++; }, { kind: topic, queue });
    for (const opts of [{ tamper: true }, { hmac: "AAAA" }, { hmac: "" }]) {
      const res = response(); await handler(request({ id: 1 }, { topic, ...opts }), res);
      assert.equal(res.code, 401, `${topic} ${JSON.stringify(opts)}`);
    }
    assert.equal(queue.jobs.size, 0); assert.equal(worked, 0);
  }
});

test("a store that is not a *.myshopify.com domain is refused with 400, even with a valid signature", async () => {
  const queue = memoryQueue();
  const handler = webhookHandler(async () => {}, { kind: "orders-cancelled", queue });
  for (const shop of ["evil.example.com", "", "techstore-test.myshopify.com.evil.com"]) {
    const res = response(); await handler(request({ id: 1 }, { topic: "orders/cancelled", shop }), res);
    assert.equal(res.code, 400, shop);
  }
  assert.equal(queue.jobs.size, 0);
});

test("the store comes from the signed header, never from the body: a body naming another store changes nothing", async () => {
  const queue = memoryQueue();
  const handler = webhookHandler(async () => {}, { kind: "orders-cancelled", queue });
  await handler(request({ id: 1, shop: "other-store.myshopify.com", shop_domain: "other-store.myshopify.com" }, { topic: "orders/cancelled" }), response());
  assert.equal([...queue.jobs.values()][0].shop, SHOP);
});

test("without a delivery id header (a proxy dropped it) the id is a hash of what was signed, so a replay is still recognised", () => {
  const raw = Buffer.from('{"id":1}');
  const get = () => undefined;
  const a = deliveryId(get, raw, "orders/cancelled", SHOP);
  assert.match(a, /^sha:[0-9a-f]{64}$/);
  assert.equal(a, deliveryId(get, raw, "orders/cancelled", SHOP));
  assert.notEqual(a, deliveryId(get, raw, "refunds/create", SHOP), "another topic is another delivery");
  assert.notEqual(a, deliveryId(get, raw, "orders/cancelled", "b.myshopify.com"), "another store is another delivery");
});

test("without a database the work is done before answering: success is 200, a failure is 500 so Shopify retries", async () => {
  const ok = webhookHandler(async () => {}, { kind: "k", queue: { register() {}, durable: () => false } });
  const bad = webhookHandler(async () => { throw new Error("Shopify down"); }, { kind: "k", queue: { register() {}, durable: () => false } });
  const r1 = response(); await ok(request({ id: 1 }, { topic: "orders/cancelled" }), r1); assert.equal(r1.code, 200);
  const r2 = response(); await bad(request({ id: 1 }, { topic: "orders/cancelled" }), r2); assert.equal(r2.code, 500);
});

// ---------------------------------------------------------------- what each webhook does to the order's event
function eventStore(initial = []) {
  const rows = initial.map((r) => ({ ...r, props: { ...r.props } }));
  return {
    rows,
    async updateOne(filter, update) {
      const row = rows.find((r) => r.shop === filter.shop && r.type === filter.type && r.dedupeKey === filter.dedupeKey && (!("props.cancelledAt" in filter) || !r.props.cancelledAt));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      for (const [k, v] of Object.entries(update.$set || {})) row.props[k.replace(/^props\./, "")] = v;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}
const placed = (name = "#1042", shop = SHOP, props = {}) => ({ shop, type: "order_placed", dedupeKey: `order:${name}`, props: { orderName: name, total: 100, shopTotal: 100, shopCurrency: "USD", ...props } });
const shopifyState = ({ name = "#1042", total = "100.00", refunded = "0.00", status = "PAID", cancelledAt = null, ref = "chat-ref-1234567890" } = {}) => async () => ({
  order: { id: "gid://shopify/Order/11", name, cancelledAt, displayFinancialStatus: status, totalPriceSet: { shopMoney: { amount: total, currencyCode: "USD" } }, totalRefundedSet: { shopMoney: { amount: refunded, currencyCode: "USD" } }, customAttributes: ref ? [{ key: "ai_chat_ref", value: ref }] : [] },
});

test("orders/cancelled marks only this store's event, once; the same cancel again and a cancel for an order never recorded change nothing", async () => {
  const events = eventStore([placed("#1042"), placed("#1042", "other.myshopify.com")]);
  const order = { name: "#1042", cancelled_at: "2026-11-16T10:00:00Z", cancel_reason: "customer" };
  assert.deepEqual(await markOrderCancelled(SHOP, order, { Event: events, analytics }), { updated: true });
  assert.ok(events.rows[0].props.cancelledAt, "this store's order is marked");
  assert.equal(events.rows[1].props.cancelledAt, undefined, "another store's order with the same number is untouched");
  assert.deepEqual(await markOrderCancelled(SHOP, order, { Event: events, analytics }), { updated: false }, "a second cancel is a no-op");
  assert.deepEqual(await markOrderCancelled(SHOP, { name: "#9999", cancelled_at: "2026-11-16T10:00:00Z" }, { Event: events, analytics }), { updated: false });
});

test("the cancel webhook handler reads Shopify's current order and writes that state (set, never added): cancelled and refunded in full", async () => {
  const events = eventStore([placed("#1042")]);
  const graphql = shopifyState({ status: "REFUNDED", refunded: "100.00", cancelledAt: "2026-11-16T10:00:00Z" });
  const result = await handleOrderEvent(SHOP, { id: 11, admin_graphql_api_id: "gid://shopify/Order/11", name: "#1042", cancelled_at: "2026-11-16T10:00:00Z" }, { Event: events, graphql, analytics, Conversation: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) } });
  assert.equal(result.reconciled, true);
  const props = events.rows[0].props;
  assert.ok(props.cancelledAt); assert.equal(props.refundedTotal, 100); assert.equal(props.refundedInFull, true); assert.equal(props.financialStatus, "refunded");
  // delivered again, in any order: the same end state
  await handleOrderEvent(SHOP, { id: 11, admin_graphql_api_id: "gid://shopify/Order/11", name: "#1042", cancelled_at: "2026-11-16T10:00:00Z" }, { Event: events, graphql, analytics, Conversation: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) } });
  assert.equal(props.refundedTotal, 100);
});

test("a Shopify that is down while a cancel webhook is processed does not fail the delivery (the payload already carries the cancellation)", async () => {
  const events = eventStore([placed("#1042")]);
  const result = await handleOrderEvent(SHOP, { id: 11, name: "#1042", cancelled_at: "2026-11-16T10:00:00Z" }, { Event: events, graphql: async () => { throw new Error("Shopify down"); }, analytics, Conversation: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) } });
  assert.equal(result.reconciled, false);
  assert.ok(events.rows[0].props.cancelledAt, "marked from the delivery itself");
});

test("refunds/create: a partial refund lowers revenue by exactly the refunded amount and the order still counts", async () => {
  const events = eventStore([placed("#1042")]);
  const out = await handleRefund(SHOP, { id: 5, order_id: 11 }, { Event: events, graphql: shopifyState({ status: "PARTIALLY_REFUNDED", refunded: "30.00" }), analytics });
  assert.equal(out.reconciled, true);
  assert.equal(events.rows[0].props.refundedTotal, 30);
  assert.equal(events.rows[0].props.refundedInFull, false);
});

test("refunds/create for an order from a chat that is not recorded yet FAILS, so the delivery is retried after orders/create; an order not from a chat is ignored", async () => {
  const events = eventStore([]);
  await assert.rejects(handleRefund(SHOP, { order_id: 11 }, { Event: events, graphql: shopifyState(), analytics }), /arrived before the order was recorded/);
  const unrelated = await handleRefund(SHOP, { order_id: 11 }, { Event: events, graphql: shopifyState({ ref: "" }), analytics });
  assert.equal(unrelated.reason, "no_event", "an order that did not come from a chat is left alone, without an error");
});

test("a refund can never name an order of another store: the lookup and the write are both this store's", async () => {
  const events = eventStore([placed("#1042", "other.myshopify.com")]);
  const seen = [];
  const graphql = async (shop, query, vars) => { seen.push(shop); return shopifyState()(shop, query, vars); };
  await assert.rejects(handleRefund(SHOP, { order_id: 11 }, { Event: events, graphql, analytics }), /before the order was recorded/);
  assert.deepEqual(seen, [SHOP]);
  assert.equal(events.rows[0].props.refundedTotal, undefined, "the other store's event is not touched");
});

test("a refund delivered before its order is retried by the queue and succeeds once orders/create has been recorded", async () => {
  const events = eventStore([]);
  const receipts = new Map();
  const Model = {
    async create(doc) { if (receipts.has(doc._id)) { const e = new Error("dup"); e.code = 11000; throw e; } receipts.set(doc._id, { ...doc }); },
    async findOneAndUpdate(filter, update) {
      const r = receipts.get(filter._id); if (!r) return null;
      const due = (["pending", "failed"].includes(r.status) && r.nextAttemptAt <= (filter.$or[0].nextAttemptAt?.$lte ?? new Date(8e15))) || (r.status === "processing" && r.lockedUntil < new Date());
      if (!due) return null;
      Object.assign(r, update.$set); r.attempts = (r.attempts || 0) + (update.$inc?.attempts || 0); return { ...r };
    },
    async updateOne(filter, update) { const r = receipts.get(filter._id); Object.assign(r, update.$set || {}); for (const k of Object.keys(update.$unset || {})) delete r[k]; },
    find() { const chain = { limit: () => chain, lean: async () => [...receipts.values()].filter((r) => ["pending", "failed"].includes(r.status)).map((r) => ({ _id: r._id })) }; return chain; },
  };
  let clock = 1_800_000_000_000;
  const queue = createWebhookQueue({ Model, connected: () => true, now: () => clock, log: { error() {} }, maxAttempts: 8 });
  const handler = webhookHandler(({ shop, body }) => handleRefund(shop, body, { Event: events, graphql: shopifyState({ refunded: "40.00", status: "PARTIALLY_REFUNDED" }), analytics }), { kind: "refunds-create", queue });

  const res = response(); await handler(request({ order_id: 11 }, { topic: "refunds/create", webhookId: "refund-evt-0001" }), res);
  assert.equal(res.code, 200);
  assert.equal(await queue.run("refund-evt-0001"), "failed", "the order is not recorded yet");
  assert.equal(receipts.get("refund-evt-0001").status, "failed");

  events.rows.push(placed("#1042")); // orders/create arrives and is recorded
  clock += 31_000; // past the first retry wait
  assert.equal(await queue.run("refund-evt-0001"), "done");
  assert.equal(events.rows[0].props.refundedTotal, 40);
});

test("reconcileOrder reports why it could not write: no id, order not found at Shopify, order never recorded here", async () => {
  const events = eventStore([placed("#1042")]);
  assert.equal((await reconcileOrder(SHOP, "", { Event: events, graphql: async () => ({}), analytics })).reason, "no_order_id");
  assert.equal((await reconcileOrder(SHOP, 11, { Event: events, graphql: async () => ({ order: null }), analytics })).reason, "order_not_found");
  assert.equal((await reconcileOrder(SHOP, 11, { Event: eventStore([]), graphql: shopifyState(), analytics })).reason, "no_event");
});
