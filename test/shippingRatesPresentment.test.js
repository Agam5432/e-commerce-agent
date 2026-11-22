// Real TechStore (2026-11-17): Shopify lists the Express rate as USD 20 (store currency) but charges an INR cart ₹2,000. The agent labelled the
// bare "20" with the cart's currency (₹20). The rate is now priced by Shopify itself in the cart's currency; nothing is converted here.
import test from "node:test";
import assert from "node:assert/strict";
import { createShippingRatesService } from "../src/services/shopifyOrderService.js";

const items = [{ variant_id: 1, quantity: 1, price: 4670000, original_price: 4670000, line_price: 4670000 }];
const shipping = { firstName: "T", lastName: "S", address1: "1 Test St", city: "Mumbai", provinceCode: "MH", zip: "400001", countryCode: "IN" };
const LISTED = [{ handle: "std", title: "Standard", price: { amount: "0.0", currencyCode: "USD" } }, { handle: "exp", title: "Express", price: { amount: "20.0", currencyCode: "USD" } }];
const PRESENTMENT = { std: "0.0", exp: "2000.0" };

function graphqlFor({ failExpress = false } = {}) {
  const calls = [];
  return { calls, fn: async (shop, q, { input }) => {
    calls.push(input);
    const handle = input.shippingLine?.shippingRateHandle;
    if (!handle) return { draftOrderCalculate: { calculatedDraftOrder: { availableShippingRates: LISTED }, userErrors: [] } };
    if (failExpress && handle === "exp") return { draftOrderCalculate: { calculatedDraftOrder: null, userErrors: [{ message: "no" }] } };
    return { draftOrderCalculate: { calculatedDraftOrder: { totalShippingPriceSet: { presentmentMoney: { amount: PRESENTMENT[handle], currencyCode: "INR" } } }, userErrors: [] } };
  } };
}

test("an INR cart gets each rate priced by Shopify in INR (₹2,000), with the store-currency figure kept alongside", async () => {
  const g = graphqlFor();
  const rates = await createShippingRatesService({ graphql: g.fn })("s.myshopify.com", { items, shipping, currency: "INR", countryCode: "IN", shopCurrency: "USD" });
  assert.deepEqual(rates.map((r) => [r.title, r.price, r.currency, r.shopPrice, r.shopCurrency]), [["Standard", 0, "INR", 0, "USD"], ["Express", 2000, "INR", 20, "USD"]]);
  assert.equal(g.calls[0].presentmentCurrencyCode, "INR");
  assert.equal(g.calls[2].shippingLine.shippingRateHandle, "exp");
});

test("a cart in the store's own currency keeps the listed rates with no extra calls", async () => {
  const g = graphqlFor();
  const rates = await createShippingRatesService({ graphql: g.fn })("s.myshopify.com", { items, shipping, currency: "USD", countryCode: "US", shopCurrency: "USD" });
  assert.deepEqual(rates.map((r) => [r.title, r.price, r.currency]), [["Standard", 0, "USD"], ["Express", 20, "USD"]]);
  assert.equal(g.calls.length, 1);
});

test("a rate Shopify will not price in the cart's currency is left out, never shown in the wrong currency", async () => {
  const g = graphqlFor({ failExpress: true });
  const rates = await createShippingRatesService({ graphql: g.fn })("s.myshopify.com", { items, shipping, currency: "INR", countryCode: "IN", shopCurrency: "USD" });
  assert.deepEqual(rates.map((r) => r.title), ["Standard"]);
});
