import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { prepareConversation } from "../src/services/conversationProfile.js";
import { normalizeOrderItems } from "../src/services/shopifyOrderService.js";

const cart = { total_price: 169800, currency: "USD", items: [
  { variant_id: "123", title: "Men's Beige Linen Shirt", variant_title: "L / Beige", quantity: 1, line_price: 109900 },
  { variant_id: "124", title: "Men's Navy Blue Polo T-Shirt", variant_title: "L / Navy", quantity: 1, line_price: 59900 },
] };
const originalAddress = { name: "Test Buyer", email: "buyer@example.com", phone: "9876543210", address1: "10 Old Road", city: "Delhi", province: "Delhi", country: "India", zip: "110001" };
function harness({ failure = null } = {}) {
  const clientId = crypto.randomUUID();
  let stored = { shipping: originalAddress, billingSameAsShipping: true, profile: { gender: "men", shoppingGender: "men" } };
  let submissions = [];
  const load = async () => structuredClone(stored);
  const save = async (shop, client, patch) => { stored = { ...stored, ...structuredClone(patch) }; return structuredClone(stored); };
  const customer = { id: "gid://shopify/Customer/1", name: "Test Buyer", email: "buyer@example.com", defaultAddress: originalAddress };
  return {
    get stored() { return structuredClone(stored); }, submissions,
    async session(message, history = [], browserCheckout = null) {
      const checkout = await prepareConversation("test.myshopify.com", clientId, message, history, browserCheckout, { load, save });
      return ecommerce.createSession("test.myshopify.com", { clientId, userMessage: message, history, replyLanguage: "en", cart, checkout, customer, customerLoggedIn: true, profile: checkout.profile }, {
        loadCheckout: load, saveCheckout: save, prepaidOffer: async () => ({ hasDiscount: false }),
        // Shopify is offline in unit tests: the quote fails fast instead of waiting for a timeout.
        quoteOrder: async () => { throw new Error("Shopify quote unavailable in tests"); },
        shippingRates: async () => [{ handle: "std", title: "Standard", price: 0, currency: "USD" }, { handle: "exp", title: "Express", price: 12.5, currency: "USD" }],
        sendConfirmation: async () => ({ ok: true }),
        submitOrder: async (shop, options) => { submissions.push(options); if (failure) throw failure; normalizeOrderItems(options.items); return { status: "ok", shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/1", orderName: "#1001", total: 1698, currency: "USD", shippingCost: 0, tax: 0, discountAmount: 0 }; },
      });
    },
  };
}

test("log reproduction: updated address survives checkout restart and compact cart produces a real order payload", async () => {
  const h = harness();
  const message = "My name is Test Buyer and phone number is 9876543210. My street address is 20 New Road, Delhi, Delhi 110001 India";
  const update = await h.session(message);
  await update.handlers.set_shipping_address({ name: "Test Buyer", phone: "9876543210", address1: "20 New Road", address2: "New Road", city: "Delhi", province: "Delhi", zip: "110001", country: "India" });
  assert.equal(h.stored.shipping.address1, "20 New Road");
  assert.equal(h.stored.shipping.address2, "");
  const billing = await h.session("Shipping address is same as billing address");
  assert.equal(await billing.routeKnownIntent(), true);
  assert.match(billing.result().fallbackSpeech, /1,?698\.00/);
  assert.doesNotMatch(billing.result().fallbackSpeech, /Total: \*\*\$0\.00/);
  const restart = await h.session("proceed to checkout", [], { shipping: originalAddress });
  await restart.handlers.begin_checkout();
  assert.equal(h.stored.shipping.address1, "20 New Road");
  const query = await h.session("What is my shipping address?");
  await query.routeKnownIntent();
  assert.match(query.result().fallbackSpeech, /20 New Road/);
  assert.doesNotMatch(query.result().fallbackSpeech, /10 Old Road/);
  const preview = await h.session("Show my order preview");
  assert.equal(await preview.routeKnownIntent(), true);
  // The single order preview is a card (items live there); the chat line only states the payable total.
  const card = preview.result().actions.find(action => action.type === "checkout_ready");
  assert.deepEqual(card.items.map(item => item.title), ["Men's Beige Linen Shirt", "Men's Navy Blue Polo T-Shirt"]);
  assert.match(preview.result().fallbackSpeech, /1,?698\.00/);
  const confirm = await h.session("COD");
  await confirm.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].shipping.address1, "20 New Road");
  assert.deepEqual(h.submissions[0].items.map(item => item.price), [109900, 59900]);
});
test("incomplete spoken phone blocks ordering instead of saving an invented phone", async () => {
  const h = harness();
  const update = await h.session("My phone number is 912345678 and my street address is 20 New Road Delhi");
  const result = await update.handlers.set_shipping_address({ phone: "9123456780", address1: "20 New Road", city: "Delhi" });
  assert.equal(result.status, "incomplete_address");
  assert.equal(h.stored.shipping.phone, "912345678");
  const confirm = await h.session("COD");
  await confirm.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(h.submissions.length, 0);
});


test("spoken COD preference routes directly and survives a failed checkout without repeating payment questions", async () => {
  const h = harness({ failure: Object.assign(new Error("Checkout: tags.2: Title Tag exceeds the maximum length of 40 characters"), { code: "CHECKOUT_REJECTED" }) });
  const first = await h.session("Yeah, I'll prefer cash on delivery.");
  assert.equal(await first.routeKnownIntent(), true);
  assert.equal(h.submissions[0].paymentMethod, "cod");
  assert.equal(h.stored.selectedPaymentMethod, "cod");
  assert.doesNotMatch(first.result().fallbackSpeech, /tags\.2|Title Tag|40 characters/);
  assert.match(first.result().fallbackSpeech, /cart is safe/i);
  assert.deepEqual(first.result().actions, []);
  const next = await h.session("Yes, please place this order.");
  assert.equal(await next.routeKnownIntent(), true);
  assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1].paymentMethod, "cod");
});

test("order instruction without a payment choice asks once instead of accepting the model's invented COD", async () => {
  const h = harness();
  const session = await h.session("Please place this order");
  const result = await session.handlers.place_order({ paymentMethod: "cod" });
  assert.equal(result.status, "payment_method_required");
  assert.equal(h.submissions.length, 0);
});

test("checkout start and express fee questions use real checkout state without invented delivery dates", async () => {
  const h = harness();
  const start = await h.session("Yeah, I was just trying to check out.");
  assert.equal(await start.routeKnownIntent(), true);
  assert.ok(start.result().actions.some(action => action.type === "checkout_ready"));
  const fee = await h.session("Why is express shipping so expensive?");
  assert.equal(await fee.routeKnownIntent(), true);
  // fees are the store's own Shopify rates, never a hardcoded number
  assert.match(fee.result().fallbackSpeech, /Standard: FREE/);
  assert.match(fee.result().fallbackSpeech, /Express: \$12\.50/);
  assert.doesNotMatch(fee.result().fallbackSpeech, /2.?3|7.?10|business days/);
});

test("address provenance stays honest and a request to finish speaking gets a brief listening reply", async () => {
  const h = harness();
  const unknown = await h.session("Where did you find this address?");
  await unknown.routeKnownIntent();
  assert.match(unknown.result().fallbackSpeech, /can't verify/);
  const updated = await h.session("My street address is 20 New Road Delhi");
  await updated.handlers.set_shipping_address({ address1: "20 New Road", city: "Delhi" });
  const known = await h.session("Where did you get this address?");
  await known.routeKnownIntent();
  assert.match(known.result().fallbackSpeech, /shared this address during checkout/);
  const listening = await h.session("Angry, let me speak");
  assert.equal(await listening.routeKnownIntent(), true);
  assert.equal(listening.result().products.length, 0);
  assert.ok(listening.result().fallbackSpeech.length < 80);
});


test("a different billing address blocks submission until the shopper finishes the requested update", async () => {
  const h = harness();
  const change = await h.session("My billing address is not the same as shipping");
  assert.equal(await change.routeKnownIntent(), true);
  assert.equal(h.stored.billingSameAsShipping, false);
  assert.equal(h.stored.billingNeedsUpdate, true);
  const preview = await h.session("Show my order preview");
  await preview.routeKnownIntent();
  assert.equal(preview.result().actions.find(action => action.type === "checkout_ready").ready, false);
  assert.match(preview.result().fallbackSpeech, /billing address/i);
  assert.equal(h.stored.step, "billing_inquiry");
  const premature = await h.session("Place this order using COD");
  await premature.routeKnownIntent();
  assert.equal(h.submissions.length, 0);
  assert.match(premature.result().fallbackSpeech, /billing address/);
  const update = await h.session("My billing address is 20 Billing Road, Delhi, Delhi 110001 India");
  await update.handlers.set_billing_address({ address1: "20 Billing Road", city: "Delhi", province: "Delhi", zip: "110001", country: "India" });
  assert.equal(h.stored.billingNeedsUpdate, false);
  const order = await h.session("Yes, please place this order using COD");
  await order.routeKnownIntent();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].paymentMethod, "cod");
  assert.equal(h.submissions[0].billing.address1, "20 Billing Road");
  assert.equal(h.submissions[0].shipping.address1, "10 Old Road");
});

test("a billing question is read-only even if the model tries the same-address tool", async () => {
  const h = harness();
  const change = await h.session("I need a different billing address");
  await change.routeKnownIntent();
  const question = await h.session("Is my billing address same as shipping?");
  await question.handlers.set_billing_same_as_shipping();
  assert.equal(h.stored.billingSameAsShipping, false);
  assert.equal(h.stored.billingNeedsUpdate, true);
  assert.deepEqual(question.result().actions, []);
  assert.match(question.result().fallbackSpeech, /separate billing address/);
});

test("an address correction with actual details reaches the address tool instead of being discarded", async () => {
  const h = harness();
  const correction = await h.session("Change my delivery address to 20 New Road Delhi 110001 India");
  assert.equal(await correction.routeKnownIntent(), false);
  await correction.handlers.set_shipping_address({ address1: "20 New Road", city: "Delhi", zip: "110001", country: "India" });
  assert.equal(h.stored.shipping.address1, "20 New Road");
  const how = await h.session("How can I change my address?");
  assert.equal(await how.routeKnownIntent(), false);
});
