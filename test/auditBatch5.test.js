// Audit batch 5: what the shopper sees must fit what was asked (wrong cards, wrong picks).
import test from "node:test";
import assert from "node:assert/strict";
import { speculativeCards } from "../src/agent/cardSelection.js";

// S18: seen on the real dev store. Shopper: "kal to 40000 ka tha, wahi price de do" (about an iPhone). No tool ran; the
// quick search before the model had matched "The Compare at Price Snowboard" on the word "price". The reply had "the" and
// "price" somewhere in it, that counted as naming the product, and a snowboard card was shown under an iPhone answer.
test("a product nobody asked a tool for gets a card only when the reply says its name, not scattered everyday words of it", () => {
  const snowboard = { title: "The Compare at Price Snowboard", vendor: "Snowboard Vendor" };
  const reply = "I understand you are looking for a better price, but the current price for the iPhone 15 is ₹71,600 as per our store records. I cannot change the prices.";
  assert.deepEqual(speculativeCards([], [snowboard], reply), []);
  assert.deepEqual(speculativeCards([], [snowboard], "The price of the iPhone 15 is ₹71,600."), []);

  // the name itself, in full or shortened, still gets its card
  const iphone = { title: "Apple iPhone 15", vendor: "Apple" };
  assert.deepEqual(speculativeCards([], [snowboard, iphone], reply), [iphone]);
  assert.deepEqual(speculativeCards([], [snowboard], "Yes, The Compare at Price Snowboard is in stock."), [snowboard]);
  const earbuds = { title: "boAt Airdopes 141 Earbuds", vendor: "boAt" };
  assert.deepEqual(speculativeCards([], [earbuds], "The Airdopes 141 come in two colours."), [earbuds]);
});

// S19: seen in the evaluation. After a boys' shirt was shown, "kuch sasta dikhao" became a search with a price limit
// nothing met, and the tool answered "The store does not stock this item" although the shirt was right there.
test("a price limit that nothing meets says the item costs more, never that the store does not have it", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  let result = null;
  __setLLMClientsForTest({ gemini: scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "shirt", gender: "kids", maxPrice: 1, sortBy: "price_low" } }] }),
    (req) => { result = req.contents.map((c) => c.parts?.[0]?.functionResponse?.response).filter(Boolean).at(-1); return "ok"; },
  ]) });
  await runAgent("show me cheaper ones", "evalstore.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  assert.equal(result.status, "over_budget");
  assert.ok(result.cheapestInCategory?.title, "the lowest priced one is named");
  assert.ok(result.closestAlternatives.length > 0);
  assert.doesNotMatch(result.reason + " " + result.note, /does not stock|not available in our store/);
  assert.doesNotMatch(String(result.verified_reply_facts || ""), /don't have/);
});

// S20: seen in the evaluation. A message in Devanagari got a Roman-letter reply, and a Hinglish message got an English
// reply after a tool ran (the tool results are in English and the model copied their language).
test("a Devanagari message answered in Roman letters is caught; a Roman or Devanagari reply to its own script is not", async () => {
  const { missedDevanagariReply } = await import("../src/services/language.js");
  assert.equal(missedDevanagariReply({ message: "मुझे लैपटॉप बैग चाहिए", reply: "Office ke liye HP Backpack sahi rahega." }), true);
  assert.equal(missedDevanagariReply({ message: "मुझे लैपटॉप बैग चाहिए", reply: "ऑफिस के लिए HP Backpack सही रहेगा।" }), false);
  assert.equal(missedDevanagariReply({ message: "laptop bag chahiye", reply: "HP Backpack sahi rahega." }), false);
  // the shopper chose Hinglish or English earlier: a Roman reply is what they asked for
  assert.equal(missedDevanagariReply({ message: "मुझे बैग चाहिए", reply: "HP Backpack sahi rahega.", replyLanguage: "hinglish", locked: true }), false);
  assert.equal(missedDevanagariReply({ message: "bag", reply: "HP Backpack is good.", replyLanguage: "hi", locked: true }), true);
});

test("after a tool runs, the model is given the shopper's own words again to mirror, and a Roman reply to Hindi is rewritten", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  let seen = null;
  __setLLMClientsForTest({ gemini: scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "laptop bag" } }] }),
    (req) => { seen = req.contents.map((c) => c.parts?.[0]?.functionResponse?.response).filter(Boolean).at(-1); return "Office ke liye yeh bag sahi rahega."; },
    () => "ऑफिस के लिए यह बैग सही रहेगा।",
  ]) });
  const out = await runAgent("मुझे ऑफिस के लिए लैपटॉप बैग चाहिए", "evalstore.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] }, replyLanguage: "hi" });
  assert.match(String(seen?.reply_language || ""), /मुझे ऑफिस के लिए लैपटॉप बैग चाहिए/);
  assert.match(out.answer, /[ऀ-ॿ]/, "the reply went out in Roman letters to a Devanagari message");
});

// S21: "delivery kitne din me hoti hai?" was answered only with "shipping rates depend on the address".
test("a delivery question without an address is told that time and charges both depend on the address", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  let result = null;
  __setLLMClientsForTest({ gemini: scriptedGemini([
    () => ({ call: [{ name: "get_shipping_options", args: {} }] }),
    (req) => { result = req.contents.map((c) => c.parts?.[0]?.functionResponse?.response).filter(Boolean).at(-1); return "ok"; },
  ]) });
  await runAgent("how many days does delivery take?", "evalstore.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  assert.equal(result.status, "needs_address");
  assert.match(result.note, /time/i);
  assert.match(String(result.verified_reply_facts || ""), /time/i);
});

// S23: "budget 1500" got "the cheapest earbuds are boAt Airdopes at ₹1,900" with no card to tap.
test("an item over the price limit that the reply offers by name gets its card; one it does not name gets none", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  const ask = async (reply) => {
    __setLLMClientsForTest({ gemini: scriptedGemini([
      () => ({ call: [{ name: "search_products", args: { searchTerm: "shirt", gender: "kids", maxPrice: 1, sortBy: "price_low" } }] }),
      (req) => { const r = req.contents.map((c) => c.parts?.[0]?.functionResponse?.response).filter(Boolean).at(-1); return reply(r.cheapestInCategory.title); },
    ]) });
    return runAgent("show me cheaper ones", "evalstore.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  };
  const named = await ask((title) => `Nothing under that price, the lowest one is ${title}. Want to see it?`);
  assert.equal((named.products || []).length, 1);
  const unnamed = await ask(() => "Nothing under that price right now. Want me to look at something else?");
  assert.deepEqual(unnamed.products || [], []);
});

// S24: a Hinglish follow-up answered in English although no word in the reply could be checked by script.
test("a reply in another language than the shopper's message is written again; one in the same language is left alone", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  const run = async (steps, verdict) => {
    __setLLMClientsForTest({ gemini: scriptedGemini(steps, { side: async (req) => (/SAME or DIFFERENT/.test(JSON.stringify(req.contents)) ? verdict : "[]") }) });
    return runAgent("kal to 40000 ka tha, wahi price de do", "evalstore.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  };
  const fixed = await run([() => "I cannot change the price.", () => "Main price nahi badal sakti."], "DIFFERENT");
  assert.equal(fixed.answer, "Main price nahi badal sakti.");
  const same = await run([() => "Main price nahi badal sakti."], "SAME");
  assert.equal(same.answer, "Main price nahi badal sakti.");
});

// ---- a budget the shopper states is a limit (found on the real store: "phone under 30000" listed the iPhone and the A55) ----------------
test("a budget is understood in English, Hinglish and Hindi, and a plain number is not a budget", async () => {
  const { budgetFromText } = await import("../src/tools/shopify/words.js");
  const cases = [["laptops under 55000", 55000], ["budget of $500", 500], ["within 300 dollars", 300], ["mujhe laptop bag chahiye 4000 ke andar", 4000], ["phone 20000 tak", 20000], ["5000 से कम की घड़ी", 5000], ["iPhone 15 price?", null], ["I need 2 shirts", null], ["a 4000 mAh power bank", null]];
  for (const [text, want] of cases) assert.equal(budgetFromText(text), want, text);
});

test("the quick search before the model answers keeps to the shopper's budget, in any of those languages", async (t) => {
  const { installRealStore } = await import("./helpers/agentHarness.js");
  const { probeCatalog } = await import("../src/tools/shopifyService.js");
  const store = installRealStore();
  t.after(() => store.restore());
  const under = await probeCatalog("budget.myshopify.com", "best phone for gaming under 30000");
  assert.ok(under.length > 0 && under.every((p) => Number(p.price) <= 30000), under.map((p) => `${p.title} ${p.price}`).join(" | "));
  assert.ok(!under.some((p) => /iPhone|A55/.test(p.title)), "an over-budget phone was handed to the model");
  assert.deepEqual(await probeCatalog("budget.myshopify.com", "phone under 20000"), [], "nothing fits: nothing is handed over");
  const hinglish = await probeCatalog("budget.myshopify.com", "mujhe ek acchi laptop bag chahiye 4000 ke andar");
  assert.ok(hinglish.length > 0 && hinglish.every((p) => Number(p.price) <= 4000), hinglish.map((p) => `${p.title} ${p.price}`).join(" | "));
  const noBudget = await probeCatalog("budget.myshopify.com", "show me smartphones");
  assert.ok(noBudget.some((p) => /iPhone/.test(p.title)), "without a budget nothing is filtered");
});

test("a reply that recommends a product above the stated budget is written again without it, and shows no card for it", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  const model = scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "phone" } }] }), // the model forgot the budget in its search
    () => "- **OnePlus Nord CE4** (₹26,700): a solid pick for gaming. - **Apple iPhone 15** (₹71,600): premium. - **Samsung Galaxy A55 5G** (₹41,000): great camera.",
    () => "For gaming within your budget, the **OnePlus Nord CE4** (₹26,700) is the one I would pick.",
  ]);
  __setLLMClientsForTest({ gemini: model });
  const out = await runAgent("best phone for gaming under 30000", "budgetguard.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  assert.doesNotMatch(out.answer, /iPhone|A55/, out.answer);
  assert.match(out.answer, /OnePlus/);
  assert.ok(out.products.every((p) => Number(p.price) <= 30000), out.products.map((p) => `${p.title} ${p.price}`).join(" | "));
  assert.ok(!out.products.some((p) => /iPhone|A55/.test(p.title)));
});

test("when the tool itself says nothing fits the budget, the nearest is still named honestly (the guard does not hide it)", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  __setLLMClientsForTest({ gemini: scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "phone", maxPrice: 20000 } }] }),
    () => "Nothing is under 20000, but the closest is the **Xiaomi Redmi Note 13** (₹21,900).",
  ]) });
  const out = await runAgent("smartphone under 20000", "budgetguard2.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  assert.match(out.answer, /Redmi/, "the honest 'nearest one' must stay");
});

// ---- the assistant stays in its lane (found on the real store: a Python function was written for a shopper) ------------------------------------
test("the prompt names coding and general knowledge as not its job, and still allows the questions that help someone buy", async () => {
  const { default: ecommerce } = await import("../src/industries/ecommerce.js");
  const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {} });
  assert.match(prompt, /writing or fixing code/);
  assert.match(prompt, /trivia and general knowledge/);
  assert.match(prompt, /what is RAM/, "a question that helps choose a product is still answered");
  assert.match(prompt, /"a" \/ "ek" \/ "koi" means any, not exactly one/, "a browse request is not read as 'exactly one product'");
});

test("a code block in a reply never reaches the shopper: it is written again as a redirect to the store", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  __setLLMClientsForTest({ gemini: scriptedGemini([
    () => "Here is a simple Python function:\n```python\ndef reverse_string(s):\n    return s[::-1]\n```\nWould you like another way?",
    () => "I can only help with the store. What would you like to look for today?",
  ]) });
  const out = await runAgent("Write a Python function to reverse a string.", "lane.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
  assert.doesNotMatch(out.answer, /```|def |return s/, out.answer);
  assert.match(out.answer, /only help with the store/);
  // when the second try fails too, the code is still cut out
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Sure:\n```js\nconsole.log(1)\n```\nDone.", () => "```js\nalert(2)\n```"]) });
  const cut = await runAgent("write javascript", "lane.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
  assert.doesNotMatch(cut.answer, /```|console\.log|alert/, cut.answer);
});

// ---- cards do not depend on how many names the model happens to write (found on the real store: "jeans" found 6, one card) -----------------
async function askWith(t, message, steps) {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  __setLLMClientsForTest({ gemini: scriptedGemini(steps) });
  return runAgent(message, "cards.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
}

test("asking to see a kind of product shows every product the search found for it, even when the reply names only one", async (t) => {
  const out = await askWith(t, "show me jeans", [
    () => ({ call: [{ name: "search_products", args: { searchTerm: "jeans" } }] }),
    () => "My best pick for you is the **Slim Fit Blue Denim Jeans**. The cards show the other options.",
  ]);
  assert.ok(out.products.length >= 3, `only ${out.products.length} card(s): ${out.products.map((p) => p.title).join(" | ")}`);
  assert.ok(out.products.every((p) => /jean/i.test(p.title)), "an unrelated product was added: " + out.products.map((p) => p.title).join(" | "));
  assert.match(out.products[0].title, /Slim Fit Blue Denim Jeans/, "the product the reply names comes first");
  assert.equal(new Set(out.products.map((p) => p.title)).size, out.products.length, "a product is shown twice");
});

test("a category named by a word that is in no title (smartphones) still shows the phones, and only phones", async (t) => {
  const out = await askWith(t, "show me smartphones", [
    () => ({ call: [{ name: "search_products", args: { searchTerm: "smartphones" } }] }),
    () => "I would start with the **OnePlus Nord CE4**.",
  ]);
  assert.ok(out.products.length >= 3, out.products.map((p) => p.title).join(" | "));
  assert.ok(out.products.every((p) => /iPhone|OnePlus|Redmi|Galaxy/.test(p.title)), out.products.map((p) => p.title).join(" | "));
  assert.match(out.products[0].title, /OnePlus/);
});

test("asking about ONE product does not bring six recommendations: only the product asked about shows", async (t) => {
  const out = await askWith(t, "How much is the iPhone 15?", [
    () => ({ call: [{ name: "search_products", args: { searchTerm: "iPhone 15" } }] }),
    () => "The **Apple iPhone 15** is the one you mean; the card shows its price.",
  ]);
  assert.deepEqual(out.products.map((p) => p.title), ["Apple iPhone 15"]);
});

test("browsing keeps to the shopper's budget even when the model forgot it in the search, and the cards stay real products", async (t) => {
  const out = await askWith(t, "show me smartphones under 30000", [
    () => ({ call: [{ name: "search_products", args: { searchTerm: "smartphones" } }] }),
    () => "The **OnePlus Nord CE4** is my pick.",
  ]);
  assert.ok(out.products.length >= 2, out.products.map((p) => `${p.title} ${p.price}`).join(" | "));
  assert.ok(out.products.every((p) => Number(p.price) <= 30000), out.products.map((p) => `${p.title} ${p.price}`).join(" | "));
});

test("browseCards: a kind needs two or more products of it; one product asked by name is not a kind", async () => {
  const { browseCards } = await import("../src/agent/cardSelection.js");
  const mk = (title, category) => ({ id: title, title, category });
  const found = [mk("Blue Denim Jeans", "jeans"), mk("Black Skinny Jeans", "jeans"), mk("Denim Jacket", "jackets")];
  const search = (query, products) => [{ result: { mode: "single", status: "ok", searchedCategory: query, products } }];
  const cards = found.map((p) => ({ ...p }));
  assert.deepEqual(browseCards(cards, search("jeans", found), [cards[1]]).map((c) => c.title), ["Black Skinny Jeans", "Blue Denim Jeans"]);
  assert.equal(browseCards(cards, search("Blue Denim Jeans", found), [cards[0]]), null, "one title has every word: that is a product, not a kind");
  assert.equal(browseCards(cards.slice(0, 1), search("jeans", found.slice(0, 1)), []), null, "one product is not a choice");
  const ranked = [{ result: { mode: "single", status: "ok", searchedCategory: "jeans", sortedBy: "price_low", products: found } }];
  assert.equal(browseCards(cards, ranked, [cards[0]]), null, "cheapest / most expensive is a ranked request: only what the reply names shows");
  assert.equal(browseCards(cards, [{ result: { mode: "single", status: "closest_alternatives", searchedCategory: "jeans", products: found } }], []), null, "nearest-of-kind results are left to the reply");
});

// ---- the lane guard must not block a useful shopping conversation ------------------------------------------------------------------------
async function runScripted(t, message, steps) {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  const model = scriptedGemini(steps);
  __setLLMClientsForTest({ gemini: model });
  const out = await runAgent(message, "lane2.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
  return { out, main: model.main.length };
}

test("shopping questions that teach (RAM, 5G, OLED vs AMOLED, a processor for gaming) are answered as written, with no redirect or rewrite", async (t) => {
  const answers = {
    "What is RAM?": "RAM is the short-term memory of a phone or laptop. More RAM lets it keep more apps and tabs open at once. 8GB is a comfortable amount for most people.",
    "Which processor is better for gaming?": "For gaming, a faster multi-core processor with a strong graphics chip matters most. Tell me your budget and I can suggest a laptop.",
    "What is the difference between OLED and AMOLED?": "- OLED: each pixel lights itself, so blacks are deep.\n- AMOLED: an OLED type used on phones, with an active-matrix layer for faster, smoother control.\nBoth look great; AMOLED is the usual phone version.",
  };
  for (const [question, answer] of Object.entries(answers)) {
    const { out, main } = await runScripted(t, question, [() => answer]);
    assert.equal(out.answer, answer, `the answer to "${question}" was changed`);
    assert.equal(main, 1, `"${question}" needed more than the one model call (a rewrite or redirect ran)`);
  }
});

test("'recommend a laptop for programming' is a shopping request: it searches, answers and shows laptops, with no redirect", async (t) => {
  const { out, main } = await runScripted(t, "Can you recommend a laptop for programming?", [
    () => ({ call: [{ name: "search_products", args: { searchTerm: "laptop" } }] }),
    () => "For programming I would look at the **Lenovo IdeaPad Slim 3**: light, with a good keyboard. The cards show the other laptops.",
  ]);
  assert.match(out.answer, /Lenovo IdeaPad Slim 3/);
  assert.ok(out.products.length >= 2 && out.products.every((p) => /laptop|IdeaPad|Vivobook|Pavilion|Inspiron/i.test(p.title)), out.products.map((p) => p.title).join(" | "));
  assert.equal(main, 2, "search + answer only");
});

test("a Python sorting program is redirected to the store, a code snippet is never delivered", async (t) => {
  const { out } = await runScripted(t, "Write a Python sorting program.", [
    () => "Sure:\n```python\ndef sort_list(items):\n    return sorted(items)\n```",
    () => "I can only help with the store. What would you like to look for today?",
  ]);
  assert.doesNotMatch(out.answer, /```|sorted\(/);
  assert.match(out.answer, /only help with the store/);
});
