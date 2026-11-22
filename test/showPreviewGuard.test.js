// "show me again what you found" answered "your cart is empty, nothing to preview" (show_preview kind=cart; real storefront 2026-11-17).
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";

const make = (userMessage, items = []) => ecommerce.createSession("prev.myshopify.com", { llmMode: true, clientId: "prev-" + Math.random().toString(36).slice(2), userMessage, replyLanguage: "en", history: [], cart: { currency: "USD", total_price: 0, item_count: items.length, items } }, { loadCheckout: async () => null, saveCheckout: async () => {} });

test("an empty-cart preview with no word about the cart is not a cart request", async () => {
  const r = await make("show me again what you found").handlers.show_preview({ kind: "cart" });
  assert.equal(r.status, "not_requested");
  assert.match(r.instruction_for_ai, /products from this conversation/);
});

test("a real cart preview request still reaches the cart", async () => {
  const r = await make("show me my cart").handlers.show_preview({ kind: "cart" });
  assert.notEqual(r.status, "not_requested");
});

test("with items in the cart, \"show me again what you found\" is still about the products, while \"show me my cart\" reaches the cart", async () => {
  const items = [{ variant_id: 1, id: 1, product_title: "Nike Revolution 7 Running Shoes", title: "Nike Revolution 7 Running Shoes", quantity: 1, price: 660000, original_price: 660000, line_price: 660000, final_line_price: 660000 }];
  const again = await make("show me again what you found", items).handlers.show_preview({ kind: "cart" });
  assert.equal(again.status, "not_requested");
  const mine = await make("show me my cart", items).handlers.show_preview({ kind: "cart" });
  assert.notEqual(mine.status, "not_requested");
});
