// Claude (Anthropic) as an AI provider. The agent keeps one chat history in the OpenAI message shape
// (the same one Groq uses); this file translates it to and from Anthropic's Messages API, and talks
// to that API over plain HTTPS so no extra package is needed.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const parseJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

// The system prompt is one fixed block of rules followed by a short block that changes every turn
// (cart, search results, customer). It starts with this marker. Only the fixed block is cached: a cache
// marker on text that changes each turn would pay the higher cache-write price and never get a hit.
export const LIVE_CONTEXT_MARKER = "\nLIVE CONTEXT (";

export function toClaudeSystem(system) {
  const at = system.indexOf(LIVE_CONTEXT_MARKER);
  if (at <= 0) return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  return [
    { type: "text", text: system.slice(0, at), cache_control: { type: "ephemeral" } },
    { type: "text", text: system.slice(at) },
  ];
}

/** OpenAI-style tool list -> Anthropic tools. The last one carries the cache marker, so the tool list is cached with the prompt. */
export function toClaudeTools(tools = []) {
  const converted = tools
    .map((t) => t?.function)
    .filter((f) => f?.name)
    .map((f) => ({ name: f.name, description: f.description || "", input_schema: f.parameters || { type: "object", properties: {} } }));
  if (converted.length) converted[converted.length - 1] = { ...converted[converted.length - 1], cache_control: { type: "ephemeral" } };
  return converted;
}

/** OpenAI-style history -> { system, messages } for Anthropic. Tool results go back as one user turn, ahead of any note. */
export function toClaudeMessages(history = []) {
  const system = history.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const blocks = [];
      if (String(m.content || "").trim()) blocks.push({ type: "text", text: String(m.content) });
      for (const call of m.tool_calls || []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parseJson(call.function?.arguments) });
      }
      if (blocks.length) push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }]);
    } else {
      const text = String(m.content ?? "");
      if (!text.trim()) continue;
      const last = out[out.length - 1];
      // a note after tool results must come after them in the same turn
      push("user", [{ type: "text", text }]);
      if (last && last.role === "user") {
        const turn = out[out.length - 1];
        turn.content.sort((a, b) => (a.type === "tool_result" ? 0 : 1) - (b.type === "tool_result" ? 0 : 1));
      }
    }
  }
  return { system, messages: out };
}

/**
 * The request body. When `forceFinal` is set the model must only write text: the tools stay in the
 * request (Anthropic requires them whenever the history contains tool calls) with calling switched off.
 */
export function buildClaudeRequest({ model, history, tools, forceFinal = false, maxTokens, temperature, thinking = process.env.CLAUDE_THINKING === "on" }) {
  const { system, messages } = toClaudeMessages(history);
  const claudeTools = toClaudeTools(tools);
  return {
    model,
    max_tokens: maxTokens,
    // Haiku 5.5 thinks by default and thinking tokens count against max_tokens: a shopping reply spent its whole
    // budget on hidden thinking and came back empty or cut. A shop reply needs no thinking, so it is switched off
    // (set CLAUDE_THINKING=on to allow it again).
    ...(thinking ? {} : { thinking: { type: "disabled" } }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(system ? { system: toClaudeSystem(system) } : {}),
    messages,
    ...(claudeTools.length ? { tools: claudeTools, tool_choice: { type: forceFinal ? "none" : "auto" } } : {}),
  };
}

/** Anthropic reply -> what the agent loop needs. `assistantMessage` is the OpenAI-style entry for the history. */
export function parseClaudeResponse(response, { maxToolCalls = 8 } = {}) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const uses = blocks.filter((b) => b.type === "tool_use").slice(0, maxToolCalls);
  const toolCalls = uses.map((b) => {
    const args = JSON.stringify(b.input || {});
    return { id: b.id, name: b.name, arguments: args, rawArguments: args };
  });
  const assistantMessage = {
    role: "assistant",
    content: text,
    tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
  };
  return { text, toolCalls, assistantMessage, stopReason: response?.stop_reason || "" };
}

/** "text, thinking" style summary of what the model sent back: shows where output tokens went when a reply is empty or cut off. */
export function describeClaudeContent(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const counts = blocks.reduce((m, b) => ((m[b?.type || "unknown"] = (m[b?.type || "unknown"] || 0) + 1), m), {});
  return Object.entries(counts).map(([t, n]) => `${t}x${n}`).join(", ") || "no content";
}

/** Token counts in the shape the conversation log already understands. */
export function claudeUsage(usage = {}) {
  const cached = Number(usage.cache_read_input_tokens) || 0;
  const written = Number(usage.cache_creation_input_tokens) || 0;
  return {
    prompt_tokens: (Number(usage.input_tokens) || 0) + cached + written,
    completion_tokens: Number(usage.output_tokens) || 0,
    cachedContentTokenCount: cached,
  };
}

/** A minimal Anthropic client: `client.messages.create(body, { signal })`. Errors carry the HTTP status in their message. */
export function createClaudeClient({ apiKey, fetchImpl = (...a) => globalThis.fetch(...a), url = API_URL, sleep = null, busyRetryLimit = 2 } = {}) {
  async function post(body, signal) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Claude ${response.status}: ${data?.error?.message || data?.error?.type || "request failed"}`);
      error.status = response.status;
      // Keep the server's "try again in N seconds" so the model is paused for exactly that long, not a guess.
      const retryAfter = response.headers?.get?.("retry-after");
      if (retryAfter) error.headers = { "retry-after": retryAfter };
      throw error;
    }
    return data;
  }
  // A busy moment (rate limit or overload) usually clears in a second or two: wait briefly and ask again
  // instead of failing the shopper's turn. Longer waits are left to the cool-down in modelHealth.
  const BUSY = new Set([429, 500, 502, 503, 529]);
  const MAX_BUSY_WAIT_MS = 4000;
  const waitFor = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
  });
  return {
    messages: {
      async create(body, { signal } = {}) {
        // Some models reject one of the optional settings: ask again without that setting
        let attempt = body;
        let busyRetries = 0;
        for (let tries = 0; tries < 6; tries++) {
          try {
            return await post(attempt, signal);
          } catch (error) {
            if (BUSY.has(error.status) && busyRetries < busyRetryLimit) {
              const asked = Number(error.headers?.["retry-after"]);
              const wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : 700 * 2 ** busyRetries;
              if (wait > MAX_BUSY_WAIT_MS) throw error;
              busyRetries++;
              await (sleep || waitFor)(wait, signal);
              continue;
            }
            const rejected = error.status === 400 && (/temperature/i.test(error.message) ? "temperature" : /thinking/i.test(error.message) ? "thinking" : "");
            if (!rejected || attempt[rejected] === undefined) throw error;
            const { [rejected]: _dropped, ...rest } = attempt;
            attempt = rest;
          }
        }
        return post(attempt, signal);
      },
    },
  };
}