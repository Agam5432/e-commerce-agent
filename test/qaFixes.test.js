// Regression tests for the QA findings: one price per product, singular/plural alike, "cheapest" without the model's help,
// cards that match the reply, no children's items as unasked recommendations, and a cart line taken out can be put back.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { parsePriceSort } from "../src/tools/shopify/words.js";
import { cardsForAnswer, productsMentionedInAnswer } from "../src/agent/cardSelection.js";
import { writeCheckoutMemory } from "../src/industries/ecommerce/pricing.js";
import { realCatalogNodes } from "./helpers/realCatalog.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
const nodes = realCatalogNodes();
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const store = { loadCheckout: async () => null, saveCheckout: async () => null };
let no = 0;
const session = (term, extra = {}) => {
  const shop = `qa${++no}.myshopify.com`;
  return { shop, s: ecommerce.createSession(shop, { llmMode: true, clientId: `qa${no}`, userMessage: term, replyLanguage: "en", ...extra }, store) };
};
const search = async (term, args = {}) => {
  const { s } = session(term);
  return { out: await s.handlers.search_products({ searchTerm: term, ...args }), s };
};

test("singular and plural name the same store type (watch = watches, smartwatch included)", async () => {
  const one = (await search("watch")).out.products.map((p) => p.title).sort();
  const many = (await search("watches")).out.products.map((p) => p.title).sort();
  assert.deepEqual(one, many);
  assert.ok(one.includes("Noise ColorFit Smartwatch"));
});

test("a price limit keeps every item of the type under it", async () => {
  const titles = (await search("watch under 10000")).out.products.map((p) => p.title).sort();
  assert.deepEqual(titles, ["Casio Vintage Digital Watch", "Noise ColorFit Smartwatch"]);
});

test("ordering words set the price order without the model's sortBy, and are not searched as product words", async () => {
  assert.deepEqual(parsePriceSort("cheapest phone"), { sort: "price_low", term: "phone" });
  assert.deepEqual(parsePriceSort("sabse mehnga watch"), { sort: "price_high", term: "watch" });
  assert.equal(parsePriceSort("laptop").sort, "");
  // real storefront 2026-11-17: "no not that one, cheaper" after power banks showed bras and backpacks (no price order was read)
  assert.deepEqual(parsePriceSort("no not that one, cheaper"), { sort: "price_low", term: "no not that one," });
  assert.equal(parsePriceSort("something less expensive").sort, "price_low");
  assert.equal(parsePriceSort("the least expensive laptop").sort, "price_low");
  assert.equal(parsePriceSort("a more expensive one").sort, "price_high");
  assert.equal(parsePriceSort("kuch aur sasta dikhao").sort, "price_low");
  const cheap = (await search("cheapest phone")).out;
  assert.equal(cheap.status, "ok");
  assert.deepEqual(cheap.products.map((p) => p.title)[0], "Xiaomi Redmi Note 13");
  const dear = (await search("most expensive watch")).out.products.map((p) => p.title);
  assert.equal(dear[0], "Analog Wrist Watch - Rose Gold");
});

test("the reply price and the card price are the same number: the product's lowest buyable price", async () => {
  const { out, s } = await search("iphone 15");
  const model = out.products.find((p) => p.title === "Apple iPhone 15");
  const card = s.result().products.find((p) => p.title === "Apple iPhone 15");
  assert.equal(Number(model.price), 71600);
  assert.equal(Number(card.price), 71600);
  assert.equal(Math.min(...model.options.map((o) => Number(o.price))), Number(model.price));
  const compare = await session("compare").s.handlers.compare_products({ productNames: ["Apple iPhone 15", "Samsung Galaxy A55 5G"] });
  assert.equal(Number(compare.products.find((p) => p.title === "Apple iPhone 15").price), 71600);
});

test("a colour written in the term is not added a second time", async () => {
  const { out } = await search("black shirt");
  assert.ok(!/black shirt black/i.test(String(out.searchedFor || "")), out.searchedFor);
});

test("recommendations do not hand out children's items nobody asked for", async () => {
  const { s } = session("jacket for a trip");
  const out = await s.handlers.get_recommendations({ keywords: ["jacket"] });
  assert.ok(out.products.length > 0);
  assert.ok(out.products.every((p) => !/^(boys|girls|kids)/i.test(p.title)), out.products.map((p) => p.title).join());
});

const watches = ["Noise ColorFit Smartwatch", "Fossil Grant Chronograph Watch", "Casio Vintage Digital Watch", "Titan Neo Analog Watch", "Analog Wrist Watch - Rose Gold"].map((title, i) => ({ id: i, title, vendor: title.split(" ")[0] }));

test("cards: a shared everyday word ('wrist', 'watch') does not bring in a product the reply never names", () => {
  const reply = "Noise ColorFit Smartwatch, Fossil Grant Chronograph Watch, Casio Vintage Digital Watch and Titan Neo Analog Watch all sit nicely on the wrist - a good watch for daily use.";
  assert.equal(productsMentionedInAnswer(watches, reply).length, 4);
});

test("cards: the brand alone names its product", () => {
  assert.deepEqual(productsMentionedInAnswer(watches, "I'd go for the Fossil - it is the best of them.").map((p) => p.title), ["Fossil Grant Chronograph Watch"]);
});

test("cards: a reply that names other products than the found ones shows none of the found ones", () => {
  const laptops = ["ASUS Vivobook 15 Laptop", "HP Pavilion 14 Laptop", "Dell Inspiron 15 Laptop"].map((title, i) => ({ id: i, title, vendor: title.split(" ")[0] }));
  const reply = "For your laptop I suggest the Samsonite Laptop Backpack 15.6 or the HP Prelude Pro 15.6 Laptop Backpack.";
  assert.deepEqual(cardsForAnswer(laptops, [{ name: "search_products", result: { status: "ok", mode: "single", products: laptops } }], reply), []);
  // ...while a generic answer keeps them
  assert.equal(cardsForAnswer(laptops, [{ name: "search_products", result: { status: "ok", mode: "single", products: laptops } }], "Here are some laptops, which budget do you have in mind?").length, 3);
});

test("a cart line taken out can be added again without asking its colour or size", async () => {
  const shop = `qa-cart-${++no}.myshopify.com`;
  const clientId = `cart${no}`;
  writeCheckoutMemory(shop, clientId, { recentlyRemoved: [{ title: "Women's Teal Printed Cotton Kurti", variant: "M / Teal", at: Date.now() }] });
  const s = ecommerce.createSession(shop, { llmMode: true, clientId, userMessage: "add it again", replyLanguage: "en", history: [], cart: { items: [], currency: "INR" } }, store);
  const out = await s.handlers.add_to_cart({ productName: "Women's Teal Printed Cotton Kurti", quantity: 1 });
  assert.notEqual(out.status, "needs_variant", JSON.stringify(out).slice(0, 300));
});
