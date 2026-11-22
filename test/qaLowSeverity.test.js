// Low-severity QA items and M7: each with the shape of the real failure. MOCK/UNIT (the real-store re-runs are in the QA report).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { probeCatalog } from "../src/tools/shopifyService.js";
import { shareableContactEmail } from "../src/tools/shopify/catalog.js";
import { browseCards } from "../src/agent/cardSelection.js";
import { parseSearchTerm } from "../src/tools/shopify/words.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

// ---------------------------------------------------------------- cart quantities: zero, negative, "add 0"
const node = {
  id: "gid://shopify/Product/1", title: "Logitech M331 Silent Wireless Mouse", handle: "m331", description: "A mouse", status: "ACTIVE", productType: "Mouse", vendor: "Logitech", tags: [],
  publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "m" }, priceRangeV2: { minVariantPrice: { amount: "24.00", currencyCode: "USD" } },
  variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/11", title: "Black", selectedOptions: [], image: null, price: "24.00", compareAtPrice: null, inventoryQuantity: 20, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
};
const serve = () => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null } }, product: node } }) }); };
let seq = 0;
const cartOf = (n) => ({ currency: "USD", item_count: n, items: n ? [{ title: node.title, variant_title: "Black", quantity: n, variant_id: 11, product_id: 1, key: "11:k", price: 2400, line_price: 2400 * n }] : [] });
const session = (cart, userMessage) => ecommerce.createSession("low.myshopify.com", { llmMode: true, clientId: `low-${++seq}`, userMessage, replyLanguage: "en", history: [], cart }, { loadCheckout: async () => null, saveCheckout: async () => null });

test("add_to_cart with quantity 0 or -3 adds nothing and asks (it used to add 1)", async () => {
  serve();
  await probeCatalog("low.myshopify.com", "warm");
  for (const q of [0, -3, "abc"]) {
    const s = session(cartOf(0), "add mouse");
    const r = await s.handlers.add_to_cart({ productName: node.title, quantity: q });
    assert.equal(r.status, "quantity_unclear", String(q));
    assert.equal(s.result().actions.length, 0, "nothing sent to the cart");
    assert.match(s.result().fallbackSpeech, /at least 1/);
  }
  const ok = await session(cartOf(0), "add mouse").handlers.add_to_cart({ productName: node.title });
  assert.equal(ok.quantity, 1, "no quantity given still means one");
});

test("update_cart_item: 'add 0', 'add minus 3', '-2' never remove the line; a real 'remove' still does", async () => {
  serve();
  for (const [args, said] of [[{ quantity: 0 }, "add 0 logitech mouse"], [{ quantity: 0 }, "add minus 3 logitech mouse"], [{ quantity: -2 }, "make the quantity -2"], [{ addQuantity: -3 }, "add -3"], [{ addQuantity: 0 }, "add 0 more"]]) {
    const s = session(cartOf(3), said);
    const r = await s.handlers.update_cart_item({ productName: node.title, variantName: "", ...args });
    assert.equal(r.status, "quantity_unclear", said);
    assert.equal(s.result().actions.length, 0, said);
  }
  const s = session(cartOf(3), "please remove the mouse from my cart");
  const r = await s.handlers.update_cart_item({ productName: node.title, variantName: "", quantity: 0 });
  assert.equal(r.quantity, 0);
  assert.equal(s.result().actions[0].type, "update_cart");
});

// ---------------------------------------------------------------- personal mailbox is not "the store's contact"
test("a personal mailbox (gmail.com) is withheld from the assistant; a business address is kept; opt-in shares it", () => {
  assert.equal(shareableContactEmail("owner@gmail.com"), null);
  assert.equal(shareableContactEmail("someone@Outlook.com"), null);
  assert.equal(shareableContactEmail("help@techstore.com"), "help@techstore.com");
  assert.equal(shareableContactEmail(""), null);
  process.env.SHARE_PERSONAL_CONTACT_EMAIL = "1";
  assert.equal(shareableContactEmail("owner@gmail.com"), "owner@gmail.com");
  delete process.env.SHARE_PERSONAL_CONTACT_EMAIL;
});

// ---------------------------------------------------------------- M7: cards must match what the reply names
test("M7: '15 inch laptop' - 'inch' is not a word every title must have, and a category tie never hides the laptops", () => {
  const p = (title, category) => ({ title, category });
  const cards = [p("Samsonite Laptop Backpack 15.6", "laptop_bags"), p("HP Prelude Pro 15.6 Laptop Backpack", "laptop_bags"), p("ASUS Vivobook 15 Laptop", "laptops"), p("Dell Inspiron 15 Laptop", "laptops")];
  const search = { result: { mode: "single", status: "ok", searchedCategory: "15 inch laptop", products: cards } };
  const shown = browseCards(cards, [search], [cards[2], cards[3]]);
  const titles = (shown || cards).map((c) => c.title);
  assert.ok(titles.includes("ASUS Vivobook 15 Laptop") && titles.includes("Dell Inspiron 15 Laptop"), titles.join(" | "));
  // an unsolvable tie: nothing is narrowed
  const tie = [p("Alpha one", "a"), p("Alpha two", "a"), p("Beta one", "b"), p("Beta two", "b")];
  assert.equal(browseCards(tie, [{ result: { mode: "single", status: "ok", searchedCategory: "gadget thing", products: tie } }], []), null);
});

test("'15 inch laptop' searches for 15 and laptop (inch is a unit word)", () => {
  const parsed = parseSearchTerm("15 inch laptop");
  const words = JSON.stringify(parsed);
  assert.doesNotMatch(words, /inch/);
});
