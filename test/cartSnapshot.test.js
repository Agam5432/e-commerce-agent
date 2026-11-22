import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCartSnapshot, requireCartPricing } from "../src/services/cartSnapshot.js";
import { normalizeOrderItems } from "../src/services/shopifyOrderService.js";

export const compactCart = {
  item_count: 2, total_price: 169800, currency: "USD", items: [
    { title: "Men's Beige Linen Shirt", variant_title: "L / Beige", quantity: 1, line_price: 109900, final_line_price: 109900, variant_id: "123" },
    { title: "Men's Navy Blue Polo T-Shirt", variant_title: "L / Navy", quantity: 1, line_price: 59900, final_line_price: 59900, variant_id: "124" },
  ],
};
test("compact widget cart recovers missing unit prices and the correct total", () => {
  const cart = normalizeCartSnapshot(compactCart);
  assert.equal(cart.original_total_price, 169800);
  assert.equal(cart.total_price, 169800);
  assert.deepEqual(cart.items.map(item => item.price), [109900, 59900]);
  assert.deepEqual(normalizeOrderItems(compactCart.items).map(item => item.price), [109900, 59900]);
});
test("quantities divide integer line totals without guessing dollars versus cents", () => {
  const cart = normalizeCartSnapshot({ items: [{ variant_id: "123", quantity: 2, line_price: 1598 }] });
  assert.equal(cart.items[0].price, 799);
  assert.equal(cart.total_price, 1598);
  assert.equal(normalizeCartSnapshot({ items: [{ quantity: 1, price: "1099.00", line_price: 109900 }] }).items[0].price, 109900);
});
test("absent prices remain unknown and cannot produce a zero-dollar checkout", () => {
  const cart = normalizeCartSnapshot({ total_price: 0, items: [{ variant_id: "123", quantity: 1 }] });
  assert.equal(cart.total_price, null);
  assert.equal(cart.pricingComplete, false);
  assert.throws(() => requireCartPricing(cart), /Refresh your cart/);
});
test("valid free items retain zero prices and Ajax cart discounts do not get applied twice", () => {
  const cart = normalizeCartSnapshot({ items: [{ variant_id: "123", quantity: 1, original_price: 1000, final_line_price: 800 }, { variant_id: "124", quantity: 1, price: 0 }] });
  assert.equal(cart.original_total_price, 1000);
  assert.equal(cart.total_price, 800);
  assert.equal(cart.pricingComplete, true);
});
