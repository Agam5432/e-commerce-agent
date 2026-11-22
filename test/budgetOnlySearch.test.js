// "1000 ke andar kya milega?" names only a budget. The search used to ignore the budget (₹4,700 dresses), the budget check then cut
// every line and the reply said nothing costs under ₹1,000 while a ₹900 mouse was in stock (real storefront, 2026-11-21).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { installRealStore } from "./helpers/agentHarness.js";
import ecommerce from "../src/industries/ecommerce.js";

const store = installRealStore();
after(() => store.restore());

const session = (userMessage) => ecommerce.createSession("budget-only.myshopify.com", { llmMode: true, clientId: "budget-" + Math.random().toString(36).slice(2, 20), userMessage, replyLanguage: "hinglish", history: [], cart: { currency: "INR", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => {} });

for (const args of [{ maxPrice: 1000 }, { searchTerm: "", maxPrice: 1000 }, { searchTerm: "products", maxPrice: 1000 }, { searchTerm: "items under 1000" }]) {
  test(`a budget-only search (${JSON.stringify(args)}) lists the store's products within that budget`, async () => {
    const r = await session("1000 rupaye ke andar kya mil sakta hai?").handlers.search_products(args);
    const titles = (r.products || []).map((p) => p.title);
    assert.ok(titles.includes("HP X1000 Wired Mouse"), titles.join(" | "));
    assert.ok((r.products || []).every((p) => Number(p.price) <= 1000), titles.join(" | "));
  });
}

test("a budget with a product keeps searching that product", async () => {
  const r = await session("mouse under 1000").handlers.search_products({ searchTerm: "mouse", maxPrice: 1000 });
  assert.ok((r.products || []).every((p) => /mouse/i.test(p.title)));
});
