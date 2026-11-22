import { test } from "node:test";
import assert from "node:assert/strict";
import { slimResultForModel, parseGroqRequestLimit, estimatePromptTokens } from "../src/agent/agent.js";
import { describeClaudeContent } from "../src/agent/claudeAdapter.js";
import ecommerce from "../src/industries/ecommerce.js";

test("multi search sends each product to the model once, without internal match scores", () => {
  const p = { title: "A", price: 1, matchConfidence: 0.9, unmatchedQueryWords: ["x"], notExactMatch: undefined };
  const raw = { mode: "multi", groups: [{ term: "a", found: 1, products: [p] }], products: [p] };
  const slim = slimResultForModel(raw);
  assert.equal(slim.products, undefined);
  assert.deepEqual(slim.groups[0].products[0], { title: "A", price: 1 });
  assert.ok(raw.products, "the original result (used for cards) is untouched");
});

test("a single search keeps its product list", () => {
  const slim = slimResultForModel({ status: "ok", products: [{ title: "A", matchConfidence: 1 }] });
  assert.deepEqual(slim.products, [{ title: "A" }]);
});

test("non-object results pass through", () => {
  assert.equal(slimResultForModel(null), null);
  assert.deepEqual(slimResultForModel([1]), [1]);
});

test("Groq 413 message gives its limit; other errors give none", () => {
  assert.equal(parseGroqRequestLimit(new Error("413 Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 10086")), 8000);
  assert.equal(parseGroqRequestLimit(new Error("429 rate limit")), 0);
});

test("prompt size estimate grows with content", () => {
  assert.ok(estimatePromptTokens([{ role: "user", content: "x".repeat(3500) }]) >= 1000);
});

test("Claude content summary names block types", () => {
  assert.equal(describeClaudeContent({ content: [{ type: "thinking" }, { type: "text" }, { type: "text" }] }), "thinkingx1, textx2");
  assert.equal(describeClaudeContent({}), "no content");
});

test("prompt asks for bullets and markdown links", () => {
  const prompt = ecommerce.buildSystemPrompt("s", { storeProfile: { storeName: "S" }, probeRan: true, probeProducts: [], profile: {}, replyLanguage: "hinglish" });
  assert.match(prompt, /BULLETS, NOT PARAGRAPHS/);
  assert.match(prompt, /\[short label\]\(https:\/\/url\)/);
});

test("card-only fields (image, raw variants) never reach the model, readable options do", () => {
  const slim = slimResultForModel({ products: [{ title: "A", image: "https://x/i.png", variants: [{ id: "1" }], cardMode: "comparison", options: [{ name: "Navy" }], price: 5 }] });
  assert.deepEqual(slim.products[0], { title: "A", options: [{ name: "Navy" }], price: 5 });
});

test("prompt size estimate counts the tool schemas that are sent with it", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.ok(estimatePromptTokens(msgs, [{ function: { name: "x".repeat(3500) } }]) > estimatePromptTokens(msgs) + 900);
});
