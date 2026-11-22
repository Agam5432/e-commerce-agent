// A cart that arrives in another currency (a Shopify Markets visitor) is priced again in the store's own currency.
import test from "node:test";
import assert from "node:assert/strict";
import { cartInStoreCurrency, clearCartPricingCache } from "../src/services/cartPricing.js";
import { normalizeCartSnapshot } from "../src/services/cartSnapshot.js";

const graphqlFor = (prices, currency = "USD") => async () => ({
  shop: { currencyCode: currency },
  nodes: Object.entries(prices).map(([id, price]) => ({ id: `gid://shopify/ProductVariant/${id}`, price })),
});

const inr = () => normalizeCartSnapshot({
  currency: "INR",
  items: [{ variant_id: 11, quantity: 2, price: 150000, title: "Power bank" }, { variant_id: "22", quantity: 1, price: 99900, title: "Cable" }],
});

test("a cart in another currency is priced from the store's own prices", async () => {
  clearCartPricingCache();
  const cart = await cartInStoreCurrency("shop-a.myshopify.com", inr(), { graphql: graphqlFor({ 11: "15.00", 22: "9.99" }) });
  assert.equal(cart.currency, "USD");
  assert.equal(cart.repricedFrom, "INR");
  assert.deepEqual(cart.items.map((i) => i.price), [1500, 999]);
  assert.equal(cart.items[0].line_price, 3000);
  assert.equal(cart.total_price, 3999);
  assert.equal(cart.items[0].title, "Power bank");
});

test("a cart already in the store's currency is left as it is, and so is one that cannot be priced", async () => {
  clearCartPricingCache();
  const usd = normalizeCartSnapshot({ currency: "USD", items: [{ variant_id: 11, quantity: 1, price: 1500 }] });
  assert.equal(await cartInStoreCurrency("shop-b.myshopify.com", usd, { graphql: graphqlFor({ 11: "15.00" }) }), usd);
  clearCartPricingCache();
  const missing = inr();
  assert.equal(await cartInStoreCurrency("shop-c.myshopify.com", missing, { graphql: graphqlFor({ 11: "15.00" }) }), missing);
  clearCartPricingCache();
  const failing = inr();
  assert.equal(await cartInStoreCurrency("shop-d.myshopify.com", failing, { graphql: async () => { throw new Error("down"); } }), failing);
  assert.equal(await cartInStoreCurrency("shop-e.myshopify.com", null), null);
});

test("BUG-03: a price the browser sent that differs from Shopify's is replaced, even in the store's own currency", async () => {
  clearCartPricingCache();
  const edited = normalizeCartSnapshot({ currency: "USD", items: [{ variant_id: 11, quantity: 2, price: 100, title: "Power bank" }, { variant_id: 22, quantity: 1, price: 999, title: "Cable" }] });
  const cart = await cartInStoreCurrency("shop-f.myshopify.com", edited, { graphql: graphqlFor({ 11: "15.00", 22: "9.99" }) });
  assert.equal(cart.priceCorrected, true);
  assert.equal(cart.currency, "USD");
  assert.deepEqual(cart.items.map((i) => i.price), [1500, 999], "the edited line is Shopify's price, the matching line is unchanged");
  assert.equal(cart.items[0].line_price, 3000);
  assert.equal(cart.total_price, 3999);
  assert.equal(cart.repricedFrom, undefined, "same currency: nothing was converted");
  // a variant Shopify does not return is left as sent (no guess), and a matching cart is returned untouched
  clearCartPricingCache();
  const unknown = normalizeCartSnapshot({ currency: "USD", items: [{ variant_id: 99, quantity: 1, price: 100 }] });
  assert.equal(await cartInStoreCurrency("shop-g.myshopify.com", unknown, { graphql: graphqlFor({ 11: "15.00" }) }), unknown);
});
