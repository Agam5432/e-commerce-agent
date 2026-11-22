// H3: a product's sale is worked out from ONE option's own price and compare-at price, never across options.
// Real TechStore data (Shopify Admin, 2026-11-16): Xiaomi Redmi Note 13 128GB $229 (was $269), 256GB $269 (was $309).
// The bug: max(compare-at over all options) = $309 and min(price over all options) = $229 gave "26% off, save $80".
// Shopify is scripted here (MOCK TESTED); the real-store re-run is a separate browser check.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { computeProductSale } from "../src/tools/shopify/offers.js";
import { getProductDiscountsAndOffers } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

let n = 0;
const variant = (title, price, compareAtPrice, qty = 10) => ({ node: { id: `gid://shopify/ProductVariant/${++n}`, title, selectedOptions: [], image: null, price, compareAtPrice, inventoryQuantity: qty, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } });
const product = (title, type, variants) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: `${title} description`, status: "ACTIVE", productType: type, vendor: "Acme", tags: [type.toLowerCase()],
  publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: "229.00", currencyCode: "USD" } }, variants: { edges: variants },
});
const XIAOMI = product("Xiaomi Redmi Note 13", "Smartphones", ["Midnight Black", "Arctic White", "Ocean Teal"].flatMap((c) => [variant(`${c} / 128GB`, "229.00", "269.00"), variant(`${c} / 256GB`, "269.00", "309.00")]));
const MOUSE = product("Logitech M331 Silent Wireless Mouse", "Mouse", [variant("Black", "24.00", null, 20)]);
const SALE_ONE_OPTION = product("Half Sale Shirt", "Shirt", [variant("S", "50.00", "80.00"), variant("L", "80.00", null)]);
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: [XIAOMI, MOUSE, SALE_ONE_OPTION].map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });

const mapped = (p) => ({ title: p.title, currency: "USD", variants: p.variants.edges.map((e) => ({ title: e.node.title, price: e.node.price, compareAtPrice: e.node.compareAtPrice, sellable: true })) });

test("H3: the headline is one option's own pair, and every option's pair is listed separately", () => {
  const { productSale, variantSales } = computeProductSale(mapped(XIAOMI));
  assert.deepEqual([productSale.originalPrice, productSale.salePrice, productSale.discountAmount, productSale.discountPercent], [269, 229, 40, 15]);
  assert.equal(productSale.optionName, "Midnight Black / 128GB");
  assert.equal(productSale.saleVariesByOption, true, "128GB is 15% off, 256GB is 13% off");
  const pairs = new Set(variantSales.map((v) => `${v.compareAtPrice}->${v.price}`));
  assert.deepEqual([...pairs].sort(), ["269->229", "309->269"]);
  assert.ok(!pairs.has("309->229"), "one option's original price is never paired with another option's price");
});

test("H3: the option the customer asked about decides the figures (256GB, 128GB, an option that is not on sale)", () => {
  const big = computeProductSale(mapped(XIAOMI), { variantName: "256GB" }).productSale;
  assert.deepEqual([big.originalPrice, big.salePrice, big.discountAmount, big.discountPercent], [309, 269, 40, 13]);
  const small = computeProductSale(mapped(XIAOMI), { variantName: "128GB" }).productSale;
  assert.deepEqual([small.originalPrice, small.salePrice, small.discountPercent], [269, 229, 15]);
  const shirt = mapped(SALE_ONE_OPTION);
  const l = computeProductSale(shirt, { variantName: "L" });
  assert.equal(l.productSale, null, "size L is not marked down: it must not borrow size S's discount");
  assert.equal(l.requestedOptionNotOnSale, true);
  assert.equal(computeProductSale(shirt, { variantName: "S" }).productSale.discountPercent, 38);
});

test("H3: a product with no markdown has no sale, and a one-option product names no option", () => {
  assert.equal(computeProductSale(mapped(MOUSE)).productSale, null);
  const single = computeProductSale({ title: "Thing", currency: "USD", variants: [{ title: "Default Title", price: "10.00", compareAtPrice: "20.00", sellable: true }] });
  assert.equal(single.productSale.optionName, "");
  assert.equal(single.productSale.discountPercent, 50);
});

test("H3: the real tool result (through the Shopify-facing function) never contains the mixed figures", async () => {
  const res = await getProductDiscountsAndOffers("techstore-test.myshopify.com", { productName: "Xiaomi Redmi Note 13" });
  const sale = res.product.saleDiscount;
  assert.deepEqual([sale.originalPrice, sale.salePrice, sale.discountAmount, sale.discountPercent], [269, 229, 40, 15]);
  const flat = JSON.stringify(res);
  assert.doesNotMatch(flat, /"discountPercent":26|"discountAmount":80|"originalPrice":309/, "the old max/min mix must be gone");
  const offer = res.offers.find((o) => o.type === "product_sale");
  assert.match(offer.description, /Midnight Black \/ 128GB/);
  assert.match(offer.description, /15% sale/);
  const big = await getProductDiscountsAndOffers("techstore-test.myshopify.com", { productName: "Xiaomi Redmi Note 13", variantName: "256GB" });
  assert.deepEqual([big.product.saleDiscount.originalPrice, big.product.saleDiscount.salePrice], [309, 269]);
});
