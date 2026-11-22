// A reply that lists products the chat already showed ("show me again what you found") used to arrive with no cards at all (real storefront, 2026-11-17).
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { writeCheckoutMemory } from "../src/industries/ecommerce/pricing.js";
import { productsMentionedInAnswer } from "../src/agent/cardSelection.js";

const make = (clientId) => ecommerce.createSession("again.myshopify.com", { llmMode: true, clientId, userMessage: "show me again what you found", replyLanguage: "en", history: [], cart: { currency: "USD", items: [] } }, { loadCheckout: async () => null, saveCheckout: async () => {} });

test("the chat's most recently shown products come back as cards, and only the ones a reply names are picked", () => {
  const clientId = "again-" + Math.random().toString(36).slice(2);
  writeCheckoutMemory("again.myshopify.com", clientId, { lastShownProducts: [
    { id: "1", title: "Nike Revolution 7 Running Shoes", price: "69.00", currency: "USD", variants: [] },
    { id: "2", title: "Adidas Duramo SL Running Shoes", price: "65.00", currency: "USD", variants: [] },
    { id: "3", title: "Puma Softride Sports Shoes", price: "55.00", currency: "USD", variants: [] },
  ] });
  const cards = make(clientId).recentlyShownCards();
  assert.equal(cards.length, 3);
  const named = productsMentionedInAnswer(cards, "Here they are again: **Nike Revolution 7 Running Shoes** ($69.00) and **Puma Softride Sports Shoes** ($55.00).", { strict: true, nameRun: true });
  assert.deepEqual(named.map((c) => c.title), ["Nike Revolution 7 Running Shoes", "Puma Softride Sports Shoes"]);
  assert.deepEqual(productsMentionedInAnswer(cards, "Our return policy is 30 days.", { strict: true, nameRun: true }), []);
});

test("a chat that showed nothing has no cards to bring back", () => {
  assert.deepEqual(make("again-none-" + Math.random().toString(36).slice(2)).recentlyShownCards(), []);
});
