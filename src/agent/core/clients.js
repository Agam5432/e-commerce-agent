// The LLM clients (made once per key), timeouts, and taking a provider out for a while after an auth error.
// Part of agent.js (which re-exports all of it); moved here unchanged.
import { alert } from "../../observability/alerts.js";
import { createClaudeClient } from "../claudeAdapter.js";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";

let cachedGroq = null;
let cachedGroqKey = "";
let cachedGemini = null;
let cachedGeminiKey = "";

// Test seam: unit tests inject fake LLM clients (same shape as the SDKs). Never used in production.
let injectedClients = null;
export function __setLLMClientsForTest(clients = null) {
  injectedClients = clients;
}

function getGroqClient() {
  if (injectedClients) return injectedClients.groq || null;
  const key = process.env.GROQ_API_KEY || "";
  if (!key) return null;
  if (!cachedGroq || cachedGroqKey !== key) {
    cachedGroq = new Groq({ apiKey: key, maxRetries: 0 });
    cachedGroqKey = key;
  }
  return cachedGroq;
}

let cachedClaude = null;
let cachedClaudeKey = "";
function getClaudeClient() {
  if (injectedClients) return injectedClients.claude || null;
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key) return null;
  if (!cachedClaude || cachedClaudeKey !== key) {
    cachedClaude = createClaudeClient({ apiKey: key });
    cachedClaudeKey = key;
  }
  return cachedClaude;
}

function getGeminiClient() {
  if (injectedClients) return injectedClients.gemini || null;
  const key = process.env.GEMINI_API_KEY || process.env.GEMINI_API || "";
  if (!key) return null;
  if (!cachedGemini || cachedGeminiKey !== key) {
    cachedGemini = new GoogleGenAI({ apiKey: key });
    cachedGeminiKey = key;
  }
  return cachedGemini;
}

const workingThinkingByModel = new Map();

function getGeminiThinkingCandidates(modelName) {
  if (workingThinkingByModel.has(modelName)) {
    return [workingThinkingByModel.get(modelName)];
  }
  const override = (process.env.GEMINI_THINKING_LEVEL || "").toLowerCase().trim();
  if (/gemini-2\.0/.test(modelName)) {
    return [undefined];
  }
  if (/gemini-3/.test(modelName)) {
    if (override === "low" || override === "medium" || override === "high") {
      return [{ thinkingLevel: override.toUpperCase() }, { thinkingBudget: 0 }, undefined];
    }
    return [
      { thinkingLevel: /pro/i.test(modelName) ? "LOW" : "MINIMAL" },
      { thinkingBudget: 0 },
      undefined,
    ];
  }
  return [{ thinkingBudget: 0 }, { thinkingLevel: "MINIMAL" }, undefined];
}

function withHardTimeout(promise, ms, label = "LLM") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} hard timeout after ${ms}ms`);
      err.name = "AbortError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A rejected API key does not start working by itself. Instead of trying that provider (and waiting
// for it to fail) on every turn, it is skipped for an hour, or until the key is fixed and the server
// restarted. The log says which key to fix.
const AUTH_BLOCK_MS = 60 * 60 * 1000;
const KEY_ENV = { claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY" };
const providerBlockedUntil = new Map();

export function isAuthError(error) {
  const status = Number(error?.status || error?.code);
  if (status === 401 || status === 403) return true;
  return /\b(?:401|403)\b|invalid[\s_-]*(?:x-)?api[\s_-]*key|api key not valid|unauthori[sz]ed/i.test(String(error?.message || error || ""));
}

function blockProviderForAuth(name, error) {
  if ((providerBlockedUntil.get(name) || 0) > Date.now()) return;
  providerBlockedUntil.set(name, Date.now() + AUTH_BLOCK_MS);
  alert(`llm_key_${name}`, `${name}: the API key was rejected; ${name} is skipped for an hour. Fix ${KEY_ENV[name] || "its key"} and restart.`);
  console.error(
    `[agent] ${name}: the API key was rejected (${String(error?.message || error).slice(0, 120)}). ` +
      `${name} is skipped for 1 hour so replies are not delayed; fix ${KEY_ENV[name] || "its key"} in .env and restart the server.`
  );
}

/** Test seam: forget blocked providers. */
export function __resetProviderBlocksForTest() {
  providerBlockedUntil.clear();
}

function providerAvailable(name) {
  if ((providerBlockedUntil.get(name) || 0) > Date.now()) return false;
  if (name === "groq") return Boolean(getGroqClient());
  if (name === "gemini") return Boolean(getGeminiClient());
  if (name === "claude") return Boolean(getClaudeClient());
  return false;
}

function isUserAbort(error) {
  const msg = String(error?.message || "");
  return error?.name === "AbortError" || /\brun cancelled\b/i.test(msg);
}

function errMsg(e) {
  return e?.message || e || "";
}

export { cachedGroq, cachedGroqKey, cachedGemini, cachedGeminiKey, injectedClients, getGroqClient, cachedClaude, cachedClaudeKey, getClaudeClient, getGeminiClient, workingThinkingByModel, getGeminiThinkingCandidates, withHardTimeout, AUTH_BLOCK_MS, KEY_ENV, providerBlockedUntil, blockProviderForAuth, providerAvailable, isUserAbort, errMsg };
