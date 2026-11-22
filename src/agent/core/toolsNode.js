// The graph state, the per-turn session, and the tools step: running the tool calls the model asked for.
// Part of agent.js (which re-exports all of it); moved here unchanged.
import { safeToolBatch } from "../../services/checkoutIntent.js";
import { noteTool } from "../../services/conversationLog.js";
import { maskPersonal } from "../../utils/logger.js";
import { camelCaseArgs, dropNullArgs } from "../toolSchema.js";
import { Annotation } from "@langchain/langgraph";
import { LLM_PHRASE_CHECKOUT, MAX_TOOL_ROUNDS, usesChatMessages } from "./config.js";
import { serializeResult, slimResultForModel } from "./payload.js";
import { differentKindNote, doubtfulProducts, sameKindVerdict } from "../sameKindGuard.js";

const AgentState = Annotation.Root({
  userMessage: Annotation(),
  storeId: Annotation(),
  industry: Annotation(),
  provider: Annotation(),
  signal: Annotation(),
  context: Annotation(),
  systemPrompt: Annotation(),
  toolDefinitions: Annotation(),
  toolsForLlm: Annotation(),
  geminiTools: Annotation(),
  groqMessages: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  geminiContents: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  round: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
  forceFinal: Annotation({ reducer: (_a, b) => b, default: () => false }),
  chatOnly: Annotation({ reducer: (_a, b) => b, default: () => false }),
  toolCalls: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  toolCallsExecuted: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
  toolLog: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  // title -> true/false: is this doubtful product (nearest of a kind, found by meaning) the same kind as the wish
  sameKind: Annotation({ reducer: (_a, b) => b, default: () => ({}) }),
  finalText: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  sessionKey: Annotation(),
  telemetry: Annotation(),
  rateBudget: Annotation(),
  // another AI provider is waiting in line for this turn: a slow model here gets the short failover wait, not the full one
  hasNextProvider: Annotation(),
  answer: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  products: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  actions: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  checkout: Annotation({ reducer: (_a, b) => b, default: () => null }),
  done: Annotation({ reducer: (_a, b) => b, default: () => false }),
  error: Annotation({ reducer: (_a, b) => b, default: () => null }),
});

const sessionStore = new Map();
function getSession(key) {
  return sessionStore.get(key);
}

function mayNeedFollowUpTool(toolCalls, results) {
  const calledNames = new Set(toolCalls.map((c) => c.name));
  for (let i = 0; i < toolCalls.length; i++) {
    const name = toolCalls[i].name;
    const res = results[i] || {};
    if (
      name === "update_cart_item" &&
      res.status === "not_found" &&
      !calledNames.has("get_cart")
    ) {
      return true;
    }
    // The customer may already have named a time and given their details ("book the first slot"): the model needs a turn to book it.
    if (name === "get_call_slots" && res.status === "ok" && !calledNames.has("book_call")) {
      return true;
    }
    // Right after a successful email-OTP check the order number may already be known: allow get_order_details.
    if (
      name === "verify_order_otp" &&
      res.status === "verified" &&
      !calledNames.has("get_order_details")
    ) {
      return true;
    }
  }
  return false;
}

const INSTANT_TOOLS = new Set([
  "request_billing_update",
  "get_shipping_options",
  "list_categories",
  "search_products",
  "get_recommendations",
  "get_product_details",
  "compare_products",
  "check_variant_availability",
  "get_store_info",
  "get_website_product_count",
  "get_cart",
  "get_checkout_details",
  "clear_cart",
  "add_to_cart",
  "update_cart_item",
  "begin_checkout",
  "set_shipping_address",
  "set_billing_same_as_shipping",
  "set_billing_address",
  "set_shipping_method",
  "mark_checkout_ready",
  "get_tax_details",
  "check_prepaid_discount",
  "get_discounts_and_offers",
  "apply_discount_or_offer",
  "get_warranty_and_policy",
  "place_order",
]);

// Tools whose wording carries money, address, payment or order facts. Their verified text can be sent
// as-is. Everything else (search, compare, details, cart add/view, categories, store info...) is
// phrased by the LLM from the structured tool result, so replies stay conversational.
const DETERMINISTIC_TOOLS = new Set([
  "request_billing_update",
  "get_shipping_options",
  "get_checkout_details",
  "begin_checkout",
  "set_shipping_address",
  "set_billing_same_as_shipping",
  "set_billing_address",
  "set_shipping_method",
  "mark_checkout_ready",
  "check_prepaid_discount",
  "get_discounts_and_offers",
  "apply_discount_or_offer",
  "place_order",
]);

// Read-only tools whose replies also carry money/order facts and are therefore fact-checked.
const FACT_CHECKED_TOOLS = new Set(["get_tax_details", "get_order_details", "show_preview", "get_cart", "cancel_order", "request_order_cancellation"]);

// Tools that change something outside this reply: an order, a cancellation, a complaint, a booking, a call, an e-mailed code,
// a discount. When an AI provider fails after running one and the turn moves to the next provider, the next provider asks for
// the same tool again: it must get the earlier result back and the tool must not run a second time (a second call, a second
// code mail, a second complaint). The ledger lives for one turn (created in runAgentInner) and is shared by every provider.
const SIDE_EFFECT_TOOLS = new Set([
  "place_order", "request_order_cancellation", "confirm_order_cancellation", "cancel_order", "raise_complaint", "track_issue",
  "request_human_support", "flag_for_owner", "book_call", "send_order_otp", "verify_order_otp", "apply_discount_or_offer",
]);
const stableJson = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

async function toolsNode(state) {
  const session = getSession(state.sessionKey);
  if (!session) {
    return { done: true, error: new Error("Session missing") };
  }

  const { handlers } = session;
  const { calls: toolCalls, checkoutDeferred } = safeToolBatch(state.toolCalls || []);
  const groqToolMessages = [];
  const geminiFunctionResponses = [];
  const rawResults = [];

  for (const call of toolCalls) {
    if (state.signal?.aborted) {
      const error = new Error("Run cancelled before tool execution");
      error.name = "AbortError";
      return { done: true, error };
    }
    let args =
      typeof call.arguments === "string"
        ? (() => {
            try {
              return JSON.parse(call.arguments || "{}");
            } catch {
              return {};
            }
          })()
        : call.arguments || {};
    args = camelCaseArgs(dropNullArgs(args));

    const t0 = Date.now();
    const verifiedBefore = session.result?.()?.fallbackSpeech || "";
    let result;
    const ledger = state.context?.sideEffectLedger;
    const ledgerKey = ledger && SIDE_EFFECT_TOOLS.has(call.name) ? `${call.name}:${stableJson(args)}` : "";
    try {
      const handler = handlers[call.name];
      if (!handler) {
        result = { status: "error", note: `Unknown tool: ${call.name}` };
      } else if (ledgerKey && ledger.has(ledgerKey)) {
        // already run earlier in this turn (by a provider that then failed): give back what it returned, run nothing again
        const earlier = ledger.get(ledgerKey);
        session.restoreActions?.(earlier.actions);
        result = earlier.result;
        console.warn(`[tool] ${call.name} was already run earlier in this turn: its result is reused and it is not run again`);
      } else {
        const actionsBefore = session.actionCount?.() ?? 0;
        result = await handler(args);
        if (ledgerKey && result?.status !== "error") ledger.set(ledgerKey, { result, actions: (session.result?.()?.actions || []).slice(actionsBefore) });
      }
    } catch (err) {
      result = {
        status: "error",
        note: String(err?.message || err).slice(0, 200),
      };
    }
    // What the model asked for and what came back, so a wrong answer can be traced from the log alone.
    console.log(`[tool] ${call.name} ${JSON.stringify(maskPersonal(args)).slice(0, 200)} -> status=${result?.status ?? "-"} products=${Array.isArray(result?.products) ? result.products.length : "-"} in ${Date.now() - t0} ms`);
    noteTool(state.telemetry, call.name, Date.now() - t0);
    // The tool's verified summary (exact totals, IDs, addresses) goes to the model as facts to convey,
    // so the model words the reply itself instead of the summary being sent as a fixed template.
    const verifiedAfter = session.result?.()?.fallbackSpeech || "";
    if (
      verifiedAfter &&
      verifiedAfter !== verifiedBefore &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.verified_reply_facts == null &&
      // A product list already carries its own prices and stock; the ready-made list sentence would only be copied word for word.
      !(Array.isArray(result.products) && result.products.length > 0)
    ) {
      result = { ...result, verified_reply_facts: verifiedAfter };
    }
    rawResults.push(result);

    // Tool results are written in English, and after reading them the model tended to answer a Hinglish shopper in English.
    // The last result of the turn carries the shopper's own words again, so the reply mirrors them and not the tool text.
    if (call === toolCalls.at(-1) && !state.context?.languageLocked && state.userMessage && result && typeof result === "object" && !Array.isArray(result)) {
      result = { ...result, reply_language: `Write the reply in the language and script of the customer's latest message, which is: "${String(state.userMessage).slice(0, 160)}". Hindi typed in Roman letters gets a Hinglish reply in Roman letters, English gets English, Devanagari gets Hindi in Devanagari. The language these tool results are written in does not matter.` };
    }

    const payload = serializeResult(result);

    if (usesChatMessages(state.provider)) {
      groqToolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: payload,
      });
    } else {
      geminiFunctionResponses.push({
        functionResponse: {
          name: call.name,
          response:
            typeof result === "object" && result !== null ? slimResultForModel(result) : { result },
        },
      });
    }
  }

  let groqMessages = state.groqMessages;
  let geminiContents = state.geminiContents;

  if (usesChatMessages(state.provider) && groqToolMessages.length) {
    groqMessages = [...state.groqMessages, ...groqToolMessages];
  }
  if (state.provider === "gemini" && geminiFunctionResponses.length) {
    geminiContents = [
      ...state.geminiContents,
      { role: "user", parts: geminiFunctionResponses },
    ];
  }

  const nextRound = (state.round || 0) + 1;
  const executedCount = (state.toolCallsExecuted || 0) + toolCalls.length;
  const allowAnotherRound =
    nextRound < MAX_TOOL_ROUNDS && mayNeedFollowUpTool(toolCalls, rawResults);

  const allInstantTools =
    !allowAnotherRound &&
    toolCalls.length > 0 &&
    toolCalls.every((c) => INSTANT_TOOLS.has(c.name)) &&
    (LLM_PHRASE_CHECKOUT ? false : toolCalls.every((c) => DETERMINISTIC_TOOLS.has(c.name)));
  const sessionSnap = session.result?.() || {};
  const toolLog = [
    ...(state.toolLog || []),
    ...toolCalls.map((c, i) => ({ name: c.name, result: rawResults[i] })),
  ];
  // Products that are not a direct match (nearest of a kind, found by meaning) are checked BEFORE the reply is written:
  // the model is told which ones are a different kind, so it does not offer them and the reply need not be written twice.
  let sameKind = state.sameKind || {};
  const unchecked = doubtfulProducts(toolCalls.map((c, i) => ({ name: c.name, result: rawResults[i] }))).filter((p) => typeof sameKind[p.title] !== "boolean");
  if (unchecked.length > 0 && typeof state.context?.askModel === "function" && !state.signal?.aborted) {
    const verdict = await sameKindVerdict({ ask: state.context.askModel, wished: state.userMessage, products: unchecked });
    if (verdict) {
      sameKind = { ...sameKind, ...Object.fromEntries(verdict) };
      const different = unchecked.filter((p) => verdict.get(p.title) === false).map((p) => p.title);
      if (different.length > 0) {
        const note = differentKindNote(different);
        if (usesChatMessages(state.provider)) groqMessages = [...groqMessages, { role: "user", content: note }];
        else geminiContents = [...geminiContents, { role: "user", parts: [{ text: note }] }];
      }
    }
  }
  if (checkoutDeferred) {
    // The cart changed in the same message that asked to place the order: the order is NOT placed.
    // The model explains this in its own words.
    const note =
      "[Note from the store system: the cart was changed in this same message, so the order was NOT placed yet. Tell the customer what changed in the cart and ask them to confirm the order again once the cart shows the change.]";
    if (usesChatMessages(state.provider)) groqMessages = [...groqMessages, { role: "user", content: note }];
    else geminiContents = [...geminiContents, { role: "user", parts: [{ text: note }] }];
    return { groqMessages, geminiContents, toolCalls: [], toolCallsExecuted: executedCount, toolLog, sameKind,
      round: nextRound, forceFinal: true, done: false };
  }

  // A tool that says its words are final (a refusal that quotes amounts in another currency than the cart's) is sent as written: the AI is not
  // asked to rephrase it, because a rephrase turned "USD 20,000.00" into "₹20,000.00".
  const verbatim = !allowAnotherRound && toolCalls.length > 0 && rawResults.every((r) => r && r.verbatim === true);
  if ((allInstantTools || verbatim) && sessionSnap.fallbackSpeech) {
    return {
      groqMessages,
      geminiContents,
      toolCalls: [],
      toolCallsExecuted: executedCount,
      toolLog,
      sameKind,
      round: nextRound,
      forceFinal: true,
      finalText: sessionSnap.fallbackSpeech,
      done: true,
    };
  }

  return {
    groqMessages,
    geminiContents,
    toolCalls: [],
    toolCallsExecuted: executedCount,
    toolLog,
    sameKind,
    round: nextRound,
    forceFinal: !allowAnotherRound,
    done: false,
  };
}

export { AgentState, sessionStore, getSession, mayNeedFollowUpTool, INSTANT_TOOLS, DETERMINISTIC_TOOLS, FACT_CHECKED_TOOLS, toolsNode };
