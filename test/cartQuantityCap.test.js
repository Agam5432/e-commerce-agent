// H4: the quantity added to the cart, and the one said to the shopper, come from the option's REAL stock. Nothing else.
// The bug (real store, 2026-11-16): "add 99999 mice" -> the assistant said "I added 50, the maximum we can pack into one order", but the
// option had 20 in stock, Shopify's cart took 20, and nothing told the assistant. The 50 was a hard-coded rule with an invented reason.
// Shopify is scripted here (MOCK TESTED); the real-store re-run is a separate browser check.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { probeCatalog } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const PRODUCT_ID = "gid://shopify/Product/1";
const VARIANT_ID = "gid://shopify/ProductVariant/11";
function productNode({ qty, policy = "DENY", tracked = true }) {
  return {
    id: PRODUCT_ID, title: "Logitech M331 Silent Wireless Mouse", handle: "logitech-m331", description: "A mouse", status: "ACTIVE", productType: "Mouse", vendor: "Logitech", tags: [],
    publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "mouse" },
    priceRangeV2: { minVariantPrice: { amount: "24.00", currencyCode: "USD" } },
    variants: { edges: [{ node: { id: VARIANT_ID, title: "Black", selectedOptions: [], image: null, price: "24.00", compareAtPrice: null, inventoryQuantity: qty, inventoryPolicy: policy, inventoryItem: { tracked } } }] },
  };
}
const serve = (node) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null } }, product: node } }) }); };

let seq = 0;
async function add(quantity, { cartQuantity = 0, node } = {}) {
  serve(node);
  const cart = cartQuantity ? { currency: "USD", item_count: cartQuantity, items: [{ title: node.title, variant_title: "Black", quantity: cartQuantity, variant_id: 11, product_id: 1, key: "11:k", price: 2400, line_price: 2400 * cartQuantity }] } : { currency: "USD", item_count: 0, items: [] };
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const session = ecommerce.createSession("cap.myshopify.com", { llmMode: true, clientId: `cap-${++seq}-${quantity}`, userMessage: "add mouse", replyLanguage: "en", history: [], cart }, store);
  await probeCatalog("cap.myshopify.com", "warm");
  const result = await session.handlers.add_to_cart({ productName: "Logitech M331 Silent Wireless Mouse", quantity });
  return { result, session, action: session.result().actions.find((a) => a.type === "add_to_cart") };
}

test("H4 (the real case): 99999 asked, 20 in stock -> 20 are added, the action asks the cart for 20, and the stated reason is the stock", async () => {
  const { result, action } = await add(99999, { node: productNode({ qty: 20 }) });
  assert.equal(result.status, "ok");
  assert.equal(result.quantity, 20);
  assert.equal(action.quantity, 20, "the browser is asked for what Shopify's cart will really take");
  assert.equal(result.requestedQuantity, 99999);
  assert.match(result.note, /only 20 of this option are available/);
  assert.doesNotMatch(JSON.stringify(result), /at most 50|maximum we can pack|one order can hold/i, "no invented limit or reason");
});

test("H4: a request within stock is added exactly, with no note (500 asked, 900 in stock)", async () => {
  const { result, action } = await add(500, { node: productNode({ qty: 900 }) });
  assert.equal(result.quantity, 500);
  assert.equal(action.quantity, 500);
  assert.equal(result.note, undefined);
});

test("H4: units already in the cart count against the stock (880 in cart, 20 left, 100 asked -> 20)", async () => {
  const { result, action } = await add(100, { cartQuantity: 880, node: productNode({ qty: 900 }) });
  assert.equal(result.quantity, 20);
  assert.equal(action.quantity, 20);
  assert.match(result.note, /880 already in the cart/);
});

test("H4: when the cart already holds every available unit nothing is added and the true reason is given", async () => {
  const { result, action, session } = await add(5, { cartQuantity: 20, node: productNode({ qty: 20 }) });
  assert.equal(result.status, "at_stock_limit");
  assert.equal(action, undefined, "no add action is sent to the browser");
  assert.match(session.result().fallbackSpeech, /already has all 20 of .*available/);
  assert.match(result.note, /real stock/);
});

test("H4: an option Shopify does not limit (untracked, or overselling allowed) takes what was asked; an absurd number is asked about, never capped by a made-up rule", async () => {
  assert.equal((await add(60, { node: productNode({ qty: null, tracked: false }) })).result.quantity, 60);
  assert.equal((await add(800, { node: productNode({ qty: 0, policy: "CONTINUE" }) })).result.quantity, 800, "overselling allowed: no stock limit");
  const { result, action, session } = await add(99999, { node: productNode({ qty: null, tracked: false }) });
  assert.equal(result.status, "quantity_unclear");
  assert.equal(action, undefined);
  assert.match(session.result().fallbackSpeech, /did you really want 99999/i);
});

test("H4: a normal quantity has no extra note", async () => {
  const { result } = await add(3, { node: productNode({ qty: 20 }) });
  assert.equal(result.quantity, 3);
  assert.equal(result.note, undefined);
});

// ---------------------------------------------------------------- the update path had the same hard-coded 50
async function update(args, { qty, cartQuantity }) {
  const node = productNode({ qty });
  serve(node);
  const cart = { currency: "USD", item_count: cartQuantity, items: [{ title: node.title, variant_title: "Black", quantity: cartQuantity, variant_id: 11, product_id: 1, key: "11:k", price: 2400, line_price: 2400 * cartQuantity }] };
  const store = { loadCheckout: async () => null, saveCheckout: async () => null };
  const session = ecommerce.createSession("cap.myshopify.com", { llmMode: true, clientId: `upd-${++seq}`, userMessage: "change quantity", replyLanguage: "en", history: [], cart }, store);
  const result = await session.handlers.update_cart_item({ productName: node.title, variantName: "", ...args });
  return { result, session, action: session.result().actions.find((a) => a.type === "update_cart") };
}

test("H4 (update): raising a line above stock sets it to the stock and says so; below stock it is exact", async () => {
  const over = await update({ quantity: 500 }, { qty: 20, cartQuantity: 2 });
  assert.equal(over.result.quantity, 20);
  assert.equal(over.action.quantity, 20);
  assert.match(over.session.result().fallbackSpeech, /Only 20 .* are available, so I've set it to 20/);
  const ok = await update({ quantity: 7 }, { qty: 20, cartQuantity: 2 });
  assert.equal(ok.result.quantity, 7);
  assert.equal(ok.result.note, undefined);
});

test("H4 (update): 'one more' on a line that already holds all the stock changes nothing and says why", async () => {
  const { result, session } = await update({ addQuantity: 1 }, { qty: 20, cartQuantity: 20 });
  assert.equal(result.quantity, 20);
  assert.match(session.result().fallbackSpeech, /already has all 20 of .*available/);
  assert.doesNotMatch(session.result().fallbackSpeech, /most one order can hold/);
});

test("H4: the tool tells the model to pass the number the shopper said, however large (a real run had the model silently swap 99999 for 1)", async () => {
  const mod = await import("../src/industries/ecommerce/toolDefinitions.js");
  const defs = mod.toolDefinitions || mod.default || Object.values(mod).find(Array.isArray);
  const tool = defs.find((d) => d.function?.name === "add_to_cart").function;
  assert.match(tool.parameters.properties.quantity.description, /EXACTLY that number/);
});
