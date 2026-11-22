// A person from the store takes over a chat: the AI stays silent, the shopper's words reach the team, the
// team's replies reach the shopper, and one store can never touch another's chats.
import test from "node:test";
import assert from "node:assert/strict";
import { Query } from "mingo";
import { holdForTeam, sendStaffReply, setHandoff, staffMessagesSince, currentChat, HandoffError } from "../src/services/handoff.js";
import { chatRefFor } from "../src/services/conversationLog.js";

const A = "a-store.myshopify.com";
const B = "b-store.myshopify.com";
const NOW = Date.parse("2026-11-04T10:00:00Z");
const CLIENT = "client-1";

function world() {
  const conversations = [{ _id: "c1", shop: A, chatRef: chatRefFor(A, CLIENT), clearedAt: null, status: "open", lastMessageAt: new Date(NOW - 60_000), expiresAt: new Date(NOW + 90 * 86400_000), messageCount: 4, fileCount: 0, flags: { needsFollowUp: true, reason: "refund" } }];
  const messages = [];
  const matches = (doc, filter) => new Query(filter).test(doc);
  const apply = (doc, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) {
      if (!k.includes(".")) { doc[k] = v; continue; }
      const [a, b] = k.split(".");
      doc[a] = { ...(doc[a] || {}), [b]: v };
    }
    for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
    for (const k of Object.keys(update.$unset || {})) delete doc[k];
    return doc;
  };
  const Conversation = {
    findOne: (filter) => {
      const hit = conversations.filter((c) => matches(c, filter));
      const chain = { sort: () => { hit.sort((x, y) => y.lastMessageAt - x.lastMessageAt); return chain; }, lean: async () => (hit[0] ? { ...hit[0] } : null), then: (res, rej) => chain.lean().then(res, rej) };
      return chain;
    },
    updateOne: async (filter, update) => { const c = conversations.find((x) => matches(x, filter)); if (c) apply(c, update); },
    findOneAndUpdate: async (filter, update) => { const c = conversations.find((x) => matches(x, filter)); return c ? { ...apply(c, update) } : null; },
  };
  const Message = {
    insertMany: async (docs) => { messages.push(...docs.map((d, i) => ({ _id: `m${messages.length + i}`, ...d }))); },
    find: (filter) => {
      let rows = messages.filter((m) => matches(m, filter));
      const chain = { sort: () => { rows = [...rows].sort((x, y) => x.at - y.at); return chain; }, limit: (n) => { rows = rows.slice(0, n); return chain; }, lean: async () => rows };
      return chain;
    },
  };
  return { conversations, messages, deps: { Conversation, Message, now: () => NOW } };
}

test("until a person takes over, the AI keeps answering", async () => {
  const w = world();
  assert.equal(await holdForTeam({ shop: A, clientId: CLIENT, text: "hello" }, w.deps), false);
  assert.equal(w.messages.length, 0);
});

test("a team reply takes the chat over, is stored for the shopper, and reopens a closed chat", async () => {
  const w = world();
  w.conversations[0].status = "resolved";
  const out = await sendStaffReply(A, "c1", { text: "  Your refund is on its way.  ", by: "42" }, w.deps);
  assert.equal(out.conversation.handoff.active, true);
  assert.equal(w.conversations[0].status, "open");
  assert.deepEqual(w.messages.map((m) => [m.role, m.text, m.staffBy]), [["staff", "Your refund is on its way.", "42"]]);
  assert.ok(w.messages[0].expiresAt > new Date(NOW + 2 * 86400_000), "a reply is kept long enough to be delivered");
  assert.equal(w.conversations[0].messageCount, 5);
});

test("a reply must be real text of sensible length", async () => {
  const w = world();
  await assert.rejects(sendStaffReply(A, "c1", { text: "   " }, w.deps), (e) => e instanceof HandoffError && e.status === 400);
  await assert.rejects(sendStaffReply(A, "c1", { text: "x".repeat(2001) }, w.deps), /under 2000/);
  assert.equal(w.messages.length, 0);
});

test("a chat the customer cleared cannot be written to, and another store's chat is not found", async () => {
  const w = world();
  await assert.rejects(sendStaffReply(B, "c1", { text: "hi" }, w.deps), (e) => e.status === 404);
  await assert.rejects(setHandoff(B, "c1", { active: true }, w.deps), (e) => e.status === 404);
  w.conversations[0].clearedAt = new Date(NOW - 1000);
  await assert.rejects(sendStaffReply(A, "c1", { text: "hi" }, w.deps), (e) => e.status === 409);
  assert.equal(w.messages.length, 0);
});

test("while a person has the chat, the shopper's message is recorded for them and the AI is skipped", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true, by: "42" }, w.deps);
  const held = await holdForTeam({ shop: A, clientId: CLIENT, text: "my number is 98765 43210, call me", attachments: [{ id: "f1", name: "box.jpg", kind: "image", mime: "image/jpeg", size: 10 }], settings: {} }, w.deps);
  assert.equal(held, true);
  assert.deepEqual(w.messages.map((m) => [m.role, m.text]), [["user", "my number is [phone], call me"]]);
  assert.equal(w.messages[0].attachments.length, 1);
  assert.equal(w.conversations[0].messageCount, 5);
  assert.equal(w.conversations[0].fileCount, 1);
});

test("with transcripts off the message is not stored, but the AI is still held back", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true }, w.deps);
  assert.equal(await holdForTeam({ shop: A, clientId: CLIENT, text: "hello", settings: { logging: { storeTranscripts: false } } }, w.deps), true);
  assert.equal(w.messages.length, 0);
  assert.equal(w.conversations[0].messageCount, 5);
});

test("a person who is not on this visitor's chat, or another visitor, never holds it", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true }, w.deps);
  assert.equal(await holdForTeam({ shop: A, clientId: "someone-else", text: "hi" }, w.deps), false);
  assert.equal(await holdForTeam({ shop: B, clientId: CLIENT, text: "hi" }, w.deps), false);
});

test("handing back gives the chat to the AI again", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true }, w.deps);
  const back = await setHandoff(A, "c1", { active: false }, w.deps);
  assert.equal(back.handoff, undefined);
  assert.equal(await holdForTeam({ shop: A, clientId: CLIENT, text: "hi" }, w.deps), false);
});

test("after a long silence the shopper is in a new chat and the AI answers again", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true }, w.deps);
  w.conversations[0].lastMessageAt = new Date(NOW - 5 * 3600_000);
  assert.equal(await currentChat(A, chatRefFor(A, CLIENT), w.deps), null);
  assert.equal(await holdForTeam({ shop: A, clientId: CLIENT, text: "hi" }, w.deps), false);
});

test("the chat window gets only new team replies, and knows whether to keep asking", async () => {
  const w = world();
  await sendStaffReply(A, "c1", { text: "first" }, { ...w.deps, now: () => NOW - 5000 });
  await sendStaffReply(A, "c1", { text: "second" }, w.deps);
  w.messages.push({ _id: "u", shop: A, conversationId: "c1", role: "user", text: "shopper", at: new Date(NOW) });
  const all = await staffMessagesSince({ shop: A, clientId: CLIENT, since: "" }, w.deps);
  assert.deepEqual(all.messages.map((m) => m.text), ["first", "second"]);
  assert.deepEqual([all.handedOff, all.watch], [true, true]);
  const fresh = await staffMessagesSince({ shop: A, clientId: CLIENT, since: all.messages[0].at }, w.deps);
  assert.deepEqual(fresh.messages.map((m) => m.text), ["second"]);
  assert.deepEqual((await staffMessagesSince({ shop: B, clientId: CLIENT, since: "" }, w.deps)).messages, []);
});

test("once handed back and nothing waits, the window can stop asking", async () => {
  const w = world();
  await setHandoff(A, "c1", { active: true }, w.deps);
  await setHandoff(A, "c1", { active: false }, w.deps);
  assert.equal((await staffMessagesSince({ shop: A, clientId: CLIENT, since: "" }, w.deps)).watch, true, "still flagged, still worth watching");
  w.conversations[0].status = "resolved";
  assert.deepEqual(await staffMessagesSince({ shop: A, clientId: CLIENT, since: "not a date" }, w.deps), { handedOff: false, watch: false, messages: [] });
});
