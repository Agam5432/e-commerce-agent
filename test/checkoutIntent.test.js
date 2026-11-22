import test from "node:test";
import assert from "node:assert/strict";
import { confirmsOrder, safeToolBatch, paymentChoice, billingRelationshipIntent } from "../src/services/checkoutIntent.js";

test("checkout questions and refusals cannot accidentally place orders", () => {
  for (const question of ["what is COD", "how can I place order", "COD available?", "do not place order", "order mat karna", "prepaid discount kya hai"]) {
    assert.equal(confirmsOrder(question, "ready"), false, question);
  }
});
test("explicit COD/online choices and final confirmations place orders", () => {
  for (const text of ["COD", "confirm COD", "cash on delivery", "prepaid", "order kar do", "place my order", "haan", "हाँ"]) {
    assert.equal(confirmsOrder(text, "ready"), true, text);
  }
  assert.equal(confirmsOrder("yes", "cart"), false);
});
test("model cannot clear the cart alongside a failed order submission", () => {
  assert.deepEqual(safeToolBatch([{ name: "place_order" }, { name: "clear_cart" }]).calls, [{ name: "place_order" }]);
});
test("checkout waits for new cart actions to reach the storefront", () => {
  const result = safeToolBatch([{ name: "add_to_cart" }, { name: "place_order" }]);
  assert.equal(result.checkoutDeferred, true);
  assert.deepEqual(result.calls, [{ name: "add_to_cart" }]);
});

test("natural spoken payment preferences work without accepting questions or refusals", () => {
  for (const text of ["Yeah, I'll prefer cash on delivery.", "I would like to pay by COD", "I prefer cash on delivery", "I'll use online payment please"]) {
    assert.equal(confirmsOrder(text, "ready"), true, text);
    assert.ok(paymentChoice(text), text);
  }
  for (const text of ["Can I place this order?", "Should I confirm this order?", "I don't prefer COD", "Maybe online payment", "not yet place this order", "COD or online payment?"]) {
    assert.equal(confirmsOrder(text, "ready"), false, text);
  }
});

test("combined checkout and payment instructions preserve the user's actual choice", () => {
  assert.equal(paymentChoice("Please place this order using COD"), "cod");
  assert.equal(paymentChoice("Confirm my order with online payment"), "prepaid");
  assert.equal(paymentChoice("COD se order kar do"), "cod");
  assert.equal(confirmsOrder("Place this order with COD or online payment", "ready"), false);
  for (const text of ["Can you place this order using COD?", "Don't place this order with COD", "Place this order with COD or online payment", "no COD"]) assert.equal(paymentChoice(text), "", text);
});

test("billing choices distinguish questions, negatives and unrelated same-item requests", () => {
  assert.equal(billingRelationshipIntent("Billing address is same as shipping"), "same");
  assert.equal(billingRelationshipIntent("Billing address is not the same as shipping"), "different");
  assert.equal(billingRelationshipIntent("billing address same nahi hai"), "different");
  assert.equal(billingRelationshipIntent("Is billing address same as shipping?"), "question");
  assert.equal(billingRelationshipIntent("yes", "Is your billing address the same as delivery?"), "same");
  assert.equal(billingRelationshipIntent("no", "Is your billing address the same as delivery?"), "different");
  assert.equal(billingRelationshipIntent("Show me the same shirt", "Is your billing address the same as delivery?"), "");
});
