// A budget in the shopper's currency must be checked against the WHOLE catalog, not against the few
// best matches: the cheap item ranked 40th still has to be found ("gift under ₹3000" found nothing).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts, recommendProducts, resolveCartItem, withShopperPricing, probeCatalog } from "../src/tools/shopifyService.js";
import ecommerce from "../src/industries/ecommerce.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const RATE = 90; // INR per USD, applied by the fake Shopify "contextual pricing" only
const node = (n, usd) => ({
  id: `gid://shopify/Product/${n}`, title: `Item ${n}`, handle: `item-${n}`, description: "A thing", productType: n === 40 ? "Cheap Gadgets" : `Type ${n % 12}`, tags: [], vendor: "V",
  status: "ACTIVE", publishedAt: "2026-01-01T00:00:00Z", featuredImage: null,
  priceRangeV2: { minVariantPrice: { amount: usd.toFixed(2), currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${n}`, title: "Default Title", selectedOptions: [], price: usd.toFixed(2), inventoryQuantity: 9, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
// 40 products, the most expensive first; the only cheap one (USD 10 = INR 900) is the very last
const catalog = Array.from({ length: 40 }, (_, i) => node(i + 1, i === 39 ? 10 : 200 + i * 5));

globalThis.fetch = async (url, options) => {
  const { query, variables } = JSON.parse(options.body);
  if (/ShopperPrices/.test(query)) {
    return { ok: true, status: 200, json: async () => ({ data: { nodes: variables.ids.map((id) => {
      const usd = Number(catalog.find((p) => p.variants.edges[0].node.id === id).variants.edges[0].node.price);
      return { id, contextualPricing: { price: { amount: (usd * RATE).toFixed(2), currencyCode: "INR" }, compareAtPrice: null } };
    }) } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { products: { edges: catalog.map((n) => ({ node: n })), pageInfo: { hasNextPage: false } } } }) };
};

const inr = (fn) => withShopperPricing({ country: "IN", currency: "INR" }, fn);

test("a budget search with no keyword finds the cheap item even when it is far down the catalog", async () => {
  const found = await inr(() => searchShopifyProducts("b.myshopify.com", "", { maxPrice: 3000 }));
  assert.deepEqual(found.map((p) => p.title), ["Item 40"]);
  assert.equal(found[0].currency, "INR");
  assert.equal(Number(found[0].price), 900);
});

test("a budget typed into the search text is honoured the same way", async () => {
  const found = await inr(() => searchShopifyProducts("b.myshopify.com", "items under 3000"));
  assert.ok(found.some((p) => p.title === "Item 40"), `got ${found.map((p) => p.title)}`);
  assert.ok(found.every((p) => Number(p.price) <= 3000));
});

test("recommendations under a budget also look at the whole catalog", async () => {
  const picks = await inr(() => recommendProducts("b.myshopify.com", { maxPrice: 3000, limit: 4, keywords: ["gift"] }));
  assert.deepEqual(picks.map((p) => p.title), ["Item 40"]);
  const none = await inr(() => recommendProducts("b.myshopify.com", { maxPrice: 500, limit: 4 }));
  assert.equal(none.length, 0, "nothing is that cheap: an honest empty list");
});

test("without a budget the result size is unchanged", async () => {
  const some = await inr(() => searchShopifyProducts("b.myshopify.com", ""));
  assert.ok(some.length <= 12);
});

test("'suggest something under 3000' with no product named is not limited to a few categories", async () => {
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  for (const seed of ["a", "b", "c", "d"]) {
    const session = ecommerce.createSession(`h${seed}.myshopify.com`, { llmMode: true, clientId: seed, userMessage: "show me things under 3000 rupees", replyLanguage: "en", history: [], catalogCategories: ["Type 1", "Type 2", "Type 3", "Type 4", "Type 5", "Cheap Gadgets"] }, store);
    await probeCatalog(`h${seed}.myshopify.com`, "warm the category index");
    await inr(() => session.handlers.get_recommendations({ keywords: [], maxPrice: 3000 }));
    assert.deepEqual(session.result().products.map((p) => p.title), ["Item 40"], seed);
  }
});

test("the price told when adding to the cart is in the shopper's currency, not the store's", async () => {
  const added = await inr(() => resolveCartItem("b.myshopify.com", { productName: "Item 40" }));
  assert.equal(added.status, "ok");
  assert.equal(added.currency, "INR");
  assert.equal(Number(added.price), 900);
});

test("'cheapest' and 'most expensive' order the whole catalog by price in the shopper's currency", async () => {
  const cheap = await inr(() => searchShopifyProducts("b.myshopify.com", "", { sort: "price_low" }));
  assert.equal(cheap[0].title, "Item 40", "the cheapest item sits last in the store's own order and is still first");
  assert.equal(Number(cheap[0].price), 900);
  assert.ok(cheap.every((p, i) => i === 0 || Number(p.price) >= Number(cheap[i - 1].price)));
  const dear = await inr(() => searchShopifyProducts("b.myshopify.com", "", { sort: "price_high" }));
  assert.ok(Number(dear[0].price) >= Number(dear[dear.length - 1].price));
  assert.equal(dear.length, 12);
});
