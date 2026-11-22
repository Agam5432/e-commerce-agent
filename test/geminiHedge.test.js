// A first-choice Gemini model that is slow (but does answer) must not hold the shopper: after GEMINI_HEDGE_MS the next model is
// asked too and the first answer is used. Live TechStore, 2026-11-22: gemini-3.1-flash-lite sat 7 s before failing over.
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.GEMINI_MODEL = "slow-model";
process.env.GEMINI_FALLBACK_MODELS = "quick-model";
process.env.GEMINI_TIMEOUT_MS = "9000";
process.env.GEMINI_FAILOVER_TIMEOUT_MS = "8000";
process.env.GEMINI_HEDGE_MS = "1500";
const { runAgent, isFallbackAnswer, __setLLMClientsForTest } = await import("../src/agent/agent.js");
const { installRealStore, freshClientId } = await import("./helpers/agentHarness.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });

const textReply = (text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], usageMetadata: {} });
const ask = () => runAgent("hello", "hedge.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });

test("a slow first model is hedged: the next model is asked after the hedge time and its answer is used", async () => {
  const asked = [];
  let slowCancelled = false;
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    asked.push(req.model);
    if (!req.config?.systemInstruction) return Promise.resolve(textReply("SAME"));
    if (req.model === "slow-model") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(textReply("Slow hello")), 6000);
        req.config.abortSignal?.addEventListener?.("abort", () => { slowCancelled = true; clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    }
    return Promise.resolve(textReply("Hello! What can I get you today?"));
  } } } });
  const started = Date.now();
  const out = await ask();
  const took = Date.now() - started;
  assert.equal(isFallbackAnswer(out.answer), false);
  assert.match(out.answer, /What can I get you/);
  assert.ok(took < 4500, `the turn took ${took} ms`);
  assert.ok(asked.includes("quick-model"));
  assert.equal(slowCancelled, true, "the slower call is cancelled");
});

test("a first model that answers before the hedge time is the only one asked", async () => {
  const asked = [];
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    if (req.config?.systemInstruction) asked.push(req.model);
    return Promise.resolve(textReply("Hi there! Looking for anything special?"));
  } } } });
  const out = await ask();
  assert.match(out.answer, /Looking for/);
  assert.ok(asked.length > 0 && asked.every((m) => m === asked[0]), asked.join(","));
});

test("when the first model fails, the backup still gets its own full wait, and the first is paused only once", async () => {
  let quickStarted = 0;
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    if (!req.config?.systemInstruction) return Promise.resolve(textReply("SAME"));
    if (req.model === "slow-model") return Promise.reject(Object.assign(new Error("503 high demand"), { status: 503 }));
    quickStarted = Date.now();
    return new Promise((resolve) => setTimeout(() => resolve(textReply("Hey! Kya dhoondh rahe hain aaj?")), 300));
  } } } });
  const out = await ask();
  assert.ok(quickStarted > 0);
  assert.match(out.answer, /dhoondh/);
});

test("with the other model paused after a timeout, it is still asked as the backup when the only healthy model fails", async () => {
  const { modelHealth } = await import("../src/agent/core/config.js");
  modelHealth.fail("gemini", "slow-model", Object.assign(new Error("Gemini(slow-model) hard timeout after 8000ms"), { name: "AbortError" }));
  modelHealth.success("gemini", "quick-model");
  const asked = [];
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    if (!req.config?.systemInstruction) return Promise.resolve(textReply("SAME"));
    asked.push(req.model);
    if (req.model === "quick-model") return Promise.reject(Object.assign(new Error('{"error":{"code":500,"message":"Internal error encountered."}}'), { status: 500 }));
    return Promise.resolve(textReply("Aapka cart abhi khaali hai. Kuch dikhaun?"));
  } } } });
  const out = await ask();
  assert.equal(isFallbackAnswer(out.answer), false, out.answer);
  assert.ok(asked.includes("slow-model"), asked.join(","));
});
