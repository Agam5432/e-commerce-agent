import test from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "mingo";
import { moneyExpr, moneyOfProps, pickPrimary } from "../../src/admin/money.js";
import ecommerce from "../../src/industries/ecommerce.js";

const rev = ecommerce.analytics.revenue;
const run = (events) => new Aggregator([{ $group: { _id: { currency: moneyExpr(rev).currency }, amount: { $sum: moneyExpr(rev).amount }, n: { $sum: 1 } } }]).run(events.map((props) => ({ props })));
const by = (rows) => Object.fromEntries(rows.map((r) => [r._id.currency, r.amount]));

test("an order in the store's currency is read as that amount with that currency", () => {
  assert.deepEqual(moneyOfProps(rev, { shopTotal: 1709.6, shopCurrency: "USD", total: 162790, currency: "INR" }), { amount: 1709.6, currency: "USD" });
  assert.deepEqual(by(run([{ shopTotal: 1709.6, shopCurrency: "USD", total: 162790, currency: "INR" }])), { USD: 1709.6 });
});

test("an order not yet confirmed by Shopify keeps what the shopper saw, with the shopper's own currency", () => {
  assert.deepEqual(moneyOfProps(rev, { total: 162790, currency: "INR", shopCurrency: "USD" }), { amount: 162790, currency: "INR" });
  assert.deepEqual(by(run([{ total: 162790, currency: "INR", shopCurrency: "USD" }])), { INR: 162790 });
});

test("a blank currency or a missing number never pairs one order's amount with another's currency", () => {
  assert.deepEqual(moneyOfProps(rev, { shopTotal: 500, shopCurrency: "", total: 400, currency: "INR" }), { amount: 400, currency: "INR" });
  assert.deepEqual(moneyOfProps(rev, { shopCurrency: "USD", total: 400, currency: "INR" }), { amount: 400, currency: "INR" });
  assert.deepEqual(moneyOfProps(rev, {}), { amount: 0, currency: "" });
  assert.deepEqual(by(run([{ shopTotal: 500, shopCurrency: "", total: 400, currency: "INR" }, { shopCurrency: "USD", total: 100, currency: "INR" }, {}])), { INR: 500, "": 0 });
});

test("zero is a real amount, not a missing one", () => {
  assert.deepEqual(moneyOfProps(rev, { shopTotal: 0, shopCurrency: "USD", total: 400, currency: "INR" }), { amount: 0, currency: "USD" });
});

test("the headline currency is the store's when it has sales, otherwise the one with the most", () => {
  assert.equal(pickPrimary({ USD: 10, INR: 5000 }, "USD"), "USD");
  assert.equal(pickPrimary({ INR: 5000, EUR: 20 }, "USD"), "INR");
  assert.equal(pickPrimary({ USD: 0, INR: 0 }, "USD"), "USD");
  assert.equal(pickPrimary({}, ""), "");
  assert.equal(pickPrimary({ "": 0 }, ""), "");
});

test("what Shopify refunded comes off the order, in the same currency only, never below zero", () => {
  const events = [
    { shopTotal: 60, shopCurrency: "USD", total: 5000, currency: "INR", refundedTotal: 20 },   // partly refunded: 40
    { shopTotal: 40, shopCurrency: "USD", total: 3300, currency: "INR", refundedTotal: 40 },   // fully refunded: 0
    { shopTotal: 10, shopCurrency: "USD", refundedTotal: 25 },                                 // more than the total: still 0
    { total: 500, currency: "INR", shopCurrency: "USD", refundedTotal: 20 },                   // refund in dollars, amount in rupees: untouched
    { shopTotal: 15, shopCurrency: "USD" },                                                    // no refund
  ];
  assert.deepEqual(events.map((p) => moneyOfProps(rev, p)), [
    { amount: 40, currency: "USD" }, { amount: 0, currency: "USD" }, { amount: 0, currency: "USD" }, { amount: 500, currency: "INR" }, { amount: 15, currency: "USD" },
  ]);
  // the database expression agrees with the in-memory rule
  assert.deepEqual(by(run(events)), { USD: 55, INR: 500 });
});
