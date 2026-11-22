import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";

// The store's own Shopify shipping rates for this cart/address (injected instead of a live Shopify call).
const RATES = [
  { handle: "shopify-Standard-0.00", title: "Standard", price: 0, currency: "USD" },
  { handle: "shopify-Express-15.00", title: "Express", price: 15, currency: "USD" },
];
const EXPRESS = RATES[1];
function setup(submit, overrides = {}, mail = async () => ({ ok: true })) {
  let emails = 0;
  const session = ecommerce.createSession("test.myshopify.com", {
    clientId: `client-${crypto.randomUUID()}`, userMessage: "confirm COD", replyLanguage: "en",
    cart: { currency: "USD", total_price: 799, items: [{ variant_id: "123", price: 799, quantity: 1, title: "Test T-Shirt" }] },
    checkout: { shipping: { name: "Test Buyer", address1: "10 Main", city: "Delhi", zip: "110001", country: "India", email: "buyer@example.com", phone: "+919876543210" }, billingSameAsShipping: true },
    ...overrides,
  }, {
    submitOrder: submit, loadCheckout: async () => null, saveCheckout: async () => null,
    sendConfirmation: async () => { emails++; return mail(); },
    prepaidOffer: async () => ({ hasDiscount: false }),
    shippingRates: async () => RATES,
    quoteOrder: async () => { throw new Error("Shopify quote unavailable in tests"); },
  });
  return { session, emails: () => emails };
}
const success = { status: "ok", shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/42", orderName: "#1042", total: 7.99, shippingCost: 0, discountAmount: 0, tax: 0, currency: "USD" };

test("Shopify failure sends no email, emits no success and preserves cart", async () => {
  const { session, emails } = setup(async () => { throw new Error("Shopify denied checkout"); });
  const result = await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(result.status, "error");
  assert.equal(emails(), 0);
  assert.deepEqual(session.result().actions, []);
  assert.doesNotMatch(session.result().fallbackSpeech, /#TS-/);
});
test("a false success result cannot produce a confirmation email or clear cart", async () => {
  const { session, emails } = setup(async () => ({ status: "ok", shopifyOrderCreated: false }));
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(emails(), 0);
  assert.deepEqual(session.result().actions, []);
});
test("confirmed Shopify order is emailed and only then emits order_placed and clear_cart", async () => {
  const { session, emails } = setup(async () => success);
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(emails(), 1);
  assert.deepEqual(session.result().actions.map(a => a.type), ["order_placed", "clear_cart"]);
  assert.match(session.result().fallbackSpeech, /#1042/);
});
test("an email failure does not undo a successfully created Shopify order", async () => {
  const { session } = setup(async () => success, {}, async () => { throw new Error("SMTP unavailable"); });
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(session.result().actions[0].shopifyOrderId, success.shopifyOrderId);
  assert.equal(session.result().actions[0].emailSent, false);
  assert.doesNotMatch(session.result().fallbackSpeech, /email was sent/);
});
test("prepaid returns payment action without order success, email or cart clear", async () => {
  const { session, emails } = setup(async (shop, options) => {
    assert.equal(options.paymentMethod, "prepaid");
    return { status: "payment_required", checkoutUrl: "https://test.myshopify.com/invoice/abc", total: 7.99, currency: "USD" };
  }, { userMessage: "I prefer online payment" });
  await session.handlers.place_order({ paymentMethod: "prepaid" });
  assert.equal(emails(), 0);
  assert.deepEqual(session.result().actions.map(a => a.type), ["checkout_redirect"]);
});
test("replayed order never sends another confirmation email", async () => {
  const { session, emails } = setup(async () => ({ ...success, replayed: true }));
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(emails(), 0);
});
test("resetting shipping/discounts after success cannot submit the same cart twice", async () => {
  let submissions = 0;
  const { session, emails } = setup(async () => { submissions++; return success; }, {
    checkout: { shippingMethod: "Express", shippingRate: EXPRESS, appliedDiscount: { code: "SALE10", percent: 10 }, shipping: { name: "Test Buyer", address1: "10 Main", city: "Delhi", zip: "110001", country: "India", email: "buyer@example.com", phone: "+919876543210" } },
  });
  await session.handlers.place_order({ paymentMethod: "cod" });
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(submissions, 1);
  assert.equal(emails(), 1);
  assert.equal(session.result().actions.at(-2).shippingMethod, "Express");
});
test("an informational COD question cannot submit an order even if the model asks to", async () => {
  let submitted = false;
  const { session } = setup(async () => { submitted = true; return success; }, { userMessage: "what is COD" });
  assert.equal((await session.handlers.place_order({ paymentMethod: "cod" })).status, "confirmation_required");
  assert.equal(submitted, false);
});
test("an acknowledgment of the revised Shopify quote survives the chitchat fallback", async () => {
  let submitted = false;
  const { session } = setup(async () => { submitted = true; return success; }, {
    userMessage: "okay",
    history: [{ role: "assistant", content: "Shopify calculated **$7.99**. Confirm this updated total to place your COD order." }],
    checkout: { step: "review", orderQuote: { status: "review_required", quoteKey: "quote-1" }, shipping: { name: "Test Buyer", address1: "10 Main", city: "Delhi", zip: "110001", country: "India", email: "buyer@example.com", phone: "+919876543210" } },
  });
  assert.equal(await session.autoRecoverProducts(), true);
  assert.equal(submitted, true);
});
test("a later product conversation cannot accidentally confirm an old checkout quote", async () => {
  let submitted = false;
  const { session } = setup(async () => { submitted = true; return success; }, {
    userMessage: "okay",
    history: [{ role: "assistant", content: "Would you like to see more T-shirts?" }],
    checkout: { step: "review", orderQuote: { status: "review_required", quoteKey: "quote-1" } },
  });
  await session.autoRecoverProducts();
  assert.equal(submitted, false);
});
test("a new shopper never inherits another shopper's delivery address or checkout state", async () => {
  const first = setup(async () => success);
  await first.session.handlers.place_order({ paymentMethod: "cod" });
  const second = setup(async () => success, { checkout: null });
  const checkout = second.session.result().checkout;
  assert.equal(checkout.shipping, null);
  assert.equal(checkout.customer, null);
  assert.equal(checkout.shopifyOrderId, undefined);
});


test("prepaid offer coupon resolves through the configured provider without a shadowed-function crash", async () => {
  const session = ecommerce.createSession("test.myshopify.com", {
    clientId: `coupon-${crypto.randomUUID()}`, userMessage: "Apply the prepaid offer", replyLanguage: "en",
    cart: { currency: "USD", items: [{ variant_id: "123", title: "Test T-Shirt", price: 1000, quantity: 1 }] },
  }, {
    loadCheckout: async () => null, saveCheckout: async () => null,
    loadDiscounts: async () => [],
    prepaidOffer: async () => ({ hasDiscount: true, discountPercent: 10, discountAmount: 1, code: "ONLINE10", title: "Online offer", prepaidTotal: 9 }),
  });
  const result = await session.handlers.apply_discount_or_offer({ offerTitle: "prepaid" });
  assert.equal(result.status, "ok");
  assert.match(session.result().fallbackSpeech, /ONLINE10/);
  assert.match(session.result().fallbackSpeech, /9\.00/);
});


test("billing address questions read the separate billing address rather than the delivery address", async () => {
  const { session } = setup(async () => success, {
    userMessage: "What is my billing address?",
    checkout: { shipping: { name: "Test Buyer", address1: "10 Delivery Road", city: "Delhi" }, billingSameAsShipping: false, billing: { name: "Test Buyer", address1: "20 Billing Road", city: "Mumbai" } },
  });
  assert.equal(await session.routeKnownIntent(), true);
  assert.match(session.result().fallbackSpeech, /20 Billing Road/);
  assert.doesNotMatch(session.result().fallbackSpeech, /10 Delivery Road/);
});

test("an emotional gift complaint gets a thoughtful follow-up without an automatic sales pitch", async () => {
  const { session } = setup(async () => success, {
    userMessage: "She is angry with me and you suggest a maxi dress",
    profile: { recipient: "gift", shoppingGender: "women" },
  });
  assert.equal(await session.routeKnownIntent(), true);
  assert.deepEqual(session.result().products, []);
  assert.match(session.result().fallbackSpeech, /personal.*enjoy|personal.*use often/i);
  assert.doesNotMatch(session.result().fallbackSpeech, /sure to|smile|fix|cart/i);
});


test("a fresh database billing choice overrides a stale browser checkout snapshot", async () => {
  const shipping = { name: "Test Buyer", address1: "10 Delivery Road", city: "Delhi" };
  const billing = { name: "Test Buyer", address1: "20 Billing Road", city: "Mumbai" };
  const session = ecommerce.createSession("test.myshopify.com", {
    clientId: `fresh-billing-${crypto.randomUUID()}`, userMessage: "What is my billing address?", replyLanguage: "en",
    checkout: { shipping, billingSameAsShipping: true },
  }, { loadCheckout: async () => ({ shipping, billing, billingSameAsShipping: false }), saveCheckout: async () => null });
  await session.routeKnownIntent();
  assert.match(session.result().fallbackSpeech, /20 Billing Road/);
  assert.doesNotMatch(session.result().fallbackSpeech, /10 Delivery Road/);
});

test("the shopper's selected Shopify shipping rate is kept at order confirmation", async () => {
  let rate;
  const { session } = setup(async (shop, options) => { rate = options.shippingRate; return success; }, {
    checkout: { shippingMethod: "Express", shippingRate: EXPRESS, shipping: { name: "Test Buyer", address1: "10 Main", city: "Delhi", zip: "110001", country: "India", email: "buyer@example.com", phone: "+919876543210" } },
  });
  // the model passes "standard" although the shopper never asked to switch
  await session.handlers.place_order({ paymentMethod: "cod", shippingMethod: "standard" });
  assert.equal(rate.handle, EXPRESS.handle);
  assert.equal(rate.price, 15);
});

test("with no rate chosen yet, the cheapest Shopify rate is used, never a hardcoded fee", async () => {
  let rate;
  const { session } = setup(async (shop, options) => { rate = options.shippingRate; return success; });
  await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(rate.handle, RATES[0].handle);
});

test("switching shipping only accepts a rate the store really offers", async () => {
  const { session } = setup(async () => success);
  const bad = await session.handlers.set_shipping_method({ shippingRate: "Same day rocket" });
  assert.equal(bad.status, "not_found");
  assert.deepEqual(bad.available, ["Standard", "Express"]);
  const ok = await session.handlers.set_shipping_method({ shippingRate: "express" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.shippingCost, 15);
});
