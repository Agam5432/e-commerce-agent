// Prices follow the shopper's own Shopify storefront currency by default (real TechStore, 2026-11-16: an INR shopper's cart said ₹46,700 while the
// assistant said "$489.00" for the same Samsung Galaxy A55 256GB, and "$5,397" for sneakers that the cart priced at ₹5,14,500).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { pricesFollowMarket } from "../src/config/env.js";
import { searchShopifyProducts, withShopperPricing, compactProduct } from "../src/tools/shopifyService.js";
import { discountEligibility } from "../src/tools/shopify/offers.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

test("market pricing is on by default and only STORE_PRICES_FOLLOW_MARKET=0 switches it off", () => {
  assert.equal(pricesFollowMarket({}), true);
  assert.equal(pricesFollowMarket({ STORE_PRICES_FOLLOW_MARKET: "1" }), true);
  assert.equal(pricesFollowMarket({ STORE_PRICES_FOLLOW_MARKET: "" }), true);
  assert.equal(pricesFollowMarket({ STORE_PRICES_FOLLOW_MARKET: "0" }), false);
});

const node = (id, title, type, basePrice) => ({
  id: `gid://shopify/Product/${id}`, title, handle: `p${id}`, description: title, status: "ACTIVE", productType: type, vendor: "V", tags: [], publishedAt: "2026-10-26T00:00:00Z",
  featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "x" }, priceRangeV2: { minVariantPrice: { amount: String(basePrice), currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${id}1`, title: "Default Title", selectedOptions: [], image: null, price: String(basePrice), compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
const nodes = [node(1, "Samsung Galaxy A55 5G", "Smartphones", 489), node(2, "Running Sneakers - Black", "Shoes", 1799)];
const SHOPPER = { "gid://shopify/ProductVariant/11": { amount: "46700.00", currencyCode: "INR" }, "gid://shopify/ProductVariant/21": { amount: "171500.00", currencyCode: "INR" } };
function mockShopify({ contextualOk = true } = {}) {
  globalThis.fetch = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (/ShopperPrices/.test(query)) {
      if (!contextualOk) return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
      assert.equal(variables.country, "IN");
      return { ok: true, status: 200, json: async () => ({ data: { nodes: variables.ids.map((id) => ({ id, contextualPricing: SHOPPER[id] ? { price: SHOPPER[id], compareAtPrice: null } : null })) } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  };
}

test("INR shopper: the Samsung and the sneakers are priced with Shopify's contextual INR prices, never as dollars", async () => {
  mockShopify();
  const found = await withShopperPricing({ country: "IN", currency: "INR" }, () => searchShopifyProducts("inr.myshopify.com", "samsung galaxy a55"));
  const samsung = found.find((p) => /Samsung/.test(p.title));
  assert.equal(samsung.currency, "INR");
  assert.equal(Number(samsung.price), 46700);
  assert.match(compactProduct(samsung).formattedPrice, /₹\s?46,700/);
  assert.doesNotMatch(compactProduct(samsung).formattedPrice, /\$/);
  const shoes = await withShopperPricing({ country: "IN", currency: "INR" }, () => searchShopifyProducts("inr.myshopify.com", "running sneakers"));
  const sneaker = shoes.find((p) => /Sneakers/.test(p.title));
  assert.equal(sneaker.currency, "INR");
  assert.match(compactProduct(sneaker).formattedPrice, /₹\s?1,71,500/);
});

test("USD shopper: prices stay in USD with the $ sign", async () => {
  mockShopify();
  const found = await withShopperPricing({ country: "US", currency: "USD" }, () => searchShopifyProducts("usd.myshopify.com", "samsung galaxy a55"));
  const samsung = found.find((p) => /Samsung/.test(p.title));
  assert.equal(samsung.currency, "USD");
  assert.match(compactProduct(samsung).formattedPrice, /\$489/);
});

test("when Shopify has no contextual price, the product keeps its USD label: a dollar amount is never shown as rupees", async () => {
  mockShopify({ contextualOk: false });
  const found = await withShopperPricing({ country: "IN", currency: "INR" }, () => searchShopifyProducts("inr2.myshopify.com", "samsung galaxy a55"));
  const samsung = found.find((p) => /Samsung/.test(p.title));
  assert.equal(samsung.currency, "USD");
  assert.match(compactProduct(samsung).formattedPrice, /\$489/);
  assert.doesNotMatch(compactProduct(samsung).formattedPrice, /₹/);
});

test("a minimum spend set in dollars is never compared with a rupee cart total", () => {
  const prepaid = { minSubtotal: 20000, minCurrency: "USD", minQuantity: 0 };
  // ₹46,700 is more than 20,000 as a number, but the cart is worth $489: not eligible
  const small = discountEligibility(prepaid, { total: 46700, itemCount: 1, storeTotal: 489, storeCurrency: "USD" }, "INR");
  assert.equal(small.eligible, false);
  assert.ok(small.conditions.some((c) => /USD 20,000\.00/.test(c) && /store's own currency/.test(c)), small.conditions.join(" | "));
  // a cart worth $25,000 qualifies
  assert.equal(discountEligibility(prepaid, { total: 2383200, itemCount: 5, storeTotal: 25000, storeCurrency: "USD" }, "INR").eligible, true);
  // the store-currency total is unknown: not claimed eligible, and the reply says it could not be checked
  const unknown = discountEligibility(prepaid, { total: 46700, itemCount: 1 }, "INR");
  assert.equal(unknown.eligible, false);
  assert.ok(unknown.conditions.some((c) => /could not be checked/.test(c)));
  // same currency: compared directly
  assert.equal(discountEligibility(prepaid, { total: 20000, itemCount: 1 }, "USD").eligible, true);
  assert.equal(discountEligibility(prepaid, { total: 19999, itemCount: 1 }, "USD").eligible, false);
});
