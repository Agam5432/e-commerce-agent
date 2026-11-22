// A provider whose API key is rejected is skipped on the next turns instead of failing (and costing
// time) on every message. Own file: the provider order and model cool-downs are per process.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

process.env.LLM_PRIMARY = "claude";
process.env.LLM_SECONDARY = "gemini";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest, isAuthError } = await import("../src/agent/agent.js");

async function harness(fn) {
  const original = { summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => null });
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD", storeName: "Test Store" });
    await fn({ options: { clientId: `c-${crypto.randomUUID()}`, cart: { currency: "USD", items: [] } } });
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find; StoreIntegration.findOne = original.integration; globalThis.fetch = original.fetch;
  }
}

test("a rejected API key is not retried on every turn: the next provider answers straight away", async () => {
  await harness(async ({ options }) => {
    __resetProviderBlocksForTest();
    let claudeTries = 0;
    const claude = { messages: { create: async () => { claudeTries++; throw Object.assign(new Error("Claude 401: invalid x-api-key"), { status: 401 }); } } };
    const gemini = { models: { generateContent: async () => ({ candidates: [{ content: { role: "model", parts: [{ text: "Backup se jawab." }] } }] }) } };
    __setLLMClientsForTest({ claude, gemini });
    assert.equal((await runAgent("hello", "test.myshopify.com", [], "ecommerce", options)).answer, "Backup se jawab.");
    const triesAfterFirst = claudeTries;
    assert.ok(triesAfterFirst >= 1);
    assert.equal((await runAgent("hello again", "test.myshopify.com", [], "ecommerce", options)).answer, "Backup se jawab.");
    assert.equal(claudeTries, triesAfterFirst, "Claude is skipped after its key was rejected");
    __resetProviderBlocksForTest();
  });
});

test("only key problems switch a provider off, not a busy or slow one", () => {
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError(new Error("Claude 403: forbidden")), true);
  assert.equal(isAuthError(new Error("API key not valid. Please pass a valid API key.")), true);
  assert.equal(isAuthError(new Error("Claude 529: overloaded")), false);
  assert.equal(isAuthError(new Error("Claude 429: rate limited")), false);
  assert.equal(isAuthError(new Error("hard timeout after 15000ms")), false);
});
