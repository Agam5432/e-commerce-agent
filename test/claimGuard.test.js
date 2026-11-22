// M3-M5, M9 and the "meaningless message" rule: pure checks (the agent-level runs are in claimGuardAgent.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { claimsEscalationNow, falseAgreement, isMeaninglessMessage, unsupportedPaymentAndStoreFacts, unsupportedPerformanceClaims, variantPrices } from "../src/agent/claimGuard.js";
import { discountEligibility } from "../src/tools/shopify/offers.js";

const xiaomi = [{ name: "search_products", result: { products: [{ title: "Xiaomi Redmi Note 13", description: "Large bright display and 108MP main camera.", variants: [{ title: "Ocean Teal / 128GB", price: "229.00" }, { title: "Ocean Teal / 256GB", price: "269.00" }] }] } }];

test("M3: agreeing that the 128GB costs $269 is false agreement; the real price is handed to the rewrite", () => {
  const r = falseAgreement({ userMessage: "no, the 128GB costs $269 right?", text: "You are absolutely right, my previous message had the prices mixed up. The 128GB is $269.", toolLog: xiaomi });
  assert.ok(r, "flagged");
  assert.match(r.truth, /128GB 229/);
});
test("M3: agreeing with a CORRECT claim is fine", () => {
  assert.equal(falseAgreement({ userMessage: "the 128GB costs $229 right?", text: "You're right, the 128GB is $229.", toolLog: xiaomi }), null);
});
test("M3: 'I told you earlier I wanted an iPhone' when they never did", () => {
  const history = [{ role: "user", content: "show me samsung phones" }, { role: "assistant", content: "Here are some." }];
  const r = falseAgreement({ userMessage: "I told you earlier I wanted an iPhone", history, text: "You're absolutely right, I apologize for the confusion. Here is the iPhone.", toolLog: [] });
  assert.ok(r);
  assert.match(r.truth, /iphone/i);
  assert.equal(falseAgreement({ userMessage: "I told you earlier I wanted an iPhone", history: [{ role: "user", content: "i want an iphone" }], text: "You're right, here is the iPhone.", toolLog: [] }), null);
});
test("M3: a reply that does not agree is never flagged", () => {
  assert.equal(falseAgreement({ userMessage: "the 128GB costs $269", text: "The 128GB is $229; the 256GB is $269.", toolLog: xiaomi }), null);
});
test("variantPrices reads every option of a product", () => {
  assert.deepEqual(variantPrices(xiaomi).map((v) => v.price), [229, 269]);
});

test("M4: gaming/performance judgements the product data never makes are flagged; listed facts are not", () => {
  const bad = unsupportedPerformanceClaims("The iPhone 15 stands out for sheer performance and smooth gaming. It costs $799.", xiaomi);
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].topics.sort(), ["gam", "perform", "smooth"].sort());
  assert.equal(unsupportedPerformanceClaims("It has a 108MP main camera and a large bright display.", xiaomi).length, 0, "plain listed facts");
  assert.equal(unsupportedPerformanceClaims("The listing doesn't say how it performs for gaming.", xiaomi).length, 0, "honest 'not stated'");
  const withData = [{ name: "get_product_details", result: { product: { title: "ROG", description: "Built for gaming with a 165Hz display and fast processor." } } }];
  assert.equal(unsupportedPerformanceClaims("It is excellent for gaming.", withData).length, 0, "the data does say gaming");
  // the shopper's own words in a search term are not evidence
  assert.equal(unsupportedPerformanceClaims("It is excellent for gaming.", [{ name: "search_products", result: { searchTerm: "gaming phone", products: [{ title: "Phone", description: "A phone." }] } }]).length, 1);
});

test("M5: invented payment methods and store facts are flagged; ones in the data are not", () => {
  assert.equal(unsupportedPaymentAndStoreFacts("We accept major debit and credit cards.", []).length, 1);
  assert.equal(unsupportedPaymentAndStoreFacts("You can pay with UPI, Visa or Mastercard.", []).length, 1);
  assert.equal(unsupportedPaymentAndStoreFacts("We ship worldwide.", []).length, 1);
  assert.equal(unsupportedPaymentAndStoreFacts("Delivery takes 3-5 business days.", []).length, 1);
  const data = [{ name: "get_store_info", result: { payment: "Visa, Mastercard and UPI are accepted", shipping: "We ship worldwide" } }];
  assert.equal(unsupportedPaymentAndStoreFacts("We accept Visa and UPI.", data).length, 0);
  assert.equal(unsupportedPaymentAndStoreFacts("We ship worldwide.", data).length, 0);
  assert.equal(unsupportedPaymentAndStoreFacts("I don't have a list of accepted cards, so I can't say.", []).length, 0);
  assert.equal(unsupportedPaymentAndStoreFacts("Do you accept cards? I can check.", []).length, 0);
});

test("M9: 'I am raising a formal complaint now' is a premature claim; asking is not", () => {
  assert.equal(claimsEscalationNow("I'm so sorry. I am raising a formal complaint now.").length, 1);
  assert.equal(claimsEscalationNow("Let me escalate this to the team.").length, 0, "no complaint noun: not matched");
  assert.equal(claimsEscalationNow("Let me raise a complaint for you.").length, 1);
  assert.equal(claimsEscalationNow("Would you like me to raise a complaint by email or connect you with a person?").length, 0);
  assert.equal(claimsEscalationNow("I'm sorry about that. Which order is this about?").length, 0);
});

test("low: messages with no letters or digits mean nothing; real ones, emoji and other scripts do", () => {
  for (const m of [".", "...", "?!", "  ", "-", ""]) assert.equal(isMeaninglessMessage(m), true, JSON.stringify(m));
  for (const m of ["hi", "5", "नमस्ते", "👍", "ok"]) assert.equal(isMeaninglessMessage(m), false, m);
});

test("M6: a code is not eligible below its minimum spend, and its limited scope is stated (never 'store-wide')", () => {
  const prepaid = { code: "PREPAID50", minSubtotal: 20000, currencyCode: "USD", limitedTo: "", scopeNames: [] };
  assert.equal(discountEligibility(prepaid, { total: 480, itemCount: 2 }, "USD").eligible, false);
  assert.match(discountEligibility(prepaid, { total: 480, itemCount: 2 }, "USD").conditions[0], /at least/);
  assert.equal(discountEligibility(prepaid, { total: 25000, itemCount: 2 }, "USD").eligible, true);
  const chat20 = { code: "CHAT20", minSubtotal: 0, limitedTo: "collection", scopeNames: ["Smartphones"] };
  const e = discountEligibility(chat20, { total: 480, itemCount: 2 }, "USD");
  assert.equal(e.eligible, true);
  assert.match(e.conditions.join(" "), /only to items in the Smartphones collection, not the whole store/);
  assert.equal(discountEligibility({ minQuantity: 3 }, { total: 100, itemCount: 2 }).eligible, false);
  assert.deepEqual(discountEligibility({}, { total: 1, itemCount: 1 }), { eligible: true, conditions: [] });
});

test("M3: 'I am so sorry for the confusion, I must have missed that' is the same false agreement", () => {
  const r = falseAgreement({ userMessage: "I told you earlier I wanted an iPhone", history: [{ role: "user", content: "show me the xiaomi redmi note 13" }], text: "I am so sorry for the confusion, I must have missed that. Here is the iPhone 15.", toolLog: [] });
  assert.ok(r);
  assert.equal(falseAgreement({ userMessage: "show me phones", history: [], text: "I am so sorry, but the store has not published that.", toolLog: [] }), null, "an apology for not knowing something is not agreement");
});
