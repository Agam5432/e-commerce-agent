// The store owner's dashboard API: who may call it, that a store only ever sees its own data, and that
// the numbers are right. The statistics run the real aggregation pipelines (via mingo, an in-memory
// MongoDB query engine) against data from two stores.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { Aggregator, Query } from "mingo";
import { verifySessionToken, requireAdmin } from "../../src/admin/auth.js";
import * as stats from "../../src/admin/stats.js";
import { createAdminRouter } from "../../src/admin/routes.js";
import ecommerce from "../../src/industries/ecommerce.js";
import { OrderLookupError } from "../../src/admin/orderDetails.js";
import { agentPerformance } from "../../src/admin/performance.js";

const A = "a-store.myshopify.com";
const B = "b-store.myshopify.com";
const SECRET = "test-secret";
const KEY = "test-client-id";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const analytics = ecommerce.analytics;

// ---- session tokens ----------------------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(over = {}, { secret = SECRET, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const payload = { iss: `https://${A}/admin`, dest: `https://${A}`, aud: KEY, sub: "42", exp: Math.floor(NOW / 1000) + 60, nbf: Math.floor(NOW / 1000) - 5, ...over };
  const body = `${b64(header)}.${b64(payload)}`;
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const verify = (t, extra = {}) => verifySessionToken(t, { now: NOW, secret: SECRET, key: KEY, ...extra });

test("a valid Shopify session token gives the store and the signed-in user", () => {
  assert.deepEqual(verify(token()), { shop: A, userId: "42" });
});

test("anything else is refused: bad signature, none algorithm, expired, wrong app, mixed-up store", () => {
  const bad = [
    token({}, { secret: "other" }),
    token({}, { header: { alg: "none" } }),
    `${token().split(".").slice(0, 2).join(".")}.`,
    token({ exp: Math.floor(NOW / 1000) - 60 }),
    token({ nbf: Math.floor(NOW / 1000) + 600 }),
    token({ aud: "someone-elses-app" }),
    token({ dest: "https://evil.example.com", iss: "https://evil.example.com/admin" }),
    token({ iss: `https://${B}/admin` }),
    "not.a.jwt", "", "a.b", null, undefined, "x".repeat(5000),
  ];
  for (const t of bad) assert.throws(() => verify(t), /invalid_token/, String(t).slice(0, 40));
  assert.throws(() => verify(token(), { secret: "" }), /invalid_token/);
});

function run(mw, headers = {}) {
  const req = { headers, get: (n) => headers[n.toLowerCase()] };
  const out = { status: 200, next: false };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  return Promise.resolve(mw(req, res, () => { out.next = true; })).then(() => ({ ...out, req }));
}

test("the admin door needs a valid token for an installed store", async () => {
  const mw = requireAdmin({ verify, active: async (s) => s === A });
  assert.equal((await run(mw)).status, 401);
  assert.equal((await run(mw, { authorization: "Basic abc" })).status, 401);
  assert.equal((await run(mw, { authorization: "Bearer garbage" })).status, 401);
  const ok = await run(mw, { authorization: `Bearer ${token()}` });
  assert.deepEqual([ok.next, ok.req.shop, ok.req.adminUser], [true, A, "42"]);
  const gone = await run(requireAdmin({ verify, active: async () => false }), { authorization: `Bearer ${token()}` });
  assert.deepEqual([gone.status, gone.next], [401, false]);
  const down = await run(requireAdmin({ verify, active: async () => { throw new Error("db"); } }), { authorization: `Bearer ${token()}` });
  assert.deepEqual([down.status, down.next], [503, false]);
});

// ---- data for two stores -------------------------------------------------------------------------
const oid = () => new mongoose.Types.ObjectId();
const t = (iso) => new Date(iso);

function dataset() {
  const c1 = oid(), c2 = oid(), c3 = oid(), cb = oid();
  const ev = (shop, type, at, over = {}) => ({ _id: oid(), shop, type, at: t(at), conversationId: null, chatRef: null, channel: "text", language: "en", props: {}, ...over });
  const events = [
    // store A, conversation 1: a full journey ending in an order (evening UTC = next day in India)
    ev(A, "conversation_started", "2026-10-28T20:30:00Z", { conversationId: c1, chatRef: "r1" }),
    ev(A, "turn", "2026-10-28T20:30:05Z", { conversationId: c1, chatRef: "r1", props: { ms: 1000, tokensIn: 100, tokensOut: 10, tokensCached: 40, degraded: false } }),
    ev(A, "products_shown", "2026-10-28T20:30:05Z", { conversationId: c1, chatRef: "r1", props: { count: 2, items: [{ title: "Earbuds" }, { title: "Power bank" }] } }),
    ev(A, "cart_add", "2026-10-28T20:31:00Z", { conversationId: c1, chatRef: "r1", props: { title: "Earbuds", quantity: 1 } }),
    ev(A, "checkout_started", "2026-10-28T20:32:00Z", { conversationId: c1, chatRef: "r1", props: { total: 1500, currency: "INR" } }),
    ev(A, "order_placed", "2026-10-28T20:33:00Z", { conversationId: c1, chatRef: "r1", props: { total: 1500, currency: "INR", orderName: "#1001" } }),
    // store A, conversation 2: voice, browsing only, one failed reply
    ev(A, "conversation_started", "2026-10-29T08:00:00Z", { conversationId: c2, chatRef: "r2", channel: "voice", language: "hi" }),
    ev(A, "turn", "2026-10-29T08:00:04Z", { conversationId: c2, chatRef: "r2", channel: "voice", language: "hi", props: { ms: 3000, tokensIn: 200, tokensOut: 20, degraded: true } }),
    ev(A, "products_shown", "2026-10-29T08:00:04Z", { conversationId: c2, chatRef: "r2", channel: "voice", language: "hi", props: { count: 1, items: [{ title: "Earbuds" }] } }),
    // store A, conversation 3: a second order, cheaper
    ev(A, "conversation_started", "2026-10-29T09:00:00Z", { conversationId: c3, chatRef: "r3" }),
    ev(A, "turn", "2026-10-29T09:00:02Z", { conversationId: c3, chatRef: "r3", props: { ms: 2000, tokensIn: 50, tokensOut: 5, degraded: false } }),
    ev(A, "order_placed", "2026-10-29T09:05:00Z", { conversationId: c3, chatRef: "r3", props: { total: 500, currency: "INR", orderName: "#1002" } }),
    // store A, outside the default range
    ev(A, "conversation_started", "2026-08-01T10:00:00Z", { conversationId: oid(), chatRef: "old" }),
    // store B, must never show up in A's numbers
    ev(B, "conversation_started", "2026-10-29T10:00:00Z", { conversationId: cb, chatRef: "rb" }),
    ev(B, "turn", "2026-10-29T10:00:02Z", { conversationId: cb, chatRef: "rb", props: { ms: 9999, tokensIn: 7777, tokensOut: 1, degraded: false } }),
    ev(B, "order_placed", "2026-10-29T10:10:00Z", { conversationId: cb, chatRef: "rb", props: { total: 99999, currency: "INR", orderName: "#1001" } }),
  ];
  const conv = (shop, id, lastMessageAt, over = {}) => ({ _id: id, shop, chatRef: "x", channel: "text", language: "en", startedAt: t(lastMessageAt), lastMessageAt: t(lastMessageAt), messageCount: 2, status: "open", outcome: "chat", firstMessage: "hi", degradedTurns: 0, customerRef: null, ...over });
  const conversations = [
    conv(A, c1, "2026-10-28T20:33:00Z", { outcome: "order_placed", firstMessage: "show me earbuds", customerRef: "778899" }),
    conv(A, c2, "2026-10-29T08:00:04Z", { channel: "voice", language: "hi", firstMessage: "(100% cotton) shirts?", degradedTurns: 1 }),
    conv(A, c3, "2026-10-29T09:05:00Z", { outcome: "order_placed", firstMessage: "cheap gift" }),
    conv(B, cb, "2026-10-29T10:10:00Z", { firstMessage: "secret of store B" }),
  ];
  const messages = [
    { _id: oid(), shop: A, conversationId: c1, role: "user", text: "show me earbuds", at: t("2026-10-28T20:30:00Z") },
    { _id: oid(), shop: A, conversationId: c1, role: "assistant", text: "Here you go", at: t("2026-10-28T20:30:05Z"), degraded: false },
    { _id: oid(), shop: B, conversationId: c1, role: "user", text: "B's line sharing an id by accident", at: t("2026-10-28T20:30:01Z") },
  ];
  return { events, conversations, messages, ids: { c1, c2, c3, cb } };
}

// Models that run queries through the in-memory engine; `find` chains like Mongoose.
function fakeModels(d) {
  const finder = (docs) => (filter = {}) => {
    let rows = new Query(filter).find(docs).all();
    const chain = {
      sort(spec) { const [[k, dir]] = Object.entries(spec).slice(0, 1); const rest = Object.entries(spec).slice(1); rows = [...rows].sort((a, b) => { for (const [key, d2] of [[k, dir], ...rest]) { const x = a[key], y = b[key]; const c = x > y ? 1 : x < y ? -1 : String(x) > String(y) ? 1 : String(x) < String(y) ? -1 : 0; if (c) return c * d2; } return 0; }); return chain; },
      limit(n) { rows = rows.slice(0, n); return chain; },
      lean: async () => rows,
    };
    return chain;
  };
  const byId = (docs, filter) => docs.find((x) => String(x._id) === String(filter._id) && x.shop === filter.shop) || null;
  const one = (docs) => ({ findOne: (filter) => ({ lean: async () => byId(docs, filter) }) });
  return {
    Event: { aggregate: async (p) => new Aggregator(p).run(d.events), find: finder(d.events), countDocuments: async (filter) => new Query(filter).find(d.events).all().length },
    Message: { find: finder(d.messages) },
    Conversation: {
      find: finder(d.conversations),
      countDocuments: async (filter) => new Query(filter).find(d.conversations).all().length,
      findOne: one(d.conversations).findOne,
      async findOneAndUpdate(filter, update) {
        const c = byId(d.conversations, filter);
        if (!c) return null;
        Object.assign(c, update.$set);
        return { ...c };
      },
    },
  };
}
const opts = { analytics, timezone: "Asia/Kolkata", currency: "INR", now: NOW };

// ---- dates ---------------------------------------------------------------------------------------
test("the default range is the last 30 days in the store's own time zone", () => {
  const r = stats.parseRange({}, "Asia/Kolkata", Date.parse("2026-10-30T20:00:00Z")); // already 31 Oct in India
  assert.deepEqual([r.from, r.to, r.days], ["2026-10-02", "2026-10-31", 30]);
  assert.equal(r.start.toISOString(), "2026-10-01T18:30:00.000Z");
  assert.equal(r.end.toISOString(), "2026-10-31T18:30:00.000Z");
});

test("a day that is 23 hours long (daylight saving) still starts at local midnight", () => {
  const start = stats.startOfLocalDay("2026-03-08", "America/New_York");
  const next = stats.startOfLocalDay("2026-03-09", "America/New_York");
  assert.equal(next - start, 23 * 3600_000);
});

test("bad ranges are refused before any query runs", () => {
  for (const q of [{ from: "yesterday" }, { from: "2026-13-45", to: "2026-13-46" }, { from: "2026-10-30", to: "2026-10-01" }, { from: "2024-01-01", to: "2026-10-30" }]) {
    assert.throws(() => stats.parseRange(q, "UTC", NOW), (e) => e.name === "InputError" && e.status === 400, JSON.stringify(q));
  }
});

test("revenue is counted in the store's currency, whatever currency the shopper paid in", async () => {
  const c = oid();
  const order = (name, at, props) => ({ _id: oid(), shop: A, type: "order_placed", at: t(at), conversationId: c, chatRef: "r", channel: "text", language: "en", props: { orderName: name, ...props } });
  const data = {
    events: [
      order("#1", "2026-10-29T09:00:00Z", { total: 1178147.4, currency: "INR", shopTotal: 13171.06, shopCurrency: "USD" }), // agent order, confirmed by Shopify
      order("#2", "2026-10-29T10:00:00Z", { total: 100, currency: "USD", shopTotal: 100, shopCurrency: "USD" }),               // order only the webhook saw
      order("#3", "2026-10-29T11:00:00Z", { total: 5000, currency: "INR" }),                                                    // webhook not here yet
    ],
    conversations: [], messages: [],
  };
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, { ...opts, currency: "USD" }, fakeModels(data));
  assert.deepEqual(o.totals.revenue, { currency: "USD", amount: 13271.06 });
  assert.equal(o.totals.orders, 3);
});

// ---- overview ------------------------------------------------------------------------------------
test("the overview counts only this store's data, correctly", async () => {
  const data = dataset();
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels(data));
  const t1 = o.totals;
  assert.deepEqual([t1.conversations, t1.visitors, t1.messages, t1.orders], [3, 3, 3, 2]);
  assert.deepEqual(t1.revenue, { currency: "INR", amount: 2000 });
  assert.equal(t1.averageOrderValue, 1000);
  assert.equal(t1.conversionRate, 0.667);
  assert.equal(t1.averageResponseMs, 2000); // (1000 + 3000 + 2000) / 3 turns
  assert.equal(t1.failedReplies, 1);
  assert.deepEqual(t1.tokens, { in: 350, cached: 40, out: 35 });
  assert.deepEqual(t1.channels, { text: 2, voice: 1 });
  assert.ok(!JSON.stringify(o).includes("99999") && t1.tokens.in !== 8127, "store B's numbers must not leak in");
});

test("days are cut at the store's local midnight and empty days are filled in", async () => {
  const o = await stats.overview(A, { from: "2026-10-27", to: "2026-10-30" }, opts, fakeModels(dataset()));
  assert.deepEqual(o.series.map((r) => r.date), ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  // 20:30 UTC on the 28th is 02:00 on the 29th in India
  assert.deepEqual(o.series.map((r) => [r.conversations, r.orders, r.revenue]), [[0, 0, 0], [0, 0, 0], [3, 2, 2000], [0, 0, 0]]);
  const utc = await stats.overview(A, { from: "2026-10-27", to: "2026-10-30" }, { ...opts, timezone: "Europe/London" }, fakeModels(dataset())); // GMT in late October
  assert.deepEqual(utc.series.map((r) => r.conversations), [0, 1, 2, 0]);
});

test("the funnel counts conversations that reached each step, and the top lists rank products", async () => {
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels(dataset()));
  assert.deepEqual(o.funnel.map((f) => [f.stage, f.conversations]), [["conversation_started", 3], ["products_shown", 2], ["cart_add", 1], ["checkout_started", 1], ["order_placed", 2]]);
  assert.deepEqual(o.top.productsShown, [{ name: "Earbuds", count: 2 }, { name: "Power bank", count: 1 }]);
  assert.deepEqual(o.top.productsAdded, [{ name: "Earbuds", count: 1 }]);
  assert.deepEqual(o.busiest.map((b) => [b.weekday, b.hour, b.conversations]).sort((x, y) => x[1] - y[1]), [[4, 2, 1], [4, 13, 1], [4, 14, 1]]); // Thursday 29 Oct 02:00, 13:30, 14:30 in India
});

test("filters narrow the numbers by channel and language", async () => {
  const m = fakeModels(dataset());
  const voice = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30", channel: "voice" }, opts, m);
  assert.deepEqual([voice.totals.conversations, voice.totals.orders], [1, 0]);
  const hi = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30", language: "HI" }, opts, m);
  assert.equal(hi.totals.conversations, 1);
  await assert.rejects(stats.overview(A, { channel: "fax" }, opts, m), /text or voice/);
  await assert.rejects(stats.overview(A, { language: "e n; drop" }, opts, m), /not valid/);
});

test("a store with no activity gets zeros, not errors", async () => {
  const o = await stats.overview("empty.myshopify.com", { from: "2026-10-01", to: "2026-10-03" }, opts, fakeModels(dataset()));
  assert.deepEqual([o.totals.conversations, o.totals.orders, o.totals.conversionRate, o.totals.averageResponseMs], [0, 0, 0, 0]);
  assert.equal(o.series.length, 3);
});

// ---- conversations -------------------------------------------------------------------------------
test("the conversation list is this store's only, newest first, and pages with a cursor", async () => {
  const m = fakeModels(dataset());
  const q = { from: "2026-10-01", to: "2026-10-30", limit: 2 };
  const first = await stats.listConversations(A, q, opts, m);
  assert.deepEqual(first.items.map((c) => c.firstMessage), ["cheap gift", "(100% cotton) shirts?"]);
  assert.ok(first.nextCursor);
  const second = await stats.listConversations(A, { ...q, cursor: first.nextCursor }, opts, m);
  assert.deepEqual(second.items.map((c) => c.firstMessage), ["show me earbuds"]);
  assert.equal(second.nextCursor, null);
  assert.ok(![...first.items, ...second.items].some((c) => /store B/.test(c.firstMessage)));
  assert.equal(second.items[0].verifiedCustomer, true);
  assert.ok(!("customerRef" in second.items[0]), "the customer id itself is not sent to the screen");
});

test("filters and text search work, and special characters are searched literally", async () => {
  const m = fakeModels(dataset());
  const base = { from: "2026-10-01", to: "2026-10-30" };
  assert.deepEqual((await stats.listConversations(A, { ...base, outcome: "order_placed" }, opts, m)).items.length, 2);
  assert.deepEqual((await stats.listConversations(A, { ...base, channel: "voice" }, opts, m)).items.map((c) => c.channel), ["voice"]);
  assert.deepEqual((await stats.listConversations(A, { ...base, q: "(100% cotton)" }, opts, m)).items.length, 1);
  assert.deepEqual((await stats.listConversations(A, { ...base, q: ".*" }, opts, m)).items.length, 0);
  await assert.rejects(stats.listConversations(A, { ...base, status: "weird" }, opts, m), /status/);
  await assert.rejects(stats.listConversations(A, { ...base, outcome: "a;b" }, opts, m), /outcome/);
  await assert.rejects(stats.listConversations(A, { ...base, cursor: "garbage" }, opts, m), /cursor/);
});

test("a conversation opens with its transcript, but only for the store it belongs to", async () => {
  const d = dataset();
  const m = fakeModels(d);
  const mine = await stats.getConversation(A, String(d.ids.c1), m);
  assert.deepEqual(mine.messages.map((x) => x.text), ["show me earbuds", "Here you go"]);
  assert.ok(mine.events.every((e) => e.type !== "turn") && mine.events.some((e) => e.type === "order_placed"));
  assert.equal(await stats.getConversation(B, String(d.ids.c1), m), null); // another store's id is simply "not found"
  await assert.rejects(stats.getConversation(A, "not-an-id", m), /id is not valid/);
});

test("only the owner's store can change a conversation's status", async () => {
  const d = dataset();
  const m = fakeModels(d);
  assert.equal((await stats.setConversationStatus(A, String(d.ids.c1), "resolved", m)).status, "resolved");
  assert.equal(await stats.setConversationStatus(B, String(d.ids.c2), "resolved", m), null);
  assert.equal(d.conversations.find((c) => String(c._id) === String(d.ids.c2)).status, "open");
  await assert.rejects(stats.setConversationStatus(A, String(d.ids.c1), "deleted", m), /status must be/);
});

test("the order list shows this store's orders only", async () => {
  const { items } = await stats.listOrders(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels(dataset()));
  assert.deepEqual(items.map((o) => [o.orderName, o.total]), [["#1002", 500], ["#1001", 1500]]);
});

// ---- the HTTP layer ---------------------------------------------------------------------------------
async function serve(over = {}) {
  const calls = [];
  const api = {
    overview: async (shop, q) => { calls.push(["overview", shop, q]); return { ok: true }; },
    listConversations: async (shop) => { calls.push(["list", shop]); return { items: [] }; },
    getConversation: async (shop, id) => (id === "mine" ? { conversation: {} } : null),
    updateConversation: async (shop, id, { status }) => { calls.push(["status", shop, id, status]); return id === "mine" ? { id, status } : null; },
    listOrders: async () => ({ items: [] }),
  };
  const config = {
    DEFAULT_RETENTION_DAYS: 90,
    getAgentSettings: async () => ({ version: 2 }),
    invalidateSettings() {},
    getSettingsHistory: async () => [],
    saveAgentSettings: async (shop, patch, o) => { calls.push(["save", shop, patch, o.by, o.expectedVersion]); if (patch === "boom") throw Object.assign(new Error("Conflict"), { name: "SettingsConflictError" }); return patch?.bad ? { ok: false, errors: ["nope"] } : { ok: true, settings: { version: 3 }, changed: ["x"] }; },
  };
  const app = express();
  app.use(express.json());
  app.use("/admin/api", createAdminRouter({
    auth: requireAdmin({ verify, active: async (s) => s === A }),
    store: async (shop) => ({ shop, name: "A", currency: "INR", timezone: "UTC", industry: "ecommerce" }),
    api, config, orders: { OrderLookupError, orderStatuses: async () => ({}), orderDetails: async () => null }, perform: async (shop) => ({ shop }), team: { sendStaffReply: async () => ({ at: "x" }), setHandoff: async () => ({}) }, limit: (req, res, next) => next(), ...over,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin/api`;
  const call = (path, { method = "GET", body, auth = `Bearer ${token()}` } = {}) =>
    fetch(base + path, { method, headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), cache: r.headers.get("cache-control") }));
  return { call, calls, close: () => server.close() };
}

test("every admin route refuses a caller without a valid token", async () => {
  const s = await serve();
  try {
    for (const [method, path] of [["GET", "/me"], ["GET", "/overview"], ["GET", "/conversations"], ["GET", "/conversations/mine"], ["PATCH", "/conversations/mine"], ["GET", "/orders"], ["GET", "/orders/1001"], ["GET", "/performance"], ["POST", "/conversations/aaaaaaaaaaaaaaaaaaaaaaaa/reply"], ["POST", "/conversations/aaaaaaaaaaaaaaaaaaaaaaaa/handoff"], ["GET", "/settings"], ["PUT", "/settings"], ["GET", "/settings/history"]]) {
      assert.equal((await s.call(path, { method, auth: null, body: {} })).status, 401, `${method} ${path}`);
      assert.equal((await s.call(path, { method, auth: "Bearer junk", body: {} })).status, 401, `${method} ${path} with junk`);
    }
    assert.equal(s.calls.length, 0);
  } finally { s.close(); }
});

test("the store always comes from the token, never from the URL or the body", async () => {
  const s = await serve();
  try {
    await s.call(`/overview?shop=${B}&from=2026-10-01`);
    await s.call("/settings", { method: "PUT", body: { shop: B, settings: { persona: { name: "X" } } } });
    await s.call("/conversations/mine", { method: "PATCH", body: { shop: B, status: "resolved" } });
    assert.ok(s.calls.length === 3 && s.calls.every((c) => c[1] === A), JSON.stringify(s.calls));
  } finally { s.close(); }
});

test("a conversation of another store is 'not found', settings errors are 400/409, and replies are never cached", async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("/conversations/someone-elses")).status, 404);
    assert.equal((await s.call("/conversations/someone-elses", { method: "PATCH", body: { status: "resolved" } })).status, 404);
    const bad = await s.call("/settings", { method: "PUT", body: { settings: { bad: 1 } } });
    assert.deepEqual([bad.status, bad.body.errors], [400, ["nope"]]);
    assert.equal((await s.call("/settings", { method: "PUT", body: { settings: "boom" } })).status, 409);
    const ok = await s.call("/settings", { method: "PUT", body: { settings: { persona: { name: "Mira" } }, expectedVersion: 2 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(s.calls.filter((c) => c[0] === "save").pop().slice(3), ["42", 2]); // saved by the signed-in Shopify user
    const me = await s.call("/me");
    assert.equal(me.cache, "no-store");
    const options = await s.call("/settings");
    assert.ok(options.body.options.configurableTools.includes("place_order"));
  } finally { s.close(); }
});

test("a validation problem is a 400 with its message; an unexpected failure never leaks details", async () => {
  const s = await serve({ api: { overview: async () => { throw new stats.InputError("from must not be after to."); }, listConversations: async () => { throw new Error("mongo://user:password@host exploded"); } } });
  try {
    const a = await s.call("/overview");
    assert.deepEqual([a.status, a.body.error], [400, "from must not be after to."]);
    const b = await s.call("/conversations");
    assert.equal(b.status, 500);
    assert.ok(!JSON.stringify(b.body).includes("password"));
  } finally { s.close(); }
});

test("the router builds with its real defaults (rate limiter, token check) and still refuses an anonymous caller", async () => {
  const app = express();
  app.use("/admin/api", createAdminRouter());
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/overview`);
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test("the dashboard in Shopify admin may ask permission first (CORS), but an unsigned call is still refused", async () => {
  const app = express();
  app.use("/admin/api", createAdminRouter());
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/admin/api/settings`;
  try {
    const ask = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://extensions.shopifycdn.com", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(ask.status, 204);
    assert.match(ask.headers.get("access-control-allow-headers"), /authorization/i);
    assert.match(ask.headers.get("access-control-allow-methods"), /PUT/);
    assert.equal(ask.headers.get("access-control-allow-credentials"), null);
    const real = await fetch(url, { headers: { Origin: "https://extensions.shopifycdn.com" } });
    assert.equal(real.status, 401);
    assert.equal(real.headers.get("access-control-allow-origin"), "https://extensions.shopifycdn.com");
  } finally { server.close(); }
});

test("overview counts chats that added to cart or reached checkout but never ordered", async () => {
  const [a, b, c, d] = [oid(), oid(), oid(), oid()];
  const ev = (shop, type, conversationId, at = "2026-10-29T08:00:00Z") => ({ _id: oid(), shop, type, at: t(at), conversationId, chatRef: null, channel: "text", language: "en", props: {} });
  const events = [
    ev(A, "conversation_started", a), ev(A, "cart_add", a), // cart only
    ev(A, "conversation_started", b), ev(A, "cart_add", b), ev(A, "checkout_started", b), // reached checkout, no order
    ev(A, "conversation_started", c), ev(A, "cart_add", c), ev(A, "checkout_started", c), ev(A, "order_placed", c), // ordered: not a drop-off
    ev(A, "cart_add", a), // a second add in the same chat counts once
    ev(B, "conversation_started", d), ev(B, "cart_add", d), ev(B, "checkout_started", d), // another store: never counted
  ];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels({ events, conversations: [], messages: [] }));
  assert.deepEqual(o.totals.dropoffs, { cartOnly: 2, checkoutNoOrder: 1 });
});

test("overview says who placed the orders: the agent in the chat, or the shopper later on the site", async () => {
  const ev = (type, source) => ({ _id: oid(), shop: A, type, at: t("2026-10-29T08:00:00Z"), conversationId: oid(), chatRef: null, channel: "text", language: "en", props: source === undefined ? {} : { source } });
  const events = [ev("order_placed", "agent"), ev("order_placed", "agent"), ev("order_placed", "assisted"), ev("order_placed"), ev("cart_add", "agent")];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels({ events, conversations: [], messages: [] }));
  assert.deepEqual(o.totals.ordersBySource, { agent: 2, assisted: 1, unknown: 1 });
  assert.equal(o.totals.orders, 4);
});

test("overview says how the orders were paid, for this store only", async () => {
  const ev = (shop, type, paymentMethod) => ({ _id: oid(), shop, type, at: t("2026-10-29T08:00:00Z"), conversationId: oid(), chatRef: null, channel: "text", language: "en", props: paymentMethod === undefined ? {} : { paymentMethod } });
  const events = [ev(A, "order_placed", "cod"), ev(A, "order_placed", "cod"), ev(A, "order_placed", "prepaid"), ev(A, "order_placed"), ev(A, "cart_add", "cod"), ev(B, "order_placed", "cod")];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels({ events, conversations: [], messages: [] }));
  assert.deepEqual(o.totals.ordersByPayment, { cod: 2, prepaid: 1, unknown: 1 });
});

test("overview counts chats marked for follow-up in the period, for this store only", async () => {
  const conv = (shop, status, at) => ({ _id: oid(), shop, status, lastMessageAt: t(at) });
  const conversations = [
    conv(A, "needs_human", "2026-10-29T08:00:00Z"), conv(A, "needs_human", "2026-10-20T08:00:00Z"),
    conv(A, "open", "2026-10-29T08:00:00Z"), conv(A, "needs_human", "2026-08-01T08:00:00Z"), // too old
    conv(B, "needs_human", "2026-10-29T08:00:00Z"), // another store
  ];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, opts, fakeModels({ events: [], conversations, messages: [] }));
  assert.equal(o.totals.needsFollowUp, 2);
});

test("each person says whether a call is waiting and how many files they sent, for this store only", async () => {
  const conv = (shop, over) => ({ _id: oid(), shop, status: "open", channel: "text", messageCount: 4, startedAt: t("2026-10-29T08:00:00Z"), lastMessageAt: t("2026-10-29T08:30:00Z"), contact: {}, flags: {}, fileCount: 0, outcomeRank: 0, ...over });
  const riya = { name: "Riya", email: "riya@x.com", phone: "+91 90000 00001" };
  const conversations = [
    conv(A, { contact: riya, customerRef: "gid://shopify/Customer/1", flags: { callRequested: true } }),
    conv(A, { contact: riya, customerRef: "gid://shopify/Customer/1", fileCount: 2 }),
    conv(A, { contact: { name: "Aman", email: "aman@x.com" }, status: "needs_human" }),
    conv(B, { contact: riya, customerRef: "gid://shopify/Customer/1", flags: { callRequested: true }, fileCount: 9 }),
  ];
  const base = fakeModels({ events: [], conversations, messages: [] });
  const models = { ...base, Conversation: { ...base.Conversation, aggregate: async (p) => new Aggregator(p).run(conversations) } };
  const page = await stats.listCustomers(A, { from: "2026-10-01", to: "2026-10-30" }, opts, models);
  const by = Object.fromEntries(page.items.map((p) => [p.name, p]));
  assert.equal(page.total, 2);
  assert.equal(by.Riya.callRequested, true);
  assert.equal(by.Riya.fileCount, 2);
  assert.equal(by.Riya.chats, 2);
  assert.equal(by.Aman.callRequested, false);
  assert.equal(by.Aman.fileCount, 0);
  assert.equal(by.Aman.needsFollowUp, true);
});

test("a store set up in dollars whose orders were taken in rupees shows its rupee sales, never $0", async () => {
  const ev = (props) => ({ _id: oid(), shop: A, type: "order_placed", at: t("2026-10-29T08:00:00Z"), conversationId: oid(), chatRef: null, channel: "text", language: "en", props });
  const events = [ev({ total: 120000, currency: "INR", shopCurrency: "USD" }), ev({ total: 80000, currency: "INR", shopCurrency: "" })];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, { ...opts, currency: "USD" }, fakeModels({ events, conversations: [], messages: [] }));
  assert.equal(o.totals.orders, 2);
  assert.deepEqual(o.totals.revenue, { currency: "INR", amount: 200000 });
  assert.equal(o.totals.averageOrderValue, 100000);
  assert.deepEqual(o.totals.otherRevenue, []);
});

test("sales in two currencies: the store's own is the headline and the other is reported, not dropped", async () => {
  const ev = (props) => ({ _id: oid(), shop: A, type: "order_placed", at: t("2026-10-29T08:00:00Z"), conversationId: oid(), chatRef: null, channel: "text", language: "en", props });
  const events = [ev({ shopTotal: 150, shopCurrency: "USD", total: 14000, currency: "INR" }), ev({ total: 5000, currency: "INR" })];
  const o = await stats.overview(A, { from: "2026-10-01", to: "2026-10-30" }, { ...opts, currency: "USD" }, fakeModels({ events, conversations: [], messages: [] }));
  assert.deepEqual(o.totals.revenue, { currency: "USD", amount: 150 });
  assert.deepEqual(o.totals.otherRevenue, [{ currency: "INR", amount: 5000 }]);
});

test("searching orders also finds them by who ordered, within this store", async () => {
  const d = dataset();
  d.conversations.find((c) => String(c._id) === String(d.ids.c1)).contact = { name: "Riya Sharma", email: "riya@example.com" };
  d.conversations.find((c) => String(c._id) === String(d.ids.cb)).contact = { name: "Riya Sharma" };
  const m = fakeModels(d);
  const range = { from: "2026-10-01", to: "2026-10-30" };
  assert.deepEqual((await stats.listOrders(A, { ...range, q: "riya" }, opts, m)).items.map((o) => o.orderName), ["#1001"]);
  assert.deepEqual((await stats.listOrders(A, { ...range, q: "1002" }, opts, m)).items.map((o) => o.orderName), ["#1002"]);
  assert.equal((await stats.listOrders(A, { ...range, q: "nobody" }, opts, m)).items.length, 0);
});

test("the orders route adds Shopify's payment and delivery status, and a missing one is null", async () => {
  const s = await serve({
    api: { listOrders: async () => ({ items: [{ orderName: "#1001" }, { orderName: "#1002" }] }) },
    orders: { OrderLookupError, orderStatuses: async (shop, names) => (shop === A && names.length === 2 ? { 1001: { payment: "paid", fulfillment: "fulfilled", cancelled: false } } : {}) },
  });
  try {
    const { body } = await s.call("/orders");
    assert.deepEqual(body.items.map((o) => o.status), [{ payment: "paid", fulfillment: "fulfilled", cancelled: false }, null]);
  } finally { s.close(); }
});

test("one order: only for this store's chat orders, with friendly errors", async () => {
  const seen = [];
  const s = await serve({
    orders: {
      OrderLookupError,
      orderStatuses: async () => ({}),
      orderDetails: async (shop, name) => {
        seen.push([shop, name]);
        if (name === "9") return null;
        if (name === "bad") throw new OrderLookupError("That order number is not valid.", 400);
        if (name === "down") throw new OrderLookupError("Shopify did not answer. Try again in a moment.", 502);
        return { recorded: {}, order: { name: "#1001" }, notice: "" };
      },
    },
  });
  try {
    assert.equal((await s.call("/orders/1001", { auth: null })).status, 401);
    assert.equal((await s.call("/orders/1001")).body.order.name, "#1001");
    assert.equal((await s.call("/orders/9")).status, 404);
    assert.deepEqual([(await s.call("/orders/bad")).status, (await s.call("/orders/down")).body.error], [400, "Shopify did not answer. Try again in a moment."]);
    assert.ok(seen.every(([shop]) => shop === A));
  } finally { s.close(); }
});

test("agent performance counts this store's chats and replies, and fills empty days", async () => {
  const d = dataset();
  const conv = d.conversations.find((c) => String(c._id) === String(d.ids.c2));
  conv.status = "needs_human";
  d.conversations.find((c) => String(c._id) === String(d.ids.c3)).status = "resolved";
  d.conversations.find((c) => String(c._id) === String(d.ids.c3)).flags = { needsFollowUp: true }; // closed since: no longer waiting
  const p = await agentPerformance(A, { from: "2026-10-27", to: "2026-10-30" }, opts, fakeModels(d));
  assert.deepEqual([p.totals.conversations, p.totals.needPerson, p.totals.handledAlone, p.totals.handledAloneRate, p.totals.resolved], [3, 1, 2, 0.667, 1]);
  assert.deepEqual([p.totals.replies, p.totals.failedReplies, p.totals.failedRate, p.totals.averageResponseMs], [3, 1, 0.333, 2000]);
  assert.deepEqual([p.totals.orderedChats, p.totals.orderRate, p.totals.channels], [2, 0.667, { text: 2, voice: 1 }]);
  assert.deepEqual(p.series.map((r) => [r.date, r.replies, r.failed, r.averageResponseMs]), [["2026-10-27", 0, 0, 0], ["2026-10-28", 0, 0, 0], ["2026-10-29", 3, 1, 2000], ["2026-10-30", 0, 0, 0]]);
  assert.deepEqual(p.funnel.map((f) => f.stage), analytics.funnel);
  assert.ok(!JSON.stringify(p).includes("9999"), "store B must not leak in");
});

test("agent performance on a store with no activity is all zeros, not NaN", async () => {
  const p = await agentPerformance(A, { from: "2026-10-01", to: "2026-10-03" }, opts, fakeModels({ events: [], conversations: [], messages: [] }));
  assert.deepEqual([p.totals.conversations, p.totals.handledAloneRate, p.totals.failedRate, p.totals.averageResponseMs, p.totals.orderRate], [0, 0, 0, 0, 0]);
  assert.equal(p.series.length, 3);
});

test("the performance route answers for the token's store", async () => {
  const s = await serve();
  try {
    assert.deepEqual((await s.call(`/performance?shop=${B}`)).body, { shop: A });
  } finally { s.close(); }
});

test("the team can reply to a shopper and take a chat over or hand it back, only in their own store", async () => {
  const seen = [];
  const { HandoffError } = await import("../../src/services/handoff.js");
  const id = "a".repeat(24);
  const s = await serve({
    team: {
      sendStaffReply: async (shop, cid, { text, by }) => { seen.push(["reply", shop, cid, text, by]); if (text === "closed") throw new HandoffError("The customer cleared this chat, so they can no longer receive replies.", 409); return { at: "2026-11-04T10:00:00.000Z" }; },
      setHandoff: async (shop, cid, { active, by }) => { seen.push(["handoff", shop, cid, active, by]); return { handoff: active ? { active: true } : undefined }; },
    },
  });
  try {
    assert.deepEqual((await s.call(`/conversations/${id}/reply`, { method: "POST", body: { shop: B, text: "Refund sent" } })).body, { at: "2026-11-04T10:00:00.000Z", handoff: { active: true } });
    assert.deepEqual((await s.call(`/conversations/${id}/handoff`, { method: "POST", body: { active: false } })).body, { handoff: { active: false } });
    assert.equal((await s.call(`/conversations/${id}/handoff`, { method: "POST", body: { active: "yes" } })).status, 400);
    assert.equal((await s.call("/conversations/not-an-id/reply", { method: "POST", body: { text: "hi" } })).status, 404);
    const closed = await s.call(`/conversations/${id}/reply`, { method: "POST", body: { text: "closed" } });
    assert.deepEqual([closed.status, closed.body.error], [409, "The customer cleared this chat, so they can no longer receive replies."]);
    assert.ok(seen.every(([, shop]) => shop === A), "the store comes from the token");
    assert.equal(seen[0][4], "42");
  } finally { s.close(); }
});

test("a chat shows whether a person has it, and closing a chat gives it back to the AI", async () => {
  const d = dataset();
  const conv = d.conversations.find((c) => String(c._id) === String(d.ids.c2));
  conv.handoff = { active: true, at: t("2026-10-29T08:10:00Z") };
  const m = fakeModels(d);
  assert.equal((await stats.getConversation(A, String(d.ids.c2), m)).conversation.handoff.active, true);
  assert.equal((await stats.getConversation(A, String(d.ids.c1), m)).conversation.handoff.active, false);
});

test("resolving a chat clears follow-up and any takeover in one update", async () => {
  let sent;
  const models = { Conversation: { findOneAndUpdate: async (filter, update) => { sent = { filter, update }; return { _id: filter._id, shop: filter.shop, startedAt: new Date(), lastMessageAt: new Date(), status: "resolved" }; } } };
  await stats.updateConversation(A, "a".repeat(24), { status: "resolved" }, models);
  assert.equal(sent.filter.shop, A);
  assert.deepEqual(Object.keys(sent.update.$unset).sort(), ["flags.needsFollowUp", "handoff"]);
});

test("the owner records a refund / exchange status that the chat then shows", async () => {
  let sent;
  const reply = (extra) => ({ _id: "a".repeat(24), shop: A, startedAt: new Date(), lastMessageAt: new Date(), ...extra });
  const models = { Conversation: { findOneAndUpdate: async (filter, update) => { sent = { filter, update }; return reply({ case: update.$set?.case }); } } };
  const out = await stats.updateConversation(A, "a".repeat(24), { case: { type: "refund", status: "approved", note: "  Refund goes out in 5 days  " }, by: "owner@x.com" }, models);
  assert.equal(sent.filter.shop, A);
  assert.deepEqual([sent.update.$set.case.type, sent.update.$set.case.status, sent.update.$set.case.note, sent.update.$set.case.updatedBy], ["refund", "approved", "Refund goes out in 5 days", "owner@x.com"]);
  assert.ok(sent.update.$set.case.updatedAt instanceof Date);
  assert.equal(out.case.status, "approved");
  assert.equal(out.case.note, "Refund goes out in 5 days");
  await assert.rejects(stats.updateConversation(A, "a".repeat(24), { case: { type: "gift", status: "approved" } }, models), /type must be one of/);
  await assert.rejects(stats.updateConversation(A, "a".repeat(24), { case: { type: "refund", status: "shipped" } }, models), /status must be one of/);
  await stats.updateConversation(A, "a".repeat(24), { case: null }, models);
  assert.deepEqual(sent.update.$unset, { case: "" });
});

test("a chat with no recorded request shows case: null", async () => {
  const d = dataset();
  assert.equal((await stats.getConversation(A, String(d.ids.c1), fakeModels(d))).conversation.case, null);
});
