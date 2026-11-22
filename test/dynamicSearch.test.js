import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts, probeCatalog } from "../src/tools/shopifyService.js";
import ecommerce, { classifyConversationalTurn } from "../src/industries/ecommerce.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });

let n = 0;
const variant = (title = "Default Title") => ({ id: `gid://shopify/ProductVariant/${++n}`, title, selectedOptions: [{ name: "Title", value: title }], price: "20.00", inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } });
const product = (title, { type = "", tags = [] } = {}) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: "",
  productType: type, tags, status: "ACTIVE", publishedAt: "2026-01-01T00:00:00Z", onlineStoreUrl: null,
  featuredImage: null, priceRangeV2: { minVariantPrice: { amount: "20.00", currencyCode: "USD" } },
  variants: { edges: [{ node: variant() }] },
});
// No product types at all, no gender tags on the bottle: the store has NO taxonomy to lean on.
const fixtures = [
  product("Stainless Steel Water Bottle 1L"),
  product("Women Printed Kurti", { tags: ["women"] }),
  product("Wireless Earbuds"),
  product("Cotton Bedsheet Set"),
];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: fixtures.map((node) => ({ node })) } } }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const SHOP = "dynamic.myshopify.com";

test("misspelt 'bootle' still finds the bottle (typo repaired from the store's own words)", async () => {
  const found = await searchShopifyProducts(SHOP, "water bootle");
  assert.deepEqual(found.map((p) => p.title), ["Stainless Steel Water Bottle 1L"]);
});

test("probe maps a Hinglish sentence onto real products and ignores filler words", async () => {
  const hits = await probeCatalog(SHOP, "mere ko water bootle purchase krni h");
  assert.deepEqual(hits.map((p) => p.title), ["Stainless Steel Water Bottle 1L"]);
});

test("probe stays empty for chit-chat and for items the store does not have", async () => {
  assert.deepEqual(await probeCatalog(SHOP, "hey kse ho"), []);
  assert.deepEqual(await probeCatalog(SHOP, "I want a laptop"), []);
});

test("gender is a preference: men's kurti request returns the store's kurti flagged, not 'none'", async () => {
  const found = await searchShopifyProducts(SHOP, "kurti for men");
  assert.equal(found.length, 1);
  assert.equal(found[0].title, "Women Printed Kurti");
  assert.equal(found[0].genderMismatch, true);
});

test("no hardcoded conversational classifier remains", () => {
  assert.equal(classifyConversationalTurn("hello"), null);
  assert.equal(classifyConversationalTurn("I want cigarettes"), null);
});

test("system prompt carries live search facts and forbids availability claims from type labels", () => {
  const ctx = {
    catalogProductCount: 4,
    storeProfile: { storeName: "T", categoryCounts: [{ label: "Clothing", count: 2 }] },
    probeRan: true,
    probeProducts: [{ id: "1", title: "Stainless Steel Water Bottle 1L", price: "20.00", currency: "USD", variants: [] }],
    profile: {},
  };
  const prompt = ecommerce.buildSystemPrompt(SHOP, ctx);
  assert.match(prompt, /Stainless Steel Water Bottle 1L/);
  assert.match(prompt, /NEVER say the store lacks an item listed here/);
  assert.match(prompt, /must never be used to decide availability/);
  const none = ecommerce.buildSystemPrompt(SHOP, { ...ctx, probeProducts: [] });
  assert.match(none, /NOT proof the item is missing/);
});

test("prompt: static rules first, per-turn data last (cache-friendly); friendly shopkeeper persona present", () => {
  const mk = (extra) => ecommerce.buildSystemPrompt(SHOP, { catalogProductCount: 4, storeProfile: { storeName: "T" }, probeRan: true, probeProducts: [], profile: {}, replyLanguage: "hinglish", ...extra });
  const a = mk({ lastOrderNumber: "#1001", orderVerifiedEmail: "a***@g.com" });
  const b = mk({});
  const live = a.indexOf("LIVE CONTEXT (changes every turn");
  assert.ok(live > 0);
  // everything before LIVE CONTEXT is identical whatever the per-turn data is
  assert.equal(a.slice(0, live), b.slice(0, live));
  assert.match(a, /real friend/);
  assert.match(a, /Never invent urgency, scarcity, discounts/);
  assert.match(a.slice(live), /#1001/);
});

test("a need or occasion is turned into real product types, and a qualifier never blocks the plain item", () => {
  const prompt = ecommerce.buildSystemPrompt(SHOP, { catalogProductCount: 3, storeProfile: { storeName: "T" }, probeRan: true, probeProducts: [], profile: {}, replyLanguage: "en", languageLocked: false, cart: { items: [], currency: "USD" } });
  assert.match(prompt, /A NEED or OCCASION is not a product/);
  assert.match(prompt, /never search that word itself/);
  assert.match(prompt, /search the plain type/);
});
