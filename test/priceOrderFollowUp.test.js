// "and the most expensive one?" after a laptop search keeps the category (real storefront, 2026-11-16: it answered with a trench coat).
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { probeCatalog } from "../src/tools/shopifyService.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
const mk = (id, title, type, price) => ({ id: `gid://shopify/Product/${id}`, title, handle: `p${id}`, description: title, status: "ACTIVE", productType: type, vendor: "V", tags: [], publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "x" }, priceRangeV2: { minVariantPrice: { amount: String(price), currencyCode: "USD" } }, variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${id}1`, title: "Default Title", selectedOptions: [], image: null, price: String(price), compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] } });
const nodes = [mk(1, "Budget Laptop", "Laptops", 549), mk(2, "Mid Laptop", "Laptops", 599), mk(3, "Pro Laptop", "Laptops", 829), mk(4, "Winter Coat", "Coats", 2999)];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });

test("a price-order follow-up with no category keeps the last searched category", async () => {
  await probeCatalog("order.myshopify.com", "warm");
  const clientId = "order-" + Math.random().toString(36).slice(2);
  const make = (msg) => ecommerce.createSession("order.myshopify.com", { llmMode: true, clientId, userMessage: msg, replyLanguage: "en", history: [], cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
  const first = await make("what is the cheapest laptop").handlers.search_products({ searchTerm: "laptop", sortBy: "price_low" });
  assert.match(first.products[0].title, /Laptop/);
  const s2 = make("and the most expensive one?");
  const second = await s2.handlers.search_products({ sortBy: "price_high" });
  const titles = (second.products || []).map((p) => p.title);
  assert.ok(titles.length > 0 && titles.every((t) => /Laptop/.test(t)), titles.join(" | "));
  assert.equal(titles[0], "Pro Laptop");
});

test("a price-order request that names its own category is unchanged", async () => {
  const clientId = "order2-" + Math.random().toString(36).slice(2);
  const s = ecommerce.createSession("order.myshopify.com", { llmMode: true, clientId, userMessage: "most expensive coat", replyLanguage: "en", history: [], cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
  const r = await s.handlers.search_products({ searchTerm: "coat", sortBy: "price_high" });
  assert.equal(r.products[0].title, "Winter Coat");
});

test("with no remembered search, the category comes from the shopper's earlier message (first turn answered without a search call)", async () => {
  const clientId = "order3-" + Math.random().toString(36).slice(2);
  const history = [{ role: "user", content: "what is the cheapest laptop you have?" }, { role: "assistant", content: "The Budget Laptop." }];
  const s = ecommerce.createSession("order.myshopify.com", { llmMode: true, clientId, userMessage: "and the most expensive one?", replyLanguage: "en", history, cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
  const r = await s.handlers.search_products({ sortBy: "price_high" });
  const titles = (r.products || []).map((p) => p.title);
  assert.ok(titles.length > 0 && titles.every((t) => /Laptop/.test(t)), titles.join(" | "));
  assert.equal(titles[0], "Pro Laptop");
});

test("\"no not that one, cheaper\" after a search keeps the category and orders by price (it showed bras and backpacks after power banks)", async () => {
  const clientId = "order4-" + Math.random().toString(36).slice(2);
  const history = [{ role: "user", content: "I just want a laptop" }, { role: "assistant", content: "Here are the laptops: Mid Laptop, Pro Laptop, Budget Laptop." }];
  const s = ecommerce.createSession("order.myshopify.com", { llmMode: true, clientId, userMessage: "no not that one, cheaper", replyLanguage: "en", history, cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => {} });
  const r = await s.handlers.search_products({});
  const titles = (r.products || []).map((p) => p.title);
  assert.ok(titles.length > 0 && titles.every((t) => /Laptop/.test(t)), titles.join(" | "));
  assert.equal(titles[0], "Budget Laptop");
});
