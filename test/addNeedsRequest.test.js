// Real TechStore (2026-11-17): "black one" after a list of watches and "size L" after a list of T-shirts put a watch and a T-shirt in the cart
// although the shopper never asked to add anything.
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { addRequested } from "../src/industries/ecommerce/addRequest.js";
import { freshClientId } from "./helpers/agentHarness.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { readCheckoutMemory, writeCheckoutMemory } from "../src/industries/ecommerce/pricing.js";

const listed = [{ role: "assistant", content: "Here are some watches: **Titan Neo Analog Watch** ($129.00), **Casio Vintage Digital Watch** ($59.00). Which one would you like to look at?" }];
const offered = [{ role: "assistant", content: "The Titan Neo Analog Watch comes in black. Would you like me to add it to your cart?" }];

test("a message that only narrows a list is not a request to add", () => {
  for (const msg of ["black one", "size L", "in silver", "kaunsa sasta hai"]) assert.equal(addRequested(msg, listed), false, msg);
});

test("an explicit request, or an answer to an offer to add, is a request", () => {
  assert.equal(addRequested("add the Titan to my cart", listed), true);
  assert.equal(addRequested("I'll take the black one", listed), true);
  assert.equal(addRequested("mujhe ye chahiye", listed), true);
  assert.equal(addRequested("black", offered), true);
  assert.equal(addRequested("haan", offered), true);
  assert.equal(addRequested("कार्ट में डालो", []), true);
});

test("the add_to_cart tool refuses a narrowing message and leaves the cart alone", async () => {
  const session = ecommerce.createSession("addreq.myshopify.com", { llmMode: true, clientId: freshClientId(), userMessage: "black one", replyLanguage: "en", history: listed, cart: { currency: "USD", item_count: 0, total_price: 0, items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
  const r = await session.handlers.add_to_cart({ productName: "Titan Neo Analog Watch", variantName: "Black", quantity: 1 });
  assert.equal(r.status, "not_requested");
  assert.equal(session.result().actions.filter((a) => a.type === "add_to_cart").length, 0);
});

test("\"make it 3\" with items in the cart is a quantity change, not an add", async () => {
  const cart = { currency: "USD", item_count: 20, total_price: 48000, items: [{ variant_id: 1, id: 1, title: "Mouse", product_title: "Mouse", quantity: 20, price: 2400, original_price: 2400, line_price: 48000 }] };
  const session = ecommerce.createSession("addreq.myshopify.com", { llmMode: true, clientId: freshClientId(), userMessage: "make it 3 mice", replyLanguage: "en", history: [{ role: "assistant", content: "Your cart already has all 20 of the Mouse. Would you like to head to checkout?" }], cart }, { loadCheckout: async () => null, saveCheckout: async () => null });
  const r = await session.handlers.add_to_cart({ productName: "Mouse", variantName: "", quantity: 3 });
  assert.equal(r.status, "not_requested");
  assert.match(r.note, /update_cart_item/);
});

test("lowering the cart below a code's minimum quantity takes the code off and says so", async () => {
  const originalFind = StoreIntegration.findOne;
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
  try {
  let stored = { step: "cart", appliedDiscount: { code: "FREESHIPPING2026", isFreeShipping: true } };
  const cart = { currency: "USD", item_count: 3, total_price: 12000, items: [{ variant_id: 7, id: 7, key: "7:a", title: "Tee", product_title: "Tee", variant_title: "L", quantity: 3, price: 4000, original_price: 4000, line_price: 12000, final_line_price: 12000 }] };
  const deps = {
    loadCheckout: async () => structuredClone(stored), saveCheckout: async (_s, _c, patch) => { stored = { ...stored, ...patch }; },
    loadDiscounts: async () => [{ code: "FREESHIPPING2026", isFreeShipping: true, minQuantity: 3, minSubtotal: 0, limitedTo: "", scopeNames: [] }],
  };
  const clientId = freshClientId();
  writeCheckoutMemory("dropcode.myshopify.com", clientId, { step: "cart", appliedDiscount: { code: "FREESHIPPING2026", isFreeShipping: true } });
  const session = ecommerce.createSession("dropcode.myshopify.com", { llmMode: true, clientId, userMessage: "make it 2 tees", replyLanguage: "en", history: [], cart }, deps);
  const r = await session.handlers.update_cart_item({ productName: "Tee", variantName: "", quantity: 2 });
  assert.equal(r.status, "ok");
  assert.equal(r.discountRemoved?.code, "FREESHIPPING2026");
  assert.equal(readCheckoutMemory("dropcode.myshopify.com", clientId)?.appliedDiscount, null);
  assert.match(session.result().fallbackSpeech, /no longer qualifies for FREESHIPPING2026/);
  } finally { StoreIntegration.findOne = originalFind; }
});
