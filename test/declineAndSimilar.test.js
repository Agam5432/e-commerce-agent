// "not now" must never produce product cards, and "suggest something" stays with what the shopper was
// just looking at instead of a random category.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { probeCatalog, parseSearchTerm } from "../src/tools/shopifyService.js";
import { productsMentionedInAnswer } from "../src/agent/cardSelection.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

let n = 0;
const item = (title, type) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: title,
  status: "ACTIVE", productType: type, vendor: "Acme", tags: [], publishedAt: "2026-10-26T00:00:00Z", onlineStoreUrl: null,
  featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: "199.00", currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: "Default Title", selectedOptions: [], image: null, price: "199.00", compareAtPrice: null, inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
const CATALOG = [
  item("The Inventory Not Tracked Snowboard", "Snowboards"), item("Hydrogen Snowboard", "Snowboards"),
  item("Solo Microwave 20L", "Microwaves"), item("Convection Microwave 28L", "Microwaves"), item("Grill Microwave 23L", "Microwaves"),
  item("Air Fryer 5.5L", "Air Fryers"), item("4K Smart TV 55 Inch", "Televisions"),
];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: CATALOG.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });

test("a reply like 'not now' or 'no thanks, maybe later' is not a product search", async () => {
  for (const reply of ["not now", "no thanks, maybe later", "ok abhi nahi", "haan theek hai"]) {
    assert.deepEqual(parseSearchTerm(reply).words, [], reply);
    assert.deepEqual(await probeCatalog("decline1.myshopify.com", reply), [], reply);
  }
});

test("a real product word next to those words still searches", async () => {
  const hits = await probeCatalog("decline2.myshopify.com", "not now, show microwave");
  assert.ok(hits.length > 0 && hits.every((p) => /Microwave/.test(p.title)), hits.map((p) => p.title).join());
});

test("products found before the model answered show only if the answer names them (even a single one)", () => {
  const one = [{ title: "The Inventory Not Tracked Snowboard" }];
  const answer = "No worries at all. Take your time, and let me know if you want to check out any other appliances.";
  assert.deepEqual(productsMentionedInAnswer(one, answer, { strict: true }), []);
  assert.deepEqual(productsMentionedInAnswer(one, "The Inventory Not Tracked Snowboard is in stock.", { strict: true }), one);
  // tool results keep the old behaviour: nothing named means the shopper asked for these, keep them
  assert.deepEqual(productsMentionedInAnswer(one, answer), one);
  assert.deepEqual(productsMentionedInAnswer([{ title: "A b" }, { title: "C d" }], "", { strict: true }), []);
});

test("'show me something else' after looking at microwaves suggests microwaves, not a random category", async () => {
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const history = [
    { role: "user", content: "microwave dikhao" },
    { role: "assistant", content: "Here are a few microwaves: Solo Microwave 20L and Grill Microwave 23L." },
  ];
  const session = ecommerce.createSession("similar1.myshopify.com", { llmMode: true, clientId: "s1", userMessage: "kuch aur suggest karo", replyLanguage: "en", history }, store);
  await probeCatalog("similar1.myshopify.com", "warm the category index");
  await session.handlers.get_recommendations({ keywords: [] });
  const shown = session.result().products.map((p) => p.title);
  assert.ok(shown.length > 0, "something is suggested");
  assert.ok(shown.every((t) => /Microwave/.test(t)), shown.join(", "));
});

test("when a search ran and found nothing, the pre-check's loose guesses are not shown as cards", async () => {
  const { speculativeCards } = await import("../src/agent/cardSelection.js");
  const jeans = [{ title: "Slim Fit Blue Denim Jeans" }];
  const said = "I could not find a PlayStation. The search only turned up Slim Fit Blue Denim Jeans, which is not what you asked for.";
  assert.deepEqual(speculativeCards([{ name: "search_products", result: { status: "no_match" } }], jeans, said), []);
  assert.deepEqual(speculativeCards([{ name: "get_recommendations", result: { status: "not_found" } }], jeans, said), []);
  // no search ran: the answer names the item, so it is shown (unchanged behaviour)
  assert.deepEqual(speculativeCards([], jeans, "The Slim Fit Blue Denim Jeans are in stock."), jeans);
  assert.deepEqual(speculativeCards([], [], "anything"), []);
});
