// Real widget (2026-11-17): "I will pay online" on a cart with no prepaid discount asked "which payment method?" again and again, and a later
// "yes create the payment link" made the model claim a link it never created.
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { freshClientId } from "./helpers/agentHarness.js";

test("online payment is selected when there is no prepaid discount, and the next yes creates the payment link", async () => {
  const originalFind = StoreIntegration.findOne;
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
  try {
    let stored = { step: "ready", billingSameAsShipping: true, shipping: { name: "Test Buyer", email: "buyer@example.com", address1: "10 Main Road", city: "New York", country: "United States", zip: "10001", phone: "+12125550100" } };
    const submitted = [];
    const deps = {
      loadCheckout: async () => structuredClone(stored),
      saveCheckout: async (_s, _c, patch) => { stored = { ...stored, ...patch }; },
      prepaidOffer: async () => ({ hasDiscount: false, source: "minimum_not_met", minimumSubtotal: 20000, minimumCurrency: "USD", originalTotal: 15, prepaidTotal: 15, discountAmount: 0 }),
      sendConfirmation: async () => ({ ok: true }),
      quoteOrder: async () => { throw new Error("no quote in this test"); },
      submitOrder: async (_s, options) => { submitted.push(options.paymentMethod); return { status: "payment_required", shopifyOrderCreated: false, draftOrderId: "gid://shopify/DraftOrder/1", checkoutUrl: "https://shop.example/invoices/abc", total: 15, currency: "USD", subtotal: 15, shippingCost: 0, tax: 0, discountAmount: 0 }; },
    };
    const clientId = freshClientId();
    const cart = { currency: "USD", item_count: 1, total_price: 1500, items: [{ variant_id: "123", title: "Power Bank", product_title: "Power Bank", price: 1500, original_price: 1500, line_price: 1500, quantity: 1 }] };
    const make = (userMessage) => ecommerce.createSession("loop.myshopify.com", { llmMode: true, clientId, userMessage, replyLanguage: "en", history: [], cart }, deps);
    const first = make("I will pay online");
    const r1 = await first.handlers.check_prepaid_discount({ apply: true });
    assert.equal(stored.selectedPaymentMethod, "prepaid");
    assert.equal(r1.onlinePaymentSelected, true);
    assert.match(first.result().fallbackSpeech, /Online Payment/);
    // the model calls the same tool again on "yes": it must place the (prepaid) order instead
    const second = make("yes create the payment link");
    await second.handlers.check_prepaid_discount({ apply: true });
    assert.deepEqual(submitted, ["prepaid"]);
  } finally { StoreIntegration.findOne = originalFind; }
});

test("asking to switch to a named shipping rate through get_shipping_options makes the switch", async () => {
  const originalFind = StoreIntegration.findOne;
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
  try {
    const rates = [{ handle: "std", title: "Standard", price: 0, currency: "USD" }, { handle: "exp", title: "Express", price: 20, currency: "USD" }];
    let stored = { step: "ready", billingSameAsShipping: true, shippingRates: rates, shippingRatesKey: "k", shippingRate: rates[0], shipping: { name: "T B", email: "b@example.com", address1: "10 Main Road", city: "New York", country: "United States", zip: "10001", phone: "+12125550100" } };
    const deps = { loadCheckout: async () => structuredClone(stored), saveCheckout: async (_s, _c, patch) => { stored = { ...stored, ...patch }; }, prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }), quoteOrder: async () => { throw new Error("no quote"); } };
    const cart = { currency: "USD", item_count: 1, total_price: 1500, items: [{ variant_id: "123", title: "Power Bank", product_title: "Power Bank", price: 1500, original_price: 1500, line_price: 1500, quantity: 1 }] };
    const session = ecommerce.createSession("ship.myshopify.com", { llmMode: true, clientId: freshClientId(), userMessage: "switch to Express shipping", replyLanguage: "en", history: [], cart }, deps);
    // the rates are cached in the saved checkout, so no Shopify call is needed
    await session.handlers.get_shipping_options();
    assert.equal(stored.shippingRate?.title, "Express");
  } finally { StoreIntegration.findOne = originalFind; }
});
