import test from "node:test";
import assert from "node:assert/strict";
import { recallVisitor, visitorMemoryBlock } from "../src/services/visitorMemory.js";

const chat = (o) => ({ shop: "s.myshopify.com", chatRef: "r1", clearedAt: null, startedAt: new Date("2026-10-01"), lastMessageAt: new Date("2026-10-02"), ...o });
const fakeDeps = (chats, events = []) => {
  let seen;
  return {
    seen: () => seen,
    Conversation: { find(q) { seen = q; const rows = chats.filter((c) => c.clearedAt == null); return { sort: () => ({ limit: () => ({ lean: async () => rows }) }) }; } },
    Event: { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => events }) }) }) },
  };
};

test("recall: empty without a visitor id", async () => {
  assert.equal(await recallVisitor("s.myshopify.com", "", {}, fakeDeps([])), null);
});

test("recall: contact, orders, cases from earlier chats; cleared chats are excluded in the query", async () => {
  const deps = fakeDeps(
    [chat({ contact: { name: "Agam", email: "a@x.com" }, firstMessage: "where is my order", case: { type: "refund", status: "approved", note: "Refund in 5 days" } })],
    [{ props: { orderName: "#1007", shopTotal: 499, shopCurrency: "INR" }, at: new Date() }]
  );
  const m = await recallVisitor("s.myshopify.com", "abcdefghijklmnop1234", {}, deps);
  assert.equal(deps.seen().clearedAt, null);
  assert.equal(m.contact.email, "a@x.com");
  assert.equal(m.orders[0].name, "#1007");
  assert.equal(m.cases[0].status, "approved");
});

test("block: facts, case status wording, and the look-before-asking rule", () => {
  const text = visitorMemoryBlock({ contact: { name: "Agam" }, orders: [{ name: "#1007", total: 499, currency: "INR" }], cases: [{ type: "exchange", status: "in_progress", note: "", updatedAt: new Date("2026-10-03") }], chats: [] });
  assert.match(text, /name Agam/);
  assert.match(text, /#1007 \(499 INR\)/);
  assert.match(text, /exchange, status "in progress"/);
  assert.match(text, /no note yet/);
  assert.match(text, /look here first/);
  assert.equal(visitorMemoryBlock(null), "");
  assert.equal(visitorMemoryBlock({ contact: {}, orders: [], cases: [], chats: [] }), "");
});
