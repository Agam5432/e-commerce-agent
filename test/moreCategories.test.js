// A broad word ("electronics") can match just one product type. When few things can be bought, the
// search result tells the model what else the store really has, from the store's own categories.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

let n = 0;
const item = (title, type, { qty = 5, size = "" } = {}) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: title,
  status: "ACTIVE", productType: type, vendor: "Acme", tags: [], publishedAt: "2026-10-26T00:00:00Z", onlineStoreUrl: null,
  featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: "499.00", currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: size || "Default Title", selectedOptions: size ? [{ name: "Size", value: size }] : [], image: null, price: "499.00", compareAtPrice: null, inventoryQuantity: qty, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});

let catalog = [];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: catalog.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });

let shopNo = 0;
const store = { loadCheckout: async () => null, saveCheckout: async () => null };
async function search(products, message, args) {
  catalog = products;
  const shop = `broad${++shopNo}.myshopify.com`; // each case gets its own store, so no cached catalog is shared
  const session = ecommerce.createSession(shop, { llmMode: true, clientId: `c${shopNo}`, userMessage: message, replyLanguage: "en" }, store);
  const out = await session.handlers.search_products(args);
  return { out, session };
}

const BROAD = [
  item("Wireless Bluetooth Earbuds", "Electronics", { qty: 0 }),
  item("Dell Inspiron Laptop", "Laptops"), item("Dell Gaming Laptop", "Laptops"),
  item("iPhone 15", "Smartphones"), item("Samsung Galaxy", "Smartphones"),
  item("Fossil Analog Watch", "Watches"),
  item("Out Of Stock Camera", "Cameras", { qty: 0 }),
];

test("a broad word that finds nothing to buy also tells the model what else is in stock", async () => {
  const { out } = await search(BROAD, "okay electronics me dikhao", { searchTerm: "electronics" });
  assert.equal(out.status, "no_match");
  const names = out.moreInStore.map((c) => c.category);
  assert.deepEqual([...names].sort(), ["Laptops", "Smartphones", "Watches"]);
  assert.equal(out.moreInStore.find((c) => c.category === "Laptops").inStock, 2);
  assert.ok(!names.includes("Cameras"), "a category with nothing in stock is not offered");
  assert.match(out.moreNote, /searchTerms/);
});

test("one item that can be bought is simply shown: no other categories are offered", async () => {
  const one = [item("Power Bank", "Electronics"), ...BROAD.slice(1)];
  const { out } = await search(one, "electronics dikhao", { searchTerm: "electronics" });
  assert.equal(out.status, "ok");
  assert.equal(out.foundCount, 1);
  assert.equal(out.moreInStore, undefined);
});

test("a colour that does not exist is never answered with other kinds of products", async () => {
  const store = [item("Blue Cotton Kurta", "Kurtas", { size: "M" }), item("Leather Belt", "Belts"), item("Running Shoes", "Shoes"), item("Brass Lamp", "Decor")];
  const { out, session } = await search(store, "black kurta dikhao", { searchTerm: "kurta", color: "black" });
  assert.equal(out.moreInStore, undefined);
  const shown = session.result().products.map((p) => p.title);
  assert.ok(shown.every((t) => /Kurta/.test(t)), shown.join());
});

test("plenty of in-stock matches means no extra hint (normal searches are unchanged)", async () => {
  const many = [item("Laptop A", "Laptops"), item("Laptop B", "Laptops"), item("Laptop C", "Laptops"), item("Phone", "Smartphones")];
  const { out } = await search(many, "laptop dikhao", { searchTerm: "laptops" });
  assert.equal(out.foundCount, 3);
  assert.equal(out.moreInStore, undefined);
  assert.equal(out.moreNote, undefined);
});

test("a colour, size or budget the shopper asked for is never answered with other categories", async () => {
  const shirts = [item("Men's Blue Shirt", "Shirts", { size: "M" }), item("Jeans", "Jeans", { size: "32" }), item("Belt", "Belts")];
  const { out } = await search(shirts, "blue shirt size M", { searchTerm: "shirt", size: "M" });
  assert.equal(out.moreInStore, undefined);
});

test("a sold-out match never leads the list", async () => {
  const mixed = [item("Sold Out Phone", "Smartphones", { qty: 0 }), item("Phone In Stock", "Smartphones")];
  const { out } = await search(mixed, "phone dikhao", { searchTerm: "phone" });
  assert.equal(out.products[0].title, "Phone In Stock");
});

test("the prompt tells the model to widen a thin search and to search every item the customer names", () => {
  const prompt = ecommerce.buildSystemPrompt("broad.myshopify.com", { catalogProductCount: 4, storeProfile: { storeName: "T" }, probeRan: true, probeProducts: [], profile: {}, replyLanguage: "en" });
  assert.match(prompt, /moreInStore/);
  assert.match(prompt, /Never say the store lacks an item you did not search for this turn/);
});
