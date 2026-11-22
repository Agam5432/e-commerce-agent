// A "hello" in the middle of a chat is a check-in, not a restart; a returning customer is welcomed
// back to what they were doing. The AI writes the words; these tests check the facts it is given.
import test from "node:test";
import assert from "node:assert/strict";
import { describeContinuity, continuityPromptBlock, humanGap, buildRecap, RETURNING_AFTER_MS } from "../src/services/conversationContinuity.js";
import { saveConversationRecap } from "../src/services/checkoutSessionService.js";
import { prepareConversation } from "../src/services/conversationProfile.js";
import { sanitizeBrowserCheckout } from "../src/services/browserCheckout.js";
import ecommerce from "../src/industries/ecommerce.js";
import { runAgent, __setLLMClientsForTest } from "../src/agent/agent.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

const NOW = Date.parse("2026-10-30T10:00:00Z");
const history = [
  { role: "user", content: "I am travelling, show me useful gadgets" },
  { role: "assistant", content: "Here are some travel picks: power bank, earbuds." },
];

test("a message seconds after the last one is a chat IN PROGRESS", () => {
  const c = describeContinuity({ previousActivityAt: new Date(NOW - 40_000), history, now: NOW });
  assert.equal(c.state, "ongoing");
  assert.equal(c.gap, "40 seconds");
  const block = continuityPromptBlock(c);
  assert.match(block, /IN PROGRESS/);
  assert.match(block, /already greeted/);
});

test("a message the next day is a customer COMING BACK, with what they were doing", () => {
  const c = describeContinuity({
    previousActivityAt: new Date(NOW - 20 * 3600_000),
    history,
    recap: { lastUserMessage: "show me earbuds for the flight", productsShown: ["Boat Airdopes 141", "Mi Power Bank 20000"] },
    cart: { items: [{ title: "Mi Power Bank 20000", quantity: 1 }] },
    checkout: { step: "address" },
    now: NOW,
  });
  assert.equal(c.state, "returning");
  assert.equal(c.gap, "20 hours");
  const block = continuityPromptBlock(c);
  assert.match(block, /COMING BACK after 20 hours/);
  assert.match(block, /earbuds for the flight/);
  assert.match(block, /Boat Airdopes 141/);
  assert.match(block, /In their cart now: Mi Power Bank 20000/);
  assert.match(block, /checkout is in progress/);
});

test("the very first message of a new chat is NEW", () => {
  assert.equal(describeContinuity({ history: [], now: NOW }).state, "new");
  assert.match(continuityPromptBlock(describeContinuity({ now: NOW })), /start of a new chat/);
});

test("the server's clock wins; a browser time is only a backup and never trusted in the future", () => {
  const server = describeContinuity({ previousActivityAt: new Date(NOW - 60_000), clientLastActivityAt: NOW - 5 * 86400_000, history, now: NOW });
  assert.equal(server.state, "ongoing");
  const backup = describeContinuity({ clientLastActivityAt: NOW - 2 * 86400_000, history, now: NOW });
  assert.equal(backup.state, "returning");
  const future = describeContinuity({ clientLastActivityAt: NOW + 86400_000, history, now: NOW });
  assert.equal(future.state, "ongoing"); // ignored: falls back to "has history"
  assert.equal(RETURNING_AFTER_MS, 30 * 60 * 1000);
});

test("gaps read naturally", () => {
  assert.equal(humanGap(1000), "1 second");
  assert.equal(humanGap(12 * 60_000), "12 minutes");
  assert.equal(humanGap(3 * 86400_000), "3 days");
});

test("the recap keeps the last products shown when a turn shows none", () => {
  const first = buildRecap({ userMessage: "earbuds dikhao", products: [{ title: "A" }, { title: "B" }], now: NOW });
  assert.deepEqual(first.productsShown, ["A", "B"]);
  const next = buildRecap({ userMessage: "hello", products: [], previous: first, now: NOW });
  assert.deepEqual(next.productsShown, ["A", "B"]);
  assert.equal(next.lastUserMessage, "hello");
});

test("the recap is written in the background and never when the database is down", async () => {
  const saved = [];
  const ok = await saveConversationRecap("x.myshopify.com", "c1", { a: 1 }, { save: async (...a) => saved.push(a), connected: () => true });
  assert.equal(ok, true);
  assert.deepEqual(saved[0], ["x.myshopify.com", "c1", { conversationRecap: { a: 1 } }]);
  assert.equal(await saveConversationRecap("x.myshopify.com", "c1", {}, { save: async () => saved.push("x"), connected: () => false }), false);
  assert.equal(saved.length, 1);
});

test("each turn records the server time and hands over the previous one", async () => {
  const before = new Date(NOW - 90_000);
  const writes = [];
  const out = await prepareConversation("x.myshopify.com", "c1", "hello", history, null, {
    load: async () => ({ lastActivityAt: before, conversationRecap: { productsShown: ["A"] } }),
    save: async (shop, client, patch) => writes.push(patch),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.previousActivityAt, before);
  assert.deepEqual(out.conversationRecap, { productsShown: ["A"] });
  assert.ok(writes.some((w) => w.lastActivityAt instanceof Date));
});

test("the browser cannot fake the activity time or the recap", () => {
  const clean = sanitizeBrowserCheckout({ previousActivityAt: "2020-01-01", lastActivityAt: 1, conversationRecap: { productsShown: ["fake"] } });
  assert.deepEqual(clean, {});
});

test("the prompt carries the mid-chat greeting rule (no restart, no re-introduction)", () => {
  const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", {
    replyLanguage: "en", profile: {},
    continuity: describeContinuity({ previousActivityAt: new Date(Date.now() - 30_000), history }),
  });
  assert.match(prompt, /GREETINGS MID-CHAT/);
  assert.match(prompt, /never introduce yourself again/);
  assert.match(prompt, /CONVERSATION: a chat IN PROGRESS/);
});

test("end to end: a mid-chat 'hello' reaches the AI as a chat in progress, with the last topic", async () => {
  const original = { find: CheckoutSession.findOne, update: CheckoutSession.findOneAndUpdate, integration: StoreIntegration.findOne, summary: ecommerce.getCachedCatalogSummary, fetch: globalThis.fetch };
  try {
    globalThis.fetch = async () => { throw new Error("offline"); };
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD" });
    CheckoutSession.findOne = () => ({ lean: async () => ({ lastActivityAt: new Date(Date.now() - 45_000), conversationRecap: { lastUserMessage: "show me earbuds", productsShown: ["Boat Airdopes 141"] } }) });
    CheckoutSession.findOneAndUpdate = () => ({ lean: async () => ({}) });
    const calls = [];
    __setLLMClientsForTest({ gemini: { models: { generateContent: async (req) => { calls.push(req); return { candidates: [{ content: { role: "model", parts: [{ text: "Yes, I'm right here! Did you like any of the earbuds?" }] } }] }; } } } });
    const r = await runAgent("hello", "test.myshopify.com", history, "ecommerce", { clientId: `cont-${crypto.randomUUID()}` });
    assert.match(r.answer, /right here/);
    const system = calls[0].config.systemInstruction;
    assert.match(system, /CONVERSATION: a chat IN PROGRESS \(previous message \d+ seconds ago\)/);
    assert.match(system, /show me earbuds/);
    assert.match(system, /Boat Airdopes 141/);
  } finally {
    __setLLMClientsForTest(null);
    CheckoutSession.findOne = original.find;
    CheckoutSession.findOneAndUpdate = original.update;
    StoreIntegration.findOne = original.integration;
    ecommerce.getCachedCatalogSummary = original.summary;
    globalThis.fetch = original.fetch;
  }
});
