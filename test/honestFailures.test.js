// When the store cannot be asked, the reply must say so (never "not available", never made-up products); and a reply that says a person
// is being connected, or the team was told, must be backed by a real request.
import test from "node:test";
import assert from "node:assert/strict";
import { lookupFailedReply, productLookupFailed } from "../src/agent/availabilityGuard.js";
import { claimsPersonHandoff } from "../src/agent/factGuard.js";

test("a failed product lookup is detected only when no lookup worked", () => {
  const err = { name: "search_products", result: { status: "error" } };
  const ok = { name: "search_products", result: { status: "ok", products: [{ title: "A" }] } };
  assert.equal(productLookupFailed([err]), true);
  assert.equal(productLookupFailed([err, { name: "compare_products", result: { status: "error" } }]), true);
  assert.equal(productLookupFailed([err, ok]), false, "one lookup worked: the reply can use it");
  assert.equal(productLookupFailed([]), false);
  assert.equal(productLookupFailed([{ name: "get_cart", result: { status: "error" } }]), false, "only product lookups count");
  assert.equal(productLookupFailed([{ name: "search_products", result: { status: "no_match" } }]), false, "no match is an answer, not a failure");
});

test("the failure reply names no product, no price and never says an item is unavailable", () => {
  for (const lang of ["en", "hi"]) {
    const text = lookupFailedReply(lang);
    assert.ok(text.length > 20);
    assert.ok(!/\*\*|[$€£₹]\s?\d/.test(text));
  }
  assert.match(lookupFailedReply("hi"), /[ऀ-ॿ]/);
  assert.doesNotMatch(lookupFailedReply("en"), /[ऀ-ॿ]/);
});

test("claims of connecting a person or telling the team are found; offers are not", () => {
  const claims = {
    "I am trying to connect you with a support representative right now.": "connect",
    "Main aapki baat ek support representative se karwane ki koshish kar rahi hoon. Ek pal rukiye.": "connect",
    "Main turant ise team ko pass kar rahi hoon taaki woh madad kar saken.": "pass",
    "I will pass this directly to our store team.": "pass",
    "I have flagged this for the team so they can look into it.": "pass",
  };
  for (const [text, kind] of Object.entries(claims)) assert.equal(claimsPersonHandoff(text), kind, text);
  for (const text of ["Would you like me to pass this to the team?", "I can connect you with a person if you want.", "Kya main ise team ko bata doon?", "Aap chahein toh main team se baat karwa sakti hoon.", "Here are two laptops that suit you."]) {
    assert.equal(claimsPersonHandoff(text), "", text);
  }
});

// ---- whole turns, with a scripted model --------------------------------------------------------------------------------
const { after, beforeEach } = await import("node:test");
process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");
const store = installRealStore();
const catalogFetch = globalThis.fetch;
const shopifyDown = () => { globalThis.fetch = async (url, init) => (/shopify/i.test(String(url?.url || url)) ? { ok: false, status: 502, json: async () => ({}), text: async () => "" } : catalogFetch(url, init)); };
after(() => { __setLLMClientsForTest(null); globalThis.fetch = catalogFetch; store.restore(); });
beforeEach(() => { __resetProviderBlocksForTest(); globalThis.fetch = catalogFetch; });
const SHOP = "honest.myshopify.com";
const ask = (text, extra = {}) => runAgent(text, SHOP, [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] }, ...extra });

test("Shopify is down: 'we do not have it' is replaced by an honest 'could not check', with no cards", async () => {
  shopifyDown();
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "iPhone 15" } }] }),
    () => "I am sorry, we do not have the Apple iPhone 15 in stock right now.",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("do you have the iPhone 15?");
  assert.equal(r.answer, lookupFailedReply("en"));
  assert.deepEqual(r.products, []);
});

test("Shopify is down: products and prices made up from memory are not sent", async () => {
  shopifyDown();
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "charger" } }] }),
    () => "- **Anker PowerPort III 20W Charger** ($25): compact and reliable.",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("anker charger dikhao");
  assert.doesNotMatch(r.answer, /Anker PowerPort|\$25/);
  assert.equal(r.answer, lookupFailedReply("en"));
});

test("Shopify is down: when the model itself writes an honest reply it is kept", async () => {
  shopifyDown();
  const honest = "I could not reach the store's catalog just now, please try again in a moment.";
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "search_products", args: { searchTerm: "iPhone 15" } }] }),
    () => honest,
  ]);
  __setLLMClientsForTest({ gemini });
  assert.equal((await ask("do you have the iPhone 15?")).answer, honest);
});

test("a reply that says a person is being connected, with no request made, makes the request (the team is told when nobody can join)", async () => {
  const gemini = scriptedGemini([() => "I am trying to connect you with a support representative right now."]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("I want to talk to a human");
  assert.ok(r.actions.some((a) => a.type === "flag_for_owner" || a.type === "human_support"), "a real request exists now");
  assert.doesNotMatch(r.answer, /trying to connect/i);
});

test("a reply that says the team was told, with no request made, makes the request", async () => {
  const gemini = scriptedGemini([() => "I am so sorry. I have passed this to the store team and they will follow up."]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("wrong item mila hai, refund chahiye");
  assert.ok(r.actions.some((a) => a.type === "flag_for_owner"));
});

test("an offer to pass it to the team is not a claim: nothing is flagged", async () => {
  const gemini = scriptedGemini([() => "Would you like me to pass this to the store team?"]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("I have a problem with my order");
  assert.equal(r.actions.some((a) => a.type === "flag_for_owner" || a.type === "human_support"), false);
});

test("claims of a preview above, and of keeping a language, are found; questions and plain replies are not", async () => {
  const { claimsLanguageSwitch, claimsPreviewShown, languageAskedFor } = await import("../src/agent/factGuard.js");
  for (const text of ["Your order preview is ready right above, with a payable total of $47.00.", "Your order review is right above.", "Aapka order preview upar hai, total 47 dollar.", "Your order preview is shown above."]) assert.equal(claimsPreviewShown(text), true, text);
  for (const text of ["Shall I show you the order preview?", "Here are two laptops that suit you.", "Would you like Cash on Delivery or online payment?"]) assert.equal(claimsPreviewShown(text), false, text);
  for (const text of ["Arre bilkul, ab se hum Hinglish mein hi baat karenge!", "Sure, from now on I will talk in Hindi.", "Hinglish mein baat karungi aapse."]) assert.equal(claimsLanguageSwitch(text), true, text);
  for (const text of ["Which language would you like?", "Here is the laptop in English and Hindi packaging.", "Kya main Hinglish mein baat karoon?"]) assert.equal(claimsLanguageSwitch(text), false, text);
  assert.equal(languageAskedFor("Hinglish mein reply do"), "hinglish");
  assert.equal(languageAskedFor("please talk to me in Hindi"), "hindi");
  assert.equal(languageAskedFor("english mein baat karo"), "english");
  assert.equal(languageAskedFor("show me laptops"), "");
});

test("whole turn: 'Hinglish mein reply do' answered without saving the choice saves it", async () => {
  const gemini = scriptedGemini([() => "Arre bilkul, ab se hum Hinglish mein hi baat karenge! Bataiye, kya dekhna hai?"]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("Hinglish mein reply do");
  assert.equal(r.languageChoice, "hinglish");
});

test("whole turn: when the model really saves the language, nothing is saved twice", async () => {
  const gemini = scriptedGemini([
    () => ({ call: [{ name: "set_reply_language", args: { language: "hindi" } }] }),
    () => "ज़रूर, अब से हम हिंदी में ही बात करेंगे।",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("please talk to me in Hindi");
  assert.equal(r.languageChoice, "hi");
});

test("whole turn: 'the order preview is above' with no preview made, in a checkout, makes the preview card", async () => {
  const gemini = scriptedGemini([() => "Your order preview is above, payable total $47.00. Would you like Cash on Delivery or online payment?"]);
  __setLLMClientsForTest({ gemini });
  const item = { title: "Anker 20W USB-C Fast Charger", variant_title: "White", quantity: 1, variant_id: 11, key: "11:a", price: 1900, original_price: 1900, final_price: 1900, line_price: 1900, final_line_price: 1900 };
  const r = await ask("final summary dikhao", {
    cart: { currency: "USD", item_count: 1, total_price: 1900, items: [item] },
    checkout: { shipping: { name: "Rahul Sharma", phone: "9876543210", address1: "12 MG Road", city: "Bengaluru", province: "Karnataka", zip: "560001", country: "India" }, customer: { name: "Rahul Sharma", email: "rahul@example.com", phone: "9876543210" }, billingSameAsShipping: true },
  });
  assert.ok(r.actions.some((a) => a.type === "checkout_ready" || a.type === "preview"), JSON.stringify(r.actions.map((a) => a.type)));
});

test("whole turn: a plain reply that does not point at a preview makes none", async () => {
  const gemini = scriptedGemini([() => "Sure. Which colour would you like?"]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("tell me about the charger");
  assert.equal(r.actions.some((a) => a.type === "checkout_ready" || a.type === "preview"), false);
});

test("claims that a call is booked are found; offers and questions are not", async () => {
  const { claimsCallBooked } = await import("../src/agent/factGuard.js");
  for (const text of ["Your call is booked for tomorrow at 10:00 am.", "I have scheduled the call for Wednesday.", "10 November, 10:00 am wala slot aapke liye book kar rahi hoon.", "Booking the slot for you now."]) assert.equal(claimsCallBooked(text), true, text);
  for (const text of ["Which of these times works for you?", "Shall I book the 10:00 am slot?", "Kya main 10 baje ka slot book kar doon?", "Here are two free slots tomorrow."]) assert.equal(claimsCallBooked(text), false, text);
});

test("whole turn: 'I am booking the slot' with no booking made is not sent as it is", async () => {
  const gemini = scriptedGemini([
    () => "Done! I have booked the call for you tomorrow at 10:00 am.",
    () => "I have not booked the call yet. Which of the available times works best for you?",
  ]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("book a call with your team, I am Neha, 9811122233, neha@example.com");
  assert.doesNotMatch(r.answer, /have booked the call|Done!/);
});

test("a reply that is the model's own reasoning is written again before it reaches the shopper", async () => {
  const leak = "The customer asks for an order preview in Hinglish. They have a cart but no checkout started, and no placed order. \"Order preview\" most likely means the checkout review. Since the cart has items and no checkout is in progress, I should show the cart preview, but the rule says if unsure, ask one short question.";
  const gemini = scriptedGemini([() => leak, () => "Aap cart ka preview dekhna chahte ho ya order ka? Bata dijiye."]);
  __setLLMClientsForTest({ gemini });
  const r = await ask("order preview dikhao");
  assert.equal(r.answer, "Aap cart ka preview dekhna chahte ho ya order ka? Bata dijiye.");
});

test("the shopper asks for a language and the model just answers in it: the choice is saved anyway", async () => {
  const { languageRequestedBy } = await import("../src/agent/factGuard.js");
  for (const [text, lang] of [["please talk to me in Hindi", "hindi"], ["english mein baat karo", "english"], ["Hinglish mein reply do", "hinglish"], ["speak in English from now on", "english"], ["mujhse Hindi mein baat karo", "hindi"]]) assert.equal(languageRequestedBy(text), lang, text);
  for (const text of ["Is this available in English?", "show me the Hindi book", "tell me about the laptop"]) assert.equal(languageRequestedBy(text), "", text);
  const gemini = scriptedGemini([() => "Sure, we can continue in English. What are you looking for today?"]);
  __setLLMClientsForTest({ gemini });
  assert.equal((await ask("english mein baat karo")).languageChoice, "en");
});
