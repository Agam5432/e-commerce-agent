// A shopper who asks for a person must hear about THAT, not about products from earlier in the chat: no product cards, no
// product list in the reply, and "nobody can join" is never turned into "here is what the store has".
process.env.GEMINI_API_KEY = "fake";
process.env.GOOGLE_API_KEY = "fake";
process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "gemini";
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { realCatalogNodes } from "./helpers/realCatalog.js";

const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");

const nodes = realCatalogNodes();
const originalFind = StoreIntegration.findOne;
const originalSession = CheckoutSession.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
CheckoutSession.findOne = () => ({ lean: async () => null });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
after(() => { StoreIntegration.findOne = originalFind; CheckoutSession.findOne = originalSession; globalThis.fetch = originalFetch; __setLLMClientsForTest(null); });

const fakeGemini = (steps) => {
  const calls = [];
  return { calls, models: { generateContent: async () => { calls.push(1); return { candidates: [{ content: { role: "model", parts: steps[Math.min(calls.length - 1, steps.length - 1)] } }] }; } } };
};
const tool = (name, args) => [{ functionCall: { name, args } }];
const say = (text) => [{ text }];
const past = [{ role: "user", content: "show me watches" }, { role: "assistant", content: "Here are some watches: Fossil Grant Chronograph Watch." }];

test("asking the team to follow up: products found for the earlier topic are not shown, and the reply is written again without them", async () => {
  const gemini = fakeGemini([
    [...tool("search_products", { searchTerm: "watch" }), ...tool("flag_for_owner", { reason: "wants customer care" })],
    say("I have alerted the team. In the meantime here are some options:\n- Fossil Grant Chronograph Watch: ₹18,100"),
    say("I have let the team know and someone will follow up with you."),
  ]);
  __setLLMClientsForTest({ gemini });
  const out = await runAgent("connect me to customer care", "person1.myshopify.com", past, "ecommerce", { clientId: "person1", cart: { currency: "INR", items: [] } });
  assert.deepEqual(out.products, []);
  assert.doesNotMatch(out.answer, /Fossil/);
  assert.match(out.answer, /team/i);
  assert.ok(out.actions.some((a) => a.type === "flag_for_owner"));
});

test("if the AI keeps listing the product, the lines that name it are cut", async () => {
  const gemini = fakeGemini([
    [...tool("search_products", { searchTerm: "watch" }), ...tool("flag_for_owner", { reason: "wants customer care" })],
    say("I have alerted the team.\n- Fossil Grant Chronograph Watch: ₹18,100"),
    say("I have alerted the team.\n- Fossil Grant Chronograph Watch: ₹18,100"),
  ]);
  __setLLMClientsForTest({ gemini });
  const out = await runAgent("connect me to customer care", "person2.myshopify.com", past, "ecommerce", { clientId: "person2", cart: { currency: "INR", items: [] } });
  assert.doesNotMatch(out.answer, /Fossil/);
  assert.match(out.answer, /alerted the team/);
  assert.deepEqual(out.products, []);
});

test("an ordinary product question still shows its products", async () => {
  const gemini = fakeGemini([tool("search_products", { searchTerm: "watch" }), say("Here is a watch: Fossil Grant Chronograph Watch.")]);
  __setLLMClientsForTest({ gemini });
  const out = await runAgent("watch dikhao", "person3.myshopify.com", [], "ecommerce", { clientId: "person3", cart: { currency: "INR", items: [] } });
  assert.ok(out.products.length > 0);
  assert.match(out.answer, /Fossil/);
});
