// Everything the shopper reads about products comes from Shopify: a price the AI states that the store's data of this turn
// does not contain is written again, and if it stays wrong the line is left out.
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
import { isLanguageCheck } from "./helpers/languageCheck.js";

const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");

const nodes = realCatalogNodes();
const originalFind = StoreIntegration.findOne;
const originalSession = CheckoutSession.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
CheckoutSession.findOne = () => ({ lean: async () => null });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
after(() => { StoreIntegration.findOne = originalFind; CheckoutSession.findOne = originalSession; globalThis.fetch = originalFetch; __setLLMClientsForTest(null); });

function fakeGemini(steps) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (req) => {
        if (isLanguageCheck(req)) return { candidates: [{ content: { role: "model", parts: [{ text: "SAME" }] } }] };
        calls.push(req);
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        return { candidates: [{ content: { role: "model", parts: step } }] };
      },
    },
  };
}
const toolCall = [{ functionCall: { name: "search_products", args: { searchTerm: "watch" } } }];
const say = (text) => [{ text }];

test("a price the AI invented is written again with the prices Shopify returned", async () => {
  const gemini = fakeGemini([toolCall, say("The Fossil Grant Chronograph Watch is just ₹999 - great deal!"), say("The Fossil Grant Chronograph Watch is ₹18,100.")]);
  __setLLMClientsForTest({ gemini });
  const result = await runAgent("watch dikhao", "facts1.myshopify.com", [], "ecommerce", { clientId: "facts1", cart: { currency: "INR", items: [] } });
  assert.match(result.answer, /18,100/);
  assert.doesNotMatch(result.answer, /999/);
});

test("if the AI keeps stating a wrong price, that line is not shown", async () => {
  const gemini = fakeGemini([toolCall, say("- Fossil Grant Chronograph Watch: ₹999\n- Casio Vintage Digital Watch: ₹5,700"), say("- Fossil Grant Chronograph Watch: ₹999\n- Casio Vintage Digital Watch: ₹5,700")]);
  __setLLMClientsForTest({ gemini });
  const result = await runAgent("watch dikhao", "facts2.myshopify.com", [], "ecommerce", { clientId: "facts2", cart: { currency: "INR", items: [] } });
  assert.doesNotMatch(result.answer, /999/);
  assert.match(result.answer, /5,700/);
});

test("prices exactly as Shopify returned them pass untouched", async () => {
  const gemini = fakeGemini([toolCall, say("- Casio Vintage Digital Watch: ₹5,700\n- Titan Neo Analog Watch: ₹12,400")]);
  __setLLMClientsForTest({ gemini });
  const result = await runAgent("watch dikhao", "facts3.myshopify.com", [], "ecommerce", { clientId: "facts3", cart: { currency: "INR", items: [] } });
  assert.match(result.answer, /5,700/);
  assert.match(result.answer, /12,400/);
  assert.equal(gemini.calls.length, 2);
});
