import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { withLanguageNote } from "../src/agent/agent.js";
import { shippingLineInput, mapShippingRates, createShippingRatesService, createOrderQuoteService } from "../src/services/shopifyOrderService.js";
import { getProductWarrantyAndPolicy, getPrepaidDiscountOffer, keywordsNamedByShopper } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

// Fake Shopify Admin GraphQL: answer by operation name.
function shopify(handlers) {
  globalThis.fetch = async (url, options) => {
    const { query } = JSON.parse(options.body);
    for (const [name, data] of Object.entries(handlers)) {
      if (query.includes(name)) return { ok: true, status: 200, json: async () => ({ data: typeof data === "function" ? data() : data }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [], pageInfo: { hasNextPage: false } } } }) };
  };
}

const address = { name: "Test Buyer", email: "buyer@example.com", phone: "+919876543210", address1: "10 Main Road", city: "Delhi", province: "Delhi", country: "India", countryCode: "IN", zip: "110001" };
const cart = { currency: "USD", total_price: 799, items: [{ variant_id: "123", title: "Test T-Shirt", price: 799, original_price: 799, quantity: 1 }] };

function session(userMessage, { llmMode = true, checkout = {}, deps = {} } = {}) {
  let stored = { shipping: address, billingSameAsShipping: true, billingConfirmed: true, ...checkout };
  const submitted = [];
  const s = ecommerce.createSession("test.myshopify.com", { llmMode, clientId: `prod-${crypto.randomUUID()}`, userMessage, replyLanguage: "en", cart, checkout: structuredClone(stored) }, {
    loadCheckout: async () => structuredClone(stored),
    saveCheckout: async (shop, client, patch) => { stored = { ...stored, ...structuredClone(patch) }; },
    prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
    shippingRates: async () => [{ handle: "std", title: "Standard", price: 0, currency: "USD" }],
    quoteOrder: async () => { throw new Error("offline"); },
    submitOrder: async (shop, options) => { submitted.push(options); return { status: "ok", shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/9", orderName: "#1009", total: 7.99, currency: "USD", discountAmount: 0, tax: 0, shippingCost: 0 }; },
    ...deps,
  });
  return { s, submitted, stored: () => stored };
}

// ---------------------------------------------------------------- AI decides intent

test("AI mode: the order is placed only when the model says the customer confirmed", async () => {
  const no = session("cod theek hai na?");
  const r1 = await no.s.handlers.place_order({ paymentMethod: "cod", customerConfirmed: false });
  assert.equal(r1.status, "confirmation_required");
  assert.equal(no.submitted.length, 0);

  const yes = session("haan bhai kar do");
  await yes.s.handlers.place_order({ paymentMethod: "cod", customerConfirmed: true });
  assert.equal(yes.submitted.length, 1);
  assert.equal(yes.submitted[0].paymentMethod, "cod");
});

test("AI mode: a keyword in the message cannot place an order the model did not confirm", async () => {
  // "place the order" would satisfy the old regex; the model judged it as not confirmed.
  const t = session("should I place the order now or later?");
  await t.s.handlers.place_order({ paymentMethod: "cod", customerConfirmed: false });
  assert.equal(t.submitted.length, 0);
});

test("AI mode: the payment method comes from the model's argument, not from words in the message", async () => {
  const t = session("haan, jo bola wahi kar do");
  await t.s.handlers.place_order({ paymentMethod: "prepaid", customerConfirmed: true });
  assert.equal(t.submitted[0].paymentMethod, "prepaid");
});

test("AI mode: the billing tool trusts the model even for an unusual 'yes'", async () => {
  const t = session("bilkul wahi wala", { checkout: { billingSameAsShipping: null, billingConfirmed: false } });
  await t.s.handlers.set_billing_same_as_shipping();
  assert.equal(t.stored().billingSameAsShipping, true);
});

test("place_order schema requires the model's confirmation judgement", () => {
  const def = ecommerce.toolDefinitions.find((t) => t.function.name === "place_order");
  assert.ok(def.function.parameters.required.includes("customerConfirmed"));
  assert.equal(def.function.parameters.properties.customerConfirmed.type, "boolean");
});

// ---------------------------------------------------------------- language: the AI mirrors

test("language: the model mirrors the customer unless they explicitly chose a language", () => {
  assert.match(withLanguageNote("hello", "hinglish", false), /language of THIS message/);
  assert.match(withLanguageNote("hello", "hi", true), /chose to talk in Hindi/);
  const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "hinglish", profile: {} });
  assert.match(prompt, /language and script of the customer's LATEST message/);
  assert.doesNotMatch(prompt, /Reply ONLY in Hinglish/);
});

// ---------------------------------------------------------------- shipping from Shopify

test("shipping line uses the store's Shopify rate handle; no rate means no invented fee", () => {
  assert.equal(shippingLineInput(null), null);
  assert.deepEqual(shippingLineInput({ handle: "shopify-Express-15.00", title: "Express", price: 15, currency: "usd" }), {
    shippingRateHandle: "shopify-Express-15.00", title: "Express", priceWithCurrency: { amount: "15.00", currencyCode: "USD" },
  });
  assert.deepEqual(mapShippingRates([
    { handle: "b", title: "Express", price: { amount: "15.0", currencyCode: "USD" } },
    { handle: "a", title: "Standard", price: { amount: "0.0", currencyCode: "USD" } },
    { handle: "", title: "broken", price: { amount: "1" } },
  ]).map((r) => r.title), ["Standard", "Express"]);
});

test("shipping rates are read from Shopify's draftOrderCalculate for the real cart and address", async () => {
  let input;
  const list = createShippingRatesService({ graphql: async (shop, q, vars) => { input = vars.input; return { draftOrderCalculate: { calculatedDraftOrder: { availableShippingRates: [{ handle: "h1", title: "Delhivery Surface", price: { amount: "49.00", currencyCode: "INR" } }] }, userErrors: [] } }; } });
  const rates = await list("test.myshopify.com", { items: cart.items, shipping: address });
  assert.deepEqual(rates, [{ handle: "h1", title: "Delhivery Surface", price: 49, currency: "INR" }]);
  assert.equal(input.shippingLine, undefined);
  assert.equal(input.lineItems[0].variantId, "gid://shopify/ProductVariant/123");
});

test("the quote sends the chosen rate to Shopify and no hardcoded express fee exists", async () => {
  let input;
  const quote = createOrderQuoteService({ graphql: async (shop, q, vars) => { input = vars.input; return { draftOrderCalculate: { calculatedDraftOrder: {
    currencyCode: "USD", taxesIncluded: false,
    subtotalPriceSet: { shopMoney: { amount: "7.99" } }, totalShippingPriceSet: { shopMoney: { amount: "12.50" } },
    totalTaxSet: { shopMoney: { amount: "0" } }, totalPriceSet: { shopMoney: { amount: "20.49", currencyCode: "USD" } }, taxLines: [],
    availableShippingRates: [],
  }, userErrors: [] } }; } });
  const q = await quote("test.myshopify.com", { items: cart.items, shipping: address, shippingRate: { handle: "exp", title: "Express", price: 12.5, currency: "USD" } });
  assert.equal(input.shippingLine.shippingRateHandle, "exp");
  assert.equal(q.shippingCost, 12.5);
  assert.equal(q.total, 20.49);
  const noRate = await quote("test.myshopify.com", { items: cart.items, shipping: address, shippingMethod: "express" });
  assert.equal(input.shippingLine, undefined);
  assert.ok(noRate);
});

test("checkout pre-selects the cheapest Shopify rate and the review uses it", async () => {
  const t = session("checkout", { deps: { shippingRates: async () => [
    { handle: "exp", title: "Express", price: 15, currency: "USD" },
    { handle: "std", title: "Standard", price: 4.99, currency: "USD" },
  ].sort((a, b) => a.price - b.price) } });
  await t.s.handlers.mark_checkout_ready();
  assert.equal(t.stored().shippingRate.handle, "std");
  const card = t.s.result().actions.find((a) => a.type === "checkout_ready");
  assert.equal(card.shippingCost, 4.99);
  // the review card carries the store's real rates so the widget can offer them (no hardcoded buttons)
  assert.deepEqual(card.shippingRates.map((r) => r.title), ["Standard", "Express"]);
  assert.equal(card.shippingMethod, "Standard");
});

// ---------------------------------------------------------------- policies from Shopify

test("warranty/returns come only from the store's published Shopify policies", async () => {
  shopify({
    StorePolicies: { shop: { shopPolicies: [{ type: "REFUND_POLICY", title: "Refund policy", url: "https://s.example/policies/refund-policy", body: "<p>Returns accepted within <b>14 days</b> of delivery.</p>" }] } },
  });
  const r = await getProductWarrantyAndPolicy("policy-a.myshopify.com", "");
  assert.equal(r.status, "ok");
  assert.match(r.policies[0].text, /14 days/);
  assert.doesNotMatch(JSON.stringify(r), /1 Year|Doorstep|7 Days/i);
});

test("a topic returns only the matching policy and names what else exists", async () => {
  shopify({
    StorePolicies: { shop: { shopPolicies: [
      { type: "REFUND_POLICY", title: "Refund policy", url: null, body: "<p>14 days.</p>" },
      { type: "SHIPPING_POLICY", title: "Shipping policy", url: null, body: "<p>Ships in 2-4 business days.</p>" },
    ] } },
  });
  const r = await getProductWarrantyAndPolicy("policy-c.myshopify.com", "", "shipping");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.policies.map((p) => p.type), ["SHIPPING_POLICY"]);
  assert.deepEqual(r.otherPoliciesAvailable, ["Refund policy"]);
  const none = await getProductWarrantyAndPolicy("policy-c.myshopify.com", "", "privacy");
  assert.equal(none.status, "not_published");
  assert.match(none.instruction_for_ai, /Never invent/);
});

test("with no published policy the agent is told to say so, never to invent one", async () => {
  shopify({ StorePolicies: { shop: { shopPolicies: [] } } });
  const r = await getProductWarrantyAndPolicy("policy-b.myshopify.com", "");
  assert.equal(r.status, "not_published");
  assert.match(r.instruction_for_ai, /Never invent/);
});

// ---------------------------------------------------------------- prepaid discount detection

test("an ordinary automatic discount is not mistaken for a prepaid-only discount", async () => {
  shopify({
    ActiveDiscounts: { discountNodes: { edges: [{ node: { id: "1", discount: { __typename: "DiscountAutomaticBasic", title: "Diwali Sale 10%", status: "ACTIVE", summary: "10% off", customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 } } } } }] } },
  });
  const offer = await getPrepaidDiscountOffer("prepaid-a.myshopify.com", 1000);
  assert.equal(offer.hasDiscount, false);
});

test("a discount the merchant named 'prepaid' is detected", async () => {
  shopify({
    ActiveDiscounts: { discountNodes: { edges: [{ node: { id: "2", discount: { __typename: "DiscountCodeBasic", title: "Prepaid 5% off", status: "ACTIVE", summary: "", codes: { nodes: [{ code: "PREPAID5" }] }, customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.05 } } } } }] } },
  });
  const offer = await getPrepaidDiscountOffer("prepaid-b.myshopify.com", 1000);
  assert.equal(offer.hasDiscount, true);
});

// ---------------------------------------------------------------- recommendation focus

test("recommendations keep only the items the shopper named (negated items excluded)", () => {
  assert.deepEqual(keywordsNamedByShopper(["kurti", "watch", "sunglasses"], "wife ke liye cotton kurti dikhao"), ["kurti"]);
  assert.deepEqual(keywordsNamedByShopper(["dress", "kurti"], "maxi dress nahi chahiye, kurti dikhao"), ["kurti"]);
  assert.deepEqual(keywordsNamedByShopper(["backpack", "power bank"], "useful things for my trip"), []);
});
