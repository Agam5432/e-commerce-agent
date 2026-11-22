// The shopper's own request for a person, or to put something in the cart, is recognised in English, Hinglish and Hindi,
// and an ordinary product question is not mistaken for one.
import test from "node:test";
import assert from "node:assert/strict";
import { asksForPerson, asksToAddToCart, connectingReply } from "../src/agent/requestGuards.js";

test("asking for a person", () => {
  for (const text of [
    "talk to a human", "connect me with someone from the team", "can I speak to a representative", "I want to talk to the store owner",
    "customer care se baat karni hai", "mujhe customer care se baat karni hai, kisi insaan se connect karo", "कस्टमर केयर से बात करनी है",
  ]) assert.equal(asksForPerson(text), true, text);
  for (const text of ["show me earbuds", "does it have a support belt?", "what is the team jersey price", "which bag is best", "do you have customer reviews"]) {
    assert.equal(asksForPerson(text), false, text);
  }
});

test("asking to add to the cart", () => {
  for (const text of ["add Ambrane 10000mAh power bank in black to cart", "black wala cart me daal do", "put it in my bag", "कार्ट में जोड़ दो"]) {
    assert.equal(asksToAddToCart(text), true, text);
  }
  for (const text of ["can I add it to cart?", "show my cart", "what is in my cart", "add this", "show me earbuds"]) {
    assert.equal(asksToAddToCart(text), false, text);
  }
});

test("the connecting line follows the reply language", () => {
  assert.match(connectingReply("en"), /connect you/);
  assert.match(connectingReply("hinglish"), /connect karne/);
  assert.match(connectingReply("hi"), /सपोर्ट/);
});
