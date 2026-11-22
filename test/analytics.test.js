// Chat logging for the store owner's dashboard: what is stored, what is removed first, how long it is
// kept, and that it can never leak between stores or slow the customer's reply.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { redactText, chatRefFor, recordTurn, recordEvent, newTelemetry, noteLLM, noteTool, EVENT_RETENTION_DAYS } from "../src/services/conversationLog.js";
import ecommerce from "../src/industries/ecommerce.js";
import { runAgent, __setLLMClientsForTest } from "../src/agent/agent.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import Event from "../src/models/Event.js";
import AgentSettings from "../src/models/AgentSettings.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import Complaint from "../src/models/Complaint.js";
import { clearSettingsCache } from "../src/admin/settings.js";

const SHOP = "a-store.myshopify.com";
const NOW = Date.parse("2026-10-30T10:00:00Z");
const DAY = 86400_000;

// A tiny in-memory stand-in for the three collections.
function fakeDb() {
  const convs = [], msgs = [], events = [];
  const seenKeys = new Set();
  return {
    convs, msgs, events,
    connected: () => true,
    Conversation: {
      async findOneAndUpdate(filter, update) {
        const c = convs.filter((x) => x.shop === filter.shop && x.chatRef === filter.chatRef && x.lastMessageAt >= filter.lastMessageAt.$gte).sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
        if (!c) return null;
        Object.assign(c, update.$set);
        for (const [k, v] of Object.entries(update.$inc || {})) c[k] = (c[k] || 0) + v;
        return { ...c };
      },
      async create(doc) { const c = { _id: new mongoose.Types.ObjectId(), outcome: "chat", outcomeRank: 0, ...doc }; convs.push(c); return c; },
      async updateOne(filter, update) {
        const c = convs.find((x) => String(x._id) === String(filter._id) && x.shop === filter.shop && x.outcomeRank < filter.outcomeRank.$lt);
        if (c) Object.assign(c, update.$set);
      },
    },
    Message: { async insertMany(docs) { msgs.push(...docs); } },
    Event: {
      async insertMany(docs) {
        const dup = [];
        for (const d of docs) {
          const key = d.dedupeKey ? `${d.shop}|${d.dedupeKey}` : null;
          if (key && seenKeys.has(key)) { dup.push({ code: 11000 }); continue; }
          if (key) seenKeys.add(key);
          events.push(d);
        }
        if (dup.length) { const e = new Error("E11000"); e.writeErrors = dup; throw e; }
      },
      async create(d) {
        const key = d.dedupeKey ? `${d.shop}|${d.dedupeKey}` : null;
        if (key && seenKeys.has(key)) { const e = new Error("E11000"); e.code = 11000; throw e; }
        if (key) seenKeys.add(key);
        events.push(d);
      },
    },
  };
}

const turn = (over = {}) => ({
  shop: SHOP, clientId: "client-abcdefghijklmnop", industry: "ecommerce", analytics: ecommerce.analytics,
  settings: {}, userMessage: "show me earbuds", result: { answer: "Here are some earbuds.", products: [], actions: [] },
  telemetry: { ...newTelemetry(), startedAt: NOW - 1200, llmCalls: 2, tokensIn: 900, tokensOut: 60, provider: "gemini", model: "m" }, ...over,
});

// ---- personal data -------------------------------------------------------------------------
test("redaction removes emails, phones, cards and one-time codes but keeps the sentence", () => {
  assert.equal(redactText("mail me at agam.tyagi@gmail.com please"), "mail me at [email] please");
  assert.equal(redactText("call +91 98765 43210 today"), "call [phone] today");
  assert.equal(redactText("card 4242 4242 4242 4242 exp 12/29"), "card [card] exp 12/29");
  assert.equal(redactText("my otp is 483920"), "my otp is [code]");
  assert.equal(redactText("483920"), "[code]");
});

test("redaction leaves ordinary numbers, prices, dates and not-a-card digits alone", () => {
  assert.equal(redactText("under 2500 rupees"), "under 2500 rupees");
  assert.equal(redactText("2026-10-30 delivery"), "2026-10-30 delivery");
  assert.equal(redactText("order 1234 5678 9012 3456 shipped"), "order 1234 5678 9012 3456 shipped"); // fails the card checksum
});

test("the visitor reference is stable, per store, and not the private client id", () => {
  const a = chatRefFor(SHOP, "client-abcdefghijklmnop");
  assert.equal(a, chatRefFor(SHOP, "client-abcdefghijklmnop"));
  assert.notEqual(a, chatRefFor("other.myshopify.com", "client-abcdefghijklmnop"));
  assert.ok(!a.includes("client-abcdefghijklmnop"));
  assert.equal(a.length, 22);
});

// ---- recording a turn ----------------------------------------------------------------------
test("the first turn starts a conversation, stores the redacted transcript and writes events", async () => {
  const db = fakeDb();
  const id = await recordTurn(turn({ userMessage: "write to me at x@y.com about earbuds", result: { answer: "Sure.", products: [{ id: "1", title: "Boat 141" }], actions: [{ type: "add_to_cart", title: "Boat 141", quantity: 1 }] } }), { ...db, now: () => NOW });
  assert.ok(id);
  assert.equal(db.convs.length, 1);
  assert.equal(db.convs[0].firstMessage, "write to me at [email] about earbuds");
  assert.equal(db.convs[0].outcome, "cart_add");
  assert.deepEqual(db.msgs.map((m) => [m.role, m.text]), [["user", "write to me at [email] about earbuds"], ["assistant", "Sure."]]);
  assert.deepEqual(db.events.map((e) => e.type), ["conversation_started", "turn", "products_shown", "cart_add"]);
  const t = db.events.find((e) => e.type === "turn").props;
  assert.equal(t.ms, 1200);
  assert.equal(t.tokensIn, 900);
  assert.equal(t.provider, "gemini");
  assert.ok(db.events.every((e) => e.shop === SHOP && String(e.conversationId) === String(id)));
});

test("a message soon after continues the same conversation; a long silence starts a new one", async () => {
  const db = fakeDb();
  const a = await recordTurn(turn(), { ...db, now: () => NOW });
  const b = await recordTurn(turn({ userMessage: "and cheaper?" }), { ...db, now: () => NOW + 5 * 60_000 });
  assert.equal(String(a), String(b));
  assert.equal(db.convs[0].messageCount, 2);
  assert.equal(db.events.filter((e) => e.type === "conversation_started").length, 1);
  const c = await recordTurn(turn({ userMessage: "hello" }), { ...db, now: () => NOW + 5 * 60_000 + 31 * 60_000 });
  assert.notEqual(String(a), String(c));
  assert.equal(db.convs.length, 2);
});

test("a chat only moves forward: later turns cannot lower how far it got", async () => {
  const db = fakeDb();
  await recordTurn(turn({ result: { answer: "ok", actions: [{ type: "order_placed", orderId: "#1001", total: 999, currency: "INR", paymentMethod: "cod" }] } }), { ...db, now: () => NOW });
  await recordTurn(turn({ result: { answer: "ok", products: [{ id: "2", title: "X" }] } }), { ...db, now: () => NOW + 60_000 });
  assert.equal(db.convs[0].outcome, "order_placed");
  assert.equal(db.convs[0].outcomeRank, 4);
});

test("one visitor's chat never lands in another store", async () => {
  const db = fakeDb();
  await recordTurn(turn(), { ...db, now: () => NOW });
  await recordTurn(turn({ shop: "b-store.myshopify.com" }), { ...db, now: () => NOW + 1000 });
  assert.equal(db.convs.length, 2);
  assert.deepEqual(db.convs.map((c) => c.shop).sort(), [SHOP, "b-store.myshopify.com"]);
  assert.ok(db.events.every((e) => (e.shop === SHOP) === (String(e.conversationId) === String(db.convs.find((c) => c.shop === SHOP)._id))));
});

test("when the owner turns transcripts off nothing the customer typed is stored", async () => {
  const db = fakeDb();
  await recordTurn(turn({ settings: { logging: { storeTranscripts: false } } }), { ...db, now: () => NOW });
  assert.equal(db.msgs.length, 0);
  assert.equal(db.convs[0].firstMessage, "");
  assert.ok(db.events.some((e) => e.type === "turn")); // the counts still work
});

test("retention: transcripts expire on the owner's setting, events later", async () => {
  const db = fakeDb();
  await recordTurn(turn({ settings: { logging: { retentionDays: 30 } } }), { ...db, now: () => NOW });
  assert.equal(db.msgs[0].expiresAt.getTime(), NOW + 30 * DAY);
  assert.equal(db.convs[0].expiresAt.getTime(), NOW + 30 * DAY);
  assert.equal(db.events[0].expiresAt.getTime(), NOW + EVENT_RETENTION_DAYS * DAY);
});

test("a failed AI turn is counted as degraded", async () => {
  const db = fakeDb();
  await recordTurn(turn({ degraded: true }), { ...db, now: () => NOW });
  assert.equal(db.convs[0].degradedTurns, 1);
  assert.equal(db.msgs[1].degraded, true);
  assert.equal(db.events.find((e) => e.type === "turn").props.degraded, true);
});

test("nothing is written while the database is down, and a verified customer is linked by id only", async () => {
  const down = fakeDb();
  assert.equal(await recordTurn(turn(), { ...down, connected: () => false }), null);
  assert.equal(down.convs.length, 0);
  const db = fakeDb();
  await recordTurn(turn({ customerId: "gid://shopify/Customer/778899" }), { ...db, now: () => NOW });
  assert.equal(db.convs[0].customerRef, "778899");
});

test("the same order seen twice is counted once", async () => {
  const db = fakeDb();
  const order = { type: "order_placed", orderId: "#1001", total: 1500, currency: "INR", paymentMethod: "cod" };
  await recordTurn(turn({ result: { answer: "done", actions: [order] } }), { ...db, now: () => NOW });
  assert.equal(await recordEvent({ shop: SHOP, type: "order_placed", dedupeKey: "order:#1001", props: { total: 1500 } }, { ...db, now: () => NOW }), false);
  assert.equal(db.events.filter((e) => e.type === "order_placed").length, 1);
  assert.equal(await recordEvent({ shop: "b-store.myshopify.com", type: "order_placed", dedupeKey: "order:#1001" }, { ...db, now: () => NOW }), true); // another store's #1001
});

test("the measurements add up across the AI calls and tools of one turn", () => {
  const t = newTelemetry();
  noteLLM(t, { provider: "gemini", model: "m", usage: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50 } });
  noteLLM(t, { provider: "gemini", model: "m", usage: { promptTokenCount: 1200, candidatesTokenCount: 80 } });
  noteTool(t, "search_products", 312.4);
  assert.deepEqual([t.llmCalls, t.tokensIn, t.tokensCached, t.tokensOut], [2, 2200, 600, 130]);
  assert.deepEqual(t.tools, [{ name: "search_products", ms: 312 }]);
});

// ---- what the shop industry counts -----------------------------------------------------------
test("shop events carry no personal data", () => {
  const events = ecommerce.analytics.eventsFromResult({
    products: [{ id: "9", title: "Travel Mug" }],
    actions: [{ type: "order_placed", orderId: "#1002", total: 1200, currency: "INR", paymentMethod: "cod", recipientEmail: "a@b.com", shipping: { address1: "12 Street", phone: "9999999999" }, cart: { items: [1, 2] } }],
  });
  const json = JSON.stringify(events);
  assert.ok(!json.includes("a@b.com") && !json.includes("12 Street") && !json.includes("9999999999"));
  const order = events.find((e) => e.type === "order_placed");
  assert.equal(order.dedupeKey, "order:#1002");
  assert.deepEqual([order.props.total, order.props.items], [1200, 2]);
});

// ---- wired into the agent ----------------------------------------------------------------------
test("end to end: a chat turn is logged after the reply, with the store owner's persona in the prompt", async () => {
  const keep = { cf: Conversation.findOneAndUpdate, cc: Conversation.create, cu: Conversation.updateOne, cfo: Conversation.findOne, cum: Conversation.updateMany, mi: Message.insertMany, ei: Event.insertMany, sf: AgentSettings.findOne, csf: CheckoutSession.findOne, csu: CheckoutSession.findOneAndUpdate, si: StoreIntegration.findOne, summary: ecommerce.getCachedCatalogSummary, fetch: globalThis.fetch };
  const ready = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  const db = fakeDb();
  try {
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    clearSettingsCache();
    globalThis.fetch = async () => { throw new Error("offline"); };
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD" });
    CheckoutSession.findOne = () => ({ lean: async () => null });
    CheckoutSession.findOneAndUpdate = () => ({ lean: async () => ({}) });
    AgentSettings.findOne = () => ({ lean: async () => ({ shop: SHOP, version: 3, persona: { name: "Mira", tone: "calm and brief" }, instructions: "We ship from Jaipur.", disabledTools: ["place_order"] }) });
    Conversation.findOneAndUpdate = db.Conversation.findOneAndUpdate;
    Conversation.create = db.Conversation.create;
    Conversation.updateOne = db.Conversation.updateOne;
    // Earlier-chat lookups are not part of this test; answer them from memory instead of waiting on a real database.
    Conversation.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    Conversation.updateMany = async () => ({});
    // a complaint of this chat: none (answered from memory like the other lookups)
    Complaint.findOne = () => ({ lean: async () => null });
    Complaint.updateMany = async () => ({});
    Message.insertMany = db.Message.insertMany;
    Event.insertMany = db.Event.insertMany;
    const calls = [];
    __setLLMClientsForTest({ gemini: { models: { generateContent: async (req) => { calls.push(req); return { usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20 }, candidates: [{ content: { role: "model", parts: [{ text: "Hi, I'm here." }] } }] }; } } } });
    const r = await runAgent("hello there", SHOP, [], "ecommerce", { clientId: `e2e-${crypto.randomUUID()}`, channel: "voice" });
    assert.match(r.answer, /here/);
    const system = calls[0].config.systemInstruction;
    assert.match(system, /You are Mira,/);
    assert.match(system, /calm and brief/);
    assert.match(system, /We ship from Jaipur\./);
    const toolNames = (calls[0].config.tools || []).flatMap((t) => (t.functionDeclarations || []).map((f) => f.name));
    assert.ok(!toolNames.includes("place_order") && toolNames.includes("search_products"));
    for (let i = 0; i < 200 && !db.events.length; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(db.convs[0].shop, SHOP);
    assert.equal(db.convs[0].channel, "voice");
    assert.deepEqual(db.msgs.map((m) => m.text), ["hello there", "Hi, I'm here."]);
    assert.equal(db.events.find((e) => e.type === "turn").props.tokensIn, 500);
  } finally {
    __setLLMClientsForTest(null);
    Object.assign(Conversation, { findOneAndUpdate: keep.cf, create: keep.cc, updateOne: keep.cu, findOne: keep.cfo, updateMany: keep.cum });
    Message.insertMany = keep.mi; Event.insertMany = keep.ei; AgentSettings.findOne = keep.sf;
    delete Complaint.findOne; delete Complaint.updateMany;
    CheckoutSession.findOne = keep.csf; CheckoutSession.findOneAndUpdate = keep.csu; StoreIntegration.findOne = keep.si;
    ecommerce.getCachedCatalogSummary = keep.summary; globalThis.fetch = keep.fetch;
    if (ready) Object.defineProperty(mongoose.connection, "readyState", ready); else delete mongoose.connection.readyState;
    clearSettingsCache();
  }
});

test("a store owner's switched-off tool refuses to run even if called directly", async () => {
  const session = ecommerce.createSession(SHOP, { disabledTools: ["place_order"], settings: {}, cart: { items: [] }, profile: {}, history: [] });
  const out = await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(out.status, "disabled");
  assert.match(out.note, /switched this capability off/);
});
