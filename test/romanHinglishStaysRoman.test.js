import test from "node:test";
import assert from "node:assert/strict";
import { withLanguageNote } from "../src/agent/core/turnPrep.js";
import { buildSystemPrompt } from "../src/industries/ecommerce/systemPrompt.js";

test("the per-message language note keeps Roman-letter Hindi in Roman letters", () => {
  const note = withLanguageNote("20000 se 30000 ke beech phone", "en", false);
  assert.match(note, /Hinglish written in Roman letters only, never in Devanagari/);
  assert.match(note, /only if THIS message itself contains Devanagari letters/);
});

test("a locked choice of Hindi still means Devanagari", () => {
  assert.match(withLanguageNote("hello", "hi", true), /Hindi \(Devanagari\)/);
});

test("the system prompt says Roman Hindi never turns into Devanagari", () => {
  const prompt = buildSystemPrompt({ replyLanguage: "en", storeName: "Test", agentName: "Aria" });
  assert.match(prompt, /never switch to Devanagari unless the customer's message itself contains Devanagari letters/);
});

test("the model is told never to invent a price limit for cheap", async () => {
  const { toolDefinitions } = await import("../src/industries/ecommerce/toolDefinitions.js");
  const prompt = buildSystemPrompt({ replyLanguage: "en", storeName: "Test", agentName: "Aria" });
  assert.match(prompt, /Never invent a price limit/);
  assert.match(JSON.stringify(toolDefinitions), /ONLY when the customer states a budget in numbers/);
});

test("the prompt names the shop's own item for another name and forbids unrelated substitutes", () => {
  const prompt = buildSystemPrompt({ replyLanguage: "en", storeName: "Test", agentName: "Aria" });
  assert.match(prompt, /a portable charger is a power bank/);
  assert.match(prompt, /never suggest an unrelated category/);
});
