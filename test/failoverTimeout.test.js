// A slow first-choice Gemini model must not hold the shopper for the full timeout while a healthy model is next in line.
// Measured on the dev key: gemini-3.1-flash-lite answered a one-word prompt in 1.6 s, 18.9 s and 4.4 s on three tries in
// a row, while gemini-3.5-flash-lite took under 1.1 s each time; a "hi" in the storefront took 22 s.
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.GEMINI_MODEL = "slow-model";
process.env.GEMINI_FALLBACK_MODELS = "quick-model";
process.env.GEMINI_TIMEOUT_MS = "9000";
process.env.GEMINI_FAILOVER_TIMEOUT_MS = "400";
const { runAgent, isFallbackAnswer, __setLLMClientsForTest } = await import("../src/agent/agent.js");
const { installRealStore, freshClientId } = await import("./helpers/agentHarness.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });

const textReply = (text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], usageMetadata: {} });
const ask = () => runAgent("hello", "failover.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });

test("a model that hangs is left after the failover time when another model is next, and is skipped on the next turn", async () => {
  const asked = [];
  __setLLMClientsForTest({ gemini: { models: { generateContent: (req) => {
    asked.push(req.model);
    if (req.model === "slow-model") return new Promise(() => {}); // never answers
    return Promise.resolve(textReply("Hello! What can I get you?"));
  } } } });
  const started = Date.now();
  const first = await ask();
  const took = Date.now() - started;
  assert.equal(isFallbackAnswer(first.answer), false);
  assert.match(first.answer, /Hello/);
  assert.deepEqual(asked.filter((m) => m !== "slow-model").slice(0, 1), ["quick-model"]);
  assert.ok(took < 4000, `the turn took ${took} ms: it waited the full timeout on the hanging model`);

  const before = asked.length;
  await ask();
  assert.ok(!asked.slice(before).includes("slow-model"), "the hanging model is paused, not tried again on the next turn");
});

// ---- a provider that fails after running a tool must not make the next provider run it again ---------------------------------------
const { sessionStore, toolsNode } = await import("../src/agent/core/toolsNode.js");

function fakeSession(runs) {
  const actions = [];
  return {
    handlers: {
      raise_complaint: async () => { runs.complaint += 1; actions.push({ type: "complaint_raised", reference: "CMP-ABC123" }); return { status: "email_sent", reference: "CMP-ABC123" }; },
      search_products: async () => { runs.search += 1; return { status: "ok", products: [] }; },
    },
    actionCount: () => actions.length,
    restoreActions: (list) => actions.push(...list),
    result: () => ({ actions: [...actions], products: [], fallbackSpeech: "" }),
    actions,
  };
}
const turnState = (key, ledger, name, args = {}) => ({ sessionKey: key, toolCalls: [{ id: "c1", name, arguments: args }], provider: "gemini", context: { sideEffectLedger: ledger }, userMessage: "raise it", telemetry: undefined, geminiContents: [], groqMessages: [], toolLog: [], round: 0 });

test("a side-effect tool that already ran in this turn is not run again by the next provider, and its actions come back", async () => {
  const runs = { complaint: 0, search: 0 };
  const ledger = new Map();
  const first = fakeSession(runs), second = fakeSession(runs);
  sessionStore.set("provider-a", first);
  sessionStore.set("provider-b", second);
  try {
    await toolsNode(turnState("provider-a", ledger, "raise_complaint", { channel: "email", summary: "dead charger", customerAgreed: true }));
    // provider A now fails; provider B asks for the same tool with the same arguments (written in another key order)
    await toolsNode(turnState("provider-b", ledger, "raise_complaint", { summary: "dead charger", customerAgreed: true, channel: "email" }));
    assert.equal(runs.complaint, 1, "the complaint was raised twice");
    assert.deepEqual(second.actions.map((a) => a.type), ["complaint_raised"], "the widget would lose the complaint_raised action");
  } finally {
    sessionStore.delete("provider-a");
    sessionStore.delete("provider-b");
  }
});

test("different arguments, read-only tools and a turn without a ledger still run every time", async () => {
  const runs = { complaint: 0, search: 0 };
  const ledger = new Map();
  const s = fakeSession(runs);
  sessionStore.set("provider-c", s);
  try {
    await toolsNode(turnState("provider-c", ledger, "raise_complaint", { channel: "human", summary: "a" }));
    await toolsNode(turnState("provider-c", ledger, "raise_complaint", { channel: "human", summary: "b" }));
    assert.equal(runs.complaint, 2, "a different complaint must run");
    await toolsNode(turnState("provider-c", ledger, "search_products", { searchTerm: "jeans" }));
    await toolsNode(turnState("provider-c", ledger, "search_products", { searchTerm: "jeans" }));
    assert.equal(runs.search, 2, "a read-only tool is never cached");
    await toolsNode(turnState("provider-c", null, "raise_complaint", { channel: "human", summary: "a" }));
    assert.equal(runs.complaint, 3, "without a ledger nothing is skipped");
  } finally {
    sessionStore.delete("provider-c");
  }
});

// ---- the provider chain is Gemini, then Claude when its key is set; every way a provider can fail ends in an answer ------------------------------
const claudeReply = (text) => ({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } });
const fakeClaudeClient = (text, calls = []) => ({ calls, messages: { create: async (body) => { calls.push(body); return claudeReply(text); } } });
const askChain = (message = "hello there") => (healthy(), runAgent(message, "chain.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } }));
// an earlier test may have paused a model for a while: every test here starts with all models healthy
const { modelHealth: health, GEMINI_FALLBACK_MODELS: chainModels } = await import("../src/agent/core/config.js");
const healthy = () => { for (const m of ["slow-model", ...chainModels]) health.success("gemini", m); };
const emptyGemini = () => ({ models: { generateContent: async () => ({ candidates: [{ content: { role: "model", parts: [] } }], usageMetadata: {} }) } });

test("an EMPTY answer from Gemini is a failure: the turn moves to Claude instead of showing nothing", async () => {
  const claude = fakeClaudeClient("Hello! Claude here, what can I find for you?");
  __setLLMClientsForTest({ gemini: emptyGemini(), claude });
  const out = await askChain();
  assert.equal(isFallbackAnswer(out.answer), false);
  assert.match(out.answer, /Claude here/);
  assert.ok(claude.calls.length >= 1);
});

test("a Gemini quota error (429) is answered by Claude, and the shopper never sees the error", async () => {
  const claude = fakeClaudeClient("Claude answered after Gemini ran out.");
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw Object.assign(new Error('429 RESOURCE_EXHAUSTED: You exceeded your current quota. Please retry in 3600s.'), { status: 429 }); } } }, claude });
  const out = await askChain();
  assert.match(out.answer, /Claude answered/);
  assert.doesNotMatch(out.answer, /429|quota|RESOURCE_EXHAUSTED/i);
});

test("without an Anthropic key Claude is simply not a provider: Gemini answers normally and nothing breaks", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    __setLLMClientsForTest({ gemini: { models: { generateContent: async () => textReply("Gemini answers alone.") } } });
    const out = await askChain();
    assert.equal(out.answer, "Gemini answers alone.");
    // and when that only provider fails, the shopper gets the plain connection-trouble line, never an exception or a raw error
    __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw new Error("503 UNAVAILABLE secret-detail"); } } } });
    const down = await askChain();
    assert.equal(isFallbackAnswer(down.answer), true);
    assert.doesNotMatch(down.answer, /503|UNAVAILABLE|secret-detail/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("Gemini and Claude both failing, or both answering with nothing, still ends in the graceful line", async () => {
  __setLLMClientsForTest({ gemini: emptyGemini(), claude: { messages: { create: async () => claudeReply("") } } });
  const out = await askChain();
  assert.equal(isFallbackAnswer(out.answer), true);
  __setLLMClientsForTest({ gemini: { models: { generateContent: async () => { throw new Error("timeout"); } } }, claude: { messages: { create: async () => { throw new Error("529 overloaded"); } } } });
  assert.equal(isFallbackAnswer((await askChain()).answer), true);
});
