// Real TechStore run (2026-11-16, cart already holding the Samsung phone): "add 2 Running Sneakers - Black size 9" made the assistant raise the PHONE to 2,
// or list sneakers without adding any, or claim an add that did not happen.
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { freshClientId } from "./helpers/agentHarness.js";

const cart = { currency: "INR", item_count: 1, total_price: 4670000, items_subtotal_price: 4670000, items: [{ title: "Samsung Galaxy A55 5G", variant_title: "Awesome Iceblue / 256GB", quantity: 1, variant_id: 11, key: "11:a", price: 4670000, original_price: 4670000, final_price: 4670000, line_price: 4670000, original_line_price: 4670000, final_line_price: 4670000 }] };
const sessionFor = (userMessage) => ecommerce.createSession("newadd.myshopify.com", { llmMode: true, clientId: freshClientId(), userMessage, replyLanguage: "en", cart }, { loadCheckout: async () => null, saveCheckout: async () => null });

test("naming a NEW product with 'add' never changes a line that is already in the cart", async () => {
  const session = sessionFor("add 2 Running Sneakers - Black size 9");
  const r = await session.handlers.update_cart_item({ productName: "", variantName: "", addQuantity: 1 });
  assert.equal(r.status, "not_requested");
  assert.equal(session.result().actions.filter((a) => a.type === "update_cart").length, 0);
});

test("'add one more' and a cart item's own name still raise that line", async () => {
  for (const msg of ["add one more", "add another phone", "add the Samsung Galaxy again"]) {
    const session = sessionFor(msg);
    const r = await session.handlers.update_cart_item({ productName: "Samsung Galaxy A55 5G", variantName: "", addQuantity: 1 });
    assert.equal(r.status, "ok", msg);
    assert.equal(r.quantity, 2, msg);
  }
});
