// A provider's rate limit (429) is waited out, not shown to the shopper as "trouble connecting".
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isLanguageCheck } from "./helpers/languageCheck.js";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
process.env.RATE_LIMIT_MAX_WAIT_MS = "6000";
const { runAgent, generateText, isFallbackAnswer, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { modelHealth, GEMINI_FALLBACK_MODELS } = await import("../src/agent/core/config.js");
const { retryAfterMs, isRateLimitError, rateLimitWait, createPacer, sleep } = await import("../src/agent/core/retry.js");
const { createModelHealth } = await import("../src/agent/modelHealth.js");
const { installRealStore, freshClientId } = await import("./helpers/agentHarness.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });
const resetHealth = () => { for (const m of GEMINI_FALLBACK_MODELS) modelHealth.success("gemini", m); };
beforeEach(() => { __resetProviderBlocksForTest(); resetHealth(); });

const limited = (seconds) => Object.assign(new Error(`{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"${seconds}s"}]}}`), { status: 429 });
const textReply = (text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], usageMetadata: {} });
const claudeSaying = (text) => ({ calls: 0, messages: { async create() { this.calls++; return { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }; } } });
const ask = (signal) => runAgent("hello", "ratelimit.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] }, signal });

test("the wait a provider asks for is read from the header or the error text", () => {
  assert.equal(retryAfterMs({ headers: { "retry-after": "7" } }), 7000);
  assert.equal(retryAfterMs({ headers: new Map([["retry-after", "3"]]) }), 3000);
  assert.equal(retryAfterMs(limited(23)), 23000);
  assert.equal(retryAfterMs(new Error("429: Please retry in 2.5s.")), 2500);
  assert.equal(retryAfterMs(new Error("retry after 500 ms")), 500);
  assert.equal(retryAfterMs(new Error("boom")), 0);
  assert.equal(retryAfterMs(null), 0);
});

test("rate-limit errors are recognised, other errors are not", () => {
  assert.equal(isRateLimitError({ status: 429 }), true);
  assert.equal(isRateLimitError(new Error("RESOURCE_EXHAUSTED: quota")), true);
  assert.equal(isRateLimitError(new Error("503 unavailable")), false);
  assert.equal(isRateLimitError(new Error("API key not valid")), false);
});

test("a wait is taken only when it fits the budget", () => {
  assert.equal(rateLimitWait({ error: limited(2), maxTotalMs: 6000 }), 2000);
  assert.equal(rateLimitWait({ error: limited(30), maxTotalMs: 6000 }), 0, "asked for longer than the budget");
  assert.equal(rateLimitWait({ error: new Error("429"), fallbackMs: 1500, maxTotalMs: 6000 }), 1500, "no hint: a short default");
  assert.equal(rateLimitWait({ error: limited(2), spentMs: 5000, maxTotalMs: 6000 }), 0, "budget used up");
});

test("pacing lets at most N calls start per minute and is off by default", () => {
  let now = 0;
  const off = createPacer({ now: () => now });
  assert.equal(off.claim(), 0);
  const pacer = createPacer({ maxPerMinute: 2, now: () => now });
  assert.equal(pacer.claim(), 0);
  assert.equal(pacer.claim(), 0);
  assert.equal(pacer.claim(), 60000);
  now = 59000;
  assert.equal(pacer.claim(), 1000);
  now = 60000;
  assert.equal(pacer.claim(), 0);
});

test("a sleep ends at once when the turn is cancelled", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await assert.rejects(sleep(5000, controller.signal), /cancelled/);
  assert.ok(Date.now() - started < 1000);
});

test("model health tells a rate-limit pause from an outage, and forgets it when asked", () => {
  let now = 0;
  const health = createModelHealth(() => now);
  health.fail("gemini", "a", limited(20));
  health.fail("gemini", "b", new Error("503 unavailable"));
  assert.equal(health.fail("gemini", "c", limited(1)), 5000);
  assert.equal(health.rateLimited("gemini", "a"), true);
  assert.equal(health.rateLimited("gemini", "b"), false);
  assert.equal(health.retryInMs("gemini", "a"), 20000);
  health.clearRateLimits("gemini", ["a", "b", "c"]);
  assert.equal(health.available("gemini", "a"), true);
  assert.equal(health.available("gemini", "b"), false, "an outage stays paused");
});

test("every Gemini model rate limited: the turn waits what Gemini asked, then answers", async () => {
  let calls = 0;
  __setLLMClientsForTest({ gemini: { models: { generateContent: async (req) => { if (isLanguageCheck(req)) return textReply("SAME"); calls++; if (calls <= GEMINI_FALLBACK_MODELS.length) throw limited(1); return textReply("Namaste! Kya dhoondh rahe hain?"); } } } });
  const started = Date.now();
  const r = await ask();
  assert.equal(r.answer, "Namaste! Kya dhoondh rahe hain?");
  assert.equal(isFallbackAnswer(r.answer), false);
  assert.ok(Date.now() - started >= 900, "it waited for the retry-after");
  assert.equal(calls, GEMINI_FALLBACK_MODELS.length + 1);
});

test("a model paused by an earlier turn's rate limit is waited for, not skipped", async () => {
  for (const m of GEMINI_FALLBACK_MODELS) modelHealth.fail("gemini", m, limited(2));
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => textReply("Wapas aa gaya.") } } });
  const started = Date.now();
  const r = await ask();
  assert.equal(r.answer, "Wapas aa gaya.");
  assert.ok(Date.now() - started >= 1500);
});

test("when Gemini asks for longer than the budget, the turn goes to Claude at once instead of waiting", async () => {
  const claude = claudeSaying("Claude ne sambhal liya.");
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw limited(120); } } }, claude });
  const started = Date.now();
  const r = await ask();
  assert.equal(r.answer, "Claude ne sambhal liya.");
  assert.ok(Date.now() - started < 4000);
});

test("with nobody else to answer and a very long wait, the honest fallback comes quickly (no 2-minute hang)", async () => {
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw limited(120); } } } });
  const started = Date.now();
  const r = await ask();
  assert.equal(isFallbackAnswer(r.answer), true);
  assert.ok(Date.now() - started < 4000);
});

test("cancelling the chat during the wait ends the turn at once", async () => {
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw limited(5); } } } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Run cancelled")), 300);
  const started = Date.now();
  await assert.rejects(ask(controller.signal));
  assert.ok(Date.now() - started < 3500);
});

test("a short side call (meaning match, greeting) tries once more after a 429 instead of silently returning nothing", async () => {
  let calls = 0;
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { calls++; if (calls === 1) throw limited(1); return textReply('["Power Banks"]'); } } } });
  const text = await generateText("which type?", { timeoutMs: 6000, label: "need_match" });
  assert.equal(text, '["Power Banks"]');
  assert.equal(calls, 2);
});

// S12: one "busy" answer (503) from each Gemini model used to pause the provider for 30 s or more; with no Claude key
// every shopper of every store got "trouble connecting" for that long without a single real attempt.
test("models paused only by a busy answer (503) are probed again on the next turn instead of an instant fallback", async () => {
  const busy = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
  for (const m of GEMINI_FALLBACK_MODELS) modelHealth.fail("gemini", m, busy);
  let calls = 0;
  __setLLMClientsForTest({ gemini: { models: { generateContent: async (req) => { if (isLanguageCheck(req)) return textReply("SAME"); calls++; return textReply("Haan ji, bataiye!"); } } } });
  const r = await ask();
  assert.equal(r.answer, "Haan ji, bataiye!");
  assert.equal(calls, 1);
});

test("a retired model, a rejected key or a timeout is never probed (the pause stays)", () => {
  let now = 0;
  const health = createModelHealth(() => now);
  health.fail("gemini", "busy", new Error("503 unavailable"));
  health.fail("gemini", "gone", { status: 404, message: "no longer available" });
  health.fail("gemini", "key", { status: 401, message: "bad key" });
  health.fail("gemini", "slow", new Error("hard timeout"));
  health.fail("gemini", "limited", limited(30));
  assert.deepEqual(["busy", "gone", "key", "slow", "limited"].map((m) => health.busyOnly("gemini", m)), [true, false, false, false, false]);
  now += 30000;
  assert.equal(health.busyOnly("gemini", "busy"), false, "after the pause it is simply available again");
});

// S13: side calls (meaning match, same-kind check) always called the light model, even while it was answering
// "busy", and never tried another Gemini model: one search waited two full timeouts (8 to 11 s) for nothing.
test("a side call moves to the next healthy Gemini model when the light model is busy, and remembers it", async () => {
  __resetProviderBlocksForTest();
  const asked = [];
  __setLLMClientsForTest({ gemini: { models: { generateContent: async (req) => {
    asked.push(req.model);
    if (asked.length === 1) throw new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
    return textReply("yes");
  } } } });
  assert.equal(await generateText("same kind?", { timeoutMs: 4000, label: "same_kind" }), "yes");
  assert.equal(asked.length, 2);
  assert.notEqual(asked[1], asked[0], "the second try used a different model");
  // the next side call does not go back to the model that just said it is busy
  assert.equal(await generateText("same kind?", { timeoutMs: 4000, label: "same_kind" }), "yes");
  assert.equal(asked[2], asked[1]);
});

// S16: after S13 a side call that ran out of its own short time paused the model for everyone. In the storefront the
// suggestion call timed out and the next "hi" got the connection-trouble line in 0.2 s; a search waited two timeouts.
test("a side call that runs out of time does not pause the model and does not wait twice", async () => {
  __resetProviderBlocksForTest();
  const asked = [];
  let hang = true;
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    asked.push(req.model);
    return hang ? new Promise(() => {}) : Promise.resolve(textReply("yes"));
  } } } });
  const started = Date.now();
  assert.equal(await generateText("same kind?", { timeoutMs: 300, label: "same_kind" }), "");
  const took = Date.now() - started;
  assert.ok(took < 550, "one time budget for the whole side call, it took " + took + " ms");
  assert.equal(asked.length, 1, "no second try after the time ran out");
  hang = false;
  assert.equal(await generateText("same kind?", { timeoutMs: 300, label: "same_kind" }), "yes");
  assert.equal(asked[1], asked[0], "the model was not paused by the side call's own timeout");
});
