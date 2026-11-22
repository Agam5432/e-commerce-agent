// Cards must agree with the reply, and a short word must find the store's own category.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { cardsForAnswer } from "../src/agent/cardSelection.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

// ---- cards follow the reply -----------------------------------------------------------------------
const phones = [{ title: "Samsung Galaxy A55 5G" }, { title: "OnePlus Nord CE4" }, { title: "Apple iPhone 15" }];

test("items found only by meaning are not shown under a reply that says the item is not sold", () => {
  const log = [{ name: "search_products", result: { status: "ok", mode: "need_match" } }];
  assert.deepEqual(cardsForAnswer(phones, log, "We do not have televisions right now. Would you like to look at smartphones instead?"), []);
});

test("items found by meaning are shown once the reply names them", () => {
  const log = [{ name: "search_products", result: { status: "ok", mode: "need_match" } }];
  const shown = cardsForAnswer(phones, log, "For calls and photos I suggest the Samsung Galaxy A55 5G or the OnePlus Nord CE4.");
  assert.deepEqual(shown.map((p) => p.title), ["Samsung Galaxy A55 5G", "OnePlus Nord CE4"]);
});

test("a normal match keeps every card when the reply names none, and only the named ones when it names some", () => {
  const log = [{ name: "search_products", result: { status: "ok" } }];
  assert.equal(cardsForAnswer(phones, log, "Here are some options for you.").length, 3);
  assert.deepEqual(cardsForAnswer(phones, log, "I like the OnePlus Nord CE4 most.").map((p) => p.title), ["OnePlus Nord CE4"]);
});

test("a normal match in the same turn keeps the cards even if another search was by meaning", () => {
  const log = [
    { name: "search_products", result: { status: "ok", mode: "need_match" } },
    { name: "search_products", result: { status: "ok" } },
  ];
  assert.equal(cardsForAnswer(phones, log, "Here are some options.").length, 3);
});

// ---- "phone" means the store's Smartphones, not every phone case ---------------------------------
let n = 0;
const item = (title, type) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: title,
  status: "ACTIVE", productType: type, vendor: "Acme", tags: [], publishedAt: "2026-10-26T00:00:00Z", onlineStoreUrl: null,
  featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: "499.00", currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: "Default Title", selectedOptions: [], image: null, price: "499.00", compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
let catalog = [];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: catalog.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
const store = { loadCheckout: async () => null, saveCheckout: async () => null };
let shopNo = 0;
async function search(products, message, args) {
  catalog = products;
  const shop = `compound${++shopNo}.myshopify.com`;
  const session = ecommerce.createSession(shop, { llmMode: true, clientId: `c${shopNo}`, userMessage: message, replyLanguage: "en" }, store);
  return session.handlers.search_products(args);
}

const withText = (product, text) => ({ ...product, description: text });
const STORE = [
  // like a real store: only one phone says the word "phone" in its text
  item("Apple iPhone 15", "Smartphones"), item("Samsung Galaxy A55", "Smartphones"), withText(item("OnePlus Nord CE4", "Smartphones"), "A phone with a smooth AMOLED display"),
  item("Rugged Phone Case", "Phone Cases"), item("Phone Charger 20W", "Chargers"), item("Laptop Backpack", "Laptop Bags"),
];

test("the word phone finds the store's Smartphones and not the phone accessories", async () => {
  const out = await search(STORE, "phone", { searchTerm: "phone" });
  assert.equal(out.status, "ok");
  const titles = out.products.map((p) => p.title).sort();
  assert.deepEqual(titles, ["Apple iPhone 15", "OnePlus Nord CE4", "Samsung Galaxy A55"]);
});

test("when two categories could be meant by the word, none is guessed", async () => {
  const mixed = [item("Apple iPhone 15", "Smartphones"), item("Sony Headphones", "Headphones")];
  const out = await search(mixed, "phone", { searchTerm: "phone" });
  const titles = (out.products || []).map((p) => p.title);
  assert.ok(!(titles.length === 1), "a single guessed category must not be chosen");
});

// ---- a word that is only in some other item's description does not make that item the one asked for ----
const SHOP = () => [
  withText(item("Apple iPhone 15", "Smartphones"), "Mirror your screen to a TV with USB-C"),
  withText(item("Women's Cotton Dress", "Women's Clothing"), "Comes in 5 colours"),
  item("Denim Jeans", "Women's Clothing"),
];

test("a word found only in descriptions gets a low match confidence, so it is no sure card", async () => {
  const out = await search(SHOP(), "tv", { searchTerm: "tv" });
  assert.ok((out.products || out.closestAlternatives || []).every((p) => p.matchConfidence < 0.6), JSON.stringify(out.products?.map((p) => p.matchConfidence)));
});

test("PlayStation 5 is not rescued by the digit 5 found in a dress description", async () => {
  const out = await search(SHOP(), "PlayStation 5 hai?", { searchTerm: "PlayStation 5" });
  const titles = [...(out.products || []), ...(out.closestAlternatives || [])].map((p) => p.title);
  assert.ok(!titles.includes("Women's Cotton Dress"), `got ${titles.join(", ")}`);
});

test("cards of weak description-only matches need a mention in the reply", () => {
  const weak = [{ title: "Apple iPhone 15", matchConfidence: 0.5 }, { title: "Samsung Galaxy A55", matchConfidence: 0.5 }];
  const log = [{ name: "search_products", result: { status: "ok", products: weak } }];
  assert.deepEqual(cardsForAnswer(weak, log, "We do not sell TVs, sorry."), []);
  assert.deepEqual(cardsForAnswer(weak, log, "The Apple iPhone 15 can mirror to a TV.").map((p) => p.title), ["Apple iPhone 15"]);
  const strong = weak.map((p) => ({ ...p, matchConfidence: 0.9 }));
  assert.equal(cardsForAnswer(strong, [{ name: "search_products", result: { status: "ok", products: strong } }], "Here are some options.").length, 2);
});

test("a category listing (confidence 0.58) keeps all its cards even when the reply names none", () => {
  const listing = [{ title: "Samsung Galaxy A55 5G", matchConfidence: 0.58 }, { title: "OnePlus Nord CE4", matchConfidence: 0.58 }];
  const log = [{ name: "search_products", result: { status: "ok", products: listing } }];
  assert.equal(cardsForAnswer(listing, log, "Here are the phones we have.").length, 2);
});

test("a gift search that found accessories, under a reply recommending earbuds, shows the earbuds (real storefront 2026-11-17)", () => {
  const acc = ["Women's Perfume Gift Set", "Women's Leather Handbag", "Women's Printed Silk Scarf"].map((title) => ({ title, category: "Gifts" }));
  const buds = [{ title: "JBL Wave Beam Earbuds", category: "Earbuds" }, { title: "boAt Airdopes 141 Earbuds", category: "Earbuds" }, { title: "Noise Buds VS104 Earbuds", category: "Earbuds" }];
  const log = [{ name: "search_products", result: { status: "ok", mode: "single", searchedCategory: "music", products: acc } }];
  const reply = "Since she loves music, our JBL Wave Beam Earbuds would be a great choice. - **boAt Airdopes 141 Earbuds** ($19.00): long playtime. - **Noise Buds VS104 Earbuds** ($24.00): touch controls.";
  const shown = cardsForAnswer([...acc, ...buds], log, reply).map((p) => p.title);
  assert.deepEqual(shown.sort(), buds.map((p) => p.title).sort());
});
