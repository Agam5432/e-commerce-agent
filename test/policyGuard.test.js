// H1 (invented store policy / support hours) and the claim side of H3 (discount figures mixed across options).
// Sentences below are the ones the real assistant produced on TechStore on 2026-11-16, plus honest ones that must NOT be flagged.
import test from "node:test";
import assert from "node:assert/strict";
import { storePolicyClaims, unsupportedStoreClaims, policyNotPublishedReply, salePairs, discountClaimProblems, saleFactsLine } from "../src/agent/policyGuard.js";

const noPolicy = [{ name: "get_warranty_and_policy", result: { status: "not_published", policies: [], productDescription: null } }];
const privacyOnly = [{ name: "get_warranty_and_policy", result: { status: "ok", topic: null, policies: [{ type: "PRIVACY_POLICY", title: "Privacy policy", text: "We collect your name and email to process orders." }] } }];
const returns7 = [{ name: "get_warranty_and_policy", result: { status: "ok", topic: "returns", policies: [{ type: "REFUND_POLICY", title: "Refund policy", text: "You can return unused items within 7 days of delivery for a full refund. Damaged items are replaced." }] } }];

test("H1: the invented damaged-item policy from the real chat is recognised as a policy claim", () => {
  const draft = "According to our policy, if you receive a damaged item, please contact our support team with your order details and a photo of the damage so we can assist you with a return or replacement.";
  const claims = storePolicyClaims(draft);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "policy");
});

test("H1: other invented commitments are recognised (periods, 'our return policy', free replacement, Hinglish)", () => {
  for (const s of [
    "We offer a 30-day return on every phone.",
    "You can return it within 7 days for a full refund.",
    "Our return policy allows exchanges on unopened items.",
    "Damaged phones get a free replacement.",
    "Hamari policy ke anusar 7 din mein return ho jata hai.",
    "If you receive a defective item, we will arrange a replacement.",
  ]) assert.ok(storePolicyClaims(s).length > 0, s);
});

test("H1: honest 'not published' answers, offers and questions are never flagged", () => {
  for (const s of [
    "The store has not published a return policy yet.",
    "The store hasn't published a warranty for this phone.",
    "I can't confirm a return window because it isn't listed.",
    "Would you like me to share the store's return policy link?",
    "I can share the store's contact details if you like.",
    "If you receive a damaged item, tell me and I will pass it to the team.",
    "Is there a return policy you would like me to look up?",
    "This store hasn't published that policy in Shopify.",
  ]) assert.deepEqual(storePolicyClaims(s), [], s);
});

test("H1: a policy claim is UNSUPPORTED when the tool said not_published, never ran, or only a different policy came back", () => {
  const draft = "According to our policy, if you receive a damaged item, contact support for a return or replacement.";
  assert.equal(unsupportedStoreClaims(draft, noPolicy).length, 1, "tool said not published");
  assert.equal(unsupportedStoreClaims(draft, []).length, 1, "tool never ran");
  assert.equal(unsupportedStoreClaims(draft, privacyOnly).length, 1, "only the privacy policy exists: it says nothing about damaged items");
});

test("H1: a policy claim backed by the published policy passes, but only with the real period", () => {
  assert.deepEqual(unsupportedStoreClaims("You can return unused items within 7 days of delivery for a full refund.", returns7), []);
  assert.equal(unsupportedStoreClaims("You can return unused items within 30 days of delivery for a full refund.", returns7).length, 1, "30 days is not in the policy");
  assert.deepEqual(unsupportedStoreClaims("Damaged items are replaced.", returns7), []);
});

test("H1: support hours stated as fact need the data to say them", () => {
  const hours = "Our support team is available from 9:00 AM to 6:00 PM, Monday through Friday.";
  assert.equal(storePolicyClaims(hours)[0].kind, "hours");
  assert.equal(unsupportedStoreClaims(hours, []).length, 1);
  assert.equal(unsupportedStoreClaims(hours, [{ name: "get_store_info", result: { supportHours: "Mon-Fri 9:00 AM to 6:00 PM" } }]).length, 0);
  assert.equal(unsupportedStoreClaims(hours, [{ name: "get_store_info", result: { supportHours: "Mon-Fri 10:00 AM to 4:00 PM" } }]).length, 1);
});

test("H1: the replacement line the shopper hears says plainly that it is not published", () => {
  assert.match(policyNotPublishedReply("en"), /hasn't published/);
  assert.match(policyNotPublishedReply("hi"), /प्रकाशित नहीं/);
});

// ---------------------------------------------------------------- H3: discount figures belong to ONE option
// TechStore's Xiaomi Redmi Note 13, from Shopify: 128GB $229 (was $269), 256GB $269 (was $309).
const xiaomi = [{
  name: "get_discounts_and_offers",
  result: { product: { title: "Xiaomi Redmi Note 13", options: [
    { name: "Midnight Black / 128GB", price: "229.00", compareAtPrice: "269.00" },
    { name: "Midnight Black / 256GB", price: "269.00", compareAtPrice: "309.00" },
  ] }, offers: [{ type: "coupon", description: "20% off one-time purchase products in Automated Collection" }] },
}];

test("H3: the pairs come from each option's own compare-at and price", () => {
  const pairs = salePairs(xiaomi);
  assert.deepEqual(pairs.map((p) => [p.was, p.now, p.amount, p.percent]), [[269, 229, 40, 15], [309, 269, 40, 13]]);
});

test("H3: the real wrong answer (26% off, $309 to $229, save $80) is caught; each real option's own figures pass", () => {
  const wrong = "The Xiaomi Redmi Note 13 is currently on a 26% direct sale, which brings the price down from $309.00 to $229.00, saving you $80.00.";
  const problems = discountClaimProblems(wrong, xiaomi);
  assert.equal(problems.length, 3, JSON.stringify(problems));
  assert.deepEqual(discountClaimProblems("The 128GB is $229.00, down from $269.00: 15% off, saving you $40.00.", xiaomi), []);
  assert.deepEqual(discountClaimProblems("The 256GB goes from $309.00 to $269.00, which is 13% off.", xiaomi), []);
});

test("H3: a store coupon percentage in the data is not mistaken for a product discount error; no data means no judgement", () => {
  assert.deepEqual(discountClaimProblems("You can also use CHAT20 for 20% off.", xiaomi), []);
  assert.deepEqual(discountClaimProblems("It is 26% off.", []), [], "nothing to compare with");
});

test("H3: the verified one-line fallback lists every option with its own numbers", () => {
  assert.match(saleFactsLine(salePairs(xiaomi)), /Midnight Black \/ 128GB: \$269\.00 → \$229\.00 \(15% off, saves \$40\.00\)/);
});
