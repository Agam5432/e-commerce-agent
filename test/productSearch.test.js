import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts, searchShopifyProductsMany, filterProductsByVariantHints, parseSearchFilters } from "../src/tools/shopifyService.js";
import ecommerce from "../src/industries/ecommerce.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
let nextId = 0;
function variant(color, size, quantity = 5) {
  return { id: `gid://shopify/ProductVariant/${++nextId}`, title: [color, size].filter(Boolean).join(" / "), selectedOptions: [{ name: "Color", value: color }, { name: "Size", value: size }].filter(o => o.value), price: "7.99", inventoryQuantity: quantity, inventoryPolicy: "DENY", inventoryItem: { tracked: true } };
}
function product(title, variants, { published = true, gender = "mens" } = {}) {
  return { featuredImage: { url: `https://cdn.example.com/${title.toLowerCase().replace(/[^a-z]+/g, "-")}.jpg`, altText: title }, id: `gid://shopify/Product/${++nextId}`, title, handle: title.toLowerCase().replace(/[^a-z]+/g, "-"), description: "Comfortable cotton clothing", productType: "Clothing", tags: [gender], status: "ACTIVE", onlineStoreUrl: null, publishedAt: published ? "2026-01-01T00:00:00Z" : null, priceRangeV2: { minVariantPrice: { amount: "7.99", currencyCode: "USD" } }, variants: { edges: variants.map(node => ({ node })) } };
}
const fixtures = [
  product("Men's Red Cotton T-Shirt", [variant("", "S"), variant("", "M"), variant("", "L")]),
  product("Men's Blue Cotton T-Shirt", [variant("", "M")]),
  product("Women's Red T-Shirt", [variant("Red", "M")], { gender: "womens" }),
  product("Men's Red Oxford Shirt", [variant("", "M")]),
  product("Men's Multicolour T-Shirt", [variant("Red", "M"), variant("Blue", "L")]),
  product("Men's Green T-Shirt", [variant("Green", "M", 0)]),
  product("Men's Purple T-Shirt", [variant("Purple", "M")], { published: false }),
  product("Travel Backpack 32L", [variant("Black", "Default Title")], { gender: "unisex" }),
  product("Fast Charging Power Bank", [variant("Black", "Default Title")], { gender: "unisex" }),
  product("Stainless Steel Water Bottle", [variant("Silver", "Default Title")], { gender: "unisex" }),
  product("Wireless Earbuds", [variant("Black", "Default Title")], { gender: "unisex" }),
  product("Women's Denim Jacket", [variant("Blue", "M")], { gender: "womens" }),
  product("Men's Travel Jacket", [variant("Blue", "L")]),
];
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /\.myshopify\.com\/admin\/api\//);
  const { query } = JSON.parse(options.body);
  assert.match(query, /(?:ListProducts|SearchProducts)/);
  return { ok: true, status: 200, json: async () => ({ data: { products: { edges: fixtures.map(node => ({ node })) } } }) };
};
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

test("men's red T-shirt returns only men's red T-shirts, including title-level colours", async () => {
  const results = await searchShopifyProducts("search.myshopify.com", "mens red color t-shirt");
  assert.equal(results.length, 2);
  assert.ok(results.every(p => !p.title.includes("Women's") && /T-Shirt/.test(p.title)));
  assert.ok(results.every(p => p.title.includes("Red") || p.variants.every(v => /Red/.test(v.title))));
});
test("colour and size must exist on the same sellable variant", async () => {
  const results = await searchShopifyProducts("search.myshopify.com", "mens red t-shirt size L");
  assert.deepEqual(results.map(p => p.title), ["Men's Red Cotton T-Shirt"]);
  assert.deepEqual(results[0].variants.map(v => v.title), ["L"]);
});
test("missing colour/size never falls back to a different colour or category", async () => {
  for (const term of ["mens yellow t-shirt", "mens red t-shirt size XXL", "mens green t-shirt", "mens purple t-shirt"]) {
    assert.deepEqual(await searchShopifyProducts("search.myshopify.com", term), [], term);
  }
});
test("a shirt request cannot return T-shirts", async () => {
  const results = await searchShopifyProducts("search.myshopify.com", "mens red shirt");
  assert.deepEqual(results.map(p => p.title), ["Men's Red Oxford Shirt"]);
});
test("a women's request overrides the previous men's gender hint", async () => {
  const results = await searchShopifyProducts("search.myshopify.com", "womens red t-shirt", { defaultGender: "men" });
  assert.deepEqual(results.map(p => p.title), ["Women's Red T-Shirt"]);
});
test("Hinglish colour aliases and explicit parameters are enforced", async () => {
  const alias = await searchShopifyProducts("search.myshopify.com", "mens laal t-shirt dikhao");
  assert.equal(alias.length, 2);
  const explicit = await searchShopifyProducts("search.myshopify.com", "t-shirt", { defaultGender: "men", color: "red", size: "L" });
  assert.deepEqual(explicit.map(p => p.title), ["Men's Red Cotton T-Shirt"]);
  assert.deepEqual(parseSearchFilters("men's red T-shirt size M").sizes, ["m"]);
  assert.deepEqual(parseSearchFilters("I am looking for a men's T-shirt").sizes, []);
  assert.deepEqual(parseSearchFilters("I'm looking for a men's T-shirt").sizes, []);
  assert.deepEqual(parseSearchFilters("mens t-shirt size M under 50").sizes, ["m"]);
  assert.equal(parseSearchFilters("mens t-shirt size M under 50").maxPrice, 50);
});
test("multi-search applies the same strict filters independently to each group", async () => {
  const groups = await searchShopifyProductsMany("search.myshopify.com", ["mens red t-shirt size L", "mens yellow shirt"]);
  assert.equal(groups[0].products.length, 1);
  assert.deepEqual(groups[1].products, []);
});
test("stock and colour filters reject a sold-out red option even if blue is available", () => {
  const products = [{ title: "Men's Red T-Shirt", variants: [
    { id: "r", title: "Red / L", price: "7.99", sellable: false },
    { id: "b", title: "Blue / L", price: "7.99", sellable: true },
  ] }];
  assert.deepEqual(filterProductsByVariantHints(products, "red size L"), []);
});
test("agent preserves colour and size even when the model omits them in its tool call", async () => {
  const session = ecommerce.createSession("search.myshopify.com", { clientId: "filter-agent", userMessage: "mens red color t-shirt size L dikhao", inferredGender: "men", replyLanguage: "en" }, { loadCheckout: async () => null, saveCheckout: async () => null });
  await session.handlers.search_products({ searchTerm: "t-shirt", gender: "men" });
  assert.deepEqual(session.result().products.map(p => p.title), ["Men's Red Cotton T-Shirt"]);
});
test("trip shopping: the AI picks the items and the store's real products come back (no hardcoded travel bundle)", async () => {
  const session = ecommerce.createSession("search.myshopify.com", { llmMode: true, clientId: "trip-buyer", userMessage: "I am travelling from India to US and want useful products for my complete whole trip", profile: { gender: "men", shoppingGender: "men" } }, { loadCheckout: async () => null, saveCheckout: async () => null });
  await session.handlers.get_recommendations({ keywords: ["backpack", "power bank", "water bottle"] });
  const titles = session.result().products.map(p => p.title);
  assert.ok(titles.some(t => /Backpack/.test(t)), titles.join());
  assert.ok(titles.some(t => /Power Bank/.test(t)), titles.join());
  assert.ok(titles.some(t => /Bottle/.test(t)), titles.join());
  assert.ok(titles.every(t => !/Women's/.test(t)));
});
test("with an AI model, a single-item search is honoured exactly (no keyword hijack)", async () => {
  const session = ecommerce.createSession("search.myshopify.com", { llmMode: true, clientId: "trip-bottle", userMessage: "Recommend useful products for my whole trip, start with a water bottle" }, { loadCheckout: async () => null, saveCheckout: async () => null });
  await session.handlers.search_products({ searchTerm: "water bottle" });
  assert.deepEqual(session.result().products.map(p => p.title), ["Stainless Steel Water Bottle"]);
});

test("'iski photo dikhao' after a product was shown returns that product's card WITH its image", async () => {
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const first = ecommerce.createSession("search.myshopify.com", { clientId: "img-buyer", userMessage: "mens red t-shirt dikhao", inferredGender: "men", replyLanguage: "en" }, store);
  await first.handlers.search_products({ searchTerm: "t-shirt", gender: "men" });
  assert.ok(first.result().products.every(p => p.image), "search cards carry images");

  const second = ecommerce.createSession("search.myshopify.com", { clientId: "img-buyer", userMessage: "iski photo dikhao", inferredGender: "men", replyLanguage: "hi", history: [{ role: "assistant", content: "Here is **Men's Red Cotton T-Shirt**" }] }, store);
  assert.equal(await second.routeKnownIntent(), true);
  const cards = second.result().products;
  assert.equal(cards.length, 1);
  assert.ok(cards[0].image && /^https:\/\//.test(cards[0].image));
});
test("asking about offers/warranty of one named product also shows its card with image", async () => {
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const s = ecommerce.createSession("search.myshopify.com", { clientId: "warranty-buyer", userMessage: "Men's Red Cotton T-Shirt ki warranty kya hai", inferredGender: "men", replyLanguage: "hi" }, store);
  await s.handlers.get_warranty_and_policy({ productName: "Men's Red Cotton T-Shirt" });
  const cards = s.result().products;
  assert.equal(cards.length, 1);
  assert.ok(cards[0].image);
});