// "add one more": the cart line goes from 1 to 2 (one more, not a new search), and a reply never claims a cart change
// that no cart tool made.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => __resetProviderBlocksForTest());

const MOUSE = "Dell WM126 Wireless Mouse";
// a Shopify Ajax cart: prices in minor units
const cartWith = (quantity) => ({
  currency: "INR", item_count: quantity, total_price: 140000 * quantity, items_subtotal_price: 140000 * quantity,
  items: [{ title: MOUSE, variant_title: "Black", quantity, variant_id: 11, key: "11:abc", price: 140000, original_price: 140000, final_price: 140000, line_price: 140000 * quantity, original_line_price: 140000 * quantity, final_line_price: 140000 * quantity }],
});
const sessionFor = (cart, userMessage = "add one more") => ecommerce.createSession("cartplus.myshopify.com", { llmMode: true, clientId: freshClientId(), userMessage, replyLanguage: "en", cart }, { loadCheckout: async () => null, saveCheckout: async () => null });

test("addQuantity raises the line by that many", async () => {
  const session = sessionFor(cartWith(1));
  const r = await session.handlers.update_cart_item({ productName: MOUSE, variantName: "", addQuantity: 1 });
  assert.equal(r.status, "ok");
  assert.equal(r.previousQuantity, 1);
  assert.equal(r.quantity, 2);
  const action = session.result().actions.find((a) => a.type === "update_cart");
  assert.equal(action.quantity, 2);
  assert.equal(action.previousQuantity, 1);
});

test("addQuantity 2 on a line of 3 makes 5; there is no invented per-order maximum (stock limits are in cartQuantityCap.test.js)", async () => {
  assert.equal((await sessionFor(cartWith(3)).handlers.update_cart_item({ productName: MOUSE, variantName: "", addQuantity: 2 })).quantity, 5);
  // the old rule capped a line at 50 "because one order can hold at most 50": a made-up limit. Without stock data nothing is capped.
  const session = sessionFor(cartWith(50));
  const r = await session.handlers.update_cart_item({ productName: MOUSE, variantName: "", addQuantity: 1 });
  assert.equal(r.quantity, 51);
  assert.doesNotMatch(session.result().fallbackSpeech, /most one order can hold/);
});

test("the final-quantity form still works, and a call with neither is refused", async () => {
  const session = sessionFor(cartWith(1));
  assert.equal((await session.handlers.update_cart_item({ productName: MOUSE, variantName: "", quantity: 4 })).quantity, 4);
  assert.equal((await sessionFor(cartWith(1)).handlers.update_cart_item({ productName: MOUSE, variantName: "" })).status, "error");
  assert.equal((await sessionFor(cartWith(2), "remove the mouse").handlers.update_cart_item({ productName: MOUSE, variantName: "", quantity: 0 })).quantity, 0);
});

test("the tool is offered with addQuantity and without a required final quantity", async () => {
  const { default: defs } = await import("../src/industries/ecommerce/toolDefinitions.js").then((m) => ({ default: m.toolDefinitions || m.default || Object.values(m).find(Array.isArray) }));
  const tool = defs.find((d) => d.function?.name === "update_cart_item").function;
  assert.ok(tool.parameters.properties.addQuantity);
  assert.deepEqual(tool.parameters.required, ["productName", "variantName"]);
});

test("whole turn: 'add one more' runs update_cart_item and the cart line becomes 2", async () => {
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "update_cart_item", args: { productName: MOUSE, variantName: "", addQuantity: 1 } }] }),
    () => "Done, you now have two of the mouse in your cart. Shall we head to checkout?",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await runAgent("add one more", "cartplus.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: cartWith(1) });
  assert.equal(r.actions.find((a) => a.type === "update_cart")?.quantity, 2);
  assert.match(r.answer, /two/);
  assert.equal(gemini.main.length, 2, "the cart claim is true, so no rewrite");
});

test("whole turn: a reply that says 'added another one' with no cart tool is not sent as it is", async () => {
  const gemini = scriptedGemini([
    () => "I have added another one to your cart.",
    () => "Your cart is unchanged so far. Which item should I add one more of?",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await runAgent("add one more", "cartplus.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: cartWith(1) });
  assert.doesNotMatch(r.answer, /I have added another one/);
  assert.deepEqual(r.actions.filter((a) => /cart/.test(a.type)), []);
});
