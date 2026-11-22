import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { buildBreakdown, breakdownRows, prepaidDiscountInput } from "../src/services/shopifyOrderService.js";
import { paymentChoice, billingRelationshipIntent, wantsOrderPreview } from "../src/services/checkoutIntent.js";

// The fridge checkout from the shopper's chat: $35,999 item, Shopify returns $13,044.66 tax and $49,584.32 total.
const cart = { currency: "USD", total_price: 3599900, original_total_price: 3599900, items: [
  { variant_id: "901", title: "Double Door Refrigerator 450L", variant_title: "Grey", quantity: 1, price: 3599900, original_price: 3599900, line_price: 3599900 },
] };
const address = { name: "Agam tyagi", email: "agamtyagi2001@gmail.com", phone: "+918218185432", address1: "733/12 friends colony", city: "muzaffarnagar", province: "Uttar Pradesh", country: "India", countryCode: "IN", zip: "251001" };
const shopifyQuote = (extra = {}) => buildBreakdown({
  subtotal: 35999, shippingCost: 0, tax: 13044.66, total: 49584.32, currency: "USD",
  taxLines: [{ title: "TAX", ratePercent: 18, amount: 6479.82 }], ...extra,
});

function harness({ billing = false, quote = shopifyQuote(), offer = { hasDiscount: false }, submit } = {}) {
  let stored = { shipping: address, ...(billing ? { billingSameAsShipping: true, billingConfirmed: true } : {}) };
  const quotes = [];
  const submissions = [];
  const load = async () => structuredClone(stored);
  const save = async (shop, client, patch) => { stored = { ...stored, ...structuredClone(patch) }; return structuredClone(stored); };
  return {
    get stored() { return structuredClone(stored); }, quotes, submissions,
    session(userMessage, history = []) {
      return ecommerce.createSession("test.myshopify.com", { clientId: "chat-regression", userMessage, history, replyLanguage: "en", cart, checkout: structuredClone(stored) }, {
        loadCheckout: load, saveCheckout: save, prepaidOffer: async () => offer, sendConfirmation: async () => ({ ok: true }),
        quoteOrder: async (shop, options) => { quotes.push(options); return typeof quote === "function" ? quote(options) : quote; },
        submitOrder: submit || (async (shop, options) => { submissions.push(options); return { status: "payment_required", shopifyOrderCreated: false, checkoutUrl: "https://shop/pay/1", total: 25000, tax: 0, discountAmount: 10799.7, currency: "USD" }; }),
      });
    },
  };
}
const askedBilling = [{ role: "assistant", content: "I've saved your delivery address. Is your billing address the same, or would you like to use a different one?" }];

test("'yes it is same' / 'yes' answer the billing question instead of asking it again", async () => {
  assert.equal(billingRelationshipIntent("yes it is same", askedBilling[0].content), "same");
  assert.equal(billingRelationshipIntent("yes", "Would you like to use your delivery address for billing too?"), "same");
  assert.equal(billingRelationshipIntent("yes shipping address is same as billing addressh", ""), "same");
  assert.equal(billingRelationshipIntent("no", "Would you like to use your delivery address for billing too?"), "different");
  assert.equal(billingRelationshipIntent("yes", askedBilling[0].content), ""); // "same, or different?" + bare yes is ambiguous
  const h = harness();
  const s = h.session("yes it is same", askedBilling);
  assert.equal(await s.routeCheckoutIntent(), true);
  assert.equal(h.stored.billingSameAsShipping, true);
  assert.ok(s.result().actions.some(a => a.type === "checkout_ready"));
  assert.doesNotMatch(s.result().fallbackSpeech, /use your delivery address for billing too/);
});

test("the billing tool does not second-guess the model with a regex when the shopper clearly agreed", async () => {
  const h = harness();
  const s = h.session("haan wahi hai", [{ role: "assistant", content: "Anything else?" }]);
  await s.handlers.set_billing_same_as_shipping();
  assert.equal(h.stored.billingSameAsShipping, true);
});

test("payment choices like 'go with prepaid' are understood; questions and discount talk are not choices", () => {
  for (const t of ["go with prepaid", "prepaid online payment", "I'll go with COD", "take cod", "prepaid"]) assert.ok(paymentChoice(t), t);
  for (const t of ["is there any prepaid discount", "i have applied 30% prepaid discount coupon", "apply this on my itme", "cod or prepaid?"]) assert.equal(paymentChoice(t), "", t);
});

test("totals: every figure comes from one Shopify quote and the rows add up, including tax Shopify did not itemize", () => {
  const q = shopifyQuote();
  assert.equal(q.subtotal, 35999);
  assert.equal(q.unitemizedTax, 6564.84);
  assert.equal(q.otherCharges, 540.66);
  assert.equal(q.taxLooksUnusual, true);
  const t = breakdownRows(q);
  assert.equal(t.total, 49584.32);
  assert.equal(t.sum, 49584.32);
  assert.equal(t.reconciles, true);
  // a subtotal reported before an order-level discount is normalised, never shown as a negative charge
  const d = buildBreakdown({ subtotal: 100, shippingCost: 0, tax: 0, total: 70, currency: "USD" });
  assert.equal(d.subtotal, 70); assert.equal(d.discountAmount, 30); assert.equal(d.otherCharges, 0);
});

test("'what tax is this' / 'the total should be…' is answered from rows, not from the model's own maths", async () => {
  const h = harness({ billing: true });
  const s = h.session("but the total should be $49,043.66");
  const out = await s.handlers.get_tax_details();
  assert.equal(out.status, "ok");
  assert.equal(out.rowsAddUpToTotal, true);
  assert.equal(out.payableTotal, 49584.32);
  assert.equal(out.itemsSubtotalAfterDiscounts, 35999);
  assert.equal(out.otherChargesInTotal, 540.66);
  assert.equal(out.taxNotItemizedByShopify, 6564.84);
  assert.equal(out.taxLooksHigherThanListedRate, true);
  assert.match(out.arithmetic, /\$35,999\.00.*= \$49,584\.32$/);
  assert.ok(!out.rows.some(r => /shipping/i.test(r.label) && r.amount !== 0)); // no invented shipping charge
});

test("order review card and chat text carry the same Shopify numbers and flag the odd tax", async () => {
  const h = harness({ billing: true });
  const s = h.session("show my order");
  await s.handlers.mark_checkout_ready({ force: true });
  const card = s.result().actions.find(a => a.type === "checkout_ready");
  assert.equal(card.total, 49584.32);
  assert.equal(card.tax, 13044.66);
  assert.equal(card.originalTotal, 35999);
  assert.equal(card.unitemizedTax, 6564.84);
  assert.equal(card.otherCharges, 540.66);
  assert.match(s.result().fallbackSpeech, /49,584\.32/);
  assert.match(s.result().fallbackSpeech, /not itemize/);
});

test("'yeah please' to the assistant's offer to show the order shows the card again; unrelated chat does not", async () => {
  const offer = [{ role: "assistant", content: "Let me bring up your order review right now so you can check all the exact numbers." }];
  assert.equal(wantsOrderPreview("yeah please", offer[0].content), true);
  assert.equal(wantsOrderPreview("yeah please", "Anything else?"), false);
  const h = harness({ billing: true });
  await h.session("ok").handlers.mark_checkout_ready(); // preview shown once
  const again = h.session("yeah please", offer);
  assert.equal(await again.routeCheckoutIntent(), true);
  assert.ok(again.result().actions.some(a => a.type === "checkout_ready"));
  const quiet = h.session("what is the warranty?");
  await quiet.handlers.mark_checkout_ready();
  assert.ok(!quiet.result().actions.some(a => a.type === "checkout_ready"), "no second preview unless asked");
});

test("prepaid: the discount is part of the Shopify quote and of the draft sent for the payment link", async () => {
  const offer = { hasDiscount: true, discountPercent: 30, discountAmount: 10799.7, prepaidTotal: 25199.3, title: "Prepaid 30%", code: null, source: "env_config" };
  assert.deepEqual(prepaidDiscountInput(offer), { title: "Prepaid 30%", valueType: "PERCENTAGE", value: 30 });
  const h = harness({ billing: true, offer, quote: (o) => o.paymentMethod === "prepaid" ? shopifyQuote({ subtotal: 25199.3, tax: 4535.87, total: 29735.17, taxLines: [{ title: "TAX", ratePercent: 18, amount: 4535.87 }] }) : shopifyQuote() });
  const ask = h.session("is there any prepaid discount");
  await ask.handlers.check_prepaid_discount({ apply: false });
  assert.match(ask.result().fallbackSpeech, /29,735\.17/);
  assert.match(ask.result().fallbackSpeech, /49,584\.32/);
  const apply = h.session("apply this on my item");
  await apply.handlers.check_prepaid_discount({ apply: true });
  assert.equal(h.stored.selectedPaymentMethod, "prepaid");
  assert.equal(apply.result().actions.find(a => a.type === "checkout_ready").total, 29735.17);
  const go = h.session("go with prepaid", [{ role: "assistant", content: "Shall I create the payment link?" }]);
  assert.equal(await go.routeCheckoutIntent(), true);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].paymentMethod, "prepaid");
  assert.equal(h.submissions[0].prepaidOffer.discountPercent, 30);
  assert.match(go.result().fallbackSpeech, /prepaid discount/i);
  assert.match(go.result().fallbackSpeech, /https:\/\/shop\/pay\/1/);
});

test("a payment method that is selected but not yet confirmed is stated back with the total, not a generic loop", async () => {
  const offer = { hasDiscount: true, discountPercent: 30, discountAmount: 10799.7, prepaidTotal: 25199.3, title: "Prepaid 30%", code: null };
  const h = harness({ billing: true, offer });
  await h.session("x").handlers.check_prepaid_discount({ apply: true }); // prepaid selected
  const s = h.session("hmm ok", [{ role: "assistant", content: "Shall I create the payment link?" }]);
  const out = await s.handlers.place_order({ paymentMethod: "prepaid" });
  assert.equal(out.status, "confirmation_required");
  assert.equal(out.selectedPaymentMethod, "prepaid");
  assert.match(s.result().fallbackSpeech, /Online Payment/);
  assert.match(s.result().fallbackSpeech, /payment link/);
  assert.equal(h.submissions.length, 0, "nothing is created until the shopper confirms");
});
