import test from "node:test";
import assert from "node:assert/strict";
import { budgetSourceMessage } from "../src/agent/budgetScope.js";

const history = [{ role: "user", content: "black sneakers size 9 under $100" }, { role: "assistant", content: "Our sneakers start at $1,799." }];
test("a new full question does not inherit an earlier budget", () => {
  assert.equal(budgetSourceMessage("compare Samsung Galaxy A55 and OnePlus Nord CE4", history), null);
  assert.equal(budgetSourceMessage("which laptop is compatible with a 15.6 inch bag?", history), null);
});
test("a short refinement keeps the budget of the previous request, and a message with its own budget uses it", () => {
  assert.equal(budgetSourceMessage("in black please", history), "black sneakers size 9 under $100");
  assert.equal(budgetSourceMessage("show phones under $300", history), "show phones under $300");
});

test("a short request for another kind of product does not take the earlier product's budget; a budget asked on its own does carry", () => {
  const phones = [{ role: "user", content: "phones under 45000" }, { role: "assistant", content: "Here are three phones." }];
  assert.equal(budgetSourceMessage("laptop dikhao", phones), null);
  assert.equal(budgetSourceMessage("black wala", phones), "phones under 45000");
  const generic = [{ role: "user", content: "1000 rupaye ke andar kya mil sakta hai?" }, { role: "assistant", content: "Nothing under 1000." }];
  assert.equal(budgetSourceMessage("mujhe ek t-shirt chahiye", generic), "1000 rupaye ke andar kya mil sakta hai?");
});
