import test from "node:test";
import assert from "node:assert/strict";
import { claimsCartChange } from "../src/agent/factGuard.js";

test("replies that say the cart was changed are recognised", () => {
  for (const text of [
    "Done, I have added another pair of Nike Revolution 7 Running Shoes to your cart, making it two pairs in total.",
    "I removed the shoes from your cart.",
    "Your cart has been updated.",
    "Maine Nike shoes cart me daal diya hai.",
    "Shoes cart se hata diye.",
    "Ek aur pair add kar diya.",
    "मैंने जूते आपके कार्ट में जोड़ दिए।".replace("दिए।", "दिया।"),
  ]) assert.equal(claimsCartChange(text), true, text);
});

test("showing, asking about or describing the cart is not a claim", () => {
  for (const text of [
    "Here is a look at your cart.",
    "Your cart is already empty! Would you like to look at shoes?",
    "Would you like me to add it to your cart?",
    "Kya main ise cart me daal du?",
    "Sizes 7 to 10 are available. Which size should I add?",
    "The Nike Revolution 7 is available in Black and Grey.",
  ]) assert.equal(claimsCartChange(text), false, text);
});

// Seen in the storefront: add_to_cart answered "which colour?" (nothing was added), the reply said
// "I have added the boAt Airdopes 141 Earbuds ($19.00) to your cart" and the next turn showed an empty cart.
// The dot inside the price ended the sentence for the check, so the false claim went through.
test("a false 'added to your cart' is still caught when a price with decimals sits inside the sentence", () => {
  for (const text of [
    "I have added the boAt Airdopes 141 Earbuds ($19.00) to your cart. They are available in Bold Black and Cool Grey.",
    "Added the Samsung Galaxy A55 5G (₹42,999.00) to your cart!",
    "Maine boAt Airdopes 141 (₹1,299.00) cart mein daal diya hai.",
  ]) assert.equal(claimsCartChange(text), true, text);
  assert.equal(claimsCartChange("The boAt Airdopes 141 cost $19.00. Would you like them in your cart?"), false);
});
