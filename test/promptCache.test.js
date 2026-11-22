// Prompt caching: the fixed part of the system prompt (everything before LIVE CONTEXT) must be the same
// for every turn of a store, whatever the cart, the customer, the message or the time. Claude caches it
// explicitly (cache_control) and Gemini/Groq cache an unchanged prefix on their own; one per-turn value in
// it would make every turn a cache miss and silently raise the AI bill. Cached tokens are reported in
// /metrics as llm_tokens_total{kind="cached"}.
import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import { LIVE_CONTEXT_MARKER, toClaudeSystem, toClaudeTools } from "../src/agent/claudeAdapter.js";

const store = { storeProfile: { storeName: "Gada Electronics" }, storeCurrency: "INR", settings: {} };
const fixedPart = (context) => {
  const prompt = ecommerce.buildSystemPrompt("gada.myshopify.com", { ...store, ...context });
  const at = prompt.indexOf(LIVE_CONTEXT_MARKER);
  assert.ok(at > 0, "the prompt has a LIVE CONTEXT section");
  return prompt.slice(0, at);
};

test("the fixed part of the prompt is identical across very different turns of one store", () => {
  const a = fixedPart({ cart: { items: [], currency: "INR" }, history: [], userMessage: "hi" });
  const b = fixedPart({
    cart: { currency: "INR", items: [{ title: "Smart TV", variant_title: "55 inch", quantity: 1, line_price: 4999900 }] },
    customer: { name: "Asha", email: "asha@example.com" },
    history: [{ role: "user", content: "TV dikhao" }, { role: "assistant", content: "Yeh rahe TVs" }],
    userMessage: "mujhe 55 inch wala chahiye, address 12 MG Road",
    replyLanguage: "hinglish",
    profile: { recipient: "self" },
    inferredGender: "women",
  });
  assert.equal(a, b);
  assert.ok(a.length > 4000, "large enough to be worth caching");
});

test("Claude gets the fixed part and the tool list marked for caching, the live part unmarked", () => {
  const prompt = ecommerce.buildSystemPrompt("gada.myshopify.com", { ...store, cart: { items: [] } });
  const blocks = toClaudeSystem(prompt);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  assert.equal(blocks[1].cache_control, undefined);
  assert.ok(blocks[1].text.startsWith(LIVE_CONTEXT_MARKER));
  const tools = toClaudeTools(ecommerce.toolDefinitions);
  assert.deepEqual(tools.at(-1).cache_control, { type: "ephemeral" });
  assert.ok(tools.slice(0, -1).every((t) => !t.cache_control), "one marker, at the end of the list");
});

test("the tool list is the same, in the same order, for every turn", () => {
  const names = () => ecommerce.toolDefinitions.map((t) => t.function.name).join(",");
  assert.equal(names(), names());
  assert.equal(new Set(ecommerce.toolDefinitions.map((t) => t.function.name)).size, ecommerce.toolDefinitions.length);
});
