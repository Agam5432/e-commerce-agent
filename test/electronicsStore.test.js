import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts, getCatalogSummary, compactProduct, recommendProducts } from "../src/tools/shopifyService.js";

// A freshly created non-fashion store: the built-in category labels know nothing about TVs or laptops,
// and one product has zero stock. The agent must still find them (and report stock truthfully).
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });

let n = 0;
const item = (title, { qty = 5, type = "", published = true, status = "ACTIVE", tags = [] } = {}) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  description: `${title} description`, status, productType: type, vendor: "Acme", tags,
  publishedAt: published ? "2026-10-26T00:00:00Z" : null,
  featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: "499.00", currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: "Default Title", selectedOptions: [], image: null, price: "499.00", compareAtPrice: null, inventoryQuantity: qty, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
const fixtures = [
  item("The Complete Snowboard", { type: "snowboard" }),
  item("Samsung 55 inch Smart TV", { type: "Television", tags: ["tv"] }),
  item("Sony Bravia 43 inch TV", { type: "Television", qty: 0 }),
  item("LG 43 inch 4K Ultra HD TV", { type: "Television" }),
  item("Front Load Washing Machine 9kg", { type: "Washing Machine" }),
  item("Fully Automatic Top Load Washing Machine 8kg", { type: "Washing Machine" }),
  item("Dell Inspiron Laptop", { type: "Laptop" }),
  item("Draft Camera", { type: "Camera", status: "DRAFT" }),
];
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /\.myshopify\.com\/admin\/api\//);
  return { ok: true, status: 200, json: async () => ({ data: { products: { edges: fixtures.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) };
};
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const SHOP = "gada-test.myshopify.com";

test("a store the built-in categories do not know still finds its own products", async () => {
  const result = await searchShopifyProducts(SHOP, "TV", { first: 8 });
  const titles = (result.products || result).map((p) => p.title);
  assert.ok(titles.includes("Samsung 55 inch Smart TV"), JSON.stringify(titles));
  assert.ok(!titles.includes("The Complete Snowboard"));
});

test("sold-out matches are still reported (flagged), not denied", async () => {
  const result = await searchShopifyProducts(SHOP, "Sony Bravia", { first: 8 });
  const list = result.products || result;
  assert.equal(list.length, 1);
  assert.equal(compactProduct(list[0]).inStock, false);
  assert.ok(list[0].variants.every((v) => v.sellable === false), "must be reported as sold out");
});

test("catalog summary reflects the real store, not a fashion template", async () => {
  const summary = await getCatalogSummary(SHOP);
  assert.equal(summary.error, undefined);
  assert.deepEqual(summary.outOfStockTitles, ["Sony Bravia 43 inch TV"]);
  assert.ok(summary.categories.some((c) => /television/i.test(c)));
  assert.ok(!summary.products.some((p) => p.title === "Draft Camera"));
});

test("asking for a TV never pads the cards with unrelated in-stock products", async () => {
  const picked = await recommendProducts(SHOP, { keywords: ["TV", "television"], userQuery: "hall ke liye tv dekhna hai", limit: 4 });
  const titles = picked.map((p) => p.title).sort();
  assert.deepEqual(titles, ["LG 43 inch 4K Ultra HD TV", "Samsung 55 inch Smart TV"]);
});

test("browsing with nothing named samples the store's own product types", async () => {
  const picked = await recommendProducts(SHOP, { limit: 6 });
  const titles = picked.map((p) => p.title);
  assert.ok(titles.length >= 3, JSON.stringify(titles));
  assert.ok(titles.some((t) => /TV/.test(t)) && titles.some((t) => /Washing|Laptop/.test(t)));
});

test("context words that exist nowhere in the store (hall, living room) do not block the real product", async () => {
  for (const q of ["TV for hall", "hall ke liye TV", "television living room"]) {
    const result = await searchShopifyProducts(SHOP, q, { first: 8 });
    const titles = (result.products || result).map((p) => p.title);
    assert.ok(titles.includes("Samsung 55 inch Smart TV"), `${q} -> ${JSON.stringify(titles)}`);
    assert.ok(!titles.some((t) => /Washing|Laptop|Snowboard/.test(t)), `${q} leaked ${JSON.stringify(titles)}`);
  }
});

test("a brand that does not exist is reported, not silently ignored", async () => {
  const result = await searchShopifyProducts(SHOP, "panasonic tv", { first: 8 });
  const list = result.products || result;
  assert.ok(list.length > 0);
  assert.deepEqual(compactProduct(list[0]).unmatchedQueryWords, ["panasonic"]);
});

test("'Top Load' appliances are not classified as clothing", async () => {
  const summary = await getCatalogSummary(SHOP);
  assert.ok(!summary.categories.includes("Dresses"), JSON.stringify(summary.categories));
  assert.ok(!("dresses" in summary.categoryMap));
});