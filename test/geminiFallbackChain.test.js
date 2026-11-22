// Gemini 3.1 flash lite first (faster in live tests), then 3.5 flash lite; Groq is no longer a provider.
import test from "node:test";
import assert from "node:assert/strict";

async function loadConfig(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k] === undefined ? "" : env[k]; }
  try { return await import(`../src/agent/core/config.js?case=${Math.random()}`); }
  finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("by default Gemini 3.1 flash lite is tried first and 3.5 flash lite is the fallback", async () => {
  const c = await loadConfig({ GEMINI_MODEL: undefined, GEMINI_FALLBACK_MODELS: "", LLM_PROVIDER: undefined, LLM_PRIMARY: undefined, LLM_SECONDARY: undefined });
  assert.deepEqual(c.GEMINI_FALLBACK_MODELS, ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
  assert.equal(c.LLM_PRIMARY, "gemini");
  assert.equal(c.LLM_SECONDARY, "claude");
});

test("groq in an old .env is ignored instead of being used", async () => {
  const c = await loadConfig({ LLM_PRIMARY: "gemini", LLM_SECONDARY: "groq", LLM_PROVIDER: undefined });
  assert.equal(c.LLM_SECONDARY, "claude");
  const c2 = await loadConfig({ LLM_PROVIDER: "groq", LLM_SECONDARY: undefined });
  assert.equal(c2.LLM_PRIMARY, "gemini");
});

test("models from the environment still win, and the fallback list has no duplicates", async () => {
  const c = await loadConfig({ GEMINI_MODEL: "gemini-3.1-flash-lite", GEMINI_FALLBACK_MODELS: "gemini-3.1-flash-lite" });
  assert.deepEqual(c.GEMINI_FALLBACK_MODELS, ["gemini-3.1-flash-lite"]);
});
