// Fixes from the real-storefront end-to-end run of 2026-11-21 (TechStore, INR market, Hinglish shopper).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { claimsDiscountApplied, claimsCartChange, changedCart, unknownFeatureClaims, verifyReplyFacts } from "../src/agent/factGuard.js";
import { addRequested } from "../src/industries/ecommerce/addRequest.js";
import { cardsForAnswer } from "../src/agent/cardSelection.js";
import { billingRelationshipIntent } from "../src/services/checkoutIntent.js";
import { mergeShippingAddress } from "../src/services/shippingAddressService.js";
import { formatMoney } from "../src/utils/money.js";
import { dropDanglingListIntro, fixOneDecimalAmounts } from "../src/agent/textTidy.js";
import { installRealStore } from "./helpers/agentHarness.js";
import ecommerce from "../src/industries/ecommerce.js";
import { catalogSummaryCaches } from "../src/tools/shopify/caches.js";

test("showing the cart is not a cart change; adding is", () => {
  assert.equal(changedCart([{ type: "show_cart" }]), false);
  assert.equal(changedCart([{ type: "add_to_cart" }]), true);
  assert.equal(claimsCartChange("Maine Pink wala Gift Set cart mein daal diya hai"), true);
});

test("a reply that says a code is applied is recognised in English, Hinglish and Hindi; offers and refusals are not", () => {
  for (const t of ["CHAT20 code bhi apply kar diya hai taaki 20% off mil sake.", "I applied the code CHAT20 for you.", "ab dekho CHAT20 apply ho gaya hai", "मैंने कोड लगा दिया है"]) assert.equal(claimsDiscountApplied(t), true, t);
  for (const t of ["Kya main CHAT20 laga doon?", "CHAT20 mouse par nahi lagega.", "Shall I apply the code?"]) assert.equal(claimsDiscountApplied(t), false, t);
});

test("'pink wala' answers the option question that followed the shopper's own add request", () => {
  const history = [{ role: "user", content: "Girls Hair Accessories Gift Set bhi add kar do" }, { role: "assistant", content: "Pink, Purple, Blue aur Red options hain, aap kaun sa wala lena chahenge?" }];
  assert.equal(addRequested("pink wala", history), true);
  assert.equal(addRequested("black one", [{ role: "user", content: "show me watches" }, { role: "assistant", content: "Which colour do you like?" }]), false);
});

test("features the listing never states are flagged; listed ones and denials are not", () => {
  const src = ["Samsung Galaxy A55 5G: 6.6-inch AMOLED display, a multi-lens camera", "Xiaomi Redmi Note 13: 108MP main camera"];
  assert.deepEqual(unknownFeatureClaims("Iska triple camera setup aur in-display fingerprint sensor. 50 megapixel ka Sony camera.", src).sort(), ["Sony", "fingerprint", "triple camera"].sort());
  assert.deepEqual(unknownFeatureClaims("AMOLED display aur multi-lens camera. The listing does not mention a headphone jack.", src), []);
  assert.ok(verifyReplyFacts("Sony camera", src).unknownSpecs.includes("Sony"));
});

test("a case for 'iske liye' shows only the case the reply says fits, not every case nor the phone itself", () => {
  const cases = [{ title: "ESR Classic Hybrid Phone Case" }, { title: "Nillkin Frosted Shield Phone Case" }, { title: "Spigen Rugged Armor Phone Case" }];
  const toolLog = [{ name: "search_products", result: { status: "ok", mode: "single", searchedCategory: "phone case", products: cases } }];
  const shown = cardsForAnswer([...cases, { title: "Samsung Galaxy A55 5G" }], toolLog, "Galaxy A55 ke liye ESR Classic Hybrid Phone Case bilkul fit baithta hai.", "iske liye cover bhi milega kya?");
  assert.deepEqual(shown.map((c) => c.title), ["ESR Classic Hybrid Phone Case"]);
});

test("'haan same hai' to the billing question means same, in Hinglish and Hindi", () => {
  const q = "Is your billing address the same as your delivery address, or would you like to use a different one?";
  assert.equal(billingRelationshipIntent("haan same hai", q), "same");
  assert.equal(billingRelationshipIntent("billing address bhi wahi hai jo delivery ka hai", q), "same");
  assert.equal(billingRelationshipIntent("nahi alag hai", q), "different");
});

test("the locality between the street and the city is kept when the model leaves it out", () => {
  const r = mergeShippingAddress({ email: "a@example.com", phone: "+919876543210" }, { name: "Rahul Verma", address1: "12 MG Road", city: "Mumbai", province: "Maharashtra", zip: "400058", country: "IN" }, { message: "Rahul Verma, 12 MG Road, Andheri West, Mumbai, Maharashtra 400058" });
  assert.equal(r.address.address2, "Andheri West");
});

test("money is written with both decimals when it has paise", () => {
  assert.equal(formatMoney(56858.3, "INR"), "₹56,858.30");
  assert.equal(formatMoney(8999, "INR"), "₹8,999");
  assert.equal(fixOneDecimalAmounts("Total ₹56,858.3 incl ₹8,673.3 tax, rated 4.5"), "Total ₹56,858.30 incl ₹8,673.30 tax, rated 4.5");
});

test("an introduction left without its list (question on the next line) is dropped", () => {
  assert.equal(dropDanglingListIntro("Yeh lo kuch badiya t-shirt options:\nKya aap inme se koi lena chahenge?"), "Kya aap inme se koi lena chahenge?");
});

test("the exact product asked for is reported as sold out next to the alternatives", async () => {
  const store = installRealStore();
  after(() => store.restore());
  catalogSummaryCaches.set("soldout.myshopify.com", { at: Date.now(), summary: { categories: [], categoryMap: {}, allProducts: [{ title: "Wireless Bluetooth Earbuds" }], products: [] } });
  const s = ecommerce.createSession("soldout.myshopify.com", { llmMode: true, clientId: "so-" + Math.random().toString(36).slice(2, 20), userMessage: "Wireless Bluetooth Earbuds chahiye", replyLanguage: "hinglish", history: [], cart: { currency: "INR", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => {} });
  const r = await s.handlers.search_products({ searchTerm: "Wireless Bluetooth Earbuds" });
  assert.equal(r.requestedItemSoldOut, "Wireless Bluetooth Earbuds");
  assert.ok((r.products || []).length > 0);
});

import { consistentAssistantVoice } from "../src/agent/textTidy.js";
test("assistant speaks of herself consistently in the feminine", () => {
  assert.equal(consistentAssistantVoice("Main connect kar raha hoon aur check karunga."), "Main connect kar rahi hoon aur check karungi.");
  assert.equal(consistentAssistantVoice("Main bata sakta hoon"), "Main bata sakti hoon");
  assert.equal(consistentAssistantVoice("मैं बताऊँगा"), "मैं बताऊँगी");
  assert.equal(consistentAssistantVoice("Your order is placed."), "Your order is placed.");
});
