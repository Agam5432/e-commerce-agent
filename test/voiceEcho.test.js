// The assistant must not take its own voice for the shopper: what the microphone hears of it while it is still talking is
// ignored, a real interruption (different words) and a shopper answering after it has finished are not.
import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyEcho, speechWindowMs } from "../src/voice/transcriptUtils.js";

const ANSWER = "Of course, I'll help you with your complaint. Could you tell me which product arrived damaged and when you received it?";
const T0 = 1_000_000;

test("a speech recogniser's version of the assistant's own sentence is an echo while the assistant is speaking", () => {
  // dropped words, a different spelling, only a part of the sentence: none of them is an exact match
  for (const heard of [
    "of course i'll help you with your complaint",
    "help you with your complaint could you tell me which product arrived damaged",
    "of course I will help you with complaint could you tell me which product arrived damaged and when you received",
    "could you tell me which product arrived damaged",
  ]) assert.equal(isLikelyEcho(heard, ANSWER, T0, T0 + 1200), true, heard);
});

test("a Hinglish answer heard back from the speaker is an echo", () => {
  const answer = "Main aapki complaint raise kar rahi hoon, aap bas mujhe order number bata dijiye taaki main team ko poori jaankari de sakoon";
  assert.equal(isLikelyEcho("main aapki complaint raise kar rahi hoon aap bas mujhe order number", answer, T0, T0 + 900), true);
});

test("a real interruption is not an echo", () => {
  for (const heard of ["wait stop", "no no I already told you that twice", "nahi mujhe insaan se baat karni hai", "actually the product is a phone case"]) {
    assert.equal(isLikelyEcho(heard, ANSWER, T0, T0 + 1200), false, heard);
  }
});

test("the same words from a shopper who answers after the assistant has finished are an answer, not an echo", () => {
  const answer = "Is your shipping address the same as your billing address or would you like another?";
  const done = T0 + speechWindowMs(answer) + 500;
  assert.equal(isLikelyEcho("Shipping address is same as billing address", answer, T0, done), false);
  assert.equal(isLikelyEcho("Yeah, it is same", answer, T0, T0 + 600), false, "two or three words are never decided as an echo");
});

test("anything with numbers is the shopper (an address, a phone, a quantity)", () => {
  assert.equal(isLikelyEcho("My address is 10 New Road Delhi India 110001 please use this address", ANSWER, T0, T0 + 500), false);
});

test("the speaking window grows with the length of the answer and is bounded", () => {
  assert.ok(speechWindowMs(ANSWER) > speechWindowMs("Sure."));
  assert.ok(speechWindowMs("word ".repeat(500)) <= 45000);
});
