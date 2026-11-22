// "Not available" is only said when the store's data agrees; compare requests are recognised; cards follow the reply.
import test from "node:test";
import assert from "node:assert/strict";
import { claimsUnavailable } from "../src/agent/factGuard.js";
import { contradictedAvailability, storeMatchesForTurn } from "../src/agent/availabilityGuard.js";
import { cardsForAnswer, productsMentionedInAnswer } from "../src/agent/cardSelection.js";
import { comparedNames, isComparisonRequest } from "../src/services/compareIntent.js";
import { hasTypeList, storeTypesForNeed } from "../src/industries/ecommerce/needMatch.js";

test("replies that say the item is not available are recognised (English, Hinglish, Hindi)", () => {
  for (const text of [
    "Sorry, we do not carry any bags in our store right now.",
    "We don't have portable power banks.",
    "That is not available at the moment.",
    "Currently unavailable.",
    "Abhi hamare paas bag nahi hai.",
    "Ye item available nahi hai.",
    "यह उपलब्ध नहीं है।",
    "It is sold out.",
  ]) assert.equal(claimsUnavailable(text), true, text);
});

test("replies that offer products are not 'not available' claims", () => {
  for (const text of [
    "Yes, we have three bags: the Dell Essential Briefcase and two school bags.",
    "Here are the power banks I found. Which capacity do you want?",
    "Aapko kaunsa colour chahiye? Mere paas teen options hain.",
    "I can add it to your cart if you like.",
  ]) assert.equal(claimsUnavailable(text), false, text);
});

const bags = [{ title: "Dell Essential Briefcase 15", inStock: true }, { title: "Wildcraft School Bag", inStock: true }];
const searchLog = (result) => [{ name: "search_products", result }];

test("a false 'no' is caught when the search returned in-stock matches the reply does not name", () => {
  const log = searchLog({ status: "ok", mode: "single", products: bags });
  assert.deepEqual(contradictedAvailability({ text: "We do not have bags.", toolLog: log }), bags.map((b) => b.title));
});

test("no contradiction when the reply names a product, says nothing negative, or the search found nothing", () => {
  const log = searchLog({ status: "ok", mode: "single", products: bags });
  assert.deepEqual(contradictedAvailability({ text: "The Dell Essential Briefcase 15 is sold out, but the Wildcraft School Bag is not available in black.", toolLog: log }), []);
  assert.deepEqual(contradictedAvailability({ text: "Here are two bags for you.", toolLog: log }), []);
  assert.deepEqual(contradictedAvailability({ text: "We do not have PlayStation.", toolLog: searchLog({ status: "no_match", products: [] }) }), []);
  assert.deepEqual(contradictedAvailability({ text: "Nothing like that is available.", toolLog: searchLog({ status: "closest_alternatives", products: bags }) }), []);
  assert.deepEqual(contradictedAvailability({ text: "We do not have bags.", toolLog: searchLog({ status: "ok", products: [{ title: "Bag", inStock: false }] }) }), []);
});

test("only a real search is evidence; weak or description-only matches are not", () => {
  assert.deepEqual(contradictedAvailability({ text: "We don't have power banks.", toolLog: [] }), []);
  assert.deepEqual(storeMatchesForTurn(searchLog({ status: "ok", products: [{ title: "Loose guess", matchConfidence: 0.3 }, { title: "Mentions it", matchKind: "description", matchConfidence: 0.5 }] })), []);
  assert.deepEqual(storeMatchesForTurn(searchLog({ status: "ok", products: [{ title: "Real", matchConfidence: 0.9, inStock: true }] })).map((p) => p.title), ["Real"]);
});

test("cards of the nearest alternatives need a mention in the reply", () => {
  const cards = [{ title: "Savannah Maxi Dress" }, { title: "Girls' Pink Pullover Hoodie" }];
  const log = searchLog({ status: "closest_alternatives", products: cards });
  assert.deepEqual(cardsForAnswer(cards, log, "We do not have baby clothes."), []);
  assert.deepEqual(cardsForAnswer(cards, log, "Nearest are the Girls' Pink Pullover Hoodie.").map((p) => p.title), ["Girls' Pink Pullover Hoodie"]);
});

test("a shortened product name in the reply still counts as a mention", () => {
  const phones = [{ title: "Samsung Galaxy A55 5G" }, { title: "Samsung Galaxy S24 Ultra" }, { title: "Apple iPhone 15 128GB Black" }];
  assert.deepEqual(productsMentionedInAnswer(phones, "The Samsung Galaxy A55 is a good value pick.", { strict: true }).map((p) => p.title), ["Samsung Galaxy A55 5G"]);
  assert.deepEqual(productsMentionedInAnswer(phones, "The iPhone 15 128GB is the premium one.", { strict: true }).map((p) => p.title), ["Apple iPhone 15 128GB Black"]);
  assert.deepEqual(productsMentionedInAnswer(phones, "Galaxy phones are popular.", { strict: true }), []);
});

test("compare requests are recognised in English, Hinglish and Hindi", () => {
  for (const text of ["compare iphone 15 and samsung a55", "iPhone 15 vs Galaxy A55", "difference between mi and anker power bank", "iphone aur samsung ki tulna karo", "इन दोनों की तुलना करो"]) {
    assert.equal(isComparisonRequest(text), true, text);
  }
  for (const text of ["show me phones", "samsung phone", "add the iphone to my cart"]) assert.equal(isComparisonRequest(text), false, text);
});

test("the names being compared come from the message or the model's terms", () => {
  assert.deepEqual(comparedNames("compare iphone 15 and samsung a55"), ["iphone 15", "samsung a55"]);
  assert.deepEqual(comparedNames("iphone 15 aur samsung a55 compare karo"), ["iphone 15", "samsung a55"]);
  assert.deepEqual(comparedNames("difference between oneplus nord and redmi note 13?"), ["oneplus nord", "redmi note 13"]);
  assert.deepEqual(comparedNames("which is better", ["A", "B"]), ["A", "B"]);
  assert.deepEqual(comparedNames("compare phones"), ["phones"]);
});

test("an empty or unreadable side-call answer is a failure; an empty list is a real answer", () => {
  assert.equal(hasTypeList(""), false);
  assert.equal(hasTypeList("sorry, I cannot"), false);
  assert.equal(hasTypeList("[]"), true);
  assert.equal(hasTypeList('Sure: ["Power Banks"]'), true);
});

test("a failed meaning match is retried and never remembered; a real 'none' is remembered", async () => {
  const TYPES = ["Power Banks", "Chargers"];
  let calls = 0;
  const flaky = async () => (++calls === 1 ? "" : '["Power Banks"]');
  assert.deepEqual(await storeTypesForNeed({ message: "reliability need one", types: TYPES, ask: flaky }), ["Power Banks"]);
  assert.equal(calls, 2);

  let down = 0;
  assert.deepEqual(await storeTypesForNeed({ message: "reliability need two", types: TYPES, ask: async () => { down++; return ""; } }), []);
  assert.equal(down, 2, "asked twice, then gave up");
  assert.deepEqual(await storeTypesForNeed({ message: "reliability need two", types: TYPES, ask: async () => '["Chargers"]' }), ["Chargers"], "the failure was not cached");

  let none = 0;
  const asker = async () => { none++; return "[]"; };
  assert.deepEqual(await storeTypesForNeed({ message: "reliability need three", types: TYPES, ask: asker }), []);
  assert.deepEqual(await storeTypesForNeed({ message: "reliability need three", types: TYPES, ask: asker }), []);
  assert.equal(none, 1, "a real 'nothing fits' is remembered");
});

test("the model is shown what each type holds, and a reply with punctuation or spacing differences still names the type", async () => {
  const TYPES = ["Home & Kitchen", "Power Banks"];
  let prompt = "";
  const reply = async (p) => { prompt = p; return '["home kitchen"]'; };
  const out = await storeTypesForNeed({ message: "examples need", types: TYPES, examples: { "Home & Kitchen": ["Stainless Steel Water Bottle 1L", "Mug"] }, ask: reply });
  assert.deepEqual(out, ["Home & Kitchen"]);
  assert.match(prompt, /Home & Kitchen \(for example: Stainless Steel Water Bottle 1L; Mug\)/);
  assert.match(prompt, /Power Banks(?! \()/);
});
