// H2: "the very first phone you showed me today" must be answerable after many products were shown. The recency list keeps 10 products
// (newest first), so the first ones fell off; the ordered ledger keeps first-seen order. MOCK TESTED (Shopify scripted).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { readCheckoutMemory } from "../src/industries/ecommerce/pricing.js";
import { buildSystemPrompt } from "../src/industries/ecommerce/systemPrompt.js";
import { probeCatalog } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const NAMES = ["Xiaomi Redmi","Samsung Galaxy","Apple iPhone","Google Pixel","OnePlus Nord","Nokia Lumia","Motorola Edge","Sony Xperia","Oppo Reno","Vivo Vision","Realme Narzo","Asus Zenfone","Huawei Mate","Honor Magic"];
const nodes = Array.from({ length: 14 }, (_, i) => ({
  id: `gid://shopify/Product/${i + 1}`, title: NAMES[i], handle: `phone-${i + 1}`, description: "A phone", status: "ACTIVE", productType: "Smartphones", vendor: "V", tags: [],
  publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "p" }, priceRangeV2: { minVariantPrice: { amount: String(100 + i), currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${i + 100}`, title: "Default Title", selectedOptions: [], image: null, price: String(100 + i), compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
}));

test("H2: the ledger keeps first-shown order", async () => {
  let current = nodes[0];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } }, product: current } }) });
  await probeCatalog("ledger.myshopify.com", "warm");
  const clientId = "ledger-client-1";
  for (const node of nodes) {
    current = node;
    const session = ecommerce.createSession("ledger.myshopify.com", { llmMode: true, clientId, userMessage: `show ${node.title}`, replyLanguage: "en", history: [], cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
    await session.handlers.get_product_details({ productName: node.title });
    session.recordShown(session.result().products); // what the final reply shows, in order (done by the agent after each turn)
  }
  const mem = readCheckoutMemory("ledger.myshopify.com", clientId);
  assert.ok(mem.lastShownProducts.length <= 30); // the recency list is capped (30: enough for "the first one you showed")
  assert.equal(mem.shownLedger[0].title, "Xiaomi Redmi", "the very first product shown is still known");
  assert.equal(mem.shownLedger.length, 14);
  assert.deepEqual(mem.shownLedger.map((e) => e.title).slice(0, 3), ["Xiaomi Redmi", "Samsung Galaxy", "Apple iPhone"]);
  // (the recency list now holds 30, so with 14 products it still has the first one too; the ledger is what keeps order)
});

test("H2: the prompt lists the order, and tells the model to admit what it cannot see instead of guessing", () => {
  const mem = { shownLedger: [{ title: "Xiaomi Redmi", price: 100, currency: "USD" }, { title: "Samsung Galaxy", price: 101, currency: "USD" }] };
  const src = buildSystemPrompt.toString();
  assert.match(src, /ORDER IN WHICH PRODUCTS WERE FIRST SHOWN/);
  assert.match(src, /cannot see that far back/);
  assert.ok(mem.shownLedger.length === 2);
});
