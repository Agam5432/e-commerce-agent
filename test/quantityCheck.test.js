// "Do you have 100 Logitech mice?" got "in stock, but the exact count isn't shown" (real TechStore: 20 in stock). The exact count stays hidden;
// whether the asked number can be supplied is answered from the real stock.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { checkVariantAvailability } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const variant = (stock, policy = "DENY", tracked = true) => ({ id: "gid://shopify/ProductVariant/11", title: "Black", selectedOptions: [], image: null, price: "24.00", compareAtPrice: null, inventoryQuantity: stock, inventoryPolicy: policy, inventoryItem: { tracked } });
const node = (v) => ({ id: "gid://shopify/Product/1", title: "Logitech M331 Silent Wireless Mouse", handle: "m331", description: "Wireless mouse", status: "ACTIVE", productType: "Mouse", vendor: "Logitech", tags: [], publishedAt: "2026-10-26T00:00:00Z", featuredImage: null, priceRangeV2: { minVariantPrice: { amount: "24.00", currencyCode: "USD" } }, variants: { edges: [{ node: v }] } });
const mock = (v) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { product: node(v), products: { edges: [{ node: node(v) }], pageInfo: { hasNextPage: false, endCursor: null } } } }) }); };

test("a number above the real stock is reported as not supplied, without revealing the count", async () => {
  mock(variant(20));
  const r = await checkVariantAvailability("qty1.myshopify.com", { productName: "Logitech M331", variantName: "", quantity: 100 });
  assert.deepEqual(r.quantityCheck, { requested: 100, canSupply: false });
  assert.doesNotMatch(JSON.stringify(r), /"unitsInStock":20/);
});

test("a number within the stock is reported as supplied", async () => {
  mock(variant(20));
  const r = await checkVariantAvailability("qty2.myshopify.com", { productName: "Logitech M331", variantName: "", quantity: 10 });
  assert.deepEqual(r.quantityCheck, { requested: 10, canSupply: true });
});

test("no quantity asked, or stock that cannot be read, gives no claim", async () => {
  mock(variant(20));
  assert.equal((await checkVariantAvailability("qty3.myshopify.com", { productName: "Logitech M331", variantName: "" })).quantityCheck, undefined);
  mock(variant(null));
  assert.equal((await checkVariantAvailability("qty4.myshopify.com", { productName: "Logitech M331", variantName: "", quantity: 100 })).quantityCheck, undefined);
});
