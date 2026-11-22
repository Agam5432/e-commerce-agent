// When a visitor is identified, their earlier anonymous chats become theirs; chats of someone else who used the
// same browser are left alone.
import test from "node:test";
import assert from "node:assert/strict";
import { Query } from "mingo";
import { recordTurn, chatRefFor } from "../src/services/conversationLog.js";

const SHOP = "a-store.myshopify.com";
const NOW = Date.parse("2026-11-04T10:00:00Z");

function fakes(conversations) {
  const Conversation = {
    findOneAndUpdate: async () => null,
    findOne: () => { const chain = { sort: () => chain, lean: async () => null }; return chain; },
    create: async (doc) => { const row = { _id: `n${conversations.length}`, ...doc }; conversations.push(row); return { toObject: () => row }; },
    updateOne: async () => ({ modifiedCount: 0 }),
    updateMany: async (filter, update) => {
      let n = 0;
      for (const c of conversations) if (new Query(filter).test(c)) { for (const [k, v] of Object.entries(update.$set)) { if (k.includes(".")) { const [a, b] = k.split("."); c[a] = { ...(c[a] || {}), [b]: v }; } else c[k] = v; } n++; }
      return { modifiedCount: n };
    },
  };
  return {
    Conversation, Message: { insertMany: async () => {} }, Event: { insertMany: async () => {} },
    connected: () => true, now: () => NOW, linkBookings: async () => [], ownerEmail: async () => "", alert: async () => {},
  };
}

const turn = (over = {}) => ({ shop: SHOP, clientId: "client-0123456789abcdef", result: { answer: "ok" }, userMessage: "hi", settings: {}, analytics: {}, ...over });

test("earlier anonymous chats of this visitor take the name once they are identified", async () => {
  const ref = chatRefFor(SHOP, "client-0123456789abcdef");
  const rows = [{ _id: "old", shop: SHOP, chatRef: ref, customerRef: null, personKey: `v${ref}`, contact: {} }];
  await recordTurn(turn({ customerId: "gid://shopify/Customer/55", contact: { name: "Agam Tyagi", email: "a@example.com" } }), fakes(rows));
  assert.equal(rows[0].personKey, "c55");
  assert.equal(rows[0].contact.email, "a@example.com");
});

test("a chat that belongs to someone else on the same browser is not taken over", async () => {
  const ref = chatRefFor(SHOP, "client-0123456789abcdef");
  const rows = [
    { _id: "other", shop: SHOP, chatRef: ref, customerRef: "99", personKey: "c99", contact: { name: "Riya", email: "riya@example.com" } },
    { _id: "guest-other", shop: SHOP, chatRef: ref, customerRef: null, personKey: "eSOMEONEELSE", contact: { name: "Aman", email: "aman@example.com" } },
  ];
  await recordTurn(turn({ customerId: "gid://shopify/Customer/55", contact: { name: "Agam Tyagi", email: "a@example.com" } }), fakes(rows));
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.personKey, r.contact.name]), [["c99", "Riya"], ["eSOMEONEELSE", "Aman"]]);
});

test("a guest chat with the same email joins the signed-in customer", async () => {
  const ref = chatRefFor(SHOP, "client-0123456789abcdef");
  const rows = [{ _id: "g", shop: SHOP, chatRef: ref, customerRef: null, personKey: "eHASH", contact: { name: "Agam", email: "a@example.com" } }];
  await recordTurn(turn({ customerId: "gid://shopify/Customer/55", contact: { name: "Agam Tyagi", email: "a@example.com" } }), fakes(rows));
  assert.equal(rows[0].personKey, "c55");
});
