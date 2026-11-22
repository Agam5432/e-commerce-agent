import test from "node:test";
import assert from "node:assert/strict";
import { dropDanglingListIntro } from "../src/agent/textTidy.js";

test("an introduction to a list that was cut out is removed with it", () => {
  const before = "I am sorry, but that dress is not available in size M. Since you are looking for something under $60, we have these other lovely items in stock that might catch your eye: Would you like to see more details for one of these, or should we keep looking?";
  const after = dropDanglingListIntro(before);
  assert.equal(after, "I am sorry, but that dress is not available in size M. Would you like to see more details for one of these, or should we keep looking?");
});

test("a real list keeps its introduction", () => {
  const text = "Here are the options:\n- **Savannah Maxi Dress** ($49.00): striped.\nWould you like it?";
  assert.equal(dropDanglingListIntro(text), text);
  assert.equal(dropDanglingListIntro("The **Savannah Maxi Dress** ($49.00): a classic. Would you like it?"), "The **Savannah Maxi Dress** ($49.00): a classic. Would you like it?");
});
