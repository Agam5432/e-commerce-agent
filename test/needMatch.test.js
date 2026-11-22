// "headphones", "something to carry my laptop", "bahut pyaas lagi hai": the store sells these under its own
// product types ("Bluetooth Earbuds", "Laptop Bags", "Home & Kitchen"). When the word finds nothing, the model is
// asked which of the store's own types fit, and only types that really exist can come out of that.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { probeCatalog } from "../src/tools/shopifyService.js";
import { parseTypeList, storeTypesForNeed } from "../src/industries/ecommerce/needMatch.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

let n = 0;
const item = (title, type, price = "20.00") => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: title,
  status: "ACTIVE", productType: type, vendor: "Acme", tags: [], publishedAt: "2026-10-26T00:00:00Z", onlineStoreUrl: null,
  featuredImage: null, priceRangeV2: { minVariantPrice: { amount: price, currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: "Default Title", selectedOptions: [], image: null, price, compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
const CATALOG = [
  item("JBL Wave Beam Earbuds", "Bluetooth Earbuds"), item("Noise Buds VS104", "Bluetooth Earbuds"),
  item("Lenovo IdeaPad Slim 3", "Laptops", "600.00"), item("Dell Inspiron 15", "Laptops", "700.00"),
  item("Samsonite Backpack 15.6", "Laptop Bags"), item("Dell Essential Briefcase", "Laptop Bags"),
  item("Stainless Steel Bottle 1L", "Home & Kitchen"),
];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: CATALOG.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
const TYPES = ["Bluetooth Earbuds", "Laptops", "Laptop Bags", "Home & Kitchen"];

test("only product types that really exist are accepted from the model's answer", () => {
  assert.deepEqual(parseTypeList('Sure: ["Bluetooth Earbuds", "Flying Carpets", "laptop bags"]', TYPES), ["Bluetooth Earbuds", "Laptop Bags"]);
  assert.deepEqual(parseTypeList("[]", TYPES), []);
  assert.deepEqual(parseTypeList("no idea", TYPES), []);
  assert.deepEqual(parseTypeList('["Laptops","Laptops","Bluetooth Earbuds","Laptop Bags","Home & Kitchen"]', TYPES).length, 3);
});

test("the question is asked once per need and a failing model gives an empty list", async () => {
  let asked = 0;
  const ask = async () => { asked += 1; return '["Laptops"]'; };
  assert.deepEqual(await storeTypesForNeed({ message: "cache check need", types: TYPES, ask }), ["Laptops"]);
  assert.deepEqual(await storeTypesForNeed({ message: "cache check need", types: TYPES, ask }), ["Laptops"]);
  assert.equal(asked, 1);
  assert.deepEqual(await storeTypesForNeed({ message: "other need", types: TYPES, ask: async () => { throw new Error("down"); } }), []);
  assert.deepEqual(await storeTypesForNeed({ message: "", types: TYPES, ask }), []);
  assert.deepEqual(await storeTypesForNeed({ message: "x", types: [], ask }), []);
});

const run = async (shop, message, picks, tool = "search_products", args = { searchTerm: "headphone" }) => {
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const asked = [];
  const context = { llmMode: true, clientId: shop, userMessage: message, replyLanguage: "en", history: [], catalogCategories: TYPES, askModel: async (prompt) => { asked.push(prompt); return picks; } };
  const session = ecommerce.createSession(shop, context, store);
  await probeCatalog(shop, "warm the category index");
  const result = await session.handlers[tool](args);
  return { result, shown: session.result().products.map((p) => p.title), asked };
};

test("'headphone' finds nothing by word, so the store's earbuds are offered", async () => {
  const { result, shown, asked } = await run("need1.myshopify.com", "mujhe headphone chahiye", '["Bluetooth Earbuds"]');
  assert.equal(result.mode, "need_match");
  assert.deepEqual(shown.sort(), ["JBL Wave Beam Earbuds", "Noise Buds VS104"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Bluetooth Earbuds \| Laptops \| Laptop Bags \| Home & Kitchen/);
});

test("a situation ('very thirsty') maps to the store's own type", async () => {
  const { shown } = await run("need2.myshopify.com", "bahut pyaas lagi hai kuch dikhao", '["Home & Kitchen"]', "search_products", { searchTerm: "thirsty" });
  assert.deepEqual(shown, ["Stainless Steel Bottle 1L"]);
});

test("recommendations that find nothing by word use the same help", async () => {
  const { result, shown } = await run("need3.myshopify.com", "travel ke liye kuch", '["Laptop Bags"]', "get_recommendations", { keywords: ["zzzqx"] });
  assert.equal(result.mode, "need_match");
  assert.deepEqual(shown.sort(), ["Dell Essential Briefcase", "Samsonite Backpack 15.6"]);
});

test("if the model names no real type, the honest 'not available' answer is kept", async () => {
  const { result, shown } = await run("need4.myshopify.com", "mujhe playstation chahiye", '["Gaming Consoles"]', "search_products", { searchTerm: "playstation" });
  assert.equal(result.mode, undefined);
  assert.notEqual(result.status, "ok");
  assert.deepEqual(shown, []);
});

test("the search tool and the shop prompt tell the model to search for needs and situations, not only for exact product names", async () => {
  const fs = await import("node:fs");
  const defs = fs.readFileSync(new URL("../src/industries/ecommerce/toolDefinitions.js", import.meta.url), "utf8");
  const prompt = fs.readFileSync(new URL("../src/industries/ecommerce/systemPrompt.js", import.meta.url), "utf8");
  assert.doesNotMatch(defs, /product search ONLY when the customer explicitly asks/);
  assert.match(defs, /describes a need, use or situation/);
  assert.match(prompt, /mode need_match, those ARE the store's answer/);
});

test("'something to carry my laptop' searched as 'laptop' also brings the store's laptop bags", async () => {
  const { result, shown } = await run("need5.myshopify.com", "mera laptop carry karne ke liye kuch chahiye", '["Laptops", "Laptop Bags"]', "search_products", { searchTerm: "laptop" });
  assert.ok(result.alsoMatchesByMeaning?.length > 0, JSON.stringify(Object.keys(result)));
  assert.ok(result.alsoMatchesByMeaning.every((p) => /Briefcase|Backpack/.test(p.title)));
  assert.ok(shown.some((t) => /Briefcase|Backpack/.test(t)) && shown.some((t) => /Lenovo|Dell Inspiron/.test(t)));
});

test("a plain one-word search does not spend the extra model question", async () => {
  const { result, asked } = await run("need6.myshopify.com", "laptop", '["Laptops"]', "search_products", { searchTerm: "laptop" });
  assert.equal(asked.length, 0);
  assert.equal(result.alsoMatchesByMeaning, undefined);
});

test("recommendations with no keyword but a named item search for it; the store's first categories are not shown instead", async () => {
  const { result, shown } = await run("need7.myshopify.com", "washing machine chahiye", "[]", "get_recommendations", { keywords: [] });
  assert.equal(result.status, "no_match");
  assert.deepEqual(shown, []);
});

test("a vague request with only generic words still gets varied suggestions", async () => {
  const { result, shown } = await run("need8.myshopify.com", "kuch dikhao", "[]", "get_recommendations", { keywords: [] });
  assert.notEqual(result.status, "no_match");
  assert.ok(shown.length > 0);
});

test("two things named together ('shirt ya t-shirt') are both searched and both shown", async () => {
  const extra = [item("Men's Beige Linen Shirt", "Men's Clothing"), item("Men's Red Flannel Shirt", "Men's Clothing"), item("Men's Classic White T-Shirt", "T-Shirt")];
  CATALOG.push(...extra);
  try {
    const { shown } = await run("need9.myshopify.com", "shirt ya t-shirt dikhao", "[]", "search_products", { searchTerm: "", searchTerms: ["shirt", "t-shirt"] });
    assert.ok(shown.some((t) => /Shirt/.test(t) && !/T-Shirt/.test(t)), shown.join());
    assert.ok(shown.some((t) => /T-Shirt/.test(t)), shown.join());
  } finally {
    CATALOG.splice(CATALOG.length - extra.length, extra.length);
  }
});
