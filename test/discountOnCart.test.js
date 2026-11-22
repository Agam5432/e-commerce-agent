// Discount codes on the real TechStore (2026-11-16): CHAT20 ("20% off Automated Collection") was applied to the WHOLE cart (₹77,940 saved instead of 20% of
// the one covered line, ₹9,340) and PREPAID50 ("minimum purchase $20,000") was applied to a cart worth about $4,000.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { assessDiscountOnCart } from "../src/tools/shopify/offers.js";
import { catalogSummaryCaches } from "../src/tools/shopify/caches.js";
import { clearCartPricingCache } from "../src/services/cartPricing.js";
import { computeOrderPricing } from "../src/industries/ecommerce/pricing.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const SHOP = "disc.myshopify.com";
catalogSummaryCaches.set(SHOP, { at: Date.now(), summary: { currency: "USD" } });
const BASE = { "gid://shopify/ProductVariant/11": 489, "gid://shopify/ProductVariant/21": 1799 };
const COLLECTIONS = { "11": ["Automated Collection", "Home page"], "21": ["Home page"] };
globalThis.fetch = async (url, options) => {
  const { query, variables } = JSON.parse(options.body);
  if (/LineScope/.test(query)) return { ok: true, status: 200, json: async () => ({ data: { nodes: variables.ids.map((id) => ({ id, product: { title: id.endsWith("/11") ? "Samsung Galaxy A55 5G" : "Running Sneakers - Black", collections: { nodes: COLLECTIONS[id.split("/").pop()].map((title) => ({ title })) } } })) } }) };
  if (/CartVariantPrices/.test(query)) return { ok: true, status: 200, json: async () => ({ data: { shop: { currencyCode: "USD" }, nodes: variables.ids.map((id) => ({ id, price: String(BASE[id]) })) } }) };
  throw new Error("unexpected query " + query.slice(0, 40));
};

// the INR cart of the real run: Samsung ₹46,700 x1 + sneakers ₹1,71,500 x2
const cart = { currency: "INR", total_price: 38970000, item_count: 3, items: [
  { variant_id: 11, product_title: "Samsung Galaxy A55 5G", quantity: 1, price: 4670000, line_price: 4670000, final_line_price: 4670000 },
  { variant_id: 21, product_title: "Running Sneakers - Black", quantity: 2, price: 17150000, line_price: 34300000, final_line_price: 34300000 },
] };
const chat20 = { code: "CHAT20", percentage: 20, limitedTo: "collection", scopeNames: ["Automated Collection"], minSubtotal: 0, minQuantity: 0 };
const prepaid50 = { code: "PREPAID50", percentage: 50, limitedTo: "", scopeNames: [], minSubtotal: 20000, minCurrency: "USD", minQuantity: 0 };
const freeShip = { code: "FREESHIPPING2026", isFreeShipping: true, limitedTo: "", scopeNames: [], minSubtotal: 0, minQuantity: 3 };

test("a collection-limited code covers only the cart lines in that collection", async () => {
  const a = await assessDiscountOnCart(SHOP, cart, chat20);
  assert.equal(a.eligible, true);
  assert.equal(a.scopeKnown, true);
  assert.equal(a.eligibleSubtotal, 46700);
  assert.deepEqual(a.coveredVariantIds, ["11"]);
  assert.deepEqual(a.coveredTitles, ["Samsung Galaxy A55 5G"]);
  // 20% of the covered line, not of the whole ₹3,89,700 cart
  const pricing = computeOrderPricing(cart, { appliedDiscount: { code: "CHAT20", percent: 20, scopeVariantIds: a.coveredVariantIds } }, "USD");
  assert.equal(pricing.couponDiscountAmount, 9340);
  assert.equal(pricing.totalAfterCoupon, 389700 - 9340);
});

test("a code with a minimum spend in dollars is refused on a rupee cart worth about $4,000", async () => {
  clearCartPricingCache();
  const a = await assessDiscountOnCart(SHOP, cart, prepaid50);
  assert.equal(a.eligible, false);
  assert.ok(a.conditions.some((c) => /USD 20,000\.00/.test(c)), a.conditions.join(" | "));
});

test("a cart worth over $20,000 meets the dollar minimum", async () => {
  clearCartPricingCache();
  BASE["gid://shopify/ProductVariant/21"] = 12000;
  try {
    const a = await assessDiscountOnCart(SHOP, cart, prepaid50);
    assert.equal(a.eligible, true);
  } finally { BASE["gid://shopify/ProductVariant/21"] = 1799; clearCartPricingCache(); }
});

test("the minimum quantity counts the cart's items", async () => {
  assert.equal((await assessDiscountOnCart(SHOP, cart, freeShip)).eligible, true);
  const two = { ...cart, item_count: 2 };
  const a = await assessDiscountOnCart(SHOP, two, freeShip);
  assert.equal(a.eligible, false);
  assert.ok(a.conditions.some((c) => /at least 3/.test(c)));
});

test("when the covered lines cannot be read, the scope is reported unknown (never guessed)", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) });
  try {
    const a = await assessDiscountOnCart(SHOP, cart, chat20);
    assert.equal(a.scopeKnown, false);
  } finally { globalThis.fetch = saved; }
});

test("a code limited to a collection that no cart line is in covers nothing", async () => {
  const none = { ...chat20, scopeNames: ["Winter sale"] };
  const a = await assessDiscountOnCart(SHOP, cart, none);
  assert.equal(a.eligibleSubtotal, 0);
});
