// Found by the pillar 2/3 real-storefront run (2026-11-16): an exact product title returned "not in store", and a rule-based reply answered about the wrong product.
import test from "node:test";
import assert from "node:assert/strict";
import { filterProductsByVariantHints } from "../src/tools/shopify/words.js";
import ecommerce from "../src/industries/ecommerce.js";
import { writeCheckoutMemory } from "../src/industries/ecommerce/pricing.js";

const v = (title, sellable = true) => ({ title, sellable, price: "599.00", selectedOptions: [{ name: "Size", value: title.split(" / ")[0] }, { name: "Color", value: title.split(" / ")[1] }] });
const polo = { title: "Men's Navy Blue Polo T-Shirt", price: "599.00", variants: [v("S / Navy"), v("M / Navy")] };
const sky = { title: "Men's Cotton Polo T-Shirt - Sky Blue", price: "499.00", variants: [{ title: "Default Title", sellable: true, price: "499.00", selectedOptions: [] }] };

test("the exact title 'Men's Navy Blue Polo T-Shirt' finds the product (Navy Blue is one colour; the variant says Navy)", () => {
  const found = filterProductsByVariantHints([polo, sky], "Men's Navy Blue Polo T-Shirt", { gender: "men" });
  assert.deepEqual(found.map((p) => p.title), ["Men's Navy Blue Polo T-Shirt"]);
});

test("a colour the product does not have is still not matched (red polo -> nothing)", () => {
  assert.equal(filterProductsByVariantHints([polo, sky], "red polo t-shirt", {}).length, 0);
});

test("a colour named only in a product title never matches another colour's variant", () => {
  const redNamed = { title: "Red Tee", price: "10", variants: [v("M / Blue")] };
  assert.equal(filterProductsByVariantHints([redNamed], "red tee", {}).length, 0);
});

const ruleBased = (msg) => {
  const shown = { title: "Twilight Plum Ribbon Dress", price: "65.00", currency: "USD", variants: [{ title: "S", sellable: true, price: "65.00" }] };
  const clientId = "sel-" + Math.random().toString(36).slice(2);
  writeCheckoutMemory("sel.myshopify.com", clientId, { lastShownProducts: [shown] });
  return ecommerce.createSession("sel.myshopify.com", { llmMode: false, clientId, userMessage: msg, replyLanguage: "en", history: [{ role: "user", content: "show twilight" }], cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => null });
};

test("rule-based mode: choosing the shown product still works (positive control)", async () => {
  const session = ruleBased("the plum dress sounds good");
  await session.routeKnownIntent();
  assert.match(session.result().fallbackSpeech || "", /Twilight Plum/);
});

test("rule-based mode: asking about a DIFFERENT product is not treated as choosing the one just shown", async () => {
  const session = ruleBased("how much is the Savannah Maxi Dress?");
  await session.routeKnownIntent();
  assert.doesNotMatch(session.result().fallbackSpeech || "", /Twilight Plum/);
});
