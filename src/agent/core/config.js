// The agent's settings from the environment: providers, models, timeouts, limits and the fallback answer.
// Part of agent.js (which re-exports all of it); moved here unchanged.
import "dotenv/config";
import { createModelHealth } from "../modelHealth.js";

// Gemini and Claude are the supported providers; any other name in the environment (for example the retired "groq") is ignored.
const SUPPORTED_PROVIDERS = new Set(["gemini", "claude"]);
const providerName = (value, fallback) => {
  const name = String(value || "").trim().toLowerCase();
  return SUPPORTED_PROVIDERS.has(name) ? name : fallback;
};
const LLM_PRIMARY = providerName(process.env.LLM_PROVIDER || process.env.LLM_PRIMARY, "gemini");
const LLM_SECONDARY = providerName(process.env.LLM_SECONDARY, LLM_PRIMARY === "gemini" ? "claude" : "gemini");

const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
// The 3.1 lite model answers faster than 3.5 lite in live tests (13-23 s replies on 3.5), so it goes first; 3.5 lite is the fallback.
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
// Short side calls (greeting, meaning match) always use the fast model unless GEMINI_LIGHT_MODEL says otherwise.
const DEFAULT_GEMINI_LIGHT_MODEL = "gemini-3.1-flash-lite";
// Only try configured models. Retired hardcoded fallbacks were adding a failed
// request and several seconds to every conversation turn.
const models = (primary, fallbacks) => [...new Set([primary, ...String(fallbacks || "").split(",")].map(m => m.trim()).filter(Boolean))];
const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const GEMINI_FALLBACK_MODELS = models(DEFAULT_GEMINI_MODEL, process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite");
const CLAUDE_FALLBACK_MODELS = models(DEFAULT_CLAUDE_MODEL, process.env.CLAUDE_FALLBACK_MODELS);
const GROQ_FALLBACK_MODELS = models(DEFAULT_GROQ_MODEL, process.env.GROQ_FALLBACK_MODELS);

const modelHealth = createModelHealth();
const MODELS_BY_PROVIDER = { gemini: GEMINI_FALLBACK_MODELS, groq: GROQ_FALLBACK_MODELS, claude: CLAUDE_FALLBACK_MODELS };
const healthyModels = provider => (MODELS_BY_PROVIDER[provider] || []).some(model => modelHealth.available(provider, model));
/** Some model of this provider is paused only because of a rate limit: it will answer again after a short wait. */
const rateLimitPaused = provider => (MODELS_BY_PROVIDER[provider] || []).some(model => modelHealth.rateLimited(provider, model));
/** Every paused model of this provider is paused only after a quick "busy" answer (5xx): a probe is cheap. */
const busyPaused = provider => (MODELS_BY_PROVIDER[provider] || []).some(model => modelHealth.busyOnly(provider, model));
// Groq and Claude share one chat history (OpenAI message shape); Gemini keeps its own.
const usesChatMessages = provider => provider === "groq" || provider === "claude";

const GROQ_TIMEOUT_MS = Math.min(Number(process.env.GROQ_TIMEOUT_MS) || 12000, 30000);
const CLAUDE_TIMEOUT_MS = Math.min(Number(process.env.CLAUDE_TIMEOUT_MS) || 15000, 30000);
const GEMINI_TIMEOUT_MS = Math.min(Number(process.env.GEMINI_TIMEOUT_MS) || 15000, 30000);
// How long one Gemini model may take while another healthy one is next in line (the last model gets the full timeout).
const GEMINI_FAILOVER_TIMEOUT_MS = Number(process.env.GEMINI_FAILOVER_TIMEOUT_MS) || 7000;
// After this long without an answer the next healthy Gemini model is asked as well, and the first answer is used (0 = off).
const GEMINI_HEDGE_MS = process.env.GEMINI_HEDGE_MS === "0" ? 0 : Math.max(1500, Number(process.env.GEMINI_HEDGE_MS) || 3000);
// The final "write the reply" call is now the real answer (not a fallback), so give it room.
const ROUND2_TIMEOUT_MS = Number(process.env.FINAL_REPLY_TIMEOUT_MS) || 12000;

// A rate limit (429) is waited out, not shown: at most this long per model call in total (0 = never wait), and at most
// this many calls per minute to Gemini (0 = no client-side pacing).
const RATE_LIMIT_MAX_WAIT_MS = process.env.RATE_LIMIT_MAX_WAIT_MS !== undefined && process.env.RATE_LIMIT_MAX_WAIT_MS !== "" && Number.isFinite(Number(process.env.RATE_LIMIT_MAX_WAIT_MS)) ? Math.max(0, Math.min(Number(process.env.RATE_LIMIT_MAX_WAIT_MS), 30000)) : 12000;
const GEMINI_MAX_RPM = Math.max(0, Number(process.env.GEMINI_MAX_RPM) || 0);

// Rounds 1-3: the model may call tools, and a follow-up tool each time (e.g. search -> details -> add to cart). Then it must answer.
const MAX_TOOL_ROUNDS = Math.max(1, Math.min(Number(process.env.MAX_TOOL_ROUNDS) || 3, 4));
// Enough history that the model remembers what it showed (product lists are long).
const MAX_HISTORY_MESSAGES = Math.max(6, Math.min(Number(process.env.MAX_HISTORY_MESSAGES) || 16, 30));
const MAX_HISTORY_CONTENT = 1200;
const MAX_TOOL_CALLS_PER_ROUND = 3;
// After this long into one customer message, the optional extra AI calls (a reply written again by a quality guard, the
// same-kind check) are skipped and the reply that is ready goes out. The calls that make the answer are never skipped.
const TURN_SOFT_DEADLINE_MS = Math.max(5000, Math.min(Number(process.env.TURN_SOFT_DEADLINE_MS) || 15000, 60000));
const LLM_TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE)) && process.env.LLM_TEMPERATURE !== "" ? Number(process.env.LLM_TEMPERATURE) : 0.6;
// Rounds that pick tools and fill in their arguments (carts, orders, cancellations) stay close to deterministic; only the written reply keeps some warmth.
const LLM_TOOL_TEMPERATURE = Number.isFinite(Number(process.env.LLM_TOOL_TEMPERATURE)) && process.env.LLM_TOOL_TEMPERATURE !== "" ? Number(process.env.LLM_TOOL_TEMPERATURE) : 0.25;
const LLM_MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS) || 700;
// The reply round only writes the answer; a little more room so a bulleted reply is never cut mid-line.
const LLM_REPLY_MAX_OUTPUT_TOKENS = Number(process.env.LLM_REPLY_MAX_OUTPUT_TOKENS) || 1000;
const parsedHasText = (response) => (Array.isArray(response?.content) ? response.content : []).some((b) => b?.type === "tool_use" || (b?.type === "text" && String(b.text || "").trim()));
// REPLY_STYLE=ai (default): the AI writes every reply, including checkout and order replies, from the
// verified facts the tools return; the fact guard rejects any invented amount or order ID.
// REPLY_STYLE=verified_templates: checkout/order replies use the tools' verified wording as-is
// (one LLM call fewer on those turns, but the wording is fixed).
const REPLY_STYLE = String(process.env.REPLY_STYLE || (process.env.LLM_PHRASE_CHECKOUT === "0" ? "verified_templates" : "ai")).toLowerCase();
const LLM_PHRASE_CHECKOUT = REPLY_STYLE !== "verified_templates";

// Reply round reuses round 1's tool list (calling disabled) so Gemini's implicit cache can hit.
const KEEP_TOOLS_IN_FINAL_ROUND = process.env.FINAL_ROUND_KEEP_TOOLS !== "0";
// The live catalog probe never holds up the first LLM call for longer than this.
const PROBE_BUDGET_MS = Number(process.env.PROBE_BUDGET_MS) || 700;

// Shown only when no AI provider can be reached at all (there is no model to write a reply).
const FALLBACK_ANSWER ="I'm having a little trouble connecting right now. Your cart is still here; please try again in a moment.";
/** True for the stand-in reply sent when no AI could answer: the widget shows its own words for it, in the shopper's language. */
export const isFallbackAnswer = (text) => text === FALLBACK_ANSWER;

const WRAP_UP_NOTE = [
  "Now write your reply to the customer's LAST message. No more tools.",
  "Speak like a real friend who also runs this shop: warm, honest and sure of your products. Natural and varied, never robotic, never a catalogue read aloud.",
  "Write the whole reply in the language of the customer's LAST message: an English message gets a reply with no Hindi or Hinglish words at all (no yaar, dost, bhai, accha); Hinglish (Hindi words typed in Roman letters, however short the message) gets Hinglish in Roman letters; Hindi gets Hindi. Earlier replies do not decide the language. Match their mood too: relaxed with a relaxed shopper, calm and caring with an upset one.",
  "Ground every fact (products, prices, sizes, colours, stock, cart, totals, order numbers) in the tool results above, and never in your memory or earlier replies.",
  "If a tool result has status 'needs_clarification', follow its instruction_for_ai naturally in the customer's language without inventing or listing products.",
  "If a tool result says no_match / no_new_products / out_of_stock / needs_variant, say so honestly and warmly in one short line (never pretend, never blame the customer). Then help like a shop owner would: if the tool results hold something that truly serves the same need, offer the best one and say clearly that it is a different thing; otherwise ask ONE short question that helps you find them something (who it is for, what they will use it for, or their budget). NEVER dump or recite a comma-separated list of store categories when an item is unavailable.",
  "WHEN THE TOOL RESULTS HOLD 2 OR MORE PRODUCTS: do not read the whole list out. Pick what fits THIS customer best (their need, budget, the person it is for) and lead with it: name your best pick and give one short, true reason from the tool facts. Then show at most 3 more that are worth a look, each on its own line as a bullet (- **Product Name** (Price): the one thing that makes it different, and in-stock sizes/options when they matter). Never cram several products into one paragraph. Never add urgency, scarcity or a discount that the tool results do not state.",
  "When comparing products, call compare_products and then write the comparison yourself from its facts: one short bullet per product saying what the customer gets with it (price, features, use, options), contrasting the real differences, then one clear recommendation and one follow-up question. Never reply with only 'see the cards'. Always write Cash on Delivery in full. When an item is added to cart (and checkout was not requested in this message), confirm it was added and ask if they want to proceed to checkout or add anything else — do not ask for payment method before checkout starts.",
  "The order preview (checkout_ready / mark_checkout_ready) is ONE card that already shows every item, amount, tax, address and contact detail. Never repeat those details in text and never ask for or trigger a second preview; give one short line with the payable total (tax included) and ask the payment choice. For tax questions call get_tax_details and explain only from its data.",
  "For order status / order detail results (get_order_details, show_preview, send_order_otp, verify_order_otp, request_order_cancellation, confirm_order_cancellation, cancel_order): follow the tool's instruction_for_ai, say only the facts present in details (the exact detail the customer asked for) in simple friendly language, never add other order details, never invent tracking or dates, and never say, guess or repeat a verification code.",
  "Keep it short. When the customer shared something personal (a birthday, a trip, a problem), a few natural words about it are welcome before the answer, the way a friend would; never flattery, never a speech. Never pass off an item of a different kind as the one they asked for (a dress for slippers); if the store has nothing of that kind, say so.",
  "Never open with stock templates like 'Here are the products' or 'I found these options', and never repeat your previous phrasing. End with at most ONE question, and only when it moves the customer forward (never two questions, never a list of questions). No emojis.",
  "When a tool result contains verified_reply_facts, that is what the customer must be told: say it in your own warm words and in the customer's language, keeping every amount, order ID, address, email, phone and payment method EXACTLY as written there. Never compute, round or add any amount that is not written there.",
].join(" ");

const CHAT_ONLY_NOTE = [
  "Reply to the customer's last message conversationally, like a real friend who also runs this shop. No tools are available this turn.",
  "Generate a fresh, natural response every time — never use canned or repetitive template sentences.",
  "Do not list or invent products or prices. Reply in the language of their last message only: English gets pure English (no Hindi or Hinglish words), Hinglish gets Hinglish, Hindi gets Hindi. Keep it warm and concise (1-3 sentences). If the customer is upset, acknowledge it first like a person would. Ask at most ONE question, and only if it is natural.",
].join(" ");

export { busyPaused, GEMINI_FAILOVER_TIMEOUT_MS, GEMINI_HEDGE_MS, TURN_SOFT_DEADLINE_MS, LLM_TOOL_TEMPERATURE, LLM_PRIMARY, LLM_SECONDARY, DEFAULT_GROQ_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_LIGHT_MODEL, RATE_LIMIT_MAX_WAIT_MS, GEMINI_MAX_RPM, models, DEFAULT_CLAUDE_MODEL, GEMINI_FALLBACK_MODELS, CLAUDE_FALLBACK_MODELS, GROQ_FALLBACK_MODELS, modelHealth, MODELS_BY_PROVIDER, healthyModels, rateLimitPaused, usesChatMessages, GROQ_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, GEMINI_TIMEOUT_MS, ROUND2_TIMEOUT_MS, MAX_TOOL_ROUNDS, MAX_HISTORY_MESSAGES, MAX_HISTORY_CONTENT, MAX_TOOL_CALLS_PER_ROUND, LLM_TEMPERATURE, LLM_MAX_OUTPUT_TOKENS, LLM_REPLY_MAX_OUTPUT_TOKENS, parsedHasText, REPLY_STYLE, LLM_PHRASE_CHECKOUT, KEEP_TOOLS_IN_FINAL_ROUND, PROBE_BUDGET_MS, FALLBACK_ANSWER, WRAP_UP_NOTE, CHAT_ONLY_NOTE };
