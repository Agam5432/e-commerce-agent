import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent/agent.js";
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

test("checkout confirmation works with all AI providers offline and general outages do not blame the shopper's speech", async () => {
  const original = { create: ecommerce.createSession, summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  const names = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GEMINI_API", "GROQ_API_KEY"];
  const keys = names.map(name => process.env[name]);
  let stored = { step: "ready", selectedPaymentMethod: "cod", billingSameAsShipping: true,
    shipping: { name: "Test Buyer", email: "buyer@example.com", address1: "10 Main Road", city: "Delhi", country: "India", zip: "110001", phone: "+919876543210" } };
  let submitted = 0;
  let networkCalls = 0;
  try {
    for (const name of names) delete process.env[name];
    globalThis.fetch = async () => { networkCalls++; throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => structuredClone(stored) });
    // no connected store in unit tests: credential lookups fail fast instead of waiting on MongoDB
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD" });
    ecommerce.createSession = (shop, context) => original.create(shop, context, {
      loadCheckout: async () => structuredClone(stored),
      saveCheckout: async (shop, client, patch) => { stored = { ...stored, ...patch }; },
      prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
      submitOrder: async (shop, options) => {
        submitted++;
        assert.equal(options.paymentMethod, "cod");
        return { shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/42", orderName: "#1042", total: 7.99, currency: "USD", discountAmount: 0 };
      },
    });
    const options = { clientId: `offline-${crypto.randomUUID()}`, cart: { currency: "USD", items: [{ variant_id: "123", title: "Test T-Shirt", price: 799, quantity: 1 }] } };
    const result = await runAgent("Yes, please place this order.", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(submitted, 1);
    assert.match(result.answer, /#1042/);
    assert.deepEqual(result.actions.map(action => action.type), ["order_placed", "clear_cart"]);
    const outage = await runAgent("Tell me a little more about shopping", "test.myshopify.com", [], "ecommerce", options);
    assert.match(outage.answer, /trouble connecting/);
    assert.doesNotMatch(outage.answer, /didn't catch|say.*again/);
    assert.equal(networkCalls, 0);
  } finally {
    ecommerce.createSession = original.create;
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find;
    StoreIntegration.findOne = original.integration;
    globalThis.fetch = original.fetch;
    names.forEach((name, index) => { if (keys[index] === undefined) delete process.env[name]; else process.env[name] = keys[index]; });
  }
});