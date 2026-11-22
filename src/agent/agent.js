/**
 * LangGraph-based shopping agent.
 * Graph: START → agent → (tools → agent)* → finalize → END
 * Public API: runAgent(), sanitizeHistory()
 */
// Settings, LLM clients, history/tool-result shaping, the tools step and turn preparation live in ./core/;
// this file keeps the model calls, the graph, runAgent and the greeting/suggestions, and re-exports the rest.
import { withShopperPricing } from "../tools/shopifyService.js";
import { pricesFollowMarket } from "../config/env.js";
import { budgetFromText } from "../tools/shopify/words.js";
import "dotenv/config";
import { buildClaudeRequest, claudeUsage, describeClaudeContent, parseClaudeResponse } from "./claudeAdapter.js";
import { StateGraph, END, START } from "@langchain/langgraph";

import { classifyConversationalTurn } from "../industries/ecommerce.js";
import { resolveClientId } from "../services/customerContext.js";
import { maskEmail } from "../services/orderLookupAuth.js";
import { normalizeCartSnapshot } from "../services/cartSnapshot.js";
import { cartInStoreCurrency } from "../services/cartPricing.js";
import { complaintPromptBlock, openComplaintForChat } from "../services/complaintService.js";
import { sanitizeBrowserCheckout } from "../services/browserCheckout.js";
import { describeContinuity, buildRecap } from "../services/conversationContinuity.js";
import { visitorMemoryBlock } from "../services/visitorMemory.js";
import { saveConversationRecap } from "../services/checkoutSessionService.js";
import { getAgentSettings } from "../admin/settings.js";
import { newTelemetry, noteLLM, recordTurnInBackground, chatRefFor } from "../services/conversationLog.js";
import { cardsForAnswer, productsMentionedInAnswer, speculativeCards } from "./cardSelection.js";
import { consistentAssistantVoice, respectfulAddress, dropDanglingListIntro, fixOneDecimalAmounts, joinDottedCodes, neutralShopperVerbs } from "./textTidy.js";
import { explicitAddRequest } from "../industries/ecommerce/addRequest.js";
import { budgetSourceMessage } from "./budgetScope.js";
import { asksForPerson, asksToAddToCart, connectingReply } from "./requestGuards.js";
import { callNotBookedReply, claimsCallBooked, claimsBillingSet, claimsCartChange, claimsDiscountApplied, changedCart, claimsDone, doneEvidence, notConfirmedReply, claimsLanguageSwitch, claimsPersonHandoff, claimsPreviewShown, claimsUnavailable, languageAskedFor, languageRequestedBy, looksLikeThinkingAloud, noPersonReply, stripReasoningLeak, teamToldReply, dataCurrency, findWrongCurrency, repairCurrencyMarks, verifyReplyFacts } from "./factGuard.js";
import { contradictedAvailability, lookupFailedReply, productLookupFailed, searchRan } from "./availabilityGuard.js";
import { isMeaninglessMessage, claimsEscalationNow, falseAgreement, paymentNotPublishedReply, performanceFallback, unsupportedPaymentAndStoreFacts, unsupportedPerformanceClaims } from "./claimGuard.js";
import { discountClaimProblems, policyNotPublishedReply, saleFactsLine, salePairs, unsupportedStoreClaims } from "./policyGuard.js";
import { checkSubstitutes } from "./sameKindGuard.js";
import { conversationLanguage, foreignScriptInReply, replyPlainlyIn, missedDevanagariReply, plainlyEnglish, romanLanguage, scriptLanguage, stripForeignScriptWords, wrongScriptReply } from "../services/language.js";
import { createLogger, redact } from "../utils/logger.js";
import { recordLlm, inc, withTurnTimeline } from "../observability/metrics.js";
import { alert } from "../observability/alerts.js";
import { reportError } from "../observability/errors.js";
import { replyLedger, keepRealReplies } from "../services/replyLedger.js";
import { prepareConversation, resolveShoppingGender } from "../services/conversationProfile.js";
import { allowNullOnOptionalArgs } from "./toolSchema.js";
import { createPacer, isRateLimitError, rateLimitWait, sleep } from "./core/retry.js";

import { industries } from "../industries/index.js";
import { busyPaused, GEMINI_FAILOVER_TIMEOUT_MS, GEMINI_HEDGE_MS, CHAT_ONLY_NOTE, CLAUDE_FALLBACK_MODELS, DEFAULT_GEMINI_LIGHT_MODEL, GEMINI_MAX_RPM, RATE_LIMIT_MAX_WAIT_MS, CLAUDE_TIMEOUT_MS, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, FALLBACK_ANSWER, GEMINI_FALLBACK_MODELS, GEMINI_TIMEOUT_MS, GROQ_FALLBACK_MODELS, GROQ_TIMEOUT_MS, KEEP_TOOLS_IN_FINAL_ROUND, LLM_MAX_OUTPUT_TOKENS, LLM_PRIMARY, LLM_REPLY_MAX_OUTPUT_TOKENS, LLM_SECONDARY, LLM_TEMPERATURE, LLM_TOOL_TEMPERATURE, MAX_TOOL_CALLS_PER_ROUND, TURN_SOFT_DEADLINE_MS, MAX_TOOL_ROUNDS, ROUND2_TIMEOUT_MS, WRAP_UP_NOTE, healthyModels, modelHealth, parsedHasText, rateLimitPaused } from "./core/config.js";
import { blockProviderForAuth, errMsg, getClaudeClient, getGeminiClient, getGeminiThinkingCandidates, getGroqClient, isAuthError, isUserAbort, providerAvailable, withHardTimeout, workingThinkingByModel } from "./core/clients.js";
import { estimatePromptTokens, getGeminiTools, groqRequestLimit, parseGroqRequestLimit, sanitizeHistory } from "./core/payload.js";
import { AgentState, DETERMINISTIC_TOOLS, FACT_CHECKED_TOOLS, getSession, sessionStore, toolsNode } from "./core/toolsNode.js";
import { buildGreetingPrompt, buildSuggestionsPrompt, parseSuggestions, prefetchTurnData, pruneToolsForState, withLanguageNote, withinBudget } from "./core/turnPrep.js";
export { isFallbackAnswer } from "./core/config.js";
export { __resetProviderBlocksForTest, __setLLMClientsForTest } from "./core/clients.js";
export { isAuthError };
export { slimResultForModel } from "./core/payload.js";
export { estimatePromptTokens, getGeminiTools, parseGroqRequestLimit, sanitizeHistory };

/** The reply without the sentences `test` flags (used when a rewrite is not possible or still makes the false claim). */
export function dropSentences(text, test) {
  return String(text || "").split(/(?<=[.!?\n])\s+/).filter((s) => !test(s)).join(" ").trim();
}
export { buildGreetingPrompt, buildSuggestionsPrompt, parseSuggestions, prefetchTurnData, withLanguageNote, withinBudget };

const log = createLogger("agent");

let activeGeminiModel = DEFAULT_GEMINI_MODEL;
let activeGroqModel = DEFAULT_GROQ_MODEL;
let activeClaudeModel = DEFAULT_CLAUDE_MODEL;

const geminiPacer = createPacer({ maxPerMinute: GEMINI_MAX_RPM });
/** Optional pacing (GEMINI_MAX_RPM): waits for a free slot, never longer than the rate-limit budget. */
async function paceGemini(signal, budget) {
  for (let wait = geminiPacer.claim(); wait > 0; wait = geminiPacer.claim()) {
    if (budget.spent + wait > RATE_LIMIT_MAX_WAIT_MS) return;
    await sleep(wait, signal);
    budget.spent += wait;
  }
}

/**
 * A provider's rate limit (429) is a "slow down": wait what it asked (within the budget) and let the caller try again,
 * instead of answering the shopper with an error. Returns true after waiting, false when waiting is not possible or not
 * worth it (the provider asked for longer than the budget, the models are down for another reason, or the budget is spent).
 * With no error given, it waits for models that are paused only because of an earlier rate limit.
 */
async function waitOutRateLimit(provider, models, error, budget, signal) {
  if (error && !isRateLimitError(error)) return false;
  if (!error && !models.some((m) => modelHealth.rateLimited(provider, m))) return false;
  const free = models.some((m) => modelHealth.available(provider, m));
  const pausedFor = free ? 0 : Math.min(...models.map((m) => (modelHealth.rateLimited(provider, m) ? modelHealth.rateLimitReopensInMs(provider, m) : modelHealth.retryInMs(provider, m))));
  const asked = error ? rateLimitWait({ error, spentMs: budget.spent, maxTotalMs: RATE_LIMIT_MAX_WAIT_MS }) : 0;
  if (error && !asked) return false;
  // After a fresh 429 the provider's own hint decides; for models paused by an earlier turn, wait what the budget allows
  // and then try again anyway (the pause is only our estimate).
  const wait = error ? asked : Math.min(pausedFor, RATE_LIMIT_MAX_WAIT_MS - budget.spent);
  if (!(wait > 0) || budget.spent + wait > RATE_LIMIT_MAX_WAIT_MS) return false;
  console.warn(`[agent] ${provider} is rate limited; waiting ${wait} ms, then trying again`);
  inc("llm_rate_limit_waits_total", { provider }, 1, "Times a turn waited out an AI rate limit instead of failing");
  await sleep(wait, signal);
  budget.spent += wait;
  modelHealth.clearRateLimits(provider, models);
  return true;
}

async function callProviderLLM(state) {
  const {
    provider,
    systemPrompt,
    toolsForLlm,
    geminiTools,
    forceFinal,
    signal,
  } = state;
  const baseTimeoutMs = provider === "groq" ? GROQ_TIMEOUT_MS : provider === "claude" ? CLAUDE_TIMEOUT_MS : GEMINI_TIMEOUT_MS;
  const timeoutMs = forceFinal ? Math.min(baseTimeoutMs, ROUND2_TIMEOUT_MS) : baseTimeoutMs;

  function callSignal(ms = timeoutMs) {
    if (!signal) return AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    }
    return signal;
  }

  if (signal?.aborted) {
    const err = new Error("Run cancelled");
    err.name = "AbortError";
    throw err;
  }

  let toolCalls = [];
  let finalText = "";
  let nextGroqMessages = state.groqMessages;
  let nextGeminiContents = state.geminiContents;

  if (provider === "claude") {
    const claude = getClaudeClient();
    if (!claude) throw new Error("Claude client is not configured.");

    const history = forceFinal
      ? [...state.groqMessages, { role: "user", content: state.chatOnly ? CHAT_ONLY_NOTE : WRAP_UP_NOTE }]
      : state.groqMessages;
    const claudeChain = [activeClaudeModel, ...CLAUDE_FALLBACK_MODELS.filter((m) => m !== activeClaudeModel)];
    // one rate-limit budget for the whole turn (shared by its model calls), so waits never add up past it
    const rateBudget = state.rateBudget || { spent: 0 };

    let response = null;
    let lastClaudeErr = null;
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
    let candidateModels = claudeChain.filter((model) => modelHealth.available(provider, model));
    if (candidateModels.length === 0 && (await waitOutRateLimit(provider, claudeChain, null, rateBudget, signal))) {
      candidateModels = claudeChain.filter((model) => modelHealth.available(provider, model));
    }
    // Every Claude model is paused and nothing else can answer: try the current one anyway
    // (a short pause may already be over) instead of showing the shopper an error.
    if (candidateModels.length === 0) candidateModels.push(activeClaudeModel);
    for (const modelName of candidateModels) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      try {
        response = await withHardTimeout(
          claude.messages.create(
            buildClaudeRequest({
              model: modelName,
              history,
              tools: toolsForLlm,
              forceFinal,
              maxTokens: forceFinal ? LLM_REPLY_MAX_OUTPUT_TOKENS : LLM_MAX_OUTPUT_TOKENS,
              temperature: forceFinal ? LLM_TEMPERATURE : LLM_TOOL_TEMPERATURE,
            }),
            { signal: callSignal() }
          ),
          timeoutMs,
          `Claude(${modelName})`
        );
        const claudeTokens = claudeUsage(response?.usage);
        console.log(
          `[timing] Claude (${modelName}) call took ${Date.now() - t0} ms` +
            `; tokens in=${claudeTokens.prompt_tokens} cached=${claudeTokens.cachedContentTokenCount || 0} out=${claudeTokens.completion_tokens}` +
            `${forceFinal ? " (reply round)" : ""}${response?.stop_reason === "max_tokens" ? " (CUT OFF at max tokens)" : ""}`
        );
        const claudeSaidNothing = !parsedHasText(response);
        if (response?.stop_reason === "max_tokens" || claudeSaidNothing) {
          console.warn(`[claude] stop_reason=${response?.stop_reason || "-"} blocks=[${describeClaudeContent(response)}] out=${claudeTokens.completion_tokens}`);
        }
        noteLLM(state.telemetry, { provider, model: modelName, usage: claudeTokens });
        recordLlm({ provider, model: modelName, usage: claudeTokens, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent" });
        modelHealth.success(provider, modelName);
        activeClaudeModel = modelName;
        break;
      } catch (err) {
        lastClaudeErr = err;
        console.warn(`[Claude] model ${modelName} failed:`, String(err?.message || err).slice(0, 180));
        if (signal?.aborted) throw err;
        const cooldown = modelHealth.fail(provider, modelName, err);
        recordLlm({ provider, model: modelName, ok: false, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent" });
        inc("llm_model_cooldowns_total", { provider, model: modelName }, 1, "Times a model was paused after a failure");
        console.warn(`[agent] ${provider}/${modelName} cooling down for ${Math.ceil(cooldown / 1000)}s`);
        // try the next configured model on a model-specific or temporary problem; anything else is final
        if (/\b(404|429|500|502|503|529)\b|overloaded|not found|hard timeout|aborted/i.test(String(err?.message || err))) continue;
        throw err;
      }
    }
    if (response || signal?.aborted) break;
    if (!(await waitOutRateLimit(provider, claudeChain, lastClaudeErr, rateBudget, signal))) break;
    }
    if (!response) throw lastClaudeErr || new Error("All Claude models failed.");

    const parsed = parseClaudeResponse(response, { maxToolCalls: MAX_TOOL_CALLS_PER_ROUND });
    finalText = parsed.text;
    if (!forceFinal && parsed.toolCalls.length > 0) {
      toolCalls = parsed.toolCalls;
      nextGroqMessages = [...state.groqMessages, parsed.assistantMessage];
    }
  } else if (provider === "groq") {
    const groq = getGroqClient();
    if (!groq) {
      throw new Error("Groq client is not configured.");
    }

    const wrapNote = state.chatOnly ? CHAT_ONLY_NOTE : WRAP_UP_NOTE;
    const messages = forceFinal
      ? [...state.groqMessages, { role: "user", content: wrapNote }]
      : state.groqMessages;

    // A model whose per-request token limit is smaller than this prompt would only answer 413: skip it.
    const promptSizeEstimate = estimatePromptTokens(messages, forceFinal ? [] : toolsForLlm);
    const candidateModels = [
      activeGroqModel,
      ...GROQ_FALLBACK_MODELS.filter((m) => m !== activeGroqModel),
    ].filter(model => modelHealth.available(provider, model) && !(groqRequestLimit.get(model) < promptSizeEstimate));

    let response = null;
    let lastGroqErr = null;

    for (const modelName of candidateModels) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      try {
        response = await withHardTimeout(
          groq.chat.completions.create(
            {
              model: modelName,
              messages,
              ...(forceFinal
                ? {}
                : {
                    tools: toolsForLlm,
                    tool_choice: "auto",
                  }),
              max_tokens: forceFinal ? LLM_REPLY_MAX_OUTPUT_TOKENS : LLM_MAX_OUTPUT_TOKENS,
              temperature: forceFinal ? LLM_TEMPERATURE : LLM_TOOL_TEMPERATURE,
            },
            { signal: callSignal() }
          ),
          timeoutMs,
          `Groq(${modelName})`
        );
        console.log(`[timing] Groq (${modelName}) call took ${Date.now() - t0} ms`);
        noteLLM(state.telemetry, { provider, model: modelName, usage: response?.usage });
        recordLlm({ provider, model: modelName, usage: response?.usage, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent" });
        modelHealth.success(provider, modelName);
        activeGroqModel = modelName;
        break;
      } catch (err) {
        lastGroqErr = err;
        const msg = String(err?.message || err).toLowerCase();
        console.warn(
          `[Groq] model ${modelName} failed:`,
          String(err?.message || err).slice(0, 180)
        );
        if (signal?.aborted) throw err;
        const limit = parseGroqRequestLimit(err);
        if (limit) groqRequestLimit.set(modelName, limit);
        const cooldown = modelHealth.fail(provider, modelName, err);
        recordLlm({ provider, model: modelName, ok: false, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent" });
        inc("llm_model_cooldowns_total", { provider, model: modelName }, 1, "Times a model was paused after a failure");
        console.warn(`[agent] ${provider}/${modelName} cooling down for ${Math.ceil(cooldown / 1000)}s`);
        if (
          limit ||
          msg.includes("429") ||
          msg.includes("rate limit") ||
          msg.includes("404") ||
          msg.includes("not found") ||
          msg.includes("decommissioned") ||
          msg.includes("tool_use_failed") ||
          msg.includes("hard timeout") ||
          msg.includes("aborted")
        ) {
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      throw lastGroqErr || new Error("All Groq models failed.");
    }

    const assistantMessage = response.choices?.[0]?.message || {};
    toolCalls = forceFinal
      ? []
      : (assistantMessage.tool_calls || [])
          .slice(0, MAX_TOOL_CALLS_PER_ROUND)
          .map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            rawArguments: call.function.arguments,
          }));

    finalText = (assistantMessage.content || "").trim();

    if (toolCalls.length > 0) {
      nextGroqMessages = [
        ...state.groqMessages,
        {
          role: "assistant",
          content: assistantMessage.content || "",
          tool_calls: assistantMessage.tool_calls
            .slice(0, MAX_TOOL_CALLS_PER_ROUND)
            .map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments: call.function.arguments,
              },
            })),
        },
      ];
    }
  } else {
    const gemini = getGeminiClient();
    if (!gemini) {
      throw new Error("Gemini client is not configured.");
    }

    const contents = forceFinal
      ? [
          ...state.geminiContents,
          { role: "user", parts: [{ text: state.chatOnly ? CHAT_ONLY_NOTE : WRAP_UP_NOTE }] },
        ]
      : state.geminiContents;

    const geminiChain = [activeGeminiModel, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== activeGeminiModel)];
    // one rate-limit budget for the whole turn (shared by its model calls), so waits never add up past it
    const rateBudget = state.rateBudget || { spent: 0 };

    let response = null;
    let lastGemErr = null;

    // A rate limit (429) is waited out and the models tried again, instead of ending the turn with an error.
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
    let candidateModels = geminiChain.filter(model => modelHealth.available(provider, model));
    if (candidateModels.length === 0 && (await waitOutRateLimit(provider, geminiChain, null, rateBudget, signal))) {
      candidateModels = geminiChain.filter(model => modelHealth.available(provider, model));
    }
    // Every Gemini model is paused after a quick "busy" answer (503 / overloaded) and this turn has nothing else to ask:
    // probe one again instead of telling the shopper there is a connection problem (the busy spell is often over in seconds).
    if (candidateModels.length === 0) {
      const probe = geminiChain.find(model => modelHealth.busyOnly(provider, model));
      if (probe) candidateModels = [probe];
    }
    await paceGemini(signal, rateBudget);
    const hedgedAway = new Set(); // models already asked in a hedged pair this attempt: not asked a second time
    for (const [modelIndex, firstModel] of candidateModels.entries()) {
      if (signal?.aborted) break;
      if (hedgedAway.has(firstModel)) continue;
      let modelName = firstModel;
      // While another healthy model is waiting in line, a slow one gets a shorter wait: the shopper is better served by
      // the next model answering in a second than by sitting out the full timeout on one that is struggling.
      // The same holds for the last Gemini model when another provider (Claude) is next for this turn: a Gemini that hangs
      // must not eat the whole wait before the fallback even starts.
      const timeoutFor = (index) => index < candidateModels.length - 1
        ? Math.min(timeoutMs, GEMINI_FAILOVER_TIMEOUT_MS)
        : state.hasNextProvider
          ? Math.min(timeoutMs, Math.max(GEMINI_FAILOVER_TIMEOUT_MS, 10000))
          : timeoutMs;
      const modelTimeoutMs = timeoutFor(modelIndex);

      // The reply-writing round keeps the SAME tool list as round 1 (with calling switched off), so
      // the request starts with the same prefix (system prompt + tools + conversation) and Gemini's
      // implicit prompt cache can serve it: a faster and cheaper second call.
      const sharePrefix = forceFinal && !state.chatOnly && KEEP_TOOLS_IN_FINAL_ROUND && geminiTools?.length > 0;
      const callGemini = (model, thinkingCfg, ms, stop) =>
        withHardTimeout(
          gemini.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: systemPrompt,
              ...(forceFinal && !sharePrefix
                ? {}
                : {
                    tools: [{ functionDeclarations: geminiTools }],
                    toolConfig: {
                      functionCallingConfig: { mode: sharePrefix ? "NONE" : "AUTO" },
                    },
                  }),
              abortSignal: typeof AbortSignal.any === "function" ? AbortSignal.any([callSignal(ms), stop]) : callSignal(ms),
              maxOutputTokens: forceFinal ? LLM_REPLY_MAX_OUTPUT_TOKENS : LLM_MAX_OUTPUT_TOKENS,
              temperature: forceFinal ? LLM_TEMPERATURE : LLM_TOOL_TEMPERATURE,
              ...(thinkingCfg ? { thinkingConfig: thinkingCfg } : {}),
            },
          }),
          ms,
          `Gemini(${model})`
        );
      // One model, with the thinking settings it accepts (the first that works is remembered for next time).
      const askModel = async (model, ms, stop) => {
        const candidates = getGeminiThinkingCandidates(model);
        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
          const cfg = candidates[cIdx];
          try {
            const out = await callGemini(model, cfg, ms, stop);
            workingThinkingByModel.set(model, cfg);
            return out;
          } catch (error) {
            const text = String(error?.message || "").toLowerCase();
            if (cfg && /thinking|budget|invalid argument|not supported/i.test(text) && cIdx < candidates.length - 1 && !signal?.aborted && !stop.aborted) continue;
            throw error;
          }
        }
        throw new Error(`Gemini(${model}) gave no answer`);
      };

      const t0 = Date.now();
      try {
        // A hedged request: when the first model has not answered after GEMINI_HEDGE_MS (it usually answers in 2-4 s), the next
        // healthy model is asked too, and the first answer wins; the slower call is cancelled. A model that hangs used to cost
        // the shopper its whole failover wait (7 s, live 2026-11-22) before the next model was even asked.
        // With no other healthy model, one that is paused only after a slow or failed answer is still asked as the backup: a single
        // model that then fails ("500 Internal error", live 2026-11-22) left the shopper with the connection-trouble line.
        const backup = GEMINI_HEDGE_MS <= 0 ? null
          : candidateModels.slice(modelIndex + 1).find((m) => !hedgedAway.has(m))
            || (modelIndex === candidateModels.length - 1 ? geminiChain.find((m) => m !== modelName && !hedgedAway.has(m) && !candidateModels.includes(m) && modelHealth.softPaused(provider, m)) : null);
        if (!backup) {
          response = await askModel(modelName, modelTimeoutMs, new AbortController().signal);
        } else {
          hedgedAway.add(backup);
          const stopFirst = new AbortController();
          const stopBackup = new AbortController();
          let startBackup;
          const backupGo = new Promise((resolve) => { startBackup = resolve; });
          const hedgeTimer = setTimeout(() => startBackup(), GEMINI_HEDGE_MS);
          const first = askModel(modelName, modelTimeoutMs, stopFirst.signal)
            .then((out) => ({ out, model: modelName }))
            .catch((error) => {
              startBackup();
              // the first model failed on its own (not cancelled because the backup won): it is paused like any failed model
              if (!stopFirst.signal.aborted && !signal?.aborted) {
                modelHealth.fail(provider, modelName, error);
                recordLlm({ provider, model: modelName, ok: false, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent", error });
                console.warn(`[Gemini] model ${modelName} failed:`, String(error?.message || error).slice(0, 180));
                error.healthRecorded = true;
              }
              throw error;
            });
          // the backup gets the wait it would have had as the next model in line (the last model: the full wait)
          const backupTimeoutMs = candidateModels.includes(backup) ? timeoutFor(candidateModels.indexOf(backup)) : timeoutFor(candidateModels.length - 1);
          const second = backupGo.then(() => {
            if (stopBackup.signal.aborted || signal?.aborted) throw new Error("hedge not needed");
            console.warn(`[agent] ${modelName} is slow or failed; asking ${backup} at the same time`);
            return askModel(backup, backupTimeoutMs, stopBackup.signal).then((out) => ({ out, model: backup }));
          });
          try {
            let firstFailed = false;
            first.catch(() => { firstFailed = true; });
            const won = await Promise.any([first, second]);
            response = won.out;
            if (won.model !== modelName) {
              console.warn(`[agent] ${backup} answered first; ${modelName} is cancelled`);
              if (!firstFailed) recordLlm({ provider, model: modelName, ok: false, latencyMs: Date.now() - t0, label: "hedge_lost" });
              modelName = backup;
            }
          } catch (aggregate) {
            const errors = aggregate?.errors || [aggregate];
            const real = errors.find((e) => !/hedge not needed/.test(String(e?.message || ""))) || errors[0];
            // the backup failed too: it is paused like any failed model
            if (errors.length > 1 && errors[1] && !/hedge not needed/.test(String(errors[1]?.message || ""))) {
              modelHealth.fail(provider, backup, errors[1]);
              recordLlm({ provider, model: backup, ok: false, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent", error: errors[1] });
              console.warn(`[Gemini] model ${backup} failed too:`, String(errors[1]?.message || errors[1]).slice(0, 180));
            }
            throw real;
          } finally {
            clearTimeout(hedgeTimer);
            stopFirst.abort();
            stopBackup.abort();
            startBackup();
          }
        }
        const usage = response?.usageMetadata || {};
        console.log(
          `[timing] Gemini (${modelName}) call took ${Date.now() - t0} ms` +
            (usage.promptTokenCount
              ? `; tokens in=${usage.promptTokenCount} cached=${usage.cachedContentTokenCount || 0} out=${usage.candidatesTokenCount || 0}${forceFinal ? " (reply round)" : ""}`
              : "")
        );
        noteLLM(state.telemetry, { provider, model: modelName, usage });
        recordLlm({ provider, model: modelName, usage, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent" });
        modelHealth.success(provider, modelName);
        activeGeminiModel = modelName;
        break;
      } catch (err) {
        lastGemErr = err;
        const msg = String(err?.message || err).toLowerCase();
        console.warn(
          `[Gemini] model ${modelName} failed:`,
          String(err?.message || err).slice(0, 180)
        );
        if (signal?.aborted) throw err;
        const cooldown = err?.healthRecorded ? modelHealth.retryInMs(provider, modelName) : modelHealth.fail(provider, modelName, err);
        if (!err?.healthRecorded) recordLlm({ provider, model: modelName, ok: false, latencyMs: Date.now() - t0, label: forceFinal ? "reply" : "agent", error: err });
        inc("llm_model_cooldowns_total", { provider, model: modelName }, 1, "Times a model was paused after a failure");
        console.warn(`[agent] ${provider}/${modelName} cooling down for ${Math.ceil(cooldown / 1000)}s`);
        if (
          msg.includes("404") ||
          msg.includes("no longer available") ||
          msg.includes("not found") ||
          msg.includes("503") ||
          msg.includes("high demand") ||
          msg.includes("unavailable") ||
          msg.includes("429") ||
          msg.includes("hard timeout") ||
          msg.includes("aborted")
        ) {
          continue;
        }
        throw err;
      }
    }

    if (response || signal?.aborted) break;
    if (!(await waitOutRateLimit(provider, geminiChain, lastGemErr, rateBudget, signal))) break;
    }

    if (!response) {
      throw lastGemErr || new Error("All Gemini models failed.");
    }

    const candidate = response.candidates?.[0];
    const modelContent = candidate?.content;
    if (!modelContent) {
      throw new Error(
        `Gemini returned no candidate content (finishReason: ${
          candidate?.finishReason ?? "unknown"
        }).`
      );
    }

    const parts = modelContent.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);
    const textParts = parts.filter((p) => p.text);
    finalText = textParts.map((p) => p.text).join("").trim();

    if (!forceFinal && functionCalls.length > 0) {
      toolCalls = functionCalls
        .slice(0, MAX_TOOL_CALLS_PER_ROUND)
        .map((p, i) => ({
          id: `gemini-${i}`,
          name: p.functionCall.name,
          arguments: p.functionCall.args || {},
          rawArguments: p.functionCall.args || {},
        }));
      nextGeminiContents = [...state.geminiContents, modelContent];
    }
  }

  // Tool arguments can contain addresses/emails: only at debug level.
  log.debug(
    `tool calls: ${redact(JSON.stringify(
      toolCalls.map((c) => ({
        name: c.name,
        arguments:
          typeof c.arguments === "string"
            ? c.arguments
            : JSON.stringify(c.arguments),
      }))
    ))}`
  );

  return {
    toolCalls,
    finalText,
    groqMessages: nextGroqMessages,
    geminiContents: nextGeminiContents,
  };
}

async function agentNode(state) {
  const round = state.round || 0;
  const forceFinal = round >= MAX_TOOL_ROUNDS || state.forceFinal;
  log.debug(
    `provider: ${state.provider}, round ${round + 1}${
      forceFinal ? " (final, no tools)" : ""
    }`
  );

  try {
    const out = await callProviderLLM({ ...state, forceFinal });
    return {
      ...out,
      forceFinal,
      round,
      done: forceFinal || (out.toolCalls || []).length === 0,
      error: null,
    };
  } catch (error) {
    return {
      error,
      done: true,
      toolCalls: [],
      finalText: "",
    };
  }
}

// One extra reply-writing call with a note from the store system (empty reply, or a reply that
// failed the fact check). Returns "" if the provider fails, so the caller can fall back safely.
/** True once this customer message has taken longer than TURN_SOFT_DEADLINE_MS: optional extra AI calls are skipped. */
function overBudget(state) {
  const started = Number(state.telemetry?.startedAt);
  return Number.isFinite(started) && Date.now() - started > TURN_SOFT_DEADLINE_MS;
}

async function rewriteReply(state, note, { essential = false } = {}) {
  if (state.signal?.aborted) return "";
  if (!essential && overBudget(state)) {
    console.warn("[guard] this reply is taking long; skipping the optional rewrite and sending the reply as it is");
    return "";
  }
  try {
    const out = await callProviderLLM({
      ...state,
      forceFinal: true,
      groqMessages: [...(state.groqMessages || []), { role: "user", content: note }],
      geminiContents: [...(state.geminiContents || []), { role: "user", parts: [{ text: note }] }],
    });
    return String(out.finalText || "").trim();
  } catch (error) {
    console.warn("[agent] reply rewrite failed:", String(error?.message || error).slice(0, 200));
    return "";
  }
}

// A store step ran outside the model's own tool calls (a guard added the product, set the address, ran billing or a cancellation), so the
// model has not seen its result. The AI writes the reply from what the store really returned, in the shopper's language and in the
// voice of the store owner chatting with a friend. The store's own wording is sent only when the AI cannot write it, or writes
// an amount, an order number or a claim that the store's data does not have.
async function speakFromStoreResult(state, found, situation, { mustName = [] } = {}) {
  const facts = String(found?.fallbackSpeech || "").trim();
  if (!facts || !state.provider || state.signal?.aborted) return facts;
  const draft = await rewriteReply(state, `[Store system: ${situation} This is what the store really returned (verified data, not yet seen by the customer): "${facts.slice(0, 1500)}". Write your reply to the customer's last message now, in their language and script, warm and natural, like the store owner chatting with a friend: short, in your own words, not a list of fields. Keep every amount, product name, option, order number, code and address exactly as written in that data, say nothing that the data does not say, and end with the one next step it gives. Never mention the store system, a tool or a check.]`, { essential: true });
  const reply = stripReasoningLeak(String(draft || "").trim());
  if (!reply || looksLikeThinkingAloud(reply)) return facts;
  const currency = dataCurrency([(state.toolLog || []).map((t) => t.result), found.actions || [], found.checkout || null]);
  const fixed = repairCurrencyMarks(reply, currency).text;
  const verdict = verifyReplyFacts(fixed, [facts, (state.toolLog || []).map((t) => t.result), found.actions || [], found.checkout || null, state.context?.cart || null, state.userMessage || ""], { currency });
  const proven = doneEvidence({ actions: found.actions, toolLog: state.toolLog || [] });
  const overclaims = claimsDone(fixed).filter((kind) => !proven.has(kind) && !claimsDone(facts).includes(kind));
  // what the shopper must hear back: the product that was added, and every PIN code and order number the store's wording gives
  const missingName = mustName.filter((title) => title && productsMentionedInAnswer([{ title }], fixed, { strict: true }).length === 0);
  const keyNumbers = [...new Set(facts.match(/#\d{3,}|\b\d{6}\b/g) || [])];
  const missingNumbers = keyNumbers.filter((n) => !fixed.includes(n.replace(/^#/, "")));
  if (!verdict.ok || (verdict.unknownSpecs || []).length || overclaims.length || missingName.length || missingNumbers.length) {
    console.warn("[guard] the AI reply for the store step did not match the store's data; sending the store's own wording");
    return facts;
  }
  return fixed;
}

async function finalizeNode(state) {
  const session = getSession(state.sessionKey);
  let found = session?.result?.() || {
    products: [],
    actions: [],
    checkout: null,
    fallbackSpeech: "",
  };

  // CRITICAL BUG FIX:
  // ONLY run `autoRecoverProducts` when ZERO tools were executed in Round 1 (`toolCallsExecuted === 0`)!
  if (
    !state.error &&
    !state.chatOnly &&
    (state.toolCallsExecuted || 0) === 0 &&
    (found.products || []).length === 0 &&
    (found.actions || []).length === 0 &&
    (found.speculativeProducts || []).length === 0 &&
    !state.context?.llmMode &&
    typeof session?.autoRecoverProducts === "function"
  ) {
    try {
      const recovered = await session.autoRecoverProducts(
        state.userMessage,
        state.finalText
      );
      if (recovered) {
        found = session.result();
        const hasRecoveredPayload =
          (found.products || []).length > 0 || (found.actions || []).length > 0;
        if ((!String(state.finalText || "").trim() || hasRecoveredPayload) && found.fallbackSpeech) {
          return {
            answer: String(state.finalText || "").trim() && (found.products || []).length > 0 && (found.actions || []).length === 0
              ? state.finalText.trim()
              : await speakFromStoreResult(state, found, "the store was checked for the customer's message just now."),
            products: found.products || [],
            actions: found.actions || [],
            checkout: found.checkout ?? null,
            done: true,
          };
        }
      }
    } catch {
      // ignore auto-recovery errors
    }
  }

  if (state.error) {
    const msg = String(state.error?.message || state.error || "");
    const aborted =
      state.error?.name === "AbortError" || /aborted|hard timeout/i.test(msg);

    const hasProducts = (found.products || []).length > 0;
    const hasActions = (found.actions || []).length > 0;
    const hasFallbackSpeech = Boolean(found.fallbackSpeech);

    if (hasFallbackSpeech || hasProducts || hasActions) {
      console.warn(
        `[agent] ${
          aborted ? "aborted after tools" : "LLM error"
        }: ${msg.slice(0, 200)}; answering with rich tool summary.`
      );
      return {
        answer: found.fallbackSpeech || FALLBACK_ANSWER,
        products: found.products || [],
        actions: found.actions || [],
        checkout: found.checkout ?? null,
        done: true,
      };
    }

    throw state.error;
  }

  // Checkout review / placed order: the card carries every detail, and the reply is fact-checked below.
  let hasOrderOrReviewAction = (found.actions || []).some(
    (a) => a?.type === "order_placed" || a?.type === "checkout_ready"
  );
  let text = stripReasoningLeak((state.finalText || "").trim());

  // The reply is the model thinking aloud, not a message to the shopper: it is written again.
  if (text && state.provider && looksLikeThinkingAloud(text)) {
    console.warn("[guard] the reply is the model thinking aloud; asking it to write the real reply");
    const again = await rewriteReply(state, `[Store system check: your draft is your own reasoning ("${text.slice(0, 200)}"), not a message for the customer. Write ONLY what the customer should read, in their language: short and friendly. If you are not sure what they want to see, ask ONE short question. Never mention rules, instructions, the cart state, or what the customer asked.]`, { essential: true });
    text = again && !looksLikeThinkingAloud(again) ? stripReasoningLeak(again) : "";
  }

  // The model returned no text: ask it once more to write the reply (instead of a stored sentence).
  if (!text && state.provider) {
    console.warn("[agent] the model returned an empty reply; asking it once more (this adds one extra AI call)");
    text = await rewriteReply(state, "[Store system: your previous reply was empty. Write your reply to the customer's last message now, from the tool results above.]", { essential: true });
  }

  // The reply says the item is not available, but the store's own data for this message has it in stock and the reply names
  // none of it: a false "no". The AI writes the reply again with the real products; if it still contradicts the data, the
  // verified product wording is sent.
  let toolLog = state.toolLog || [];
  // The shopper asked for a person this turn (an audio call, or the team to follow up). Whatever was searched earlier in the chat
  // is not the answer: the availability check below must not turn "nobody can join right now" into a product list.
  const personTurn = text && (found.actions || []).some((a) => a?.type === "human_support" || a?.type === "flag_for_owner");
  if (personTurn && state.provider) {
    const searched = [];
    for (const t of toolLog) for (const p of Array.isArray(t?.result?.products) ? t.result.products : []) if (p?.title && !searched.some((x) => x.title === p.title)) searched.push(p);
    const named = searched.length ? productsMentionedInAnswer(searched, text, { strict: true }) : [];
    if (named.length > 0) {
      console.warn(`[guard] the shopper asked for a person but the reply talks about products (${named.map((p) => p.title).slice(0, 3).join(" | ")}); asking the AI to rewrite it`);
      const redone = await rewriteReply(state, `[Store system check: the customer's last message only asks for a person, but your draft talks about products. Draft: "${text.slice(0, 600)}". Write the reply again in the customer's language: only say what happens next with their request for a person. Name no product and offer no products.]`);
      const stillNamed = redone && searched.length ? productsMentionedInAnswer(searched, redone, { strict: true }) : [];
      if (redone && stillNamed.length === 0) text = redone;
      else text = text.split("\n").filter((line) => !named.some((p) => line.toLowerCase().includes(String(p.title).toLowerCase()))).join("\n").trim() || text;
    }
  }
  // The model said "not available" without searching at all: the store is asked now, with the shopper's own words.
  if (text && !personTurn && !state.chatOnly && !hasOrderOrReviewAction && !searchRan(toolLog) && claimsUnavailable(text) && typeof session?.handlers?.search_products === "function") {
    try {
      const result = await session.handlers.search_products({ searchTerm: String(state.userMessage || "") });
      toolLog = [...toolLog, { name: "search_products", result }];
      found = session.result();
    } catch {
      // no evidence: the reply stays as it is
    }
  }
  // The store could not be asked (Shopify gave an error): the AI does not know what the store has. It must say so, never "we do not
  // have it" and never products or prices from memory.
  let lookupFailedOverride = false;
  if (text && !state.chatOnly && !hasOrderOrReviewAction && productLookupFailed(toolLog)) {
    const probeHas = Array.isArray(state.context?.probeProducts) && state.context.probeProducts.length > 0;
    const hasPrice = (t) => /[$€£₹]\s?\d|\d\s?(?:USD|INR|EUR|GBP)\b/i.test(t);
    const risky = claimsUnavailable(text) || (!probeHas && (/\*\*/.test(text) || hasPrice(text)));
    if (risky) {
      console.warn("[guard] the store lookup failed but the reply states product facts; replacing it with an honest answer");
      const safe = state.provider
        ? await rewriteReply(state, `[Store system check: the store's product lookup FAILED this turn (the tool returned an error), so you do NOT know what the store has. Draft: "${text.slice(0, 400)}". Write the reply again in the customer's language: say briefly that you could not check the store just now and ask them to try again in a moment. Do not say any item is unavailable or out of stock, and do not name any product or price.]`, { essential: true })
        : "";
      const clean = safe && !claimsUnavailable(safe) && !/\*\*/.test(safe) && !hasPrice(safe);
      text = clean ? safe : lookupFailedReply(state.context?.replyLanguage);
      lookupFailedOverride = true;
    }
  }

  // The reply says a person is being connected, or the team has been told, but no such request was made this turn: make it true.
  // The shopper asked for a person but the model only chatted: the request is made anyway.
  const askedForPerson = Boolean(text && !personTurn && !state.chatOnly && !hasOrderOrReviewAction && asksForPerson(state.userMessage));
  const handoffClaim = text && !personTurn && !state.chatOnly && !hasOrderOrReviewAction ? (claimsPersonHandoff(text) || (askedForPerson ? "connect" : "")) : "";
  if (handoffClaim && typeof session?.handlers?.flag_for_owner === "function") {
    console.warn(`[guard] the reply says it ${handoffClaim === "connect" ? "is connecting a person" : "passed this to the team"} but no request was made; making the request now`);
    const reason = String(state.userMessage || "").replace(/\s+/g, " ").trim().slice(0, 200);
    try {
      let out = null;
      if (handoffClaim === "connect" && typeof session.handlers.request_human_support === "function") out = await session.handlers.request_human_support({ reason });
      if (out?.status === "offered" && askedForPerson && !claimsPersonHandoff(text)) text = connectingReply(state.context?.replyLanguage);
      if (!out || out.status !== "offered") {
        const flagged = await session.handlers.flag_for_owner({ reason });
        const told = flagged?.status === "ok";
        // The reply promised more than can happen (a person joining now, or a team that cannot be alerted here): say what is true.
        if (handoffClaim === "connect" || !told) {
          const truth = told
            ? "nobody can join this chat right now, but the store team has been told and will follow up; do not say a person is connecting and do not promise a time"
            : "this chat cannot connect a person or alert the store team; say so plainly and suggest the store's own contact details";
          const again = !state.provider ? "" : await rewriteReply(state, `[Store system check: your draft promised something that cannot happen. Draft: "${text.slice(0, 400)}". Write the reply again in the customer's language: ${truth}.]`, { essential: true });
          text = again && !claimsPersonHandoff(again) ? again : told ? teamToldReply(state.context?.replyLanguage) : noPersonReply(state.context?.replyLanguage);
        }
      }
      found = session.result();
    } catch (error) {
      console.warn("[guard] could not make the person request:", String(error?.message || error).slice(0, 160));
    }
  }
  // The reply says a call is booked, but no booking was made this turn: say what is true.
  if (text && !state.chatOnly && claimsCallBooked(text) && !(found.actions || []).some((a) => a?.type === "call_booked")) {
    console.warn("[guard] the reply says a call is booked but no booking was made; asking the AI to rewrite it");
    const again = state.provider
      ? await rewriteReply(state, `[Store system check: your draft says a call is booked or being booked, but book_call did not run, so NO call is booked. Draft: "${text.slice(0, 400)}". Write the reply again in the customer's language: say the call is not booked yet, offer two or three of the real times from get_call_slots if you have them, and ask which exact time they want. Do not say it is booked.]`, { essential: true })
      : "";
    text = again && !claimsCallBooked(again) ? again : callNotBookedReply(state.context?.replyLanguage);
  }

  // The customer confirmed the cancellation and gave their reason, and the model SAID it was cancelled without calling cancel_order (a real browser run
  // answered "I cannot confirm that this has been done" and left the order open). The step is run now with the customer's own words, and the reply
  // reports what Shopify answered.
  // Also when the customer's yes came with the reason already known ("reason_known"): the store asked for cancel_order in the same turn, but
  // a slow turn ends before the model's next round, and the shopper heard "cancel kar rahi hoon" while nothing was cancelled (live #1045).
  const knownReason = (toolLog || []).find((t) => t?.name === "confirm_order_cancellation" && t?.result?.status === "reason_known")?.result?.reason;
  if (text && !state.chatOnly && (claimsDone(text).includes("order_cancelled") || knownReason) && !(toolLog || []).some((t) => t?.name === "cancel_order") && typeof session?.handlers?.cancel_order === "function") {
    try {
      if ((await session.pendingCancelStage?.()) === "awaiting_reason") {
        console.warn("[guard] the cancellation is confirmed with its reason but cancel_order did not run; running it now");
        const res = await session.handlers.cancel_order({ reason: knownReason || state.userMessage });
        toolLog.push({ name: "cancel_order", result: res });
        found = session.result();
        if (found.fallbackSpeech) text = await speakFromStoreResult(state, found, "the customer confirmed the cancellation and gave the reason, so the cancellation was sent to the store just now.");
      }
    } catch (error) { console.warn("[guard] could not run the cancellation:", String(error?.message || error).slice(0, 120)); }
  }

  // The reply says an order was placed or cancelled, a refund issued, a complaint raised or an e-mail sent, but the backend confirmed none
  // of it this turn: say what is true. Replies that report what an order lookup returned are data, not claims.
  if (text && !state.chatOnly && !(toolLog || []).some((t) => ["get_order_details", "list_my_orders"].includes(t?.name))) {
    const proven = doneEvidence({ actions: found.actions, toolLog });
    const unproven = claimsDone(text).filter((kind) => !proven.has(kind));
    if (unproven.length > 0) {
      console.warn(`[guard] the reply says ${unproven.join(", ")} was done but the backend did not confirm it; asking the AI to rewrite it`);
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft says this was done (${unproven.join(", ")}), but no tool confirmed it, so it must NOT be stated as done. Draft: "${text.slice(0, 400)}". Write the reply again in the customer's language: say only what the tools actually confirmed, and offer the next real step.]`, { essential: true })
        : "";
      // when the rewrite still claims too much, the store's own verified wording for this turn comes before the generic line
      const verified = found.fallbackSpeech && claimsDone(found.fallbackSpeech).every((kind) => proven.has(kind)) ? found.fallbackSpeech : "";
      text = again && claimsDone(again).every((kind) => proven.has(kind)) ? again : (verified || notConfirmedReply(state.context?.replyLanguage));
    }
  }

  // The reply states a store policy, a promise (a return window, a replacement, a warranty) or support hours that none of THIS turn's store data
  // backs. The policy tool answers "not published" for what the merchant never wrote, but a draft written from the model's own head
  // (or without calling the tool) used to go out unchecked. Read the policy now when the question was about one, then say only what is published.
  if (text && !state.chatOnly) {
    let unsupported = unsupportedStoreClaims(text, toolLog);
    if (unsupported.length > 0) {
      console.warn(`[guard] the reply states store policy or hours that the store's data does not back (${unsupported.map((u) => u.kind).join(", ")}); checking the real policy`);
      let policyResult = (toolLog || []).filter((t) => t?.name === "get_warranty_and_policy").map((t) => t.result).pop() || null;
      if (!policyResult && typeof session?.handlers?.get_warranty_and_policy === "function") {
        try {
          const topic = /refund|return|replac|exchange|damag|broken|defect/i.test(state.userMessage || "") ? "returns" : /shipping|delivery|deliver/i.test(state.userMessage || "") ? "shipping" : "";
          policyResult = await session.handlers.get_warranty_and_policy(topic ? { topic } : {});
          toolLog.push({ name: "get_warranty_and_policy", result: policyResult });
          found = session.result();
          unsupported = unsupportedStoreClaims(text, toolLog);
        } catch (error) {
          console.warn("[guard] could not read the store policy:", String(error?.message || error).slice(0, 160));
        }
      }
      if (unsupported.length > 0) {
        const published = policyResult?.status === "ok" && (policyResult.policies || []).length > 0
          ? `The store's own policy lookup returned: ${JSON.stringify((policyResult.policies || []).map((x) => ({ title: x.title, text: String(x.text || "").slice(0, 700) })))}.`
          : "The store has NOT published any policy that covers this (the policy lookup came back empty).";
        const again = state.provider
          ? await rewriteReply(state, `[Store system check: your draft states something about the store's policy, promises or support hours that the store's data does not contain: "${unsupported.map((u) => u.sentence).join(" ").slice(0, 400)}". ${published} Write the reply again in the customer's language: say only what the store has really published; if it has not published this, say so plainly in one short line and offer the store's contact details or to pass the request to the team. Do not invent a policy, a time period, a warranty, a return or replacement promise or support hours.]`, { essential: true })
          : "";
        text = again && unsupportedStoreClaims(again, toolLog).length === 0 ? again : policyNotPublishedReply(state.context?.replyLanguage);
      }
    }
  }

  // Claims the store's data does not back: payment methods and store facts (M5), product performance judgements (M4), agreeing with or
  // apologising for something the shopper wrongly claimed (M3), and "I am raising a complaint now" before anything was done (M9).
  // Each is rewritten once (skipped when the turn is already slow: overBudget), and otherwise the unsupported sentences are removed.
  if (text && !state.chatOnly) {
    const lang = state.context?.replyLanguage;
    const dropSentences = (list) => performanceFallback(list.map((u) => u.sentence ?? u), text);

    const facts = unsupportedPaymentAndStoreFacts(text, toolLog);
    if (facts.length > 0) {
      console.warn(`[guard] the reply states payment methods or store facts the store's data does not contain (${facts.map((f) => f.kind).join(", ")})`);
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft states store facts that the store's data does not contain: "${facts.map((f) => f.sentence).join(" ").slice(0, 400)}". Write the reply again without them: say only what the data shows; if you do not know (accepted payment methods, opening hours, location, shipping coverage or delivery times), say so in one short line and point to the options shown at checkout or offer the store's contact details.]`)
        : "";
      text = again && unsupportedPaymentAndStoreFacts(again, toolLog).length === 0 ? again : (dropSentences(facts) || paymentNotPublishedReply(lang));
    }

    const perf = unsupportedPerformanceClaims(text, toolLog);
    if (perf.length > 0) {
      console.warn(`[guard] the reply judges product performance that the product data never mentions (${perf.map((x) => x.topics.join("/")).join("; ")})`);
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft makes claims about performance/quality ("${perf.map((x) => x.sentence).join(" ").slice(0, 400)}") that the product data does not state. Write the reply again: describe only what the product data lists (specs, features, price, options); do not say a product is better, faster, smoother or good for gaming, battery or camera unless the data says so. If the customer asked for such a comparison, say the listing does not say, and compare only the listed facts.]`)
        : "";
      text = again && unsupportedPerformanceClaims(again, toolLog).length === 0 ? again : (dropSentences(perf) || text);
    }

    const agreement = falseAgreement({ userMessage: state.userMessage, history: state.context?.history || [], text, toolLog });
    if (agreement) {
      console.warn(`[guard] the reply agrees with or apologises for something that is not supported: ${agreement.problem}`);
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft opens by agreeing with the customer or apologising for a mistake, but ${agreement.problem}. What the data actually shows: ${agreement.truth}. Write the reply again: do NOT say they are right and do NOT apologise for an error you did not make; politely and plainly state the real figures or facts, and say that if they see something different you would like to check it together.]`)
        : "";
      text = again && !falseAgreement({ userMessage: state.userMessage, history: state.context?.history || [], text: again, toolLog }) ? again : text.replace(/^[^.!?\n]*[.!?]\s*/, "").trim() || text;
    }

    const doneAny = (toolLog || []).some((t) => ["raise_complaint", "request_human_support", "flag_for_owner"].includes(t?.name)) || (found.actions || []).some((a) => ["human_support", "flag_for_owner"].includes(a?.type));
    const escalating = doneAny ? [] : claimsEscalationNow(text);
    if (escalating.length > 0) {
      console.warn("[guard] the reply says a complaint is being raised now, but no complaint step happened");
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft says you are raising or escalating a complaint now ("${escalating.join(" ").slice(0, 300)}"), but nothing was raised and the customer has not chosen how. Write the reply again: acknowledge the problem, say what you can do to help first, and only ASK whether they want it passed on (by email or to a person); do not say it is being raised.]`)
        : "";
      text = again && claimsEscalationNow(again).length === 0 ? again : (dropSentences(escalating) || text);
    }
  }

  // Discount figures in the reply must be one option's own (original -> sale) pair: "from $309 to $229, saving $80" paired the 256GB's original
  // price with the 128GB's sale price. The tools now return each option's own pair; a draft that mixes them is rewritten from those pairs.
  if (text && !state.chatOnly) {
    const issues = discountClaimProblems(text, toolLog);
    if (issues.length > 0) {
      console.warn(`[guard] the reply states discount figures that no single option has: ${issues.join("; ").slice(0, 300)}`);
      const pairs = salePairs(toolLog);
      const code = dataCurrency([toolLog.map((t) => t.result)]);
      const sign = code === "USD" || code === "" ? "$" : `${code} `;
      const facts = saleFactsLine(pairs, sign);
      const again = state.provider
        ? await rewriteReply(state, `[Store system check: your draft states discount figures that mix different options (${issues.join("; ").slice(0, 300)}). Draft: "${text.slice(0, 500)}". Each option has its OWN original price and sale price, and these are the only real ones: ${facts}. Write the reply again in the customer's language using only one option's own figures for each claim, naming the option. Never pair one option's original price with another option's price.]`, { essential: true })
        : "";
      text = again && discountClaimProblems(again, toolLog).length === 0 ? again : `Here are the real figures for each option: ${facts}.`;
    }
  }

  // The reply points at an order preview that was never made this turn: make it (the tool does not show the same one twice).
  const CARD_TYPES = ["checkout_ready", "preview", "order_placed"];
  if (text && !state.chatOnly && claimsPreviewShown(text) && !(found.actions || []).some((a) => CARD_TYPES.includes(a?.type)) && typeof session?.handlers?.mark_checkout_ready === "function") {
    console.warn("[guard] the reply points at an order preview but none was made this turn; making it now");
    try {
      await session.handlers.mark_checkout_ready();
      found = session.result();
      hasOrderOrReviewAction = (found.actions || []).some((a) => a?.type === "order_placed" || a?.type === "checkout_ready");
    } catch (error) {
      console.warn("[guard] could not make the preview:", String(error?.message || error).slice(0, 160));
    }
  }

  // The reply promises to keep talking in a language the shopper asked for by name, but the choice was never saved.
  const askedLanguage = languageRequestedBy(state.userMessage) || (claimsLanguageSwitch(text) ? languageAskedFor(state.userMessage) : "");
  if (text && askedLanguage && !state.chatOnly && found.languageChoice === undefined && typeof session?.handlers?.set_reply_language === "function") {
    console.warn(`[guard] the reply promises ${askedLanguage} from now on but the choice was not saved; saving it now`);
    try {
      await session.handlers.set_reply_language({ language: askedLanguage });
      found = session.result();
    } catch (error) {
      console.warn("[guard] could not save the language:", String(error?.message || error).slice(0, 160));
    }
  }

  const missed = text && !personTurn && !state.chatOnly && !hasOrderOrReviewAction ? contradictedAvailability({ text, toolLog, sameKind: state.sameKind }) : [];
  if (missed.length > 0 && state.provider) {
    console.warn(`[guard] the reply says the item is not available but the store has: ${missed.join(" | ")}; asking the AI to rewrite it`);
    const fixed = await rewriteReply(state, `[Store system check: your draft says the item is not available, but the store's live data for this message HAS matching products in stock: ${missed.join("; ")}. Draft: "${text.slice(0, 600)}". Write the reply again in the customer's language: present these as what the store has, naming them, with no apology for not having the item.]`);
    if (fixed && contradictedAvailability({ text: fixed, toolLog, sameKind: state.sameKind }).length === 0) text = fixed;
    else if (found.fallbackSpeech && (found.products || []).length > 0) text = await speakFromStoreResult(state, found, "the customer asked for an item and the store HAS matching products in stock; present them as what the store has, with no apology.");
  }

  // The reply is written in Devanagari although the shopper typed Roman letters (Hinglish or English): the AI writes it again.
  if (text && state.provider && wrongScriptReply({ message: state.userMessage, reply: text, replyLanguage: state.context?.replyLanguage, locked: state.context?.languageLocked })) {
    console.warn("[guard] the reply is in Devanagari but the shopper wrote in Roman letters; asking the AI to rewrite it");
    const again = await rewriteReply(state, `[Store system check: the customer wrote in Roman letters, so your draft must be in Roman letters too (Hinglish if they wrote Hinglish, English if they wrote English), never Devanagari. Draft: "${text.slice(0, 600)}". Write the same reply again, keeping every fact, price and product name, in Roman letters only.]`);
    if (again && !wrongScriptReply({ message: state.userMessage, reply: again, replyLanguage: state.context?.replyLanguage, locked: state.context?.languageLocked })) text = again;
  }

  // A word in a script nobody wrote in (an Urdu "شاندار" inside a Hindi reply): written again, or the stray word is taken out.
  if (text && foreignScriptInReply({ message: state.userMessage, reply: text })) {
    console.warn("[guard] the reply contains letters of another script; asking the AI to rewrite it");
    const again = state.provider ? await rewriteReply(state, `[Store system check: your draft contains words in a script the customer did not use (e.g. Urdu/Arabic letters). Draft: "${text.slice(0, 600)}". Write the same reply again only in the customer's script (Devanagari for Hindi, Roman letters for Hinglish or English), keeping every fact, price and product name.]`) : "";
    text = again && !foreignScriptInReply({ message: state.userMessage, reply: again }) ? again : stripForeignScriptWords(text);
  }

  // The other way round: the shopper wrote in Devanagari and the reply came back in Roman letters.
  const langCheck = { message: state.userMessage, replyLanguage: state.context?.replyLanguage, locked: state.context?.languageLocked };
  if (text && state.provider && missedDevanagariReply({ ...langCheck, reply: text })) {
    console.warn("[guard] the shopper wrote in Devanagari but the reply is in Roman letters; asking the AI to rewrite it");
    const again = await rewriteReply(state, `[Store system check: the customer wrote in Hindi in Devanagari script, so the reply must be in Hindi in Devanagari script too. Draft: "${text.slice(0, 600)}". Write the same reply again in Devanagari, keeping every fact and price; product names stay exactly as the store writes them.]`);
    if (again && !missedDevanagariReply({ ...langCheck, reply: again })) text = again;
  }

  // A Hinglish chat answered in plain English (live 2026-11-22: "casio watch gold wali add kar do please" -> "Done! I have added ..."): this
  // needs no model to see, and it is fixed even when the turn is already slow, since the shopper reads the whole reply in a language they
  // did not use.
  // The store's own fixed answers (a failed lookup, a handoff line) are not rewritten: a rewrite could bring back what they replaced.
  const fixedAnswers = new Set([lookupFailedReply, connectingReply, teamToldReply, noPersonReply, callNotBookedReply, notConfirmedReply, policyNotPublishedReply].map((f) => f(state.context?.replyLanguage)).concat(found.fallbackSpeech || []));
  if (text && state.provider && !state.signal?.aborted && state.context?.replyLanguage === "hinglish" && plainlyEnglish(text) && !fixedAnswers.has(text)) {
    console.warn("[guard] a Hinglish chat got a plain English reply; asking the AI to rewrite it in Hinglish");
    const again = await rewriteReply(state, `[Store system check: the customer chats in Hinglish (Hindi typed in Roman letters), but your draft is in English. Draft: "${text.slice(0, 600)}". Write the same reply again in natural Hinglish in Roman letters, keeping every fact, price and product name exactly.]`, { essential: true });
    if (again && !plainlyEnglish(again) && !scriptLanguage(again)) text = again;
  }

  // The reply must be in the language the shopper wrote: one short, cheap AI check (no word lists), and one rewrite if it differs.
  if (text && state.provider && !state.context?.languageLocked && !state.signal?.aborted && !overBudget(state)) {
    // A message with no language of its own (a name, a phone number, an address) is answered in the chat's language: a Hinglish chat got
    // "Delivery address saved ... Is the billing address the same" in English after the shopper typed only their address (live, 2026-11-22).
    const ownLanguage = scriptLanguage(state.userMessage) || romanLanguage(state.userMessage);
    // A reply that is plainly in the wanted language needs no extra AI call: this check used to add one model round trip
    // (about 1-2.5 seconds) to every reply, also when the reply was clearly right.
    const wanted = ownLanguage || state.context?.replyLanguage || "";
    // both sides must be plain: the shopper's message too ("kal to 40000 ka tha, wahi price de do" has English-looking words)
    // product lines ("- **Dell WM126** ($14.00): Reliable wireless mouse ...") carry the store's own English description: only the
    // reply's own sentences tell its language
    const ownSentences = text.split("\n").filter((line) => !/^\s*(?:[-•*]|\d+[.)])\s*\*\*/.test(line)).join("\n");
    const plainlyRight = replyPlainlyIn(ownSentences, wanted) && (ownLanguage ? replyPlainlyIn(state.userMessage, wanted, { short: true }) : Boolean(state.context?.replyLanguage));
    const chatLanguage = { hinglish: "Hinglish (Hindi typed in Roman letters)", hi: "Hindi in Devanagari", en: "English" }[state.context?.replyLanguage] || "";
    const compareWith = !ownLanguage && chatLanguage
      ? `The customer's latest message only gives details (name, phone, address) and has no language of its own; the customer chats in ${chatLanguage}.
Assistant reply: "${text.slice(0, 500)}"

Is the reply written in ${chatLanguage}? Product names, addresses and prices do not count. Answer with exactly one word: SAME or DIFFERENT.`
      : `Customer message: "${String(state.userMessage || "").slice(0, 300)}"
Assistant reply: "${text.slice(0, 500)}"

Is the reply written in the same language and script as the customer's message? Languages: English; Hinglish (Hindi typed in Roman letters); Hindi in Devanagari. Product names and prices do not count. Answer with exactly one word: SAME or DIFFERENT.`;
    const verdict = plainlyRight ? "SAME" : await generateText(
      compareWith,
      { maxTokens: 8, temperature: 0, timeoutMs: 2500, label: "language_check" }
    ).catch(() => "");
    if (/^W*different/i.test(String(verdict || ""))) {
      console.warn("[guard] the reply is in another language than the shopper's message; asking the AI to rewrite it");
      const again = await rewriteReply(state, `[Store system check: your draft is not in the language the customer wrote in. Customer wrote: "${String(state.userMessage || "").slice(0, 300)}". Draft: "${text.slice(0, 600)}". Write the same reply again in exactly the customer's language and script${!ownLanguage && chatLanguage ? ` (this chat is in ${chatLanguage})` : ""} (English stays English, Hinglish in Roman letters stays Hinglish, Devanagari gets Hindi), keeping every fact, price and product name.]`);
      if (again) text = again;
    }
  }

  // Substitutes must be the same kind of item as the wish. The doubtful products (nearest of a kind, found by meaning) get one
  // cheap yes/no check; a product that fails never shows as a card, and a reply that offers it is written again without it.
  const rejectedTitles = new Set();
  if (text && !state.chatOnly && !hasOrderOrReviewAction && state.context?.askModel && !overBudget(state)) {
    const { rejected, namedRejected } = await checkSubstitutes({ ask: state.context.askModel, wished: state.userMessage, toolLog, text, known: state.sameKind });
    for (const p of rejected) rejectedTitles.add(p.title);
    if (namedRejected.length > 0 && state.provider) {
      console.warn(`[guard] the reply offers items that are not the same kind as the wish: ${namedRejected.map((p) => p.title).join(" | ")}; asking the AI to rewrite it`);
      const kept = await rewriteReply(state, `[Store system check: these items are NOT the same kind of item as what the customer asked for, so they must not be offered or named: ${namedRejected.map((p) => p.title).join("; ")}. Draft: "${text.slice(0, 600)}". Write the reply again in the customer's language: say honestly and warmly, in one line, that the store does not have what they asked for, then ask one short question that helps you find them something that fits. Name no other product unless it is the same kind of item.]`);
      if (kept) text = kept;
    }
  }

  // A budget the shopper stated is a limit, not a hint. The AI words the reply itself, so the PRICES of the products it names are
  // checked against that budget here (the same parser the search tool uses): one that costs more is written again once without
  // them, and never shows as a card. Not applied when the tool itself said nothing fits ("over_budget"), where the reply
  // honestly names the nearest, nor when the budget is written in another currency than the store's (it cannot be compared).
  // The same limit also applies to the cards (below): a card the reply does not name is still a recommendation.
  // A stated budget belongs to its own request and to short refinements of it (see budgetScope.js).
  const statedIn = budgetSourceMessage(state.userMessage, state.context?.history || []);
  const statedBudget = statedIn ? budgetFromText(statedIn) : null;
  const toolSaysOver = toolLog.some((t) => ["over_budget", "closest_alternatives"].includes(String(t?.result?.status || "")));
  const budgetCurrency = String(state.context?.storeCurrency || "");
  const budgetInOtherCurrency = statedIn && budgetCurrency && findWrongCurrency(statedIn, budgetCurrency).length > 0;
  const budgetLimit = statedBudget && !toolSaysOver && !budgetInOtherCurrency ? statedBudget : null;
  if (text && state.provider && !state.chatOnly && !hasOrderOrReviewAction) {
    const budget = budgetLimit;
    if (budget) {
      const known = new Map();
      for (const p of [...toolLog.flatMap((t) => (Array.isArray(t?.result?.products) ? t.result.products : [])), ...(state.context?.probeProducts || [])]) {
        if (p?.title && Number.isFinite(Number(p.price)) && !known.has(p.title)) known.set(p.title, p);
      }
      const over = productsMentionedInAnswer([...known.values()].filter((p) => Number(p.price) > budget), text, { strict: true });
      if (over.length > 0) {
        console.warn(`[guard] the reply recommends products above the shopper's budget of ${budget}: ${over.map((p) => `${p.title} ${p.price}`).join(" | ")}; asking the AI to rewrite it`);
        for (const p of over) rejectedTitles.add(p.title);
        const within = [...known.values()].filter((p) => Number(p.price) <= budget).map((p) => `${p.title} (${p.price})`).slice(0, 6);
        const again = await rewriteReply(state, `[Store system check: the customer's budget is ${budget} and your draft names products that cost more: ${over.map((p) => `${p.title} (${p.price})`).join(", ")}. Never recommend those as matches. Draft: "${text.slice(0, 900)}". Write the reply again, naming ONLY products within the budget${within.length ? ` (${within.join(", ")})` : ""}. If none of the products you have fits, say plainly that nothing fits this budget and offer to look at a slightly higher one; do not name the expensive ones as suggestions.]`);
        const rewroteWithinBudget = Boolean(again && productsMentionedInAnswer(over, again, { strict: true }).length === 0);
        if (rewroteWithinBudget) text = again;
        else text = dropDanglingListIntro(text.split("\n").filter((line) => !over.some((p) => productsMentionedInAnswer([p], line, { strict: true }).length)).join("\n").trim() || text);
        // Everything the reply named was over the budget and was cut: what is left is an introduction to an empty list ("Yeh lo kuch
        // badiya options:" with nothing after it, real storefront 2026-11-21). The shopper is told plainly that nothing fits instead.
        const stillNamesWithin = productsMentionedInAnswer([...known.values()].filter((p) => Number(p.price) <= budget), text, { strict: true }).length > 0;
        if (!rewroteWithinBudget && !stillNamesWithin && state.provider) {
          const cheapest = [...known.values()].sort((a, b) => Number(a.price) - Number(b.price))[0];
          const honest = await rewriteReply(state, `[Store system check: nothing you found fits the customer's budget of ${budget}.${cheapest ? ` The lowest-priced match is ${cheapest.title} (${cheapest.price}).` : ""} Write the reply in the customer's language: say plainly that nothing fits this budget, name the lowest-priced match with its exact price, and ask whether they want to see options a bit above the budget. Never write an introduction to a list without the list.]`, { essential: true });
          if (honest && productsMentionedInAnswer(over.filter((p) => p !== cheapest), honest, { strict: true }).length === 0) text = honest;
        }
      }
    }
  }

  // A shop assistant's reply never contains a code block. One that does means the model answered a programming question: the prompt
  // says not to, and this does not depend on it (no word list, any language). The reply is written again once as a short, kind
  // redirect to the store; if that fails too, the code is cut out and nothing of it reaches the shopper.
  if (text && /```/.test(text) && !hasOrderOrReviewAction) {
    console.warn("[guard] the reply contains a code block: not about the store; asking the AI to redirect instead");
    const redirected = state.provider
      ? await rewriteReply(state, `[Store system check: your draft answers something that is not about the store (it contains code). You only help with this store. Write ONE short, kind sentence in the customer's language saying so, and ask what they would like to look for in the store. Give no code, no steps and no answer to the other question. Draft: "${text.slice(0, 300)}"]`)
      : "";
    text = redirected && !/```/.test(redirected) ? redirected : text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  // A comparison must put the compared products side by side and end in a pick. A reply that does not even name two of them
  // ("see the cards") is written again once, with the facts the tool returned.
  const compared = (toolLog || []).find((t) => t?.name === "compare_products" && Array.isArray(t?.result?.products) && t.result.products.length >= 2);
  if (text && state.provider && compared && !hasOrderOrReviewAction) {
    const wanted = compared.result.products;
    if (productsMentionedInAnswer(wanted, text, { strict: true }).length < 2) {
      console.warn("[guard] the comparison reply does not name the compared products; asking the AI to rewrite it");
      const redone = await rewriteReply(state, `[Store system check: the customer asked for a comparison of ${wanted.map((p) => p.title).join(" and ")}, but your draft does not compare them by name. Draft: "${text.slice(0, 600)}". Write it again in the customer's language: one short line per product with what the customer gets with it (use only the facts from compare_products, prices exactly as given), the real difference between them, then ONE clear recommendation and one short follow-up question.]`);
      if (redone && productsMentionedInAnswer(wanted, redone, { strict: true }).length >= 2) text = redone;
    }
  }

  // The reply says the cart was changed but no cart action happened this turn: the cart did not change, so the
  // claim is untrue. The AI writes the reply again without it.
  // The shopper told the assistant to put a product in the cart but no cart action ran: do it when it is unambiguous.
  if (text && !state.chatOnly && !hasOrderOrReviewAction && (asksToAddToCart(state.userMessage) || explicitAddRequest(state.userMessage, state.context?.history || [])) && !changedCart(found.actions) && typeof session?.ensureRequestedAdd === "function") {
    try {
      if (await session.ensureRequestedAdd()) {
        console.warn("[guard] the shopper asked to add to the cart but no cart action ran; the product was added");
        found = session.result();
        const added = (found.actions || []).filter((a) => a?.type === "add_to_cart").map((a) => String(a.title || "").replace(/\s*\([^)]*\)\s*$/, ""));
        if (found.fallbackSpeech) text = await speakFromStoreResult(state, found, "the customer asked to add the product to the cart, and it was added just now; say clearly that it is in the cart, naming it.", { mustName: added.slice(-1) });
      }
    } catch (error) {
      console.warn("[guard] could not add the requested product:", String(error?.message || error).slice(0, 160));
    }
  }
  // The shopper asked to use the last order's address and the model did not set it: it is set now, and the reply is the checkout's own next step
  // (a draft that said "address set, total incl. tax" before any address or tax existed is not sent).
  if (text && !state.chatOnly && !hasOrderOrReviewAction && typeof session?.ensureAddressReuse === "function") {
    try {
      if (await session.ensureAddressReuse()) {
        console.warn("[guard] the shopper asked to reuse the last order's address but it was not set; it was set now");
        found = session.result();
        if (found.fallbackSpeech) text = await speakFromStoreResult(state, found, "the customer asked to use the address of their last order, and it was set on this checkout just now; say the address back so they can check it.");
      }
    } catch (error) {
      console.warn("[guard] could not reuse the last address:", String(error?.message || error).slice(0, 160));
    }
  }
  // A clear answer to the checkout's billing question ("haan billing bhi same", "alag hai") that the model answered without its tool: the
  // checkout step runs now (routeCheckoutIntent was written for this but never called; a live run said "billing set kar diya" and the
  // checkout still had no billing, 2026-11-22). Only billing answers are routed this way; an order is never placed without the model.
  const billingStepRan = (found.actions || []).some((a) => a?.type === "set_billing_address") || (state.toolLog || []).some((t) => ["set_billing_same_as_shipping", "set_billing_address", "request_billing_update"].includes(t?.name));
  if (text && !state.chatOnly && !hasOrderOrReviewAction && !billingStepRan && typeof session?.routeCheckoutIntent === "function") {
    try {
      const before = (found.actions || []).length;
      if (await session.routeCheckoutIntent({ billingOnly: true })) {
        found = session.result();
        if ((found.actions || []).length > before || found.fallbackSpeech) {
          console.warn("[guard] the shopper answered the billing question but no billing step ran; it ran now");
          if (found.fallbackSpeech) text = await speakFromStoreResult(state, found, "the customer answered the billing address question, and that checkout step ran just now.");
          hasOrderOrReviewAction = (found.actions || []).some((a) => a?.type === "order_placed" || a?.type === "checkout_ready");
        }
      }
    } catch (error) {
      console.warn("[guard] could not run the billing step:", String(error?.message || error).slice(0, 160));
    }
  }
  // Still no billing step, but the reply says billing was set (a model that repeats its own earlier untrue line from the history): not sent.
  const billingDoneNow = (found.actions || []).some((a) => a?.type === "set_billing_address");
  if (text && !hasOrderOrReviewAction && !billingDoneNow && claimsBillingSet(text) && typeof session?.safeCheckoutState === "function") {
    const now = await session.safeCheckoutState().catch(() => null);
    if (!now?.billingConfirmed) {
      console.warn("[guard] the reply says billing was set but the checkout has no billing; asking the AI to rewrite it");
      const again = state.provider ? await rewriteReply(state, `[Store system check: your draft says the billing address was set, but it is NOT set on this checkout (no billing tool ran). Draft: "${text.slice(0, 500)}". Write the reply again in the customer's language without saying billing is set: ask whether billing is the same as the delivery address. Do not state a payable total.]`, { essential: true }) : "";
      text = again && !claimsBillingSet(again) ? again : dropSentences(text, claimsBillingSet) || text;
    }
  }
  // Only adding, changing or clearing changes the cart: showing it ("show_cart") does not (a real run said "cart mein daal diya" after a
  // show_cart action while the cart had not changed, 2026-11-21).
  const cartActionHappened = changedCart(found.actions);
  if (text && claimsCartChange(text) && !cartActionHappened && !hasOrderOrReviewAction) {
    console.warn("[guard] the reply says the cart was changed but no cart action ran; asking the AI to rewrite it");
    const honest = state.provider ? await rewriteReply(state, `[Store system check: your draft says the cart was changed, but no cart tool ran this turn, so the cart is unchanged. Draft: "${text.slice(0, 600)}". Write the reply again in the customer's language without saying anything was added, removed or updated: say the cart is unchanged and ask for the one detail you need (which item, size or quantity) so you can do it now.]`) : "";
    text = honest && !claimsCartChange(honest) ? honest : dropSentences(text, claimsCartChange) || text;
  }
  // The reply says a discount code is applied, but none was applied this turn and none is on the checkout: the shopper would pay full price.
  const discountOnCheckout = typeof session?.appliedDiscountCode === "function" ? session.appliedDiscountCode() : "";
  const discountActionHappened = (found.actions || []).some((a) => a?.type === "apply_discount");
  if (text && claimsDiscountApplied(text) && !discountActionHappened && !discountOnCheckout) {
    console.warn("[guard] the reply says a discount is applied but none is on the checkout; asking the AI to rewrite it");
    const honest = state.provider ? await rewriteReply(state, `[Store system check: your draft says a discount code is applied, but no discount was applied this turn and none is on this checkout, so the total has no discount. Draft: "${text.slice(0, 600)}". Write the reply again in the customer's language without saying the code is applied. If the customer asked for the code, call apply_discount now; otherwise ask whether to apply it.]`) : "";
    text = honest && !claimsDiscountApplied(honest) ? honest : dropSentences(text, claimsDiscountApplied) || text;
  }

  // Product replies (search, compare, details, recommendations) carry prices too: every amount in the reply must be one that
  // Shopify returned in this turn's tool results (or the cart / the customer's own words). Otherwise the AI writes it again,
  // and if it still states one, the lines with the unverified amount are left out rather than shown.
  const productTurn =
    text && !hasOrderOrReviewAction && !state.chatOnly &&
    toolLog.some((t) => !DETERMINISTIC_TOOLS.has(t.name) && !FACT_CHECKED_TOOLS.has(t.name) && (Array.isArray(t?.result?.products) && t.result.products.length > 0 || t?.result?.product || Array.isArray(t?.result?.closestAlternatives) && t.result.closestAlternatives.length > 0));
  // A reply about products this chat showed before, written without any search this turn (the same question asked again), is
  // checked too: against those products' own data, never against earlier replies (a real run invented "triple camera" and
  // "50 megapixel Sony camera" on the third asking, 2026-11-21).
  let remembered = [];
  if (!productTurn && text && !hasOrderOrReviewAction && !state.chatOnly) {
    try {
      const earlier = session?.recentlyShownProducts?.() || [];
      remembered = earlier.length ? productsMentionedInAnswer(earlier, text, { strict: true, nameRun: true }) : [];
    } catch { remembered = []; }
  }
  if (productTurn || remembered.length > 0) {
    const sources = [found.fallbackSpeech || "", toolLog.map((t) => t.result), remembered, found.actions || [], found.checkout || null, state.context?.cart || null, state.context?.probeProducts || [], state.userMessage || ""];
    // The currency the tool results name (never the browser's cart or the customer's own words). A reply that writes the
    // store's amount with another currency's sign ("₹429" for $429) gets the right sign back: the amount is never changed.
    const currency = dataCurrency([toolLog.map((t) => t.result), remembered, state.context?.probeProducts || []]);
    const signFix = repairCurrencyMarks(text, currency);
    if (signFix.repaired.length) {
      console.warn("[guard] the reply wrote amounts with another currency's sign; replaced with the store's:", signFix.repaired.join(", "));
      text = signFix.text;
    }
    const verdict = verifyReplyFacts(text, sources, { currency });
    // prices AND product specs ("42 hours", "6.1-inch") must come from the store's data: the voice reply in particular
    // used to add specs of its own
    const unknownClaims = (v) => [...v.unknownAmounts, ...(v.unknownSpecs || []), ...(v.wrongCurrency || [])];
    if (unknownClaims(verdict).length > 0) {
      console.warn("[guard] the reply states prices or specs that Shopify did not return this turn:", unknownClaims(verdict).join(", "));
      if (state.provider) {
        const redone = await rewriteReply(state, `[Store system check: your draft states figures that the store's data for this turn does not contain (${unknownClaims(verdict).join(", ")}). Draft: "${text.slice(0, 800)}". Write the reply again in the customer's language using ONLY the prices and the product facts (battery hours, storage, size, features) exactly as the tools returned them; never calculate, round, convert or add a price or a spec yourself. If the data does not say, do not say it.]`);
        const redoneFixed = redone ? repairCurrencyMarks(redone, currency).text : "";
        if (redoneFixed && unknownClaims(verifyReplyFacts(redoneFixed, sources, { currency })).length === 0) text = redoneFixed;
      }
      const stillUnknown = unknownClaims(verifyReplyFacts(text, sources, { currency }));
      if (stillUnknown.length > 0) {
        // only the sentences with the unverified figure or feature go; the rest of the line (the product, its real price) stays
        const kept = text.split("\n").map((line) => stillUnknown.some((claim) => line.includes(claim)) ? line.split(/(?<=[.!?])\s+/).map((part) => stillUnknown.some((claim) => part.includes(claim)) && part.includes(";") ? part.split(/;\s*/).filter((clause) => !stillUnknown.some((claim) => clause.includes(claim))).join("; ").replace(/([^.!?])$/, "$1.") : part).filter((part) => part && !stillUnknown.some((claim) => part.includes(claim))).join(" ") : line);
        text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() || found.fallbackSpeech || FALLBACK_ANSWER;
      }
    }
  }

  // The AI wrote the reply. Verify it never states an amount or order ID that the verified data of
  // this turn does not contain. If it does, the AI rewrites it once with the problem pointed out;
  // only if that also fails is the verified wording sent.
  const moneyTurn =
    hasOrderOrReviewAction ||
    (state.toolLog || []).some((t) => DETERMINISTIC_TOOLS.has(t.name) || FACT_CHECKED_TOOLS.has(t.name));
  if (moneyTurn && text && found.fallbackSpeech && text !== found.fallbackSpeech) {
    const placed = (found.actions || []).find((a) => a?.type === "order_placed");
    const requiredOrderId = String(placed?.orderName || placed?.orderId || placed?.order?.name || "");
    // the currency the verified results name (not the browser's cart, not the customer's words): a wrong sign is replaced
    const currency = dataCurrency([(state.toolLog || []).map((t) => t.result), found.actions || [], found.checkout || null]);
    const signFix = repairCurrencyMarks(text, currency);
    if (signFix.repaired.length) {
      console.warn("[guard] the reply wrote amounts with another currency's sign; replaced with the store's:", signFix.repaired.join(", "));
      text = signFix.text;
    }
    const check = (reply) => verifyReplyFacts(reply, [
      found.fallbackSpeech,
      (state.toolLog || []).map((t) => t.result),
      found.actions || [],
      found.checkout || null,
      state.context?.cart || null,
      state.context?.probeProducts || [],
      state.userMessage || "",
    ], { requiredOrderId: /\d{3,}/.test(requiredOrderId) ? requiredOrderId.replace(/^#?/, "#") : "", currency });
    const verdict = check(text);
    if (!verdict.ok) {
      const problems = JSON.stringify({
        unknownAmounts: verdict.unknownAmounts,
        unknownOrderIds: verdict.unknownOrderIds,
        missingOrderId: verdict.missingOrderId,
      });
      console.warn("[guard] AI reply used facts not in verified data; asking the AI to rewrite it", problems);
      const issues = [
        verdict.unknownAmounts?.length ? `it states amounts that are not in the verified data (${verdict.unknownAmounts.join(", ")})` : "",
        verdict.unknownOrderIds?.length ? `it states order numbers that are not in the verified data (${verdict.unknownOrderIds.join(", ")})` : "",
        verdict.missingOrderId ? `it does not give the order number ${verdict.missingOrderId}` : "",
        verdict.wrongCurrency?.length ? `it writes amounts with the wrong currency sign (${verdict.wrongCurrency.join(", ")}); the store's currency is ${currency}` : "",
      ].filter(Boolean).join("; ");
      const rewritten = state.provider
        ? await rewriteReply(state, `[Store system check: your draft reply was rejected because ${issues || "it does not match the verified data"}. Draft: "${text.slice(0, 1200)}". Rewrite it in your own words using ONLY the amounts and order numbers written in these verified facts: ${found.fallbackSpeech}]`)
        : "";
      const rewrittenFixed = rewritten ? repairCurrencyMarks(rewritten, currency).text : "";
      if (rewrittenFixed && check(rewrittenFixed).ok) {
        text = rewrittenFixed;
      } else {
        console.warn("[guard] rewrite still not verified; sending the verified wording", problems);
        text = found.fallbackSpeech;
      }
    }
  }

  // A later rewrite (language, availability) can bring back a performance claim an earlier check removed: the last word is the data's.
  if (text && !state.chatOnly && !hasOrderOrReviewAction) {
    const stillJudged = unsupportedPerformanceClaims(text, toolLog);
    if (stillJudged.length > 0) {
      console.warn("[guard] a rewrite brought back a performance claim the product data does not state; the sentence is removed");
      text = performanceFallback(stillJudged.map((x) => x.sentence), text) || text;
    }
  }

  if (!text) {
    // The provider wrote nothing (even after the one retry) and no tool left a verified summary, a card or an action to show: that is
    // a provider failure, not an answer. It is raised like any other provider error, so the next provider (Claude, when its key is
    // set) takes the turn; only when every provider has failed does the shopper get the plain connection-trouble line.
    if (state.provider && !found.fallbackSpeech && !(found.products || []).length && !(found.actions || []).length) {
      throw new Error(`${state.provider} returned an empty reply`);
    }
    text = (found.fallbackSpeech ? await speakFromStoreResult(state, found, "your reply came out empty, so write it now from the store's result.") : "") || FALLBACK_ANSWER;
  }

  // Cards must match the answer: if the model names only some of the products the tools returned,
  // show just those (comparison cards and order/checkout flows are left alone).
  let cards = (found.products || []).filter((p) => !rejectedTitles.has(p.title) && !(budgetLimit && Number(p.price) > budgetLimit));
  const isComparisonCards = cards.some((p) => p?.cardMode === "comparison" || p?.comparisonMode);
  if (!hasOrderOrReviewAction && !isComparisonCards && String(state.finalText || "").trim()) {
    const shown = cardsForAnswer(cards, state.toolLog, text, state.userMessage);
    if (shown.length !== cards.length) console.log(`[cards] showing ${shown.length} of ${cards.length} found products (the ones the answer names, or the kind the shopper asked for)`);
    cards = shown; // also when the count is the same: the products the reply names come first
  }

  // Live-search matches found before the model answered: show them as cards only if the answer
  // actually talks about them (so a policy question never grows random product cards).
  if (lookupFailedOverride) cards = [];
  if (cards.length === 0 && !hasOrderOrReviewAction && !lookupFailedOverride) {
    const named = speculativeCards(state.toolLog, found.speculativeProducts, text);
    if (named.length > 0) cards = named.filter((p) => !rejectedTitles.has(p.title));
  }

  // The reply talks about products this chat already showed (no new search ran: "show me again what you found"): they are shown again,
  // only the ones the reply names, so a list in the text is never a list without cards.
  // The same holds for a reply that names earlier products next to new cards (the text lists the Nike and the Adidas shown a turn ago, the
  // fresh search found only one more): the named ones join the cards, after the fresh ones.
  if (!hasOrderOrReviewAction && !lookupFailedOverride && !isComparisonCards && String(state.finalText || "").trim()) {
    try {
      const earlier = session?.recentlyShownCards?.() || [];
      const have = new Set(cards.map((c) => String(c.title).toLowerCase().trim()));
      const again = earlier.length ? productsMentionedInAnswer(earlier, text, { strict: true }).filter((p) => !have.has(String(p.title).toLowerCase().trim()) && !rejectedTitles.has(p.title)) : [];
      if (again.length > 0) cards = [...cards, ...again].slice(0, 6);
    } catch { /* cards from memory are a courtesy; never block the reply */ }
  }

  // What the shopper is really shown, in order, goes into the chat's first-shown ledger ("the very first phone you showed me").
  try { session?.recordShown?.(cards); } catch { /* a memory note never blocks a reply */ }

  return {
    answer: respectfulAddress(consistentAssistantVoice(neutralShopperVerbs(fixOneDecimalAmounts(joinDottedCodes(text)), state.context?.profile?.ownShoppingGender)), [state.userMessage, ...(state.context?.history || []).filter((h) => h?.role === "user").map((h) => h.content)].join("\n")),
    products: cards,
    actions: found.actions || [],
    checkout: found.checkout ?? null,
    done: true,
  };
}

function routeAfterAgent(state) {
  if (state.error || state.done) return "finalize";
  if ((state.toolCalls || []).length > 0) return "tools";
  return "finalize";
}

function routeAfterTools(state) {
  if (state.error || state.done) return "finalize";
  return "agent";
}

function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, {
      tools: "tools",
      finalize: "finalize",
    })
    .addConditionalEdges("tools", routeAfterTools, {
      agent: "agent",
      finalize: "finalize",
    })
    .addEdge("finalize", END);

  return graph.compile();
}

const compiledGraph = buildGraph();

async function runAgentWithProvider(
  provider,
  userMessage,
  storeId,
  history,
  industry,
  options = {}
) {
  const config = industries[industry] || industries.ecommerce;
  const cleanHistory = sanitizeHistory(history);

  let catalogCategories = [];
  let catalogSampleTitles = [];
  let catalogProductCount = 0;
  let catalogError = "";
  let storeProfile = null;
  // The store's own currency comes from Shopify (the catalog summary, or a cart that was priced in the store's currency below).
  // It is never taken from the browser's cart: that is the visitor's market currency, and labelling the store's amounts
  // with it showed a USD store's $429 as "₹429". Unknown stays empty: the tool results carry their own currency.
  let storeCurrency = "";

  // Everything the first LLM call needs is fetched IN PARALLEL (catalog summary, email-OTP state,
  // live catalog probe for this very message): one wait instead of three.
  const tPrep = Date.now();
  // Started by runAgentInner in parallel with prepareConversation (and shared by a fallback provider).
  // The open complaint and the cart in the store's currency do not depend on the prefetch: they start now and are awaited
  // below, so the turn waits for the slowest of the three and not for their sum.
  const openComplaintPending = openComplaintForChat(storeId, chatRefFor(storeId, options.clientId || "anon")).catch(() => null);
  const cartPending = pricesFollowMarket()
    ? Promise.resolve(normalizeCartSnapshot(options.cart))
    : cartInStoreCurrency(storeId, normalizeCartSnapshot(options.cart));
  cartPending.catch(() => {}); // a failure is raised where it is awaited, never as an unhandled rejection
  const prep = await (options.prefetch || prefetchTurnData(config, storeId, userMessage, options));
  let catalogSummary = prep.summary;
  const verifiedRes = prep.verifiedEmail;
  const lastOrderRes = prep.lastOrder;
  const probeProducts = Array.isArray(prep.probe) ? prep.probe : [];
  const probeRan = Array.isArray(prep.probe);
  options.telemetry?.steps?.push({ step: "prep", ms: Date.now() - tPrep, ok: true, ...(prep.parts ? { parts: prep.parts } : {}) });
  console.log(`[timing] prep (catalog+auth+probe) took ${Date.now() - tPrep} ms; probe ${probeRan ? `matches=${probeProducts.length}` : "skipped (over budget)"}`);
  if (catalogSummary) {
    catalogCategories = catalogSummary.categories || [];
    catalogSampleTitles = (catalogSummary.sampleTitles || []).slice(0, 20);
    catalogProductCount =
      catalogSummary.totalProducts ?? (catalogSummary.products || []).length ?? 0;
    if (catalogSummary.currency) storeCurrency = catalogSummary.currency;
    catalogError = catalogSummary.error || "";
    storeProfile = {
      storeName: catalogSummary.storeName || "",
      categoryCounts: catalogSummary.categoryCounts || [],
      vendors: catalogSummary.vendors || [],
      priceRange: catalogSummary.priceRange || null,
      outOfStockTitles: catalogSummary.outOfStockTitles || [],
      unpublishedTitles: catalogSummary.unpublishedTitles || [],
      totalActive: catalogSummary.totalActive ?? 0,
    };
  }

  const profile = options.checkout?.profile || {};
  const inferredGender = resolveShoppingGender(userMessage, cleanHistory, {
    ...profile,
    customerName: options.customer?.name || profile.customerName || "",
  });

  // Has this shopper already passed the email-OTP check on this device? (so the model never re-asks)
  const orderVerifiedEmail = verifiedRes ? maskEmail(verifiedRes) : "";
  const lastOrderNumber = lastOrderRes || "";

  // a complaint this chat already has: what the customer said and what was tried, so none of it is asked or suggested again
  const openComplaint = await openComplaintPending;
  const pricedCart = await cartPending;
  // a cart priced again from the store's own prices names the store's currency when the catalog summary was too slow
  if (!storeCurrency && pricedCart?.repricedFrom && pricedCart.currency) storeCurrency = String(pricedCart.currency).toUpperCase();

  const context = {
    complaintBlock: complaintPromptBlock(openComplaint),
    // A real AI provider drives this turn: tools take intent from the model's arguments.
    llmMode: Boolean(provider),
    // tools already run earlier in this turn by a provider that then failed: they are never run twice
    sideEffectLedger: options.sideEffectLedger || null,
    // The store owner's settings (persona, extra instructions, FAQ, switched-off tools).
    settings: prep.settings || {},
    // switched off by the owner, plus tools that exist only when a feature (e.g. call booking) is on
    disabledTools: [...new Set([...(prep.settings?.disabledTools || []), ...(config.admin?.inactiveTools?.(prep.settings) || []), ...(config.admin?.liveSupportTools?.(prep.settings) || [])])],
    // the public reference of this visitor, so a booking made in this turn can be tied to the chat afterwards
    chatRef: chatRefFor(storeId, options.clientId || "anon"),
    // New chat / in progress / returning, with what was going on (facts only; the AI words it).
    continuity: describeContinuity({
      previousActivityAt: options.checkout?.previousActivityAt,
      clientLastActivityAt: options.clientLastActivityAt,
      history: cleanHistory,
      recap: options.checkout?.conversationRecap,
      cart: normalizeCartSnapshot(options.cart),
      checkout: options.checkout,
    }),
    probeProducts,
    probeRan,
    orderVerifiedEmail,
    lastOrderNumber,
    visitorMemory: visitorMemoryBlock(prep.memory),
    userMessage,
    history: cleanHistory,
    // always in the store's currency, whatever market the visitor browses in (see cartPricing.js)
    cart: pricedCart,
    checkout: options.checkout || null,
    customer: options.customer || null,
    verifiedCustomerId: options.verifiedCustomerId || null,
    clientId: options.clientId || "anon",
    customerLoggedIn: Boolean(options.customerLoggedIn),
    shopifyLoginSource: options.shopifyLoginSource || "",
    // Not chosen by the shopper: the conversation's language (a message like an e-mail or "123456" has none of its own), so the few
    // replies written outside the AI match the chat instead of falling back to English.
    replyLanguage: options.languageLocked ? options.replyLanguage || "" : conversationLanguage(userMessage, cleanHistory),
    channel: options.channel || "",
    languageLocked: Boolean(options.languageLocked),
    catalogCategories,
    askModel: (prompt, opts) => generateText(prompt, opts),
    catalogSampleTitles,
    catalogProductCount,
    catalogError,
    storeProfile,
    storeCurrency,
    inferredGender,
    profile,
  };

  const session = config.createSession(storeId, context);
  // Greetings / thanks / "what can you do" / non-store items: let the LLM chat, with no tools, so it
  // never dumps unrelated product cards and never repeats a canned line.
  const convTurn = classifyConversationalTurn(userMessage);
  const chatOnly = Boolean(convTurn && convTurn.type !== "categories_list");
  if (!options.skipKnownIntent && await session.routeKnownIntent?.()) {
    const result = session.result();
    return { answer: result.fallbackSpeech, products: result.products || [], actions: result.actions || [], checkout: result.checkout };
  }
  if (options.deterministicOnly) return null;
  const sessionKey = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  sessionStore.set(sessionKey, session);

  const systemPrompt = config.buildSystemPrompt(storeId, context);
  const toolDefinitions = pruneToolsForState(config.toolDefinitions || [], context, options);
  const toolsForLlm = allowNullOnOptionalArgs(toolDefinitions);
  const geminiTools = getGeminiTools(toolDefinitions);

  const groqMessages = [
    { role: "system", content: systemPrompt },
    ...cleanHistory,
    { role: "user", content: withLanguageNote(userMessage, context.replyLanguage, context.languageLocked) },
  ];

  const geminiContents = [
    ...cleanHistory.map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    })),
    { role: "user", parts: [{ text: withLanguageNote(userMessage, context.replyLanguage, context.languageLocked) }] },
  ];

  const tGraph = Date.now();
  try {
    const result = await compiledGraph.invoke({
      userMessage,
      storeId,
      industry,
      provider,
      signal: options.signal,
      context,
      systemPrompt,
      toolDefinitions,
      toolsForLlm,
      geminiTools,
      groqMessages,
      geminiContents,
      round: 0,
      rateBudget: { spent: 0 },
      hasNextProvider: Boolean(options.hasNextProvider),
      telemetry: options.telemetry,
      forceFinal: chatOnly,
      chatOnly,
      toolCalls: [],
      toolCallsExecuted: 0,
      finalText: "",
      sessionKey,
      answer: "",
      products: [],
      actions: [],
      checkout: null,
      done: false,
      error: null,
    });

    console.log(`[timing] graph (LLM+tools) took ${Date.now() - tGraph} ms; tools offered=${toolDefinitions.length}`);
    const languageChoice = session.result?.()?.languageChoice;
    return {
      answer: result.answer || FALLBACK_ANSWER,
      products: result.products || [],
      actions: result.actions || [],
      checkout: result.checkout ?? null,
      ...(languageChoice !== undefined ? { languageChoice } : {}),
    };
  } finally {
    sessionStore.delete(sessionKey);
  }
}

// Prices in this run are in the shopper's own Shopify storefront currency (Shopify's contextual prices for their country); see config/env.js pricesFollowMarket().
// the cards, the reply, the cart, the checkout, the order and the email all say the same amount (see cartPricing.js).
// Set STORE_PRICES_FOLLOW_MARKET=1 to bring back Shopify Markets pricing in the visitor's own currency instead.
export async function runAgent(userMessage, storeId, history = [], industry = "ecommerce", options = {}) {
  // A message with no letter or digit ("." or "?!") has nothing to answer: no model call, no tools, nothing logged as a turn.
  if (isMeaninglessMessage(userMessage) && !(Array.isArray(options.attachments) && options.attachments.length)) {
    // the AI says it in its own words (one cheap call); the stored line is only for when no AI answers
    const language = { hi: "Hindi in Devanagari", hinglish: "Hinglish (Hindi in Roman letters)", en: "English" }[options.replyLanguage] || "the language of the chat so far (English if there is none)";
    const said = await generateText(`You are the friendly owner of an online shop chatting with a customer. They just sent "${String(userMessage || "").slice(0, 60)}", which has no clear meaning. Write ONE short, warm line in ${language} saying you did not quite get it and asking what they are looking for. No emojis, no greeting if the chat is already going, nothing else.`, { maxTokens: 60, temperature: 0.8, timeoutMs: 3000, label: "unclear_message" }).catch(() => "");
    const first = String(said || "").trim().split("\n")[0].trim();
    const line = /^[[{]/.test(first) || !/\p{L}{2,}/u.test(first) || first.length > 200 ? "" : first;
    return {
      answer: line || (options.replyLanguage === "hi" ? "कृपया बताइए, आप क्या ढूँढ रहे हैं या किस बारे में जानना चाहते हैं?" : options.replyLanguage === "hinglish" ? "Thoda samajh nahi aaya, aap kya dhoondh rahe hain?" : "I didn't catch that. What would you like to know or find?"),
      products: [], actions: [], checkout: null, done: true,
    };
  }
  const telemetry = newTelemetry();
  telemetry.steps = [];
  const clientId = resolveClientId({ clientId: options.clientId, shop: storeId, cartToken: options.cart?.token, customerId: options.verifiedCustomerId });
  const result = await withTurnTimeline(telemetry.steps, () => withShopperPricing(
    pricesFollowMarket() ? { country: options?.cart?.country, currency: options?.cart?.currency } : null,
    () => runAgentInner(userMessage, storeId, history, industry, { ...options, clientId, telemetry })
  ));
  // One line per turn that says where the time went (every AI call and every store tool, in order).
  const timing = { totalMs: Date.now() - telemetry.startedAt, ai: telemetry.steps, tools: telemetry.tools };
  console.log(`[timing] turn ${timing.totalMs} ms; AI calls: ${timing.ai.map((s) => `${s.step} ${s.ms}${s.ok ? "" : " (failed)"}`).join(", ") || "none"}; tools: ${timing.tools.map((t) => `${t.name} ${t.ms}`).join(", ") || "none"}`);
  if (result && typeof result === "object" && process.env.NODE_ENV !== "production") result.timing = timing;
  // This reply is one the server really sent: the browser may repeat it in its history next time.
  // (Waited for, at most a moment: a shopper's next message must find this reply in the record.)
  if (result?.answer) {
    await Promise.race([replyLedger().remember(storeId, { clientId }, result.answer).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 800).unref?.())]);
  }
  // Written after the answer is ready, in the background: a logging problem never reaches the customer.
  const config = industries[industry] || industries.ecommerce;
  getAgentSettings(storeId).then((settings) =>
    recordTurnInBackground({
      shop: storeId,
      clientId,
      industry,
      analytics: config.analytics,
      settings,
      result,
      userMessage: options.loggedMessage ?? userMessage,
      attachments: options.attachments,
      telemetry,
      degraded: result?.answer === FALLBACK_ANSWER,
      language: options.replyLanguage || "",
      channel: options.channel,
      customerId: options.verifiedCustomerId,
      contact: { name: options.customer?.name || options.customer?.displayName, email: options.customer?.email, phone: options.customer?.phone },
    })
  );
  return result;
}

async function runAgentInner(
  userMessage,
  storeId,
  history = [],
  industry = "ecommerce",
  options = {}
) {
  options = {
    ...options,
    clientId: resolveClientId({ clientId: options.clientId, shop: storeId, cartToken: options.cart?.token, customerId: options.verifiedCustomerId }),
    // The browser's copy of the checkout is untrusted: only the shopper's own entries are kept.
    checkout: sanitizeBrowserCheckout(options.checkout),
  };
  // ...and so is its copy of the chat: an "assistant" turn the server never sent is dropped.
  // Store/catalog/auth reads do not depend on the conversation or its profile: they start first, in parallel with both.
  const config = industries[industry] || industries.ecommerce;
  options.prefetch = prefetchTurnData(config, storeId, userMessage, options);
  options.prefetch.catch(() => {});
  const tLedger = Date.now();
  history = keepRealReplies(history, await replyLedger().known(storeId, { clientId: options.clientId }));
  options.telemetry?.steps?.push({ step: "reply_ledger", ms: Date.now() - tLedger, ok: true });
  const tProfile = Date.now();
  options.checkout = await prepareConversation(storeId, options.clientId, userMessage, history, options.checkout, {
    customerName: options.customer?.name || options.customer?.displayName || options.checkout?.shipping?.name || "",
  });
  options.telemetry?.steps?.push({ step: "profile", ms: Date.now() - tProfile, ok: true });
  if (options.signal?.aborted) throw options.signal.reason || new Error("Run cancelled");
  const order = [];
  if (providerAvailable(LLM_PRIMARY) && healthyModels(LLM_PRIMARY)) order.push(LLM_PRIMARY);
  if (providerAvailable(LLM_SECONDARY) && healthyModels(LLM_SECONDARY) && LLM_SECONDARY !== LLM_PRIMARY) {
    order.push(LLM_SECONDARY);
  }
  for (const name of ["gemini", "claude"]) {
    if (providerAvailable(name) && healthyModels(name) && !order.includes(name)) order.push(name);
  }
  // A provider paused only by a rate limit comes back after a short wait: try it last (after the healthy ones), and the
  // call waits and retries, so a burst of messages never ends in "trouble connecting".
  for (const name of [LLM_PRIMARY, LLM_SECONDARY, "gemini", "claude"]) {
    if (providerAvailable(name) && !order.includes(name) && rateLimitPaused(name)) order.push(name);
  }
  // All configured models are paused after errors: still make one real attempt with Claude before giving up.
  if (order.length === 0 && providerAvailable("claude")) order.push("claude");
  // No Claude key: a provider paused only by a quick "busy" answer (503 / overloaded) gets one more real attempt too, so
  // one busy moment at the provider is not a pause of "trouble connecting" for every shopper of every store.
  if (order.length === 0) {
    const busy = [LLM_PRIMARY, LLM_SECONDARY, "gemini"].find((name) => providerAvailable(name) && busyPaused(name));
    if (busy) order.push(busy);
  }

  // When an LLM provider is configured, always let the AI decide tool calls and phrase every reply dynamically
  // (zero hardcoded replies). Only fall back to deterministic routeKnownIntent when all AI providers are offline.
  if (order.length === 0) {
    const direct = await runAgentWithProvider(null, userMessage, storeId, history, industry, { ...options, deterministicOnly: true });
    if (direct) return direct;
    return {
      answer: FALLBACK_ANSWER,
      products: [],
      actions: [],
      checkout: null,
    };
  }
  // one ledger for this whole turn, shared by every provider that is tried (see SIDE_EFFECT_TOOLS in core/toolsNode.js)
  options = { ...options, skipKnownIntent: true, sideEffectLedger: new Map() };

  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    try {
      console.log(
        `[agent] trying provider=${provider} (${i + 1}/${order.length}) primary=${LLM_PRIMARY}`
      );
      const result = await runAgentWithProvider(
        provider,
        userMessage,
        storeId,
        history,
        industry,
        { ...options, hasNextProvider: i < order.length - 1 }
      );
      if (result?.answer) {
        saveConversationRecap(storeId, options.clientId, buildRecap({
          userMessage,
          products: result.products,
          previous: options.checkout?.conversationRecap,
        }));
        return result;
      }
    } catch (error) {
      lastError = error;
      if (isUserAbort(error) && options?.signal?.aborted) {
        throw error;
      }
      console.warn(
        `[agent] provider=${provider} failed:`,
        String(errMsg(error)).slice(0, 200)
      );
      if (isAuthError(error)) blockProviderForAuth(provider, error);
    }
  }

  console.error(
    "[agent] all providers failed:",
    String(lastError?.message || lastError || "").slice(0, 300)
  );
  inc("llm_all_providers_failed_total", {}, 1, "Turns where every AI provider failed (answered in degraded mode)");
  alert("llm_all_failed", `Every AI provider failed for a reply (${storeId}): ${String(lastError?.message || lastError || "").slice(0, 200)}. Replies are in degraded mode.`);
  reportError(lastError || new Error("all AI providers failed"), { scope: "agent", tags: { shop: storeId } });

  // Degraded mode: every AI provider is down. Answer from verified store data if this turn can be
  // handled without the model; otherwise say so honestly.
  try {
    const direct = await runAgentWithProvider(null, userMessage, storeId, history, industry, {
      ...options,
      skipKnownIntent: false,
      deterministicOnly: true,
    });
    if (direct?.answer) return direct;
  } catch (error) {
    console.warn("[agent] degraded mode failed:", String(errMsg(error)).slice(0, 200));
  }

  return {
    answer: FALLBACK_ANSWER,
    products: [],
    actions: [],
    checkout: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Opening message: written by the AI for this store, this customer and their time of day, so the
// chat never starts with a fixed sentence. Returns "" when no AI provider answers in time (the
// widget then shows the greeting the merchant set in the theme editor).
const GREETING_TIMEOUT_MS = Number(process.env.GREETING_TIMEOUT_MS) || 6000;

// Every visitor who opens the chat asks for a greeting, so an anonymous one (no name in it) is kept for a short while per store,
// language choice and part of the day: a busy store no longer spends a model call, and some of its quota, on every widget open.
// A greeting that came back empty is never kept, so a slow or rate-limited model does not make the next visitors wait or see nothing.
const GREETING_TTL_MS = 20 * 60 * 1000;
const greetingCache = new Map();
const dayPartOf = (hour) => (!Number.isInteger(Number(hour)) ? "any" : Number(hour) < 5 ? "night" : Number(hour) < 12 ? "morning" : Number(hour) < 17 ? "afternoon" : Number(hour) < 21 ? "evening" : "night");

export async function generateGreeting(storeId, { customerName = "", localHour, languageChoice = "", industry = "ecommerce" } = {}) {
  const config = industries[industry] || industries.ecommerce;
  const settings = await getAgentSettings(storeId);
  const cacheKey = customerName ? "" : `${storeId}|${industry}|${languageChoice || "auto"}|${dayPartOf(localHour)}|${settings.persona?.name || ""}`;
  const kept = cacheKey ? greetingCache.get(cacheKey) : null;
  if (kept && Date.now() - kept.at < GREETING_TTL_MS) return kept.text;
  const summary =
    (typeof config.getCachedCatalogSummary === "function" && config.getCachedCatalogSummary(storeId)) ||
    (typeof config.getCatalogSummary === "function" ? await withinBudget(config.getCatalogSummary(storeId), 1500, null) : null);
  const prompt = buildGreetingPrompt({ storeName: summary?.storeName || "", customerName, localHour, languageChoice, agentName: settings.persona?.name });
  const text = String((await generateText(prompt, { maxTokens: 160, temperature: 0.9, timeoutMs: GREETING_TIMEOUT_MS, label: "greeting" })) || "").trim();
  if (cacheKey && text) {
    if (greetingCache.size >= 200) greetingCache.delete(greetingCache.keys().next().value);
    greetingCache.set(cacheKey, { at: Date.now(), text });
  }
  return text;
}

/**
 * One short, tool-free AI call (greeting, suggestion chips, photo description). Tries the configured
 * providers in order and returns "" when none answers in time. `media` ([{ mime, data(base64) }]) is
 * sent along as images / PDFs to providers that can read them (Claude, Gemini); Groq ignores it.
 */
// Small side calls (greeting, need match, translation) are short and wait in front of the shopper's answer: they use the
// fast light model (GEMINI_LIGHT_MODEL, default gemini-3.1-flash-lite) instead of the first-choice model.
export function sideGeminiModel(env = process.env) {
  return String(env.GEMINI_LIGHT_MODEL || "").trim() || DEFAULT_GEMINI_LIGHT_MODEL;
}

// The light model first; when it is paused (busy, rate limited, retired) the next healthy Gemini model takes the side call,
// so a search does not wait out a timeout on a model that is already known to be down.
function sideGeminiCandidates() {
  return [sideGeminiModel(), activeGeminiModel, ...GEMINI_FALLBACK_MODELS].filter((m, i, all) => m && all.indexOf(m) === i);
}
function pickSideGeminiModel() {
  return sideGeminiCandidates().find((m) => modelHealth.available("gemini", m)) || sideGeminiModel();
}

export async function generateText(prompt, { maxTokens = 200, temperature = 0.7, timeoutMs = GREETING_TIMEOUT_MS, label = "text", media = [] } = {}) {
  const order = [LLM_PRIMARY, LLM_SECONDARY, "gemini", "claude"]
    .filter((p, i, all) => all.indexOf(p) === i && providerAvailable(p))
    .filter((p) => !media.length || p !== "groq");
  for (const provider of order) {
    const started = Date.now();
    let usedModel = provider === "gemini" ? sideGeminiModel() : provider === "claude" ? activeClaudeModel : activeGroqModel;
    // One short wait and a second try when the provider says "slow down" (429): a side call that fails silently
    // (like the meaning match for "I am thirsty") would otherwise turn into a wrong "not available".
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let text = "";
      let usage = null;
      if (provider === "gemini") {
        const model = pickSideGeminiModel();
        usedModel = model;
        // both tries share one time budget: a second try never doubles the shopper's wait
        const leftMs = Math.max(250, timeoutMs - (Date.now() - started));
        const thinking = getGeminiThinkingCandidates(model)[0];
        const parts = [...media.map((m) => ({ inlineData: { mimeType: m.mime, data: m.data } })), { text: prompt }];
        const response = await withHardTimeout(
          getGeminiClient().models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: { maxOutputTokens: maxTokens, temperature, abortSignal: AbortSignal.timeout(leftMs), ...(thinking ? { thinkingConfig: thinking } : {}) },
          }),
          leftMs,
          `Gemini(${model}) ${label}`
        );
        text = (response.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
        usage = response.usageMetadata;
      } else if (provider === "claude") {
        const request = buildClaudeRequest({ model: activeClaudeModel, history: [{ role: "user", content: prompt }], tools: [], maxTokens, temperature });
        if (media.length) {
          const blocks = media.map((m) => ({ type: m.mime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: m.mime, data: m.data } }));
          request.messages = [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }];
        }
        const response = await withHardTimeout(
          getClaudeClient().messages.create(request, { signal: AbortSignal.timeout(timeoutMs) }),
          timeoutMs,
          `Claude(${activeClaudeModel}) ${label}`
        );
        text = parseClaudeResponse(response).text;
        usage = claudeUsage(response?.usage);
      } else if (provider === "groq") {
        const response = await withHardTimeout(
          getGroqClient().chat.completions.create({ model: activeGroqModel, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature }),
          timeoutMs,
          `Groq(${activeGroqModel}) ${label}`
        );
        text = String(response.choices?.[0]?.message?.content || "").trim();
        usage = response.usage;
      }
      recordLlm({ provider, model: usedModel, usage, latencyMs: Date.now() - started, label });
      if (provider === "gemini") modelHealth.success(provider, usedModel);
      if (text) return text;
      break;
    } catch (error) {
      recordLlm({ provider, model: usedModel, ok: false, latencyMs: Date.now() - started, label });
      // A side call that ran out of its own short time says nothing about the model's health: pausing the model for it
      // left the main chat with no model to ask (a "hi" got the connection-trouble line in 0.2 s). Only an answer from
      // the provider (busy, rate limit, retired, bad key) is recorded, and only then is another model tried.
      const ranOutOfTime = error?.name === "AbortError" || error?.name === "TimeoutError" || Date.now() - started >= timeoutMs - 50;
      if (provider === "gemini" && !ranOutOfTime) {
        modelHealth.fail(provider, usedModel, error);
        // another healthy Gemini model can answer right away: no waiting, no giving up
        if (attempt === 0 && !isAuthError(error) && sideGeminiCandidates().some((m) => modelHealth.available(provider, m))) continue;
      }
      if (attempt === 0 && isRateLimitError(error)) {
        const wait = rateLimitWait({ error, fallbackMs: 1500, maxTotalMs: Math.min(3000, Math.max(0, timeoutMs - (Date.now() - started))) });
        if (wait > 0) {
          await sleep(wait).catch(() => {});
          continue;
        }
      }
      console.warn(`[${label}] ${provider} failed:`, String(error?.message || error).slice(0, 160));
      if (isAuthError(error)) blockProviderForAuth(provider, error);
      break;
    }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Suggestion chips: three short things the shopper might tap next, written by the AI from the last
// exchange and what this store sells, so they change with the conversation and never repeat.
const SUGGESTION_TIMEOUT_MS = Number(process.env.SUGGESTION_TIMEOUT_MS) || 4000;

export async function generateSuggestions(storeId, { lastUser = "", answer = "", recent = [], languageChoice = "", industry = "ecommerce" } = {}) {
  const config = industries[industry] || industries.ecommerce;
  const summary =
    (typeof config.getCachedCatalogSummary === "function" && config.getCachedCatalogSummary(storeId)) ||
    (typeof config.getCatalogSummary === "function" ? await withinBudget(config.getCatalogSummary(storeId), 800, null) : null);
  const categories = (summary?.categories || summary?.productTypes || []).map((c) => (typeof c === "string" ? c : c?.name || c?.title || "")).filter(Boolean);
  const prompt = buildSuggestionsPrompt({ storeName: summary?.storeName || "", categories, lastUser, answer, recent, languageChoice });
  const text = await generateText(prompt, { maxTokens: 120, temperature: 0.95, timeoutMs: SUGGESTION_TIMEOUT_MS, label: "suggestions" });
  return parseSuggestions(text, recent);
}

// ---------------------------------------------------------------------------------------------
// Photos and PDFs the shopper attached: described once, in plain facts, so the agent (on any
// provider) can search the store for it. Videos cannot be read; they are passed on to the store team.
export async function describeAttachments(media, userMessage = "") {
  if (!media.length) return "";
  const prompt = [
    "A shopper attached these files to a chat with an online store assistant.",
    userMessage ? `Their message: "${String(userMessage).slice(0, 300)}"` : "They wrote no message.",
    "Describe only what is visible, as plain facts the assistant can use to find matching products or help with a problem: what the item is, its type, colour, material, style, brand or any readable text, and any visible damage or defect. For a PDF, give its key facts (for example an invoice number, product, amount). At most 80 words, no guessing, no greetings.",
  ].join(" ");
  // The first image call of a quiet moment can run past its time (a cold connection): one more try is cheaper than telling the
  // shopper the photo cannot be seen.
  const first = await generateText(prompt, { maxTokens: 220, temperature: 0.2, timeoutMs: 12000, label: "vision", media });
  if (String(first || "").trim()) return first;
  return generateText(prompt, { maxTokens: 220, temperature: 0.2, timeoutMs: 9000, label: "vision", media });
}
