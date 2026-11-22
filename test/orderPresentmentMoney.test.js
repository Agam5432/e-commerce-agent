// Real TechStore (2026-11-17): order #1029 was paid in rupees (Rs 43,159.68) but order status showed "$457.87" (the store currency).
import test from "node:test";
import assert from "node:assert/strict";
import { projectOrder, resolveFields } from "../src/services/shopifyOrderLookupService.js";

const set = (shop, shopCur, pres, presCur) => ({ shopMoney: { amount: shop, currencyCode: shopCur }, presentmentMoney: { amount: pres, currencyCode: presCur } });
const order = { name: "#1029", displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", totalPriceSet: set("457.87", "USD", "43159.68", "INR"), subtotalPriceSet: set("323.36", "USD", "30480.0", "INR") };

test("an order placed in the shopper's currency is shown in that currency", () => {
  const t = projectOrder(order, resolveFields(["total"])).details.total;
  assert.equal(t.currency, "INR");
  assert.equal(t.amount, 43159.68);
  assert.match(t.display, /₹/);
});

test("an order with only store money still shows the store currency", () => {
  const t = projectOrder({ ...order, totalPriceSet: { shopMoney: { amount: "15.0", currencyCode: "USD" } } }, resolveFields(["total"])).details.total;
  assert.equal(t.currency, "USD");
});

import { isPaidOrder } from "../src/services/shopifyOrderLookupService.js";
test("an order that is paid or partly refunded still holds money, so cancelling it must refund; pending and refunded ones do not", () => {
  for (const s of ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"]) assert.equal(isPaidOrder({ displayFinancialStatus: s }), true, s);
  for (const s of ["PENDING", "REFUNDED", "VOIDED", "AUTHORIZED"]) assert.equal(isPaidOrder({ displayFinancialStatus: s }), false, s);
});
