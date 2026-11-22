// M3, M4, M5, M9 and the meaningless-message rule through the REAL agent loop with a scripted model (MOCK TESTED).
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");
const { clearStoreProductCache } = await import("../src/tools/shopifyService.js");
const { policyCaches } = await import("../src/tools/shopify/caches.js");

const store = installRealStore();
const recorded = globalThis.fetch;
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => { __resetProviderBlocksForTest(); globalThis.fetch = recorded; clearStoreProductCache("claim.myshopify.com"); policyCaches.clear(); });

let scripted;
const ask = (steps, message, history = []) => {
  scripted = scriptedGemini(steps);
  __setLLMClientsForTest({ gemini: scripted });
  return runAgent(message, "claim.myshopify.com", history, "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
};

function xiaomiShopify(description = "Large bright display and 108MP main camera.") {
  let n = 500;
  const v = (title, price, compareAtPrice) => ({ node: { id: `gid://shopify/ProductVariant/${++n}`, title, selectedOptions: [], image: null, price, compareAtPrice, inventoryQuantity: 10, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } });
  const node = {
    id: "gid://shopify/Product/500", title: "Xiaomi Redmi Note 13", handle: "xiaomi-redmi-note-13", description, status: "ACTIVE", productType: "Smartphones", vendor: "Xiaomi", tags: ["smartphones"],
    publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "x" }, priceRangeV2: { minVariantPrice: { amount: "229.00", currencyCode: "USD" } },
    variants: { edges: [v("Ocean Teal / 128GB", "229.00", "269.00"), v("Ocean Teal / 256GB", "269.00", "309.00")] },
  };
  globalThis.fetch = async (url, init) => {
    if (!/myshopify.com|shopify/i.test(String(url?.url || url))) return recorded(url, init);
    return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null } }, product: node } }) };
  };
}
const SEARCH = { call: [{ name: "search_products", args: { searchTerm: "xiaomi redmi note 13" } }] };

test("M3: 'you are absolutely right' to a wrong price claim is rewritten with the real price", async () => {
  xiaomiShopify();
  const out = await ask([() => SEARCH, () => "You are absolutely right, my previous message had the prices mixed up. The 128GB is $269.", () => "The 128GB option is $229.00; the 256GB option is $269.00. If you're seeing something different, tell me where and we can check it together."], "no, the 128GB costs $269");
  assert.doesNotMatch(out.answer, /absolutely right|mixed up/i, out.answer);
  assert.match(out.answer, /\$229/);
});

test("M3: a correct claim may be confirmed", async () => {
  xiaomiShopify();
  const good = "You're right, the 128GB is $229.00.";
  const out = await ask([() => SEARCH, () => good], "the 128GB costs $229 right?");
  assert.equal(out.answer.trim(), good);
});

test("M3: 'I told you earlier I wanted an iPhone' is not accepted when the chat never said so", async () => {
  const out = await ask([() => "You're absolutely right, I apologize for the confusion. Here is the iPhone.", () => "I don't see an iPhone mentioned earlier in our chat, but I'm happy to look at iPhones now. Which model?"], "I told you earlier I wanted an iPhone", [{ role: "user", content: "show me samsung phones" }, { role: "assistant", content: "Here are some Samsung phones." }]);
  assert.doesNotMatch(out.answer, /absolutely right|apologi/i, out.answer);
});

test("M4: gaming/performance judgement with no data behind it is rewritten from the listed facts", async () => {
  xiaomiShopify();
  const out = await ask([() => SEARCH, () => "The Xiaomi stands out for sheer performance and smooth gaming.", () => "The listing mentions a large bright display and a 108MP main camera. It doesn't say how it performs for gaming."], "is it good for gaming?");
  assert.doesNotMatch(out.answer, /sheer performance|smooth gaming/i, out.answer);
  assert.match(out.answer, /doesn't say/);
});

test("M4: if the description really says gaming, the claim passes untouched", async () => {
  xiaomiShopify("Built for gaming with a fast 120Hz display.");
  const good = "It is built for gaming, with a fast 120Hz display.";
  const out = await ask([() => SEARCH, () => good], "is it good for gaming?");
  assert.equal(out.answer.trim(), good);
});

test("M5: invented accepted payment methods are removed", async () => {
  const out = await ask([() => "We accept major debit and credit cards.", () => "I don't have a confirmed list of payment methods; the options shown at checkout are the ones available."], "what payment methods do you accept");
  assert.doesNotMatch(out.answer, /major debit/i, out.answer);
  assert.match(out.answer, /checkout/i);
});

test("M9: 'I am raising a formal complaint now' with no complaint step is rewritten into a question", async () => {
  const out = await ask([() => "I'm so sorry about that. I am raising a formal complaint now.", () => "I'm so sorry about that. Can you tell me what happened with the order? If it can't be sorted out here, I can pass it to the team by email or to a person, whichever you prefer."], "my phone arrived with a scratch");
  assert.doesNotMatch(out.answer, /am raising a formal complaint now/i, out.answer);
  assert.match(out.answer, /what happened|email or/i);
});

test("low: a lone '.' is not sent to the model", async () => {
  scripted = scriptedGemini([() => { throw new Error("the model must not be called"); }]);
  __setLLMClientsForTest({ gemini: scripted });
  const out = await runAgent(".", "claim.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
  assert.match(out.answer, /didn't catch that/i);
  assert.equal(scripted.main.length, 0);
});

test("a lone '.' gets the AI's own short line when it writes one, never a tool round", async () => {
  scripted = scriptedGemini([() => { throw new Error("the main model must not be called"); }], { side: async () => "Oops, I didn't quite get that. What are you looking for today?" });
  __setLLMClientsForTest({ gemini: scripted });
  const out = await runAgent(".", "claim.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
  assert.equal(out.answer, "Oops, I didn't quite get that. What are you looking for today?");
  assert.equal(scripted.main.length, 0);
});
