// Claude as an AI provider: the translation to and from Anthropic's format, the real agent loop
// running on it (tool call, then the AI-written reply), and the order in which providers are tried.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LIVE_CONTEXT_MARKER, buildClaudeRequest, claudeUsage, createClaudeClient, parseClaudeResponse, toClaudeMessages, toClaudeSystem, toClaudeTools } from "../src/agent/claudeAdapter.js";

// The provider order is read when the agent loads, so set it first (each test file runs in its own process).
process.env.LLM_PRIMARY = "claude";
process.env.LLM_SECONDARY = "gemini";
const { runAgent, __setLLMClientsForTest, generateGreeting } = await import("../src/agent/agent.js");
const { GEMINI_FALLBACK_MODELS } = await import("../src/agent/core/config.js");
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { isLanguageCheck } from "./helpers/languageCheck.js";

const tool = (name, props = {}, required = []) => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: props, required } } });

// ---- translation ---------------------------------------------------------------------------------
test("tools are sent in Anthropic's shape and only the last one carries the cache marker", () => {
  const out = toClaudeTools([tool("a", { x: { type: "string" } }, ["x"]), tool("b")]);
  assert.deepEqual(out.map((t) => t.name), ["a", "b"]);
  assert.deepEqual(out[0].input_schema.required, ["x"]);
  assert.equal(out[0].cache_control, undefined);
  assert.deepEqual(out[1].cache_control, { type: "ephemeral" });
  assert.deepEqual(toClaudeTools([]), []);
});

test("history becomes system + alternating turns, with tool results returned in one user turn before any note", () => {
  const { system, messages } = toClaudeMessages([
    { role: "system", content: "You are Orbi." },
    { role: "user", content: "show tv" },
    { role: "assistant", content: "Looking.", tool_calls: [{ id: "t1", type: "function", function: { name: "search_products", arguments: '{"searchTerm":"tv"}' } }, { id: "t2", type: "function", function: { name: "get_cart", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: '{"ok":1}' },
    { role: "tool", tool_call_id: "t2", content: "{}" },
    { role: "user", content: "[note] write the reply" },
  ]);
  assert.equal(system, "You are Orbi.");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[1].content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(messages[1].content[1].input, { searchTerm: "tv" });
  assert.deepEqual(messages[2].content.map((b) => b.type), ["tool_result", "tool_result", "text"]);
  assert.equal(messages[2].content[0].tool_use_id, "t1");
});

test("a tool call with broken arguments is sent as an empty input, not a crash", () => {
  const { messages } = toClaudeMessages([{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "n", arguments: "{oops" } }] }]);
  assert.deepEqual(messages[1].content[0].input, {});
});

test("the reply-only round keeps the tools (Anthropic requires them) with calling switched off, and caches the system prompt", () => {
  const history = [{ role: "system", content: "S" }, { role: "user", content: "hi" }];
  const normal = buildClaudeRequest({ model: "m", history, tools: [tool("a")], maxTokens: 100, temperature: 0.5 });
  const final = buildClaudeRequest({ model: "m", history, tools: [tool("a")], forceFinal: true, maxTokens: 100, temperature: 0.5 });
  assert.deepEqual(normal.tool_choice, { type: "auto" });
  assert.deepEqual(final.tool_choice, { type: "none" });
  assert.deepEqual(final.tools, normal.tools);
  assert.deepEqual(normal.system[0].cache_control, { type: "ephemeral" });
  assert.equal(normal.max_tokens, 100);
  assert.equal(buildClaudeRequest({ model: "m", history, tools: [], maxTokens: 5 }).tools, undefined);
  assert.equal("temperature" in buildClaudeRequest({ model: "m", history, tools: [], maxTokens: 5 }), false);
});

test("only the fixed rules are cached; the part that changes every turn is not", () => {
  const [fixed, live] = toClaudeSystem(`RULES...${LIVE_CONTEXT_MARKER}changes every turn)\nCART: 1 item`);
  assert.equal(fixed.text, "RULES...");
  assert.deepEqual(fixed.cache_control, { type: "ephemeral" });
  assert.match(live.text, /^\nLIVE CONTEXT \(/);
  assert.equal(live.cache_control, undefined);
  const plain = toClaudeSystem("no live part");
  assert.equal(plain.length, 1);
  assert.deepEqual(plain[0].cache_control, { type: "ephemeral" });
});

test("the store's real prompt keeps its fixed part identical from turn to turn, so the cache is hit", () => {
  const ctx = (n, lang) => ({ catalogProductCount: 40, storeProfile: { storeName: "T" }, probeRan: true, profile: {}, replyLanguage: lang, cart: { items: [], currency: "USD" },
    probeProducts: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Item ${i}`, price: 10 + i, currency: "USD", available: true, handle: `h${i}`, variants: [{ title: "D", price: 10 }] })) });
  const a = toClaudeSystem(ecommerce.buildSystemPrompt("same.myshopify.com", ctx(5, "en")));
  const b = toClaudeSystem(ecommerce.buildSystemPrompt("same.myshopify.com", ctx(2, "hi")));
  assert.equal(a.length, 2, "the prompt has a LIVE CONTEXT part");
  assert.equal(a[0].text, b[0].text);
  assert.ok(a[0].text.length > 10000, "most of the prompt is in the cached part");
  assert.notEqual(a[1].text, b[1].text);
});

test("a Claude reply is read into text, tool calls and the history entry", () => {
  const out = parseClaudeResponse({ content: [{ type: "text", text: "Sure " }, { type: "text", text: "thing" }, { type: "tool_use", id: "u1", name: "search_products", input: { searchTerm: "tv" } }, { type: "tool_use", id: "u2", name: "b", input: {} }], stop_reason: "tool_use" }, { maxToolCalls: 1 });
  assert.equal(out.text, "Sure thing");
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0], { id: "u1", name: "search_products", arguments: '{"searchTerm":"tv"}', rawArguments: '{"searchTerm":"tv"}' });
  assert.equal(out.assistantMessage.tool_calls[0].function.name, "search_products");
  assert.deepEqual(parseClaudeResponse({}).toolCalls, []);
});

test("token counts include cached prompt tokens so the log matches what the other providers report", () => {
  assert.deepEqual(claudeUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 30 }), { prompt_tokens: 1050, completion_tokens: 30, cachedContentTokenCount: 900 });
  assert.deepEqual(claudeUsage(undefined), { prompt_tokens: 0, completion_tokens: 0, cachedContentTokenCount: 0 });
});

// ---- the HTTP client -----------------------------------------------------------------------------
test("the client sends the key and version headers and reports the HTTP status in errors", async () => {
  const seen = [];
  const ok = createClaudeClient({ apiKey: "k", fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ content: [] }) }; } });
  await ok.messages.create({ model: "m", max_tokens: 1, messages: [] });
  assert.equal(seen[0].init.headers["x-api-key"], "k");
  assert.equal(seen[0].init.headers["anthropic-version"], "2023-06-01");
  const down = createClaudeClient({ apiKey: "k", sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "slow down" } }) }) });
  await assert.rejects(() => down.messages.create({ model: "m" }), (e) => e.status === 429 && /Claude 429: slow down/.test(e.message));
});

test("a short rate limit is waited out and the same request is sent again", async () => {
  const waits = [];
  let calls = 0;
  const client = createClaudeClient({
    apiKey: "k",
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => "2" }, json: async () => ({ error: { message: "busy" } }) };
      if (calls === 2) return { ok: false, status: 529, headers: { get: () => null }, json: async () => ({ error: { message: "overloaded" } }) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hi" }] }) };
    },
  });
  const out = await client.messages.create({ model: "m" });
  assert.equal(out.content[0].text, "hi");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 1400]);
});

test("a long rate limit is not waited for: the error carries retry-after so the model is paused that long", async () => {
  let calls = 0;
  const client = createClaudeClient({
    apiKey: "k",
    sleep: async () => { throw new Error("must not wait"); },
    fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: { get: () => "45" }, json: async () => ({ error: { message: "limit" } }) }; },
  });
  await assert.rejects(() => client.messages.create({ model: "m" }), (e) => e.status === 429 && e.headers["retry-after"] === "45");
  assert.equal(calls, 1);
});

test("a model that refuses a temperature is asked again without it", async () => {
  const bodies = [];
  const client = createClaudeClient({ apiKey: "k", fetchImpl: async (_u, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return "temperature" in body ? { ok: false, status: 400, json: async () => ({ error: { message: "temperature is not supported" } }) } : { ok: true, status: 200, json: async () => ({ content: [] }) };
  } });
  await client.messages.create({ model: "m", temperature: 0.7, messages: [] });
  assert.deepEqual(bodies.map((b) => "temperature" in b), [true, false]);
});

test("hidden thinking is switched off by default so it cannot use up the reply's token budget", () => {
  const history = [{ role: "user", content: "hi" }];
  assert.deepEqual(buildClaudeRequest({ model: "m", history, tools: [], maxTokens: 5 }).thinking, { type: "disabled" });
  assert.equal("thinking" in buildClaudeRequest({ model: "m", history, tools: [], maxTokens: 5, thinking: true }), false);
});

test("a model that refuses the thinking setting is asked again without it", async () => {
  const bodies = [];
  const client = createClaudeClient({ apiKey: "k", fetchImpl: async (_u, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return "thinking" in body ? { ok: false, status: 400, json: async () => ({ error: { message: "thinking.type disabled is not supported for this model" } }) } : { ok: true, status: 200, json: async () => ({ content: [] }) };
  } });
  await client.messages.create({ model: "m", thinking: { type: "disabled" }, temperature: 0.2, messages: [] });
  assert.deepEqual(bodies.map((b) => "thinking" in b), [true, false]);
  assert.equal(bodies[1].temperature, 0.2);
});

// ---- the real agent loop on Claude ---------------------------------------------------------------
function fakeClaude(script) {
  const calls = [];
  return { calls, messages: { create: async (body) => { if (isLanguageCheck(body)) return { content: [{ type: "text", text: "SAME" }], usage: { input_tokens: 1, output_tokens: 1 } }; calls.push(body); const step = script[calls.length - 1] || script[script.length - 1]; return { content: step(body), usage: { input_tokens: 10, output_tokens: 5 } }; } } };
}
const fakeGemini = (text) => ({ calls: [], models: { generateContent: async function () { this.calls?.push?.(1); return { candidates: [{ content: { role: "model", parts: [{ text }] } }] }; } } });

async function harness(fn) {
  const original = { create: ecommerce.createSession, summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => null });
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD", storeName: "Test Store" });
    await fn({ options: { clientId: `c-${crypto.randomUUID()}`, cart: { currency: "USD", items: [] } } });
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.createSession = original.create; ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find; StoreIntegration.findOne = original.integration; globalThis.fetch = original.fetch;
  }
}

test("Claude writes the reply for a plain chat turn, from the system prompt and the customer's words", async () => {
  await harness(async ({ options }) => {
    const claude = fakeClaude([() => [{ type: "text", text: "Namaste! Kya dhoondh rahe hain aap?" }]]);
    __setLLMClientsForTest({ claude });
    const result = await runAgent("hello", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, "Namaste! Kya dhoondh rahe hain aap?");
    assert.equal(claude.calls.length, 1);
    assert.match(claude.calls[0].system[0].text, /./);
    assert.equal(claude.calls[0].messages.at(-1).role, "user");
  });
});

test("Claude's tool call is run, the result goes back as a tool_result, and Claude writes the final reply", async () => {
  await harness(async ({ options }) => {
    const claude = fakeClaude([
      () => [{ type: "tool_use", id: "tu_1", name: "get_cart", input: {} }],
      () => [{ type: "text", text: "Aapka cart abhi khaali hai." }],
    ]);
    __setLLMClientsForTest({ claude });
    const result = await runAgent("mera cart dikhao", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, "Aapka cart abhi khaali hai.");
    assert.equal(claude.calls.length, 2);
    const second = claude.calls[1].messages;
    assert.equal(second.at(-2).content.at(-1).type, "tool_use");
    assert.equal(second.at(-1).content[0].type, "tool_result");
    assert.equal(second.at(-1).content[0].tool_use_id, "tu_1");
  });
});

test("when Claude is down the turn is answered by Gemini, as the second provider", async () => {
  await harness(async ({ options }) => {
    let claudeTries = 0;
    const claude = { messages: { create: async () => { claudeTries++; throw new Error("Claude 529: overloaded"); } } };
    const gemini = fakeGemini("Gemini ne jawab diya.");
    __setLLMClientsForTest({ claude, gemini });
    const result = await runAgent("hello", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, "Gemini ne jawab diya.");
    assert.ok(claudeTries >= 1, "Claude is tried first");
  });
});

test("when the first Gemini model is down, the second one answers", async () => {
  await harness(async ({ options }) => {
    const down = { messages: { create: async () => { throw new Error("Claude 503"); } } };
    const tried = [];
    const gemini = { models: { generateContent: async (req) => {
      tried.push(req.model);
      if (req.model === GEMINI_FALLBACK_MODELS[0]) throw new Error("503 unavailable");
      return { candidates: [{ content: { role: "model", parts: [{ text: "Gemini 3.1 ne sambhal liya." }] } }] };
    } } };
    __setLLMClientsForTest({ claude: down, gemini });
    const result = await runAgent("hello", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, "Gemini 3.1 ne sambhal liya.");
    assert.ok(GEMINI_FALLBACK_MODELS.length >= 2 && GEMINI_FALLBACK_MODELS.every((m) => tried.includes(m)), `tried ${tried.join(",")}`);
  });
});

test("the greeting is written by Claude when Claude is available", async () => {
  await harness(async () => {
    const claude = fakeClaude([() => [{ type: "text", text: "Hi there! What are you looking for today?" }]]);
    __setLLMClientsForTest({ claude });
    assert.equal(await generateGreeting("test.myshopify.com", {}), "Hi there! What are you looking for today?");
    assert.equal(claude.calls[0].max_tokens, 160);
  });
});

