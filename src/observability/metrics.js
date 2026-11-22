// In-process metrics in the Prometheus text format, served at GET /metrics (with METRICS_TOKEN).
// What is measured: HTTP requests and their time, every AI call (tokens, time, failures and, with
// LLM_PRICES_JSON, its cost in USD), rate-limit refusals, voice sessions, uploads, errors, memory
// and event-loop delay. No dependency: counters live in memory and reset when the process restarts
// (Prometheus handles that).
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";

// Where one chat turn's time went: every AI call made while answering it (the main rounds and every check or rewrite), in order.
const turnTimeline = new AsyncLocalStorage();
/** Runs fn with a fresh list that collects each AI call of this turn as { step, ms, ok }. */
export function withTurnTimeline(steps, fn) {
  return turnTimeline.run(steps, fn);
}

const series = new Map(); // name -> { type, help, values: Map(labelKey -> value | histogram) }
const gauges = new Map(); // name -> { help, read: () => number | [labels, value][] }
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30];

const labelKey = (labels = {}) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k] ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 120)}"`)
    .join(",");

function family(name, type, help) {
  if (!series.has(name)) series.set(name, { type, help, values: new Map() });
  return series.get(name);
}

export function inc(name, labels = {}, by = 1, help = "") {
  if (!Number.isFinite(by) || by <= 0) return;
  const f = family(name, "counter", help);
  const key = labelKey(labels);
  f.values.set(key, (f.values.get(key) || 0) + by);
}

export function observe(name, labels = {}, seconds, help = "") {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const f = family(name, "histogram", help);
  const key = labelKey(labels);
  const h = f.values.get(key) || { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) h.counts[i]++;
  });
  h.sum += seconds;
  h.count++;
  f.values.set(key, h);
}

/** A value read when /metrics is scraped (e.g. active voice calls). */
export function gauge(name, help, read) {
  gauges.set(name, { help, read });
}

export function value(name, labels = {}) {
  return series.get(name)?.values.get(labelKey(labels));
}

export function renderPrometheus() {
  const lines = [];
  for (const [name, f] of series) {
    if (f.help) lines.push(`# HELP ${name} ${f.help}`);
    lines.push(`# TYPE ${name} ${f.type}`);
    for (const [key, v] of f.values) {
      if (f.type === "histogram") {
        BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{${key}${key ? "," : ""}le="${b}"} ${v.counts[i]}`));
        lines.push(`${name}_bucket{${key}${key ? "," : ""}le="+Inf"} ${v.count}`);
        lines.push(`${name}_sum${key ? `{${key}}` : ""} ${v.sum}`);
        lines.push(`${name}_count${key ? `{${key}}` : ""} ${v.count}`);
      } else {
        lines.push(`${name}${key ? `{${key}}` : ""} ${v}`);
      }
    }
  }
  for (const [name, g] of gauges) {
    let read;
    try {
      read = g.read();
    } catch {
      continue;
    }
    lines.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
    if (Array.isArray(read)) for (const [labels, v] of read) lines.push(`${name}{${labelKey(labels)}} ${Number(v) || 0}`);
    else lines.push(`${name} ${Number(read) || 0}`);
  }
  return `${lines.join("\n")}\n`;
}

export function __resetMetricsForTest() {
  series.clear();
  gauges.clear();
}

// ---- AI calls ----------------------------------------------------------------------------------
/** Token counts from any provider's usage object (Gemini usageMetadata, Claude, Groq/OpenAI). */
export function tokensOf(usage = {}) {
  const u = usage || {};
  return {
    input: Number(u.promptTokenCount ?? u.prompt_tokens ?? u.input_tokens) || 0,
    output: Number(u.candidatesTokenCount ?? u.completion_tokens ?? u.output_tokens) || 0,
    cached: Number(u.cachedContentTokenCount ?? u.cache_read_input_tokens) || 0,
  };
}

/**
 * Prices per million tokens, from LLM_PRICES_JSON, by model name (or provider name as a fallback):
 * {"gemini-2.5-flash": {"input": 0.30, "output": 2.50, "cached": 0.075}, "groq": {"input": 0.1, "output": 0.3}}
 * Not set: tokens are counted but no cost is reported.
 */
export function pricesFrom(env = process.env) {
  try {
    const parsed = JSON.parse(env.LLM_PRICES_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function costUsd({ provider, model, usage }, prices = pricesFrom()) {
  const price = prices[model] || prices[provider];
  if (!price) return null;
  const t = tokensOf(usage);
  const uncached = Math.max(0, t.input - t.cached);
  const cachedPrice = Number(price.cached ?? price.input) || 0;
  return (uncached * (Number(price.input) || 0) + t.cached * cachedPrice + t.output * (Number(price.output) || 0)) / 1e6;
}

/** One AI call: what it was for, how long it took, the tokens and (if prices are set) the cost. */
export function recordLlm({ provider = "unknown", model = "unknown", label = "agent", usage, latencyMs, ok = true, error = null } = {}) {
  const steps = turnTimeline.getStore();
  if (Array.isArray(steps) && steps.length < 40 && Number.isFinite(latencyMs)) steps.push({ step: `ai:${label}`, model: `${provider}/${model}`, ms: Math.round(latencyMs), ok, tokensIn: tokensOf(usage).input, cached: tokensOf(usage).cached, tokensOut: tokensOf(usage).output, thoughts: Number(usage?.thoughtsTokenCount) || 0, ...(error ? { error: String(error?.message || error).slice(0, 120) } : {}) });
  const labels = { provider, model, purpose: label };
  inc("llm_calls_total", { ...labels, outcome: ok ? "ok" : "error" }, 1, "AI calls by provider, model, purpose and outcome");
  if (Number.isFinite(latencyMs)) observe("llm_call_seconds", labels, latencyMs / 1000, "Time of each AI call");
  if (!ok) return;
  const t = tokensOf(usage);
  inc("llm_tokens_total", { ...labels, kind: "input" }, t.input, "Tokens sent to and received from AI models");
  inc("llm_tokens_total", { ...labels, kind: "cached" }, t.cached);
  inc("llm_tokens_total", { ...labels, kind: "output" }, t.output);
  const cost = costUsd({ provider, model, usage });
  if (cost) inc("llm_cost_usd_total", labels, cost, "AI cost in USD, from LLM_PRICES_JSON");
}

// ---- HTTP --------------------------------------------------------------------------------------
/** Express middleware: requests by route and status class, and their duration. */
export function httpMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.baseUrl || "unmatched";
    const labels = { method: req.method, route: String(route).slice(0, 80), status: `${String(res.statusCode)[0]}xx` };
    inc("http_requests_total", labels, 1, "HTTP requests by route and status class");
    observe("http_request_seconds", { method: req.method, route: labels.route }, Number(process.hrtime.bigint() - start) / 1e9, "HTTP request duration");
    if (res.statusCode === 429) inc("http_rate_limited_total", { route: labels.route }, 1, "Requests refused by a rate limit");
  });
  next();
}

// ---- the process -------------------------------------------------------------------------------
let loopDelay;
export function installProcessGauges() {
  if (!loopDelay) {
    loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
  }
  gauge("process_resident_memory_bytes", "Resident memory of this process", () => process.memoryUsage().rss);
  gauge("process_heap_used_bytes", "Heap in use", () => process.memoryUsage().heapUsed);
  gauge("process_uptime_seconds", "Seconds since this process started", () => process.uptime());
  gauge("event_loop_delay_p99_seconds", "Event-loop delay (99th percentile since the last scrape); high means CPU-bound work blocks replies", () => {
    const p99 = loopDelay.percentile(99) / 1e9;
    loopDelay.reset();
    return p99;
  });
}

/**
 * GET /metrics, only with `Authorization: Bearer <METRICS_TOKEN>`. Without METRICS_TOKEN the route
 * does not exist (404), so nothing is exposed by default.
 */
export function metricsHandler({ env = process.env } = {}) {
  return (req, res) => {
    const token = String(env.METRICS_TOKEN || "");
    if (!token) return res.status(404).end();
    const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.set("Cache-Control", "no-store");
    return res.send(renderPrometheus());
  };
}

