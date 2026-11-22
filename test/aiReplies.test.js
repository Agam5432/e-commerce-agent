import test from "node:test";
import assert from "node:assert/strict";
import { runAgent, __setLLMClientsForTest } from "../src/agent/agent.js";
import { extractClaims, verifyReplyFacts } from "../src/agent/factGuard.js";
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

// ---------------------------------------------------------------- fact guard (pure)

test("fact guard reads amounts in $, ₹ and Indian/Western grouping, and order IDs", () => {
  const c = extractClaims("Total ₹1,01,898.90, shipping $15 and 2 items. Order #1042 is placed.");
  assert.deepEqual(c.amounts.map((a) => a.cents), [10189890, 1500]);
  assert.deepEqual(c.orderIds, ["#1042"]);
});

test("fact guard accepts amounts present in verified data and rejects invented ones", () => {
  const sources = [{ total: 101898.9, shipping: 0 }, "Order **#1042** confirmed"];
  assert.equal(verifyReplyFacts("Your total is ₹1,01,898.90 for order #1042.", sources).ok, true);
  const bad = verifyReplyFacts("Your total is ₹1,00,000.00 for order #1042.", sources);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknownAmounts, ["₹1,00,000.00"]);
  assert.equal(verifyReplyFacts("Order #9999 placed.", sources).ok, false);
});

test("fact guard requires the placed order's ID to be in the reply", () => {
  const r = verifyReplyFacts("Your order is placed!", ["#1042"], { requiredOrderId: "#1042" });
  assert.equal(r.ok, false);
  assert.equal(r.missingOrderId, "#1042");
});

test("cart snapshots in minor units count as verified amounts", () => {
  assert.equal(verifyReplyFacts("That is $7.99.", [{ items: [{ price: 799 }] }]).ok, true);
});

// ---------------------------------------------------------------- full agent with a fake AI model

function fakeGemini(script) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (req) => {
        calls.push(req);
        const step = script[calls.length - 1] || script[script.length - 1];
        return { candidates: [{ content: { role: "model", parts: step(req) } }] };
      },
    },
  };
}

async function withAgentHarness(fn) {
  const original = { create: ecommerce.createSession, summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  let stored = { step: "ready", selectedPaymentMethod: "cod", billingSameAsShipping: true,
    shipping: { name: "Test Buyer", email: "buyer@example.com", address1: "10 Main Road", city: "Delhi", country: "India", countryCode: "IN", zip: "110001", phone: "+919876543210" } };
  const submitted = [];
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => structuredClone(stored) });
    // no connected store in unit tests: credential lookups fail fast instead of waiting on MongoDB
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD" });
    ecommerce.createSession = (shop, context) => original.create(shop, context, {
      loadCheckout: async () => structuredClone(stored),
      saveCheckout: async (shop, client, patch) => { stored = { ...stored, ...patch }; },
      prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
      shippingRates: async () => [{ handle: "std", title: "Standard", price: 0, currency: "USD" }],
      quoteOrder: async () => { throw new Error("Shopify quote unavailable in tests"); },
      submitOrder: async (shop, options) => {
        submitted.push(options);
        return { shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/42", orderName: "#1042", total: 7.99, currency: "USD", discountAmount: 0 };
      },
    });
    const options = { clientId: `ai-${crypto.randomUUID()}`, cart: { currency: "USD", items: [{ variant_id: "123", title: "Test T-Shirt", price: 799, quantity: 1 }] } };
    await fn({ options, submitted });
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.createSession = original.create;
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find;
    StoreIntegration.findOne = original.integration;
    globalThis.fetch = original.fetch;
  }
}

const placeOrderCall = (customerConfirmed) => () => [{ functionCall: { name: "place_order", args: { paymentMethod: "cod", customerConfirmed } } }];

test("the AI writes the order confirmation itself when every fact matches Shopify", async () => {
  await withAgentHarness(async ({ options, submitted }) => {
    const aiText = "Ho gaya dost! Order #1042 place ho gaya, total $7.99, Cash on Delivery.";
    const gemini = fakeGemini([placeOrderCall(true), () => [{ text: aiText }]]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("haan kar do order", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(submitted.length, 1);
    assert.equal(result.answer, aiText);
    // the model was given the verified facts to convey
    const finalReq = gemini.calls[1];
    assert.match(JSON.stringify(finalReq.contents), /verified_reply_facts/);
  });
});

test("an AI reply with an invented total falls back to the verified wording", async () => {
  await withAgentHarness(async ({ options }) => {
    const gemini = fakeGemini([placeOrderCall(true), () => [{ text: "Done! Order #1042, total $9.99." }]]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("place it", "test.myshopify.com", [], "ecommerce", options);
    assert.doesNotMatch(result.answer, /9\.99/);
    assert.match(result.answer, /#1042/);
  });
});

test("the model decides confirmation: customerConfirmed=false never places an order", async () => {
  await withAgentHarness(async ({ options, submitted }) => {
    const gemini = fakeGemini([placeOrderCall(false), () => [{ text: "Cash on Delivery chuna hai. Total $7.99. Order place kar doon?" }]]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("cod theek rahega kya?", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(submitted.length, 0);
    assert.match(result.answer, /place kar doon/);
  });
});
