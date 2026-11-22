// "Kya aap ise cart mein add karna chahenge?" -> "haan black wala add kar do": the shopper said to add, named no product and no
// cart word; the model wrote "checkout karna hai?" without calling add_to_cart, and nothing was added (live TechStore, 2026-11-22).
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");
const { writeCheckoutMemory } = await import("../src/industries/ecommerce/pricing.js");
const { explicitAddRequest } = await import("../src/industries/ecommerce/addRequest.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => __resetProviderBlocksForTest());

const OFFER = [{ role: "user", content: "samsonite wale bag ke features" }, { role: "assistant", content: "Samsonite Laptop Backpack 15.6 mein padded laptop sleeve aur hidden back pocket hai, Black aur Navy mein. Kya aap ise cart mein add karna chahenge?" }];

test("an add instruction, or a yes to an offer to add, is recognised; browsing words and a bare ok are not", () => {
  for (const said of ["haan black wala add kar do", "haan", "ji haan navy", "ok", "black wala le lo"]) assert.equal(explicitAddRequest(said, OFFER), true, said);
  assert.equal(explicitAddRequest("ok", [{ role: "assistant", content: "Ye rahe options. Kaunsa pasand aaya?" }]), false);
  assert.equal(explicitAddRequest("black wala dikhao", OFFER), false);
  assert.equal(explicitAddRequest("kya ye waterproof hai?", OFFER), false);
});

test("'haan black wala add kar do' after the offer adds the Black Samsonite even when the model forgets the tool", async () => {
  const shop = "techstore-test.myshopify.com";
  const clientId = freshClientId();
  // the chat showed several products that come in Black: only the one the last reply was about is meant
  const shown = ["Samsonite Laptop Backpack 15.6", "Dell WM126 Wireless Mouse", "Casio Vintage Digital Watch"].map((title) => ({ title, variants: [{ title: "Black" }, { title: "Navy" }] }));
  writeCheckoutMemory(shop, clientId, { lastShownProducts: shown });
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Kya aap abhi checkout karna chahenge ya kuch aur dekhna hai?"]) });
  const out = await runAgent("haan black wala add kar do", shop, OFFER, "ecommerce", { clientId, cart: { currency: "INR", items: [] } });
  const add = out.actions.find((a) => a.type === "add_to_cart");
  assert.ok(add, JSON.stringify(out.actions));
  assert.match(JSON.stringify(add), /Samsonite/);
  assert.match(JSON.stringify(add), /Black/);
});

const ecommerce = (await import("../src/industries/ecommerce.js")).default;
const { joinDottedCodes } = await import("../src/agent/textTidy.js");

test("after a wrong code, another code is offered only when it really works on this cart", async () => {
  const session = ecommerce.createSession("wrongcode.myshopify.com", {
    clientId: `wc-${Math.random().toString(36).slice(2)}`, userMessage: "mera coupon FAKE50 laga do", replyLanguage: "hinglish",
    cart: { currency: "INR", total_price: 750000, items: [{ variant_id: "67662745010212", title: "Samsonite Laptop Backpack 15.6 - Black", product_title: "Samsonite Laptop Backpack 15.6", price: 750000, line_price: 750000, quantity: 1 }] },
  }, {
    loadCheckout: async () => null, saveCheckout: async () => null, prepaidOffer: async () => null,
    loadDiscounts: async () => [
      { code: "CHAT20", title: "CHAT20", percentage: 20, limitedTo: "collection", scopeNames: ["Automated Collection"], shareable: true },
      { code: "ALL10", title: "ALL10", percentage: 10, shareable: true },
    ],
  });
  const r = await session.handlers.apply_discount_or_offer({ discountCode: "FAKE50" });
  assert.equal(r.status, "invalid_code");
  const chat20 = r.activeDiscounts.find((d) => d.code === "CHAT20");
  assert.notEqual(chat20.usableOnThisCart, true, "a collection-only code is never called usable without checking the cart's items");
  assert.deepEqual(chat20.onlyFor, ["Automated Collection"]);
  assert.equal(r.activeDiscounts.find((d) => d.code === "ALL10").usableOnThisCart, true);
  assert.doesNotMatch(session.result().fallbackSpeech, /CHAT20/);
  assert.match(session.result().fallbackSpeech, /ALL10/);
});

test("a code spelled with dots is written so it can be typed", () => {
  assert.equal(joinDottedCodes("F.A.K.E.50 valid nahi hai, C.H.A.T.20 try karo"), "FAKE50 valid nahi hai, CHAT20 try karo");
  assert.equal(joinDottedCodes("Made in the U.S.A. and ships today."), "Made in the U.S.A. and ships today.");
});

const { consistentAssistantVoice } = await import("../src/agent/textTidy.js");
test("'Samajh gaya' from the assistant is written in her own voice", () => {
  assert.equal(consistentAssistantVoice("Samajh gaya, chalo checkout karte hain!"), "Samajh gayi, chalo checkout karte hain!");
});

const { plainlyEnglish } = await import("../src/services/language.js");
test("a plainly English reply is told apart from Hinglish and from a bare product name", () => {
  assert.equal(plainlyEnglish("Done! I have added the Casio Vintage Digital Watch in Gold (₹5,600) to your cart. Would you like to proceed?"), true);
  assert.equal(plainlyEnglish("Maine Casio watch add kar di hai, checkout karein?"), false);
  assert.equal(plainlyEnglish("Casio Vintage Digital Watch"), false);
});

test("'wahi pichle order wala address' puts the last order's address on the checkout when the model did not", async () => {
  const last = { name: "Agam QA Test", email: "qa@example.com", phone: "+919876543210", address1: "221 Test Street", address2: "Sector 70", city: "Mohali", province: "Punjab", zip: "160071", country: "IN", countryCode: "IN" };
  let saved = { lastOrderShipping: last, shipping: null };
  const session = ecommerce.createSession("reuse.myshopify.com", {
    llmMode: true, clientId: `ru-${Math.random().toString(36).slice(2)}`, userMessage: "checkout karo, wahi pichle order wala address use kar lo", replyLanguage: "hinglish", history: [],
    cart: { currency: "INR", total_price: 560000, items: [{ variant_id: "1", title: "Casio Vintage Digital Watch - Gold", price: 560000, line_price: 560000, quantity: 1 }] },
  }, { loadCheckout: async () => saved, saveCheckout: async (_s, _c, patch) => { saved = { ...saved, ...patch }; return saved; } });
  assert.equal(await session.ensureAddressReuse(), true);
  const set = session.result().actions.find((a) => a.type === "set_shipping_address");
  assert.equal(set.address.address1, "221 Test Street");
  assert.equal(set.address.address2, "Sector 70");
  assert.match(session.result().fallbackSpeech, /221 Test Street/);
});

test("'wahi wala phone' is not an address request", async () => {
  const session = ecommerce.createSession("reuse2.myshopify.com", {
    llmMode: true, clientId: `ru-${Math.random().toString(36).slice(2)}`, userMessage: "wahi wala phone dikhao", replyLanguage: "hinglish", history: [],
    cart: { currency: "INR", items: [] },
  }, { loadCheckout: async () => ({ lastOrderShipping: { address1: "221 Test Street" } }), saveCheckout: async () => null });
  assert.equal(await session.ensureAddressReuse(), false);
});

test("'haan billing bhi same' to the billing question sets billing even when the model only said so", async () => {
  const ship = { name: "Agam QA Test", email: "qa@example.com", phone: "+919876543210", address1: "221 Test Street", address2: "Sector 70", city: "Mohali", province: "Punjab", zip: "160071", country: "IN", countryCode: "IN" };
  let saved = { shipping: ship, shippingConfirmed: true, step: "billing_inquiry" };
  const session = ecommerce.createSession("billing.myshopify.com", {
    llmMode: true, clientId: `bl-${Math.random().toString(36).slice(2)}`, userMessage: "haan billing bhi same", replyLanguage: "hinglish",
    history: [{ role: "assistant", content: "Delivery address save kar diya: **Agam QA Test, 221 Test Street**.\nKya billing address bhi yahi hai, ya alag address chahiye?" }],
    cart: { currency: "INR", total_price: 560000, items: [{ variant_id: "1", title: "Casio Vintage Digital Watch - Gold", price: 560000, line_price: 560000, quantity: 1 }] },
  }, { loadCheckout: async () => saved, saveCheckout: async (_s, _c, patch) => { saved = { ...saved, ...patch }; return saved; }, quoteOrder: async () => null });
  assert.equal(await session.routeCheckoutIntent({ billingOnly: true }), true);
  assert.ok(session.result().actions.some((a) => a.type === "set_billing_address"), JSON.stringify(session.result().actions.map((a) => a.type)));
  assert.equal(saved.billingConfirmed, true);
});

const { claimsBillingSet } = await import("../src/agent/factGuard.js");
const { billingRelationshipIntent } = await import("../src/services/checkoutIntent.js");
test("a billing step stated as done is recognised; questions are not", () => {
  assert.equal(claimsBillingSet("Billing address bhi maine tumhare delivery address jaisa hi set kar diya hai."), true);
  assert.equal(claimsBillingSet("I have set your billing address to match."), true);
  assert.equal(claimsBillingSet("Kya billing address bhi yahi set kar doon?"), false);
});
test("'billing address bhi delivery wala hi rakho' means the same address, without a billing question before it", () => {
  assert.equal(billingRelationshipIntent("billing address bhi delivery wala hi rakho", "Cash on Delivery ya online?"), "same");
  assert.equal(billingRelationshipIntent("billing alag hai", ""), "different");
});

const { replyPlainlyIn } = await import("../src/services/language.js");
test("a reply plainly in the wanted language skips the extra AI language check; a doubtful one does not", () => {
  assert.equal(replyPlainlyIn("Sure! The Dell mouse is in your cart. Would you like to check out now?", "en"), true);
  assert.equal(replyPlainlyIn("Haan, maine Dell mouse cart mein daal diya hai. Ab checkout karna hai ya kuch aur dekhna hai?", "hinglish"), true);
  assert.equal(replyPlainlyIn("डेल माउस आपके कार्ट में जोड़ दिया है। अब चेकआउट करें?", "hi"), true);
  assert.equal(replyPlainlyIn("Done! The mouse is in your cart.", "hinglish"), false);
  assert.equal(replyPlainlyIn("Mouse cart mein hai, would you like to checkout?", "en"), false);
  assert.equal(replyPlainlyIn("Dell WM126 Wireless Mouse", "en"), false);
});

test("when a guard adds the product, the AI writes the reply in its own words, naming the product", async () => {
  const shop = "techstore-test.myshopify.com";
  const clientId = freshClientId();
  const shown = [{ title: "Samsonite Laptop Backpack 15.6", variants: [{ title: "Black" }, { title: "Navy" }] }];
  writeCheckoutMemory(shop, clientId, { lastShownProducts: shown });
  const friendly = "Ho gaya! Black Samsonite Laptop Backpack 15.6 aapke cart mein aa gaya. Checkout karein ya kuch aur dikhaun?";
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Kya aap abhi checkout karna chahenge ya kuch aur dekhna hai?", () => friendly]) });
  const out = await runAgent("haan black wala add kar do", shop, OFFER, "ecommerce", { clientId, cart: { currency: "INR", items: [] } });
  assert.ok(out.actions.find((a) => a.type === "add_to_cart"));
  assert.equal(out.answer, friendly);
});

test("an AI reply for the added product that does not name it is not sent; the store's own wording is", async () => {
  const shop = "techstore-test.myshopify.com";
  const clientId = freshClientId();
  writeCheckoutMemory(shop, clientId, { lastShownProducts: [{ title: "Samsonite Laptop Backpack 15.6", variants: [{ title: "Black" }, { title: "Navy" }] }] });
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Kya aap abhi checkout karna chahenge ya kuch aur dekhna hai?"]) });
  const out = await runAgent("haan black wala add kar do", shop, OFFER, "ecommerce", { clientId, cart: { currency: "INR", items: [] } });
  assert.match(out.answer, /Samsonite/);
});

test("the language check is skipped only when the shopper's message is plainly in that language too", () => {
  assert.equal(replyPlainlyIn("kal to 40000 ka tha, wahi price de do", "en", { short: true }), false);
  assert.equal(replyPlainlyIn("show me the cheapest phone please", "en", { short: true }), true);
  assert.equal(replyPlainlyIn("mujhe sasta phone dikhao", "hinglish", { short: true }), true);
  assert.equal(replyPlainlyIn("Dell wala black mein add kar do", "hinglish", { short: true }), true);
});

const { respectfulAddress } = await import("../src/agent/textTidy.js");
test("the customer is 'aap' unless they wrote 'tu' or 'tum' themselves; friendly 'yaar' and 'dost' stay", () => {
  assert.equal(respectfulAddress("Done yaar! Maine mouse tumhare cart mein add kar diya hai!", "Dell wala add kar do"), "Done yaar! Maine mouse aapke cart mein add kar diya hai!");
  assert.equal(respectfulAddress("Tere liye ye sahi rahega, tera budget bhi theek hai.", "mouse chahiye"), "Aapke liye ye sahi rahega, aapka budget bhi theek hai.");
  assert.equal(respectfulAddress("Bilkul dost! Ambrane power bank ready hai.", "Ambrane wala add kar do"), "Bilkul dost! Ambrane power bank ready hai.");
  assert.equal(respectfulAddress("Done! tumhare cart mein hai", "tum batao"), "Done! tumhare cart mein hai");
  assert.equal(respectfulAddress("Literally the best terabyte drive", "show drives"), "Literally the best terabyte drive");
  assert.equal(respectfulAddress("Hamare paas cheezein hain jo tum dekh sakte ho. Kya tum inmein se kuch dekhna chahoge?", "mera cart dikhao"), "Hamare paas cheezein hain jo aap dekh sakte hain. Kya aap inmein se kuch dekhna chahenge?");
});

const { unsupportedPerformanceClaims } = await import("../src/agent/claimGuard.js");
test("a Hinglish 'gaming ho sakti hai' that the listing never says is caught like the English one", () => {
  const toolLog = [{ name: "get_product_details", result: { product: { title: "Logitech M331 Silent Wireless Mouse", description: "Wireless mouse with quiet clicks, a comfortable shape and long battery life" } } }];
  assert.equal(unsupportedPerformanceClaims("Isme quiet clicks aur long battery life milti hai, jisse lamba kaam ya gaming ho sakti hai.", toolLog).length, 1);
  assert.equal(unsupportedPerformanceClaims("Isme quiet clicks aur long battery life milti hai.", toolLog).length, 0);
});

test("'Dell wala black mein add kar do' adds the Dell when the chat showed several mice and the model forgot the tool", async () => {
  const shop = "techstore-test.myshopify.com";
  const clientId = freshClientId();
  const mice = [
    { title: "Dell WM126 Wireless Mouse", variants: [{ title: "Black" }, { title: "Blue" }] },
    { title: "Logitech M331 Silent Wireless Mouse", variants: [{ title: "Black" }] },
    { title: "HP X1000 Wired Mouse", variants: [{ title: "Black" }] },
  ];
  writeCheckoutMemory(shop, clientId, { lastShownProducts: mice });
  const history = [{ role: "user", content: "wireless mouse chahiye" }, { role: "assistant", content: "Dell WM126 Wireless Mouse, Logitech M331 Silent Wireless Mouse aur HP X1000 Wired Mouse hain." }, { role: "user", content: "Logitech wala kaisa hai?" }, { role: "assistant", content: "Logitech M331 mein silent clicks hain. Add kar doon?" }];
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Kya aap abhi checkout karna chahenge ya kuch aur bhi dekhna hai?"]) });
  const out = await runAgent("theek hai Dell wala black mein add kar do", shop, history, "ecommerce", { clientId, cart: { currency: "INR", items: [] } });
  const add = out.actions.find((a) => a.type === "add_to_cart");
  assert.ok(add, JSON.stringify(out.actions));
  assert.match(JSON.stringify(add), /Dell/);
  assert.match(out.answer, /Dell/);
});

const { claimsUnavailable } = await import("../src/agent/factGuard.js");
test("an empty cart is not a claim that the store lacks an item; a later rewrite cannot bring back a removed performance claim", async () => {
  assert.equal(claimsUnavailable("Abhi aapke cart mein koi item nahi hai."), false);
  assert.equal(claimsUnavailable("Ye phone abhi stock mein nahi hai."), true);
  const T = "Abhi aapke cart mein koi item nahi hai. Ye dekh sakte hain:\n\n- **Samsung Galaxy A55 5G**: Ek behtareen smartphone jo apne display aur performance ke liye jana jata hai.\n- **Apple iPhone 15**: Ek premium choice hai.\n\nKuch dekhna hai?";
  __setLLMClientsForTest({ gemini: scriptedGemini([() => ({ call: [{ name: "get_cart", args: {} }] }), () => T]) });
  const out = await runAgent("ok rehne do, mera cart dikhao", "perf.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  assert.doesNotMatch(out.answer, /performance ke liye/);
  assert.match(out.answer, /cart mein koi item nahi/);
});

const { doneEvidence, claimsDone } = await import("../src/agent/factGuard.js");
test("a verification code that really went out ('otp_sent') may be reported as sent; 'chahoge' becomes 'chahenge'", () => {
  const toolLog = [{ name: "send_order_otp", result: { status: "otp_sent", maskedEmail: "ag***@gmail.com", digits: 6 } }];
  const claimed = claimsDone("Maine aapke email par 6 digit ka code bhej diya hai, woh yahan bata dijiye.");
  assert.deepEqual(claimed, ["email_sent"]);
  assert.ok(doneEvidence({ toolLog }).has("email_sent"));
  assert.equal(doneEvidence({ toolLog: [{ name: "send_order_otp", result: { status: "send_failed" } }] }).has("email_sent"), false);
  assert.equal(respectfulAddress("Cash on Delivery se payment karna chahoge ya online?", "cash on delivery"), "Cash on Delivery se payment karna chahenge ya online?");
});

test("'ek power bank chahiye, Ambrane wala black mein cart mein daal do' adds the Ambrane in Black when the search found three power banks", async () => {
  const shop = "techstore-test.myshopify.com";
  const clientId = freshClientId();
  const banks = [
    { title: "Ambrane 10000mAh Power Bank", variants: [{ title: "Blue" }, { title: "Black" }, { title: "White" }] },
    { title: "Anker PowerCore 20000mAh Power Bank", variants: [{ title: "Black" }] },
    { title: "Mi Power Bank 3i 10000mAh", variants: [{ title: "Midnight Black" }] },
  ];
  writeCheckoutMemory(shop, clientId, { lastShownProducts: banks });
  __setLLMClientsForTest({ gemini: scriptedGemini([() => "Ye options hain: Ambrane, Anker aur Mi. Kaunsa dekhna hai?"]) });
  const out = await runAgent("hi, mujhe ek power bank chahiye, Ambrane wala black mein cart mein daal do", shop, [], "ecommerce", { clientId, cart: { currency: "INR", items: [] }, probeProducts: banks });
  const add = out.actions.find((a) => a.type === "add_to_cart");
  assert.ok(add, JSON.stringify(out.actions));
  assert.match(JSON.stringify(add), /Ambrane/);
});
