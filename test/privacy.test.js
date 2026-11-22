// Shopify's mandatory privacy webhooks and the orders/create attribution: signed requests only, the
// store comes from the signed headers, and every delete/read is limited to that one store.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { webhookHandler, handleComplianceTopic, attributeShopifyOrder } from "../src/routes/shopifyWebhookRoutes.js";
import { customerKeys, eraseCustomer, eraseShop, fulfillDataRequest } from "../src/services/dataPrivacy.js";
import { orderLookupKeys } from "../src/services/orderLookupAuth.js";

const SHOP = "a-store.myshopify.com";
process.env.SHOPIFY_CLIENT_SECRET = "test-secret";
process.env.SHOPIFY_API_SECRET = "test-secret";

const sign = (raw) => crypto.createHmac("sha256", "test-secret").update(raw).digest("base64");
function call(handler, { body = {}, signature, headers = {} } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const h = { "x-shopify-hmac-sha256": signature ?? sign(raw), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create", ...headers };
  const req = { rawBody: raw, body, headers: h, get: (n) => h[n.toLowerCase()] };
  let status = 0;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  return handler(req, res).then(() => status);
}

// ---- the door -----------------------------------------------------------------------------
test("a webhook with a wrong or missing signature is refused and does no work", async () => {
  let ran = 0;
  const handler = webhookHandler(async () => { ran++; });
  assert.equal(await call(handler, { signature: "bad" }), 401);
  assert.equal(await call(handler, { signature: "" }), 401);
  assert.equal(ran, 0);
});

test("the store comes from the signed header, never from the body", async () => {
  let seen;
  const handler = webhookHandler(async (ctx) => { seen = ctx; });
  assert.equal(await call(handler, { body: { shop_domain: "evil.myshopify.com" }, headers: { "x-shopify-topic": "shop/redact" } }), 200);
  assert.equal(seen.shop, SHOP);
  assert.equal(seen.topic, "shop/redact");
  assert.equal(await call(handler, { headers: { "x-shopify-shop-domain": "not-a-shop.example.com" } }), 400);
});

test("a failure answers 500 so Shopify retries", async () => {
  const handler = webhookHandler(async () => { throw new Error("db down"); });
  assert.equal(await call(handler), 500);
});

test("each privacy topic goes to its own action, an unknown one is an error", async () => {
  const seen = [];
  const deps = { eraseCustomer: async (...a) => seen.push(["erase", ...a]), fulfillDataRequest: async (...a) => seen.push(["request", ...a]), eraseShop: async (...a) => seen.push(["shop", ...a]) };
  await handleComplianceTopic({ shop: SHOP, topic: "customers/redact", body: { customer: { id: 7 }, orders_to_redact: [1, 2] } }, deps);
  await handleComplianceTopic({ shop: SHOP, topic: "customers/data_request", body: { customer: { id: 7 } } }, deps);
  await handleComplianceTopic({ shop: SHOP, topic: "shop/redact", body: {} }, deps);
  assert.deepEqual(seen.map((s) => s[0]), ["erase", "request", "shop"]);
  assert.deepEqual(seen[0][2], { customer: { id: 7 }, ordersToRedact: [1, 2] });
  await assert.rejects(handleComplianceTopic({ shop: SHOP, topic: "something/else", body: {} }, deps));
});

// ---- erasing and exporting -----------------------------------------------------------------
function fakeModels({ conversations = [], storeStatus = "uninstalled", ownerEmail = "owner@store.com" } = {}) {
  const log = [];
  const del = (name) => async (filter) => { log.push({ name, filter }); return { deletedCount: 2 }; };
  return {
    log,
    Conversation: { find: (filter) => { log.push({ name: "Conversation.find", filter }); const r = { sort: () => r, lean: async () => conversations }; return r; }, deleteMany: del("Conversation") },
    Message: { find: (filter) => { log.push({ name: "Message.find", filter }); const r = { sort: () => r, lean: async () => [{ at: 1, role: "user", text: "hi" }] }; return r; }, deleteMany: del("Message") },
    Event: { deleteMany: del("Event") },
    Booking: { deleteMany: del("Booking"), find: (filter) => { log.push({ name: "Booking.find", filter }); const r = { lean: async () => [{ name: "Buyer", email: "buyer@example.com", phone: "+911234567890", status: "confirmed" }] }; return r; } },
    AgentSettings: { deleteMany: del("AgentSettings"), findOne: () => ({ lean: async () => null }) },
    CheckoutSession: { deleteMany: del("CheckoutSession"), find: (filter) => { log.push({ name: "CheckoutSession.find", filter }); return { lean: async () => [{ customer: { email: "a@b.com" }, shipping: { address1: "1 Road" } }] }; } },
    OrderSubmission: { deleteMany: del("OrderSubmission") },
    Attachment: { deleteMany: del("Attachment"), find: (filter) => { log.push({ name: "Attachment.find", filter }); return { lean: async () => [{ name: "broken.jpg", kind: "image", mime: "image/jpeg", size: 1200, createdAt: 1, data: "never exported" }] }; } },
    OrderLookupSession: { deleteMany: del("OrderLookupSession") },
    RateLimitHit: { deleteMany: del("RateLimitHit") },
    StoreIntegration: { findOne: () => ({ lean: async () => ({ status: storeStatus, contactEmail: ownerEmail }) }), deleteMany: del("StoreIntegration") },
  };
}

// A filter is limited to one store by its shop field, or by the store's name inside the row's key.
const escaped = SHOP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scopedToShop(filter) {
  if (filter.shop === SHOP || filter.storeDomain === SHOP) return true;
  if (filter.$or) return filter.$or.every(scopedToShop);
  const key = filter.key?.$regex ?? filter.key ?? filter._id?.$regex ?? "";
  return typeof key === "string" && (key.includes(`:${escaped}`) || key.includes(`:${SHOP}:`));
}

test("customer keys: an id or an email is needed, otherwise nothing can match", () => {
  assert.deepEqual(customerKeys({}), { id: null, gid: null, email: "", emailRe: null });
  const k = customerKeys({ id: 778899, email: " Buyer@Example.com " });
  assert.equal(k.gid, "gid://shopify/Customer/778899");
  assert.ok(k.emailRe.test("BUYER@example.com") && !k.emailRe.test("xbuyer@example.com.au"));
});

test("erasing a customer deletes their chats, saved checkout details and order records, in this store only", async () => {
  const m = fakeModels({ conversations: [{ _id: "c1", chatRef: "ref-one" }, { _id: "c2", chatRef: "ref-two" }] });
  const out = await eraseCustomer(SHOP, { customer: { id: 778899, email: "buyer@example.com" }, ordersToRedact: [42] }, m);
  assert.deepEqual(out, { conversations: 2, messages: 2, events: 2, attachments: 2, sessions: 2, verifications: 2, submissions: 2, bookings: 2, calls: 0, recordings: 0, complaints: 0 });
  const calls = m.log.find((e) => e.name === "Booking").filter;
  assert.equal(calls.$or.length, 2, "calls are erased by chat and by email");
  for (const entry of m.log) assert.ok(scopedToShop(entry.filter), `${entry.name} must be limited to the store`);
  const sessions = m.log.find((e) => e.name === "CheckoutSession").filter;
  assert.equal(sessions.$or.length, 4);
  assert.deepEqual(m.log.find((e) => e.name === "OrderSubmission").filter["result.shopifyOrderId"], { $in: ["gid://shopify/Order/42"] });
});

test("a request that names nobody erases nothing", async () => {
  const m = fakeModels();
  const out = await eraseCustomer(SHOP, { customer: {} }, m);
  assert.deepEqual(out, { conversations: 0, messages: 0, events: 0, attachments: 0, sessions: 0, verifications: 0, submissions: 0, bookings: 0, calls: 0, recordings: 0, complaints: 0 });
  assert.equal(m.log.length, 0);
});

test("a data request is exported and emailed to the store owner", async () => {
  const m = fakeModels({ conversations: [{ _id: "c1", chatRef: "ref-one", startedAt: 1, channel: "text", language: "en", outcome: "chat" }] });
  const sent = [];
  const out = await fulfillDataRequest(SHOP, { customer: { id: 778899, email: "buyer@example.com" }, data_request: { id: 5 } }, { models: m, send: async (mail) => { sent.push(mail); return { ok: true }; } });
  assert.deepEqual([out.found, out.emailed], [4, true]); // 1 chat + 1 saved checkout + 1 call booking + 1 file
  assert.equal(sent[0].to, "owner@store.com");
  const file = JSON.parse(sent[0].attachments[0].content);
  assert.equal(file.shop, SHOP);
  assert.equal(file.conversations[0].messages[0].text, "hi");
  assert.equal(file.bookings[0].email, "buyer@example.com");
  assert.deepEqual(file.attachments, [{ name: "broken.jpg", kind: "image", mime: "image/jpeg", size: 1200, createdAt: 1 }], "what the file is, never its bytes");
  assert.ok(m.log.every((e) => e.filter.shop === SHOP));
});

test("a data request without a store contact email is reported, not lost silently", async () => {
  const m = fakeModels({ ownerEmail: "" });
  const out = await fulfillDataRequest(SHOP, { customer: { id: 1 } }, { models: m, send: async () => assert.fail("must not send") });
  assert.equal(out.emailed, false);
  assert.match(out.reason, /no store contact email/);
});

test("shop erase removes everything of an uninstalled store, nothing if it was installed again", async () => {
  const gone = fakeModels({ storeStatus: "uninstalled" });
  const out = await eraseShop(SHOP, gone);
  assert.equal(out.Conversation, 2);
  assert.equal(out.StoreIntegration, 2);
  for (const name of ["Attachment", "OrderLookupSession", "RateLimitHit"]) assert.equal(out[name], 2, `${name} is erased too`);
  assert.ok(gone.log.every((e) => scopedToShop(e.filter)));
  const back = fakeModels({ storeStatus: "active" });
  assert.deepEqual(await eraseShop(SHOP, back), { skipped: "store is installed again" });
  assert.equal(back.log.length, 0);
});

test("erasing a customer removes the files from their chats and their email checks, matched by their own keys", async () => {
  const m = fakeModels({ conversations: [{ _id: "c1", chatRef: "ref-one" }, { _id: "c2", chatRef: "ref-two" }, { _id: "c3", chatRef: "ref-one" }] });
  await eraseCustomer(SHOP, { customer: { id: 778899, email: "Buyer@Example.com" } }, m);
  const files = m.log.find((e) => e.name === "Attachment").filter;
  assert.deepEqual(files, { shop: SHOP, chatRef: { $in: ["ref-one", "ref-two"] } });
  const lookups = m.log.find((e) => e.name === "OrderLookupSession").filter.$or;
  const email = new RegExp(lookups[0]["data.email"].$regex, lookups[0]["data.email"].$options);
  assert.ok(email.test("buyer@example.com") && !email.test("other.buyer@example.com"), "only this email");
  assert.ok(lookups.some((f) => f.key === orderLookupKeys.emailKey(SHOP, "buyer@example.com")), "their OTP send counter");
  assert.ok(lookups.some((f) => typeof f.key === "string" && f.key.startsWith(orderLookupKeys.sessionPrefix(SHOP))), "their signed-in session");
  const counters = new RegExp(m.log.find((e) => e.name === "RateLimitHit").filter._id.$regex);
  assert.ok(counters.test(`visitor:chat:${SHOP}|customer:778899@1700000000000`));
  assert.ok(!counters.test(`visitor:chat:${SHOP}|customer:7788990@1700000000000`), "not another customer");
  assert.ok(!counters.test(`visitor:chat:other-${SHOP}|customer:778899@1700000000000`), "not another store");
});

test("a customer with only an email still has their email checks erased, with no chats needed", async () => {
  const m = fakeModels({ conversations: [] });
  const out = await eraseCustomer(SHOP, { customer: { email: "buyer@example.com" } }, m);
  assert.equal(out.verifications, 2);
  assert.equal(out.attachments, 0);
  assert.ok(!m.log.some((e) => e.name === "Attachment"), "no chats, so no file query");
  assert.ok(!m.log.some((e) => e.name === "RateLimitHit"), "counters are keyed by customer id only");
});

test("shop erase reaches rows keyed by the store's name, and no other store's", async () => {
  const gone = fakeModels({ storeStatus: "uninstalled" });
  await eraseShop(SHOP, gone);
  const lookups = gone.log.find((e) => e.name === "OrderLookupSession").filter.$or.map((f) => new RegExp(f.key.$regex));
  assert.ok(lookups.some((r) => r.test(orderLookupKeys.sessionKey(SHOP, "visitor-0123456789abcdef"))));
  assert.ok(lookups.some((r) => r.test(orderLookupKeys.emailKey(SHOP, "a@b.com"))));
  assert.ok(!lookups.some((r) => r.test(orderLookupKeys.sessionKey(`x${SHOP}`, "visitor-0123456789abcdef"))));
  const counters = new RegExp(gone.log.find((e) => e.name === "RateLimitHit").filter._id.$regex);
  assert.ok(counters.test(`shop:ai:day:${SHOP}@1700000000000`) && counters.test(`visitor:chat:${SHOP}|net:1.2.3.4@1`));
  assert.ok(!counters.test(`shop:ai:day:x${SHOP}@1700000000000`) && !counters.test(`shop:ai:day:${SHOP}.evil@1`));
});

// ---- attributing Shopify orders ------------------------------------------------------------
const REF = "AbCdEfGhIjKlMnOpQrSt12";
function convoModel(conversation) {
  const calls = { findOne: [], updateOne: [] };
  return {
    calls,
    findOne: (filter) => { calls.findOne.push(filter); const r = { sort: () => r, lean: async () => conversation }; return r; },
    updateOne: async (...a) => { calls.updateOne.push(a); },
  };
}
const order = (over = {}) => ({ name: "#1001", created_at: "2026-10-30T10:00:00Z", total_price: "1500.00", total_price_set: { shop_money: { amount: "1500.00", currency_code: "INR" } }, note_attributes: [{ name: "ai_chat_ref", value: REF }], line_items: [{}, {}], tags: "", ...over });
const analytics = { outcomes: { order_placed: 4 } };

test("an order that carries a chat reference is counted for that chat, in that store", async () => {
  const Convo = convoModel({ _id: "conv1", outcomeRank: 1 });
  const events = [];
  const out = await attributeShopifyOrder(SHOP, order(), { Conversation: Convo, analytics, record: async (e) => { events.push(e); return true; } });
  assert.deepEqual(out, { attributed: true, counted: true });
  assert.equal(Convo.calls.findOne[0].shop, SHOP);
  assert.equal(Convo.calls.findOne[0].chatRef, REF);
  assert.deepEqual([events[0].type, events[0].dedupeKey, events[0].props.total, events[0].props.currency, events[0].props.source], ["order_placed", "order:#1001", 1500, "INR", "assisted"]);
  assert.equal(Convo.calls.updateOne[0][1].$set.outcome, "order_placed");
});

test("orders the agent placed itself are labelled as such", async () => {
  const events = [];
  await attributeShopifyOrder(SHOP, order({ tags: "COD, Orbi-AI-Order" }), { Conversation: convoModel({ _id: "c", outcomeRank: 0 }), analytics, record: async (e) => { events.push(e); return true; } });
  assert.equal(events[0].props.source, "agent");
});

test("orders without a valid reference, or with no recent chat, are not attributed", async () => {
  const never = async () => assert.fail("must not record");
  const base = { analytics, record: never };
  assert.equal((await attributeShopifyOrder(SHOP, order({ note_attributes: [] }), { ...base, Conversation: convoModel({ _id: "c" }) })).attributed, false);
  assert.equal((await attributeShopifyOrder(SHOP, order({ note_attributes: [{ name: "ai_chat_ref", value: "../../etc" }] }), { ...base, Conversation: convoModel({ _id: "c" }) })).attributed, false);
  assert.equal((await attributeShopifyOrder(SHOP, order(), { ...base, Conversation: convoModel(null) })).attributed, false);
});

test("the chat must be recent relative to the order (attribution window)", async () => {
  const Convo = convoModel(null);
  await attributeShopifyOrder(SHOP, order(), { Conversation: Convo, analytics, record: async () => true });
  const earliest = Convo.calls.findOne[0].lastMessageAt.$gte.getTime();
  assert.equal(Date.parse("2026-10-30T10:00:00Z") - earliest, 7 * 86400_000);
});

test("an order the agent already logged is not counted twice and does not touch the outcome again", async () => {
  const Convo = convoModel({ _id: "c1", outcomeRank: 4 });
  const Events = { updates: [], updateOne: async (...a) => { Events.updates.push(a); } };
  const out = await attributeShopifyOrder(SHOP, order(), { Conversation: Convo, Event: Events, analytics, record: async () => false });
  assert.deepEqual(out, { attributed: true, counted: false });
  assert.equal(Convo.calls.updateOne.length, 0);
});

test("Shopify's store-currency amount is added to the order the agent logged in the shopper's currency", async () => {
  const Events = { updates: [], updateOne: async (...a) => { Events.updates.push(a); } };
  const usd = order({ total_price_set: { shop_money: { amount: "13171.06", currency_code: "USD" } } });
  await attributeShopifyOrder(SHOP, usd, { Conversation: convoModel({ _id: "c1", outcomeRank: 4 }), Event: Events, analytics, record: async () => false });
  assert.equal(Events.updates.length, 1);
  assert.deepEqual(Events.updates[0][0], { shop: SHOP, dedupeKey: "order:#1001" });
  assert.deepEqual(Events.updates[0][1], { $set: { "props.shopTotal": 13171.06, "props.shopCurrency": "USD" } });
  // an order Shopify reported without store money leaves the agent's record alone
  Events.updates.length = 0;
  await attributeShopifyOrder(SHOP, order({ total_price_set: undefined }), { Conversation: convoModel({ _id: "c1" }), Event: Events, analytics, record: async () => false });
  assert.equal(Events.updates.length, 0);
  // an order first seen by the webhook carries the store amount itself
  const seen = [];
  await attributeShopifyOrder(SHOP, usd, { Conversation: convoModel({ _id: "c1", outcomeRank: 0 }), Event: Events, analytics, record: async (e) => { seen.push(e); return true; } });
  assert.deepEqual([seen[0].props.shopTotal, seen[0].props.shopCurrency], [13171.06, "USD"]);
  assert.equal(Events.updates.length, 0);
});

test("an order that is already cancelled when its create delivery arrives late is recorded as cancelled (not revenue)", async () => {
  const events = [];
  await attributeShopifyOrder(SHOP, order({ cancelled_at: "2026-10-30T12:00:00Z" }), { Conversation: convoModel({ _id: "c", outcomeRank: 0 }), analytics, record: async (e) => { events.push(e); return true; } });
  assert.equal(events[0].props.cancelledAt instanceof Date, true);
  const fresh = [];
  await attributeShopifyOrder(SHOP, order(), { Conversation: convoModel({ _id: "c", outcomeRank: 0 }), analytics, record: async (e) => { fresh.push(e); return true; } });
  assert.equal("cancelledAt" in fresh[0].props, false);
});
