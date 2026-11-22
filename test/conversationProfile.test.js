import test from "node:test";
import assert from "node:assert/strict";
import { personalGender, updateProfile, resolveShoppingGender, prepareConversation, wantsTravelRecommendations } from "../src/services/conversationProfile.js";

test("a complaint mentioning women's recommendations still preserves the user's explicit male preference", () => {
  const message = "You know I am a guy then why show me women t-shirts and all women stuff";
  assert.equal(personalGender(message), "men");
  assert.equal(resolveShoppingGender(message), "men");
  assert.equal(resolveShoppingGender("show shirts", [], updateProfile({}, message)), "men");
});
test("names and assistant guesses cannot establish the customer's gender", () => {
  assert.equal(resolveShoppingGender("show shirts", [{ role: "assistant", content: "Your name means you are a guy" }]), "");
  assert.equal(personalGender("My name is Agam"), "");
});
test("gender preference survives long conversations and a restarted process", async () => {
  let stored = null;
  const io = { load: async () => stored, save: async (shop, client, patch) => { stored = { ...stored, ...patch }; } };
  await prepareConversation("test.myshopify.com", "buyer-1", "I am a guy", [], null, io);
  const restored = await prepareConversation("test.myshopify.com", "buyer-1", "show shirts", [], null, io);
  assert.equal(resolveShoppingGender("show shirts", [], restored.profile), "men");
});
test("whole-trip request and a correction stay broad; a specific product request stays specific", () => {
  assert.equal(wantsTravelRecommendations("I am travelling from India to US and want products useful in my complete whole trip"), true);
  assert.equal(wantsTravelRecommendations("I am looking for products, not a specific product", [], { useCase: "travel" }), true);
  assert.equal(wantsTravelRecommendations("show me shirts", [], { useCase: "travel" }), false);
});
test("stored checkout state takes precedence over a stale browser address", async () => {
  const shipping = { address1: "10 New Road" };
  const result = await prepareConversation("test.myshopify.com", "buyer-1", "my address?", [], { shipping: { address1: "Old profile address" } }, { load: async () => ({ shipping }), save: async () => {} });
  assert.deepEqual(result.shipping, shipping);
});
test("older history cannot undo an already-saved gender preference", async () => {
  const result = await prepareConversation("test.myshopify.com", "buyer-1", "show more options", [{ role: "user", content: "for my wife" }], null, { load: async () => ({ profile: { gender: "men", shoppingGender: "men" } }), save: async () => {} });
  assert.equal(result.profile.shoppingGender, "men");
});


test("own travel request clears a gift recipient without guessing personal gender", () => {
  const gift = updateProfile({}, "I want to purchase products for my girlfriend");
  assert.equal(gift.shoppingGender, "women");
  const travel = updateProfile(gift, "I am travelling from India to US and want products from your store");
  assert.equal(travel.shoppingGender, "");
  assert.equal(resolveShoppingGender("show useful products", [{ role: "user", content: "for my girlfriend" }], travel), "");
  assert.equal(travel.gender, undefined);
});

test("own clothing preference survives gifting and a men's correction overrides a why complaint", () => {
  let profile = updateProfile({}, "show me men's red t-shirt");
  profile = updateProfile(profile, "I want a gift for my girlfriend");
  profile = updateProfile(profile, "I am travelling and need useful products");
  assert.equal(profile.shoppingGender, "men");
  const correction = "if I am asking travelling products then why you shouldn't like you should suggest some men's product also";
  assert.equal(resolveShoppingGender(correction, [], { shoppingGender: "women" }), "men");
  assert.equal(updateProfile({}, correction).gender, undefined);
});


test("a correction does not adopt the clothing category that the shopper explicitly rejects", () => {
  assert.equal(resolveShoppingGender("don't show women's products", [], { shoppingGender: "men" }), "men");
  assert.equal(resolveShoppingGender("don't show women's products, show me men's products", [], { shoppingGender: "women" }), "men");
});
