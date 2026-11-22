// Whole turns on the recorded TechStore catalog (124 products) with a scripted model: the live-test problems
// (false "not available", compare without comparing, cards that do not match the reply) can not come back.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isLanguageCheck } from "./helpers/languageCheck.js";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => __resetProviderBlocksForTest());

const SHOP = "scenario.myshopify.com";
const titlesOf = (r) => (r.products || []).map((p) => p.title);

async function turn(message, gemini, extra = {}) {
  __setLLMClientsForTest({ gemini });
  return runAgent(message, SHOP, [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] }, ...extra });
}
const search = (searchTerm, more = {}) => ({ call: [{ name: "search_products", args: { searchTerm, ...more } }] });

test("'we do not have bags' while the search returned bags is rewritten with the real bags", async () => {
  const gemini = scriptedGemini([
    () => search("bag"),
    () => "Sorry, we do not carry any bags in our store right now.",
    () => "Yes, we have bags: Dell Essential Briefcase and more laptop and school bags. Want to see the school bags?",
  ]);
  const r = await turn("bag", gemini);
  assert.doesNotMatch(r.answer, /do not carry/);
  assert.equal(gemini.main.length, 3, "the reply was written again");
  assert.match(JSON.stringify(gemini.main[2].contents), /HAS matching products in stock/);
});

test("an honest 'not available' for something the store does not sell stays, with no look-alike cards", async () => {
  for (const item of ["PlayStation 5", "washing machine"]) {
    const gemini = scriptedGemini([() => search(item), () => `Sorry, ${item} is not available in our store right now. What else can I show you?`]);
    const r = await turn(item, gemini);
    assert.match(r.answer, /not available/);
    assert.equal(gemini.main.length, 2, "no rewrite for a true 'not available'");
    assert.deepEqual(titlesOf(r), []);
  }
});

test("a sold-out item is reported as sold out, not as missing, and shows no card", async () => {
  const gemini = scriptedGemini([() => search("gift card"), () => "The Gift Card is sold out right now. Anything else I can look up?"]);
  const r = await turn("gift card", gemini);
  assert.match(JSON.stringify(gemini.main[1].contents), /soldOutMatches/);
  assert.match(r.answer, /sold out/);
  assert.deepEqual(titlesOf(r), []);
});

test("'compare iphone 15 and samsung a55' is a comparison: two phone cards, no phone cases", async () => {
  const gemini = scriptedGemini([
    () => search("iphone 15 samsung a55"),
    () => "- Apple iPhone 15 is the premium pick.\n- Samsung Galaxy A55 5G costs less and has a bigger battery.\nI would go for the Galaxy A55 on a budget. Which matters more to you?",
  ]);
  const r = await turn("compare iphone 15 and samsung a55", gemini);
  const titles = titlesOf(r);
  assert.ok(titles.includes("Apple iPhone 15") && titles.includes("Samsung Galaxy A55 5G"), titles.join());
  assert.ok(!titles.some((t) => /case|cover|spigen|esr/i.test(t)), titles.join());
  assert.equal(titles.length, 2);
});

test("'samsung phone': the reply names the Samsung phone and its card is shown", async () => {
  const gemini = scriptedGemini([() => search("samsung phone"), () => "The Samsung Galaxy A55 5G is what we have. Want its details?"]);
  const r = await turn("samsung phone", gemini);
  assert.deepEqual(titlesOf(r), ["Samsung Galaxy A55 5G"]);
});

test("'cell phone chahiye': every phone the reply lists gets a card", async () => {
  const gemini = scriptedGemini([
    () => search("cell phone"),
    () => "Ye phones hain:\n- Apple iPhone 15\n- OnePlus Nord CE4\n- Xiaomi Redmi Note 13\n- Samsung Galaxy A55 5G\nKaunsa dekhna chahenge?",
  ]);
  const r = await turn("cell phone chahiye", gemini);
  assert.deepEqual([...titlesOf(r)].sort(), ["Apple iPhone 15", "OnePlus Nord CE4", "Samsung Galaxy A55 5G", "Xiaomi Redmi Note 13"]);
});

test("a later search that finds nothing does not wipe the cards of an earlier search in the same turn", async () => {
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "samsung phone" } }, { name: "search_products", args: { searchTerm: "PlayStation 5" } }] }),
    () => "We have the Samsung Galaxy A55 5G. We do not have a PlayStation 5.",
  ]);
  const r = await turn("samsung phone and a PlayStation 5", gemini);
  assert.deepEqual(titlesOf(r), ["Samsung Galaxy A55 5G"]);
});

test("'baby clothes': the nearest items are not shown as cards when the reply says there are none", async () => {
  const gemini = scriptedGemini([() => search("baby clothes"), () => "We do not have baby clothes right now. Want to look at something else?"]);
  const r = await turn("baby clothes", gemini);
  assert.deepEqual(titlesOf(r), []);
  assert.ok(!/maternity|maxi/i.test(r.answer));
});

test("'maternity dress' finds both maternity dresses", async () => {
  const gemini = scriptedGemini([() => search("maternity dress"), () => "Two maternity dresses: Twilight Plum Ribbon Dress and Savannah Maxi Dress."]);
  const r = await turn("maternity dress", gemini);
  assert.deepEqual([...titlesOf(r)].sort(), ["Savannah Maxi Dress", "Twilight Plum Ribbon Dress"]);
});

test("'dell laptop' is the Dell laptop, not other brands", async () => {
  const gemini = scriptedGemini([() => search("dell laptop"), () => "The Dell Inspiron 15 Laptop is our Dell option."]);
  const r = await turn("dell laptop", gemini);
  assert.deepEqual(titlesOf(r), ["Dell Inspiron 15 Laptop"]);
});

test("'I am thirsty' reaches the water bottle through the meaning match", async () => {
  const gemini = scriptedGemini(
    [() => search("water"), () => "A cold drink helps: the Stainless Steel Water Bottle 1L keeps it chilled."],
    { side: async () => '["Home   Kitchen"]' }
  );
  const r = await turn("I am thirsty", gemini);
  assert.deepEqual(titlesOf(r), ["Stainless Steel Water Bottle 1L"]);
});

test("'portable charger' is answered with the power banks, not the wall chargers", async () => {
  const gemini = scriptedGemini(
    [() => search("portable charger"), () => "For charging on the move: Ambrane 10000mAh Power Bank, Anker PowerCore 20000mAh Power Bank and Mi Power Bank 3i 10000mAh."],
    { side: async () => '["Power Banks"]' }
  );
  const r = await turn("portable charger", gemini);
  const titles = titlesOf(r);
  assert.equal(titles.length, 3);
  assert.ok(titles.every((t) => /power ?bank/i.test(t)), titles.join());
});

test("the meaning match is asked again when the first side call fails (no wrong 'not available')", async () => {
  let asked = 0;
  const gemini = scriptedGemini(
    [() => search("water"), () => "The Stainless Steel Water Bottle 1L is what we have for thirst."],
    { side: async (req) => (isLanguageCheck(req) ? "SAME" : ++asked === 1 ? "" : '["Home   Kitchen"]') }
  );
  const r = await turn("I am thirsty, something to drink", gemini);
  assert.equal(asked, 2);
  assert.deepEqual(titlesOf(r), ["Stainless Steel Water Bottle 1L"]);
});

test("a 'not available' said without searching is checked against a real search: phones are found, not phone cases", async () => {
  const gemini = scriptedGemini([
    () => "Sorry, cell phones are not available in our store right now.",
    () => "Ye phones hain: Apple iPhone 15, OnePlus Nord CE4, Xiaomi Redmi Note 13 aur Samsung Galaxy A55 5G.",
  ]);
  const r = await turn("cell phone chahiye", gemini);
  assert.match(r.answer, /iPhone 15/);
  assert.deepEqual([...titlesOf(r)].sort(), ["Apple iPhone 15", "OnePlus Nord CE4", "Samsung Galaxy A55 5G", "Xiaomi Redmi Note 13"]);
});

test("a true 'not available' said without searching stays (the search finds nothing either)", async () => {
  const gemini = scriptedGemini([() => "Sorry, we do not sell PlayStation consoles."]);
  const r = await turn("PS5 chahiye", gemini);
  assert.match(r.answer, /do not sell/);
  assert.deepEqual(titlesOf(r), []);
  assert.equal(gemini.main.length, 1, "no needless rewrite");
});

test("the model searching the store's own name ('power bank' for 'portable charger') is not held to the shopper's word's category", async () => {
  const gemini = scriptedGemini([() => search("power bank"), () => "Ambrane 10000mAh Power Bank, Anker PowerCore 20000mAh Power Bank and Mi Power Bank 3i 10000mAh will keep you charged on the move."]);
  const r = await turn("portable charger", gemini);
  assert.equal(titlesOf(r).length, 3);
  assert.ok(titlesOf(r).every((t) => /power ?bank/i.test(t)), titlesOf(r).join());
});

test("the live pre-check shown to the model for 'cell phone chahiye' lists phones, not phone cases", async () => {
  const gemini = scriptedGemini([() => "Ye phones hain: Apple iPhone 15 aur Samsung Galaxy A55 5G."]);
  await turn("cell phone chahiye", gemini);
  const prompt = String(gemini.main[0].config.systemInstruction);
  assert.match(prompt, /iPhone 15/);
  assert.doesNotMatch(prompt, /Phone Case/);
});

// the side model: answers the same-kind question with "no" for every product, and the meaning match with the given types
const sideSaying = (types) => async (req) => {
  const prompt = req.contents[0].parts[0].text;
  if (/SAME KIND/.test(prompt)) return JSON.stringify(prompt.split("\n").filter((l) => /^\d+\. /.test(l)).map(() => false));
  return types;
};

test("'fitness band' is not answered with running shoes: no card, and the reply is written again without them", async () => {
  const gemini = scriptedGemini(
    [() => search("fitness band"), () => "We do not have fitness bands, but the Nike Revolution 7 Running Shoes are great for workouts.", () => "Sorry, we do not have fitness bands right now. What else can I look for?"],
    { side: sideSaying('["Shoes"]') }
  );
  const r = await turn("fitness band", gemini);
  assert.doesNotMatch(r.answer, /Nike/);
  assert.deepEqual(titlesOf(r), []);
  assert.match(JSON.stringify(gemini.main.at(-1).contents), /NOT the same kind/);
});

test("'tablet' is not answered with a charger card", async () => {
  const gemini = scriptedGemini(
    [() => search("tablet"), () => "We do not have tablets, but the Anker 20W USB-C Fast Charger is popular.", () => "We do not have tablets right now. Anything else?"],
    { side: sideSaying("[]") }
  );
  const r = await turn("tablet", gemini);
  assert.deepEqual(titlesOf(r), []);
  assert.doesNotMatch(r.answer, /Anker/);
});

test("a substitute of the same kind is kept (the check says yes)", async () => {
  const gemini = scriptedGemini(
    [() => search("portable charger"), () => "Ambrane 10000mAh Power Bank, Anker PowerCore 20000mAh Power Bank and Mi Power Bank 3i 10000mAh are the portable options."],
    { side: async (req) => (/SAME KIND/.test(req.contents[0].parts[0].text) ? "[true,true,true]" : '["Power Banks"]') }
  );
  const r = await turn("portable charger", gemini);
  assert.equal(titlesOf(r).length, 3);
  assert.equal(gemini.main.length, 2);
});

test("'cheapest phone' with the model's sortBy and no item orders only the phones", async () => {
  const gemini = scriptedGemini([() => ({ call: [{ name: "search_products", args: { searchTerm: "", sortBy: "price_low" } }] }), () => "The cheapest is Xiaomi Redmi Note 13, then OnePlus Nord CE4."]);
  const r = await turn("cheapest phone", gemini);
  assert.deepEqual(titlesOf(r), ["Xiaomi Redmi Note 13", "OnePlus Nord CE4"]);
});
