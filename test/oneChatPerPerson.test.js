// One person, one row, one thread: a shopper who came back on another day, or used voice and text, is not listed three times.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTempMongo } from "./helpers/tempMongo.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import { listConversations, getConversation } from "../src/admin/stats.js";
import { attention } from "../src/admin/attention.js";
import { createSupportHub } from "../src/services/supportHub.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const wide = { from: iso(Date.now() - 60 * DAY), to: iso(Date.now() + DAY) };

before(async () => { if (mongo.available) await Promise.all([Conversation.init(), Message.init()]); });
after(async () => { await mongo.stop?.(); });
beforeEach(async () => { if (mongo.available) await Promise.all([Conversation.deleteMany({}), Message.deleteMany({})]); });

let t = Date.now() - 20 * DAY;
async function chat(over = {}, texts = ["hello"]) {
  t += DAY / 2;
  const c = await Conversation.create({ shop: SHOP, chatRef: "visitor-1", industry: "ecommerce", channel: "text", startedAt: new Date(t), lastMessageAt: new Date(t), messageCount: texts.length, firstMessage: texts[0], expiresAt: new Date(Date.now() + 30 * DAY), ...over });
  let at = t;
  for (const text of texts) { at += 1000; await Message.create({ shop: over.shop || SHOP, conversationId: c._id, role: "user", text, at: new Date(at), expiresAt: new Date(Date.now() + 30 * DAY) }); }
  return c;
}

test("a guest who chatted on three days is one row, with their latest chat", { skip }, async () => {
  await chat({}, ["day one"]);
  await chat({}, ["day two"]);
  const last = await chat({ channel: "voice" }, ["day three by voice"]);
  await chat({ chatRef: "visitor-2" }, ["somebody else"]);
  const page = await listConversations(SHOP, wide);
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 2);
  const mine = page.items.find((i) => i.firstMessage === "day three by voice");
  assert.equal(mine.id, String(last._id));
  assert.equal(mine.chatCount, 3);
  assert.equal(page.items.find((i) => i.firstMessage === "somebody else").chatCount, 1);
});

test("a signed-in customer is one person across browsers and days", { skip }, async () => {
  await chat({ chatRef: "phone", customerRef: "1001" });
  await chat({ chatRef: "laptop", customerRef: "1001" });
  await chat({ chatRef: "laptop-2", customerRef: "1002" });
  const page = await listConversations(SHOP, wide);
  assert.equal(page.total, 2);
  assert.equal(page.items.find((i) => i.chatCount === 2).verifiedCustomer, true);
});

test("the thread of that person is every chat in order, and the controls belong to the latest", { skip }, async () => {
  const a = await chat({}, ["first visit", "first visit, second line"]);
  const b = await chat({}, ["second visit"]);
  const out = await getConversation(SHOP, String(a._id));
  assert.deepEqual(out.messages.map((m) => m.text), ["first visit", "first visit, second line", "second visit"]);
  assert.equal(out.conversation.id, String(b._id), "the latest chat is the one to reply to");
  assert.equal(out.conversation.chatCount, 2);
});

test("people are paged one row each, newest first, and a store never sees another store's people", { skip }, async () => {
  for (let i = 0; i < 5; i += 1) { await chat({ chatRef: `p${i}` }); await chat({ chatRef: `p${i}` }); }
  await Conversation.create({ shop: OTHER, chatRef: "p0", industry: "ecommerce", channel: "text", startedAt: new Date(), lastMessageAt: new Date(), messageCount: 1, firstMessage: "other store", expiresAt: new Date(Date.now() + DAY) });
  const first = await listConversations(SHOP, { ...wide, limit: 3 });
  assert.equal(first.total, 5);
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = await listConversations(SHOP, { ...wide, limit: 3, cursor: first.nextCursor });
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  const refs = [...first.items, ...second.items].map((i) => i.personKey);
  assert.equal(new Set(refs).size, 5);
  assert.ok(![...first.items, ...second.items].some((i) => i.firstMessage === "other store"));
  assert.equal((await listConversations(OTHER, wide)).total, 1);
});

test("one person's own list still shows every chat they had, and the chip numbers count people", { skip }, async () => {
  await chat({}, ["a"]);
  const second = await chat({ flags: { needsFollowUp: true } }, ["b"]);
  await chat({ chatRef: "visitor-2" }, ["c"]);
  const person = (await listConversations(SHOP, wide)).items.find((i) => i.chatCount === 2).personKey;
  assert.equal((await listConversations(SHOP, { person })).items.length, 2, "a person's own chats are listed one by one");
  const counts = (await attention(SHOP)).inbox;
  assert.equal(counts.all, 2, "two people, not three chats");
  const waiting = await listConversations(SHOP, { ...wide, filter: "waiting" });
  assert.equal(waiting.total, 1);
  assert.equal(waiting.items[0].id, String(second._id));
});

test("a heartbeat from the server's ping keeps a team member present, without touching their name", async () => {
  const calls = [];
  let clock = 1_000_000;
  const service = { setPresence: async (shop, row) => { calls.push([shop, row]); }, listPresence: async () => [], waitingFor: async () => [], listCalls: async () => [], iceServers: () => [], turnConfigured: () => false };
  const hub = createSupportHub({ service, now: () => clock, log: { warn() {} } });
  const socket = { readyState: 1, send() {}, on() {}, close() {} };
  await hub.attachAdmin(socket, { shop: SHOP, rep: { id: "7", name: "Asha" } });
  await hub.touchAdmin(SHOP, "7");
  await hub.touchAdmin(SHOP, "7");
  assert.equal(calls.length, 1, "refreshed once inside the throttle window");
  assert.deepEqual(calls[0], [SHOP, { representativeId: "7" }]);
  clock += 30_000;
  await hub.touchAdmin(SHOP, "7");
  assert.equal(calls.length, 2);
  await hub.touchAdmin(SHOP, "99");
  assert.equal(calls.length, 2, "someone with no open socket is not refreshed");
});

test("the sidebar number counts people with news the owner has not opened; opening a chat reads all of that person's chats", { skip }, async () => {
  const { markConversationRead } = await import("../src/admin/stats.js");
  const fresh = { lastMessageAt: new Date() };
  const a1 = await chat(fresh, ["a"]);
  await chat(fresh, ["b"]);
  await chat({ ...fresh, chatRef: "visitor-2" }, ["c"]);
  assert.equal((await attention(SHOP)).inbox.unread, 2, "two people are unread, not three chats");
  assert.equal((await listConversations(SHOP, wide)).items.filter((i) => i.unread).length, 2);
  assert.equal(await markConversationRead(SHOP, String(a1._id)), true);
  assert.equal((await attention(SHOP)).inbox.unread, 1, "both chats of the opened person are read");
  assert.equal(await markConversationRead(SHOP, "0123456789abcdef01234567"), false);
});

// ---- orders: a cancelled order stops counting (real database, webhook -> dashboard) ----------------------------
test("a cancelled Shopify order leaves the revenue and the order count, stays in the order list, in its own store only", { skip }, async () => {
  const { default: Event } = await import("../src/models/Event.js");
  const { default: ecommerce } = await import("../src/industries/ecommerce.js");
  const { markOrderCancelled } = await import("../src/routes/shopifyWebhookRoutes.js");
  const { overview, listOrders } = await import("../src/admin/stats.js");
  await Event.init();
  await Event.deleteMany({});
  const at = new Date(Date.now() - DAY);
  const expiresAt = new Date(Date.now() + 30 * DAY);
  const placed = (shop, name, shopTotal) => ({ shop, type: "order_placed", at, expiresAt, dedupeKey: `order:${name}`, props: { orderName: name, total: shopTotal, currency: "USD", shopTotal, shopCurrency: "USD", paymentMethod: "cod" } });
  await Event.create([placed(SHOP, "#1001", 100), placed(SHOP, "#1002", 50), placed(OTHER, "#1001", 999)]);
  const opts = { analytics: ecommerce.analytics, timezone: "UTC", currency: "USD" };
  const before = await overview(SHOP, wide, opts);
  assert.equal(before.totals.revenue.amount, 150);

  // another store's webhook for the same order NUMBER must not touch this store, and a repeat changes nothing
  assert.equal((await markOrderCancelled("gamma.myshopify.com", { name: "#1001", cancelled_at: at.toISOString() })).updated, false);
  assert.equal((await markOrderCancelled(SHOP, { name: "#1001", cancelled_at: at.toISOString(), cancel_reason: "customer" })).updated, true);
  assert.equal((await markOrderCancelled(SHOP, { name: "#1001", cancelled_at: at.toISOString() })).updated, false);
  assert.equal((await markOrderCancelled(SHOP, { name: "#9999" })).updated, false);

  const after = await overview(SHOP, wide, opts);
  assert.equal(after.totals.revenue.amount, 50);
  assert.equal(after.totals.orders, 1);
  assert.equal((await overview(OTHER, wide, { ...opts })).totals.revenue.amount, 999);
  // the owner still sees the order in the list
  const list = await listOrders(SHOP, wide, { analytics: ecommerce.analytics, timezone: "UTC" });
  assert.deepEqual(list.items.map((o) => o.orderName).sort(), ["#1001", "#1002"]);
  await Event.deleteMany({});
});

// ---- orders: one revenue rule for every sequence of Shopify events (real database, scripted Shopify answers) ----------
test("revenue, order count and customer spend follow Shopify's own order state, whatever order the events arrive in or how often", { skip }, async () => {
  const { default: Event } = await import("../src/models/Event.js");
  const { default: ecommerce } = await import("../src/industries/ecommerce.js");
  const { handleOrderEvent, handleRefund } = await import("../src/routes/shopifyWebhookRoutes.js");
  const { overview, listOrders, listCustomers } = await import("../src/admin/stats.js");
  await Event.init();
  await Event.deleteMany({});
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = () => ({ lastMessageAt: new Date(Date.now() - 1800_000), startedAt: new Date(Date.now() - 7200_000) });
  const refOf = (n) => `chat-ref-order-${n}`;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await chat({ chatRef: refOf(n), ...recent() });
  await chat({ shop: OTHER, chatRef: refOf(1), ...recent() });

  // Shopify's truth per order number (what its API would answer right now)
  const truth = {};
  const shopify = (name, total, over = {}) => { truth[name] = { id: `gid://shopify/Order/${100 + Number(name.slice(1))}`, name, cancelledAt: null, displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: String(total), currencyCode: "USD" } }, totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } }, customAttributes: [{ key: "ai_chat_ref", value: refOf(Number(name.slice(1))) }], ...over }; return truth[name]; };
  const graphql = async (shop, query, { id }) => ({ order: Object.values(truth).find((o) => o.id === id) || null });
  const payload = (name, total, over = {}) => ({ name, id: Number(truth[name].id.split("/").pop()), admin_graphql_api_id: truth[name].id, created_at: hourAgo, total_price_set: { shop_money: { amount: String(total), currency_code: "USD" } }, note_attributes: [{ name: "ai_chat_ref", value: truth[name].customAttributes[0].value }], line_items: [{}], tags: "COD, Orbi-AI-Order", ...over });
  const deps = { graphql };
  const create = (shop, name, total) => handleOrderEvent(shop, payload(name, total), deps);
  const cancelPayload = (name, total) => payload(name, total, { cancelled_at: new Date().toISOString(), cancel_reason: "customer" });

  shopify("#1", 100);                                                            // paid
  shopify("#2", 50, { displayFinancialStatus: "PENDING" });                      // unpaid COD: counts, as placed
  shopify("#3", 30, { cancelledAt: new Date().toISOString(), displayFinancialStatus: "VOIDED" }); // cancel arrives BEFORE create
  shopify("#4", 40);                                                             // create, then refunded in full
  shopify("#5", 60);                                                             // create, then partly refunded (20)
  shopify("#6", 25);                                                             // create, then cancelled
  shopify("#7", 70);                                                             // refund arrives before create

  // create -> (duplicate) for the ordinary ones
  for (const [name, total] of [["#1", 100], ["#2", 50], ["#4", 40], ["#5", 60], ["#6", 25]]) { await create(SHOP, name, total); await create(SHOP, name, total); }
  // cancel -> create (and the create again): the cancelled order must never count
  await handleOrderEvent(SHOP, cancelPayload("#3", 30), deps);
  await create(SHOP, "#3", 30);
  await create(SHOP, "#3", 30);
  // create -> cancel (twice)
  Object.assign(truth["#6"], { cancelledAt: new Date().toISOString(), displayFinancialStatus: "VOIDED" });
  await handleOrderEvent(SHOP, cancelPayload("#6", 25), deps);
  await handleOrderEvent(SHOP, cancelPayload("#6", 25), deps);
  // refunds, one of them delivered twice
  Object.assign(truth["#4"], { displayFinancialStatus: "REFUNDED", totalRefundedSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } } });
  await handleRefund(SHOP, { order_id: 104 }, deps);
  await handleRefund(SHOP, { order_id: 104 }, deps);
  Object.assign(truth["#5"], { displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: { shopMoney: { amount: "20.00", currencyCode: "USD" } } });
  await handleRefund(SHOP, { order_id: 105 }, deps);
  // a refund that arrives before its order was recorded is retried (it throws), then lands once the create is processed
  Object.assign(truth["#7"], { displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } } });
  await assert.rejects(handleRefund(SHOP, { order_id: 107 }, deps), /before the order was recorded/);
  await create(SHOP, "#7", 70);
  await handleRefund(SHOP, { order_id: 107 }, deps);
  // an order that never came from a chat is none of our business, and no error
  shopify("#8", 15, { customAttributes: [] });
  assert.equal((await handleRefund(SHOP, { order_id: 108 }, deps)).reconciled, false);
  // another store's order with the same number is a different order
  await Event.create({ shop: OTHER, type: "order_placed", at: new Date(), expiresAt: new Date(Date.now() + DAY), dedupeKey: "order:#1", props: { orderName: "#1", shopTotal: 999, shopCurrency: "USD", total: 999, currency: "USD" } });

  const opts = { analytics: ecommerce.analytics, timezone: "UTC", currency: "USD" };
  // counted: #1 100 + #2 50 + #5 (60-20) 40 + #7 (70-10) 60 = 250, in 4 orders
  const o = await overview(SHOP, wide, opts);
  assert.equal(o.totals.revenue.amount, 250);
  assert.equal(o.totals.orders, 4);
  assert.equal((await overview(OTHER, wide, opts)).totals.revenue.amount, 999);

  // the owner still sees every order in the list
  const list = await listOrders(SHOP, wide, { analytics: ecommerce.analytics, timezone: "UTC" });
  assert.deepEqual(list.items.map((x) => x.orderName).sort(), ["#1", "#2", "#3", "#4", "#5", "#6", "#7"]);

  // customer spend uses the same rule: the same total, person by person
  const people = await listCustomers(SHOP, wide, opts);
  const spends = people.items.map((p) => p.spend.amount).filter((a) => a > 0).sort((a, b) => a - b);
  assert.deepEqual(spends, [40, 50, 60, 100]);
  assert.equal(spends.reduce((a, b) => a + b, 0), o.totals.revenue.amount);

  // replaying everything once more changes nothing
  for (const [name, total] of [["#1", 100], ["#5", 60], ["#7", 70]]) await create(SHOP, name, total);
  await handleOrderEvent(SHOP, cancelPayload("#3", 30), deps);
  await handleRefund(SHOP, { order_id: 105 }, deps);
  const again = await overview(SHOP, wide, opts);
  assert.equal(again.totals.revenue.amount, 250);
  assert.equal(again.totals.orders, 4);
  assert.equal(await Event.countDocuments({ shop: SHOP, type: "order_placed" }), 7);
  await Event.deleteMany({});
});
