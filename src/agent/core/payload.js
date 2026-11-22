// What the model is sent: trimmed history, tool declarations, slimmed tool results and the prompt size estimate.
// Part of agent.js (which re-exports all of it); moved here unchanged.
import { toGeminiToolDeclarations } from "../toolSchema.js";
import { MAX_HISTORY_CONTENT, MAX_HISTORY_MESSAGES } from "./config.js";

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-MAX_HISTORY_MESSAGES)
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim()
    )
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, MAX_HISTORY_CONTENT),
    }));
}

export function getGeminiTools(toolDefinitions = []) {
  return toGeminiToolDeclarations(toolDefinitions);
}

// What the model reads is trimmed; the shop screen still gets the full result. A multi-item search
// returns every product twice (inside each group and again as one flat list): the model needs it once.
// Internal match scores help no reply, so they are dropped too.
// Card-only fields (image links, raw variant lists, display flags) are for the shop screen, not for wording a reply:
// the model already gets the options, prices and stock in readable form.
const MODEL_ONLY_DROP = new Set(["matchConfidence", "unmatchedQueryWords", "image", "imageAlt", "handle", "url", "variants", "cardMode", "comparisonMode"]);
export function slimResultForModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const trimProduct = (p) => {
    if (!p || typeof p !== "object") return p;
    const out = {};
    for (const [k, v] of Object.entries(p)) if (!MODEL_ONLY_DROP.has(k) && v !== undefined && v !== null) out[k] = v;
    return out;
  };
  const out = { ...value };
  if (Array.isArray(out.groups) && Array.isArray(out.products)) delete out.products;
  if (Array.isArray(out.groups)) out.groups = out.groups.map((g) => ({ ...g, products: Array.isArray(g.products) ? g.products.map(trimProduct) : g.products }));
  if (Array.isArray(out.products)) out.products = out.products.map(trimProduct);
  return out;
}

// Groq answers 413 with "Limit 8000, Requested 10086": remember the limit per model so a prompt that
// cannot fit is not sent again on every turn.
const groqRequestLimit = new Map();
export function parseGroqRequestLimit(error) {
  const text = String(error?.message || error || "");
  if (!/\b413\b|request too large|too large for model/i.test(text)) return 0;
  const m = text.match(/limit\s+(\d+)/i);
  return m ? Number(m[1]) : 0;
}
export function estimatePromptTokens(messages = [], tools = []) {
  const chars = messages.reduce((n, m) => n + JSON.stringify(m?.content ?? "").length + JSON.stringify(m?.tool_calls ?? "").length, 0);
  return Math.ceil((chars + (tools?.length ? JSON.stringify(tools).length : 0)) / 3.5);
}

function serializeResult(value) {
  try {
    return JSON.stringify(slimResultForModel(value) ?? null);
  } catch {
    return JSON.stringify({ error: "Could not serialize tool result." });
  }
}

export { MODEL_ONLY_DROP, groqRequestLimit, serializeResult };
