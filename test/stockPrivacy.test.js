// A shopper (or a competitor posing as one) must not be able to read exact stock levels out of the chat:
// every tool result that carries a unit count goes through visibleStockCount (only a low count is shown).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { getProductDetails, resolveCartItem } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const variant = (n, qty) => ({ node: { id: `gid://shopify/ProductVariant/${n}`, title: `Size ${n}`, selectedOptions: [{ name: "Size", value: String(n) }], price: "10.00", inventoryQuantity: qty, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } });
const product = { id: "gid://shopify/Product/9", title: "Stock Tee", handle: "stock-tee", description: "A tee", productType: "Shirts", tags: [], status: "ACTIVE", publishedAt: "2026-01-01T00:00:00Z", featuredImage: null, priceRangeV2: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } }, variants: { edges: [variant(1, 40), variant(2, 3), variant(3, 0)] } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node: product }] }, product } }) });

const counts = (json) => [...JSON.stringify(json).matchAll(/"unitsInStock":(\d+)/g)].map((m) => Number(m[1]));

test("product details show a unit count only for a low stock level", async () => {
  const out = await getProductDetails("stock.myshopify.com", "Stock Tee");
  const shown = counts(out);
  assert.ok(!JSON.stringify(out).includes('"unitsInStock":40'), "40 units must not be told");
  assert.ok(shown.every((n) => n <= 5), `only low counts may appear, got ${shown}`);
  assert.ok(shown.includes(3), "a low count (3) is still told");
});

test("the cart resolver does not list exact stock either", async () => {
  const out = await resolveCartItem("stock.myshopify.com", { productName: "Stock Tee" });
  assert.ok(!JSON.stringify(out).includes('"unitsInStock":40'), "40 units must not be told");
  assert.ok(counts(out).every((n) => n <= 5));
});

const rawCounts = (json) => [...JSON.stringify(json).matchAll(/"inventoryQuantity":(\d+)/g)].map((m) => Number(m[1]));

test("no raw inventoryQuantity above the low-stock limit reaches the model in any variants list", async () => {
  const details = await getProductDetails("stock.myshopify.com", "Stock Tee");
  const resolved = await resolveCartItem("stock.myshopify.com", { productName: "Stock Tee" });
  for (const out of [details, resolved]) {
    assert.ok(!JSON.stringify(out).includes('"inventoryQuantity":40'), "40 units must not be told");
    assert.ok(rawCounts(out).every((n) => n <= 5), `only low counts may appear, got ${rawCounts(out)}`);
  }
  assert.ok(rawCounts(details).includes(3), "a low count (3) is kept");
  assert.ok(rawCounts(details).includes(0), "sold out (0) is kept so cards still show it");
});
