// Monitoring: metrics in the Prometheus format behind a token, every AI call's tokens/time/cost,
// alerts to a webhook (throttled), and errors to Sentry (redacted, throttled) — without any SDK.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { inc, observe, gauge, value, renderPrometheus, recordLlm, tokensOf, costUsd, pricesFrom, httpMetrics, metricsHandler, __resetMetricsForTest } from "../src/observability/metrics.js";
import { createAlerter } from "../src/observability/alerts.js";
import { createErrorReporter, parseDsn, buildEnvelope } from "../src/observability/errors.js";
import { createShopBudget } from "../src/http/hardening.js";
import { createSharedRateLimitStore } from "../src/http/rateLimitStore.js";
import { validateEnv } from "../src/config/env.js";

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("counters, histograms and gauges render in the Prometheus text format", () => {
  __resetMetricsForTest();
  inc("things_total", { kind: 'a"b' }, 2, "Things");
  inc("things_total", { kind: 'a"b' });
  observe("wait_seconds", { route: "/x" }, 0.3, "Wait");
  gauge("open_now", "Open", () => 4);
  gauge("by_shop", "Per shop", () => [[{ shop: "a" }, 1], [{ shop: "b" }, 2]]);
  const text = renderPrometheus();
  assert.match(text, /# TYPE things_total counter\nthings_total\{kind="a\\"b"\} 3/);
  assert.match(text, /wait_seconds_bucket\{route="\/x",le="0.25"\} 0/);
  assert.match(text, /wait_seconds_bucket\{route="\/x",le="0.5"\} 1/);
  assert.match(text, /wait_seconds_count\{route="\/x"\} 1/);
  assert.match(text, /open_now 4/);
  assert.match(text, /by_shop\{shop="b"\} 2/);
});

test("each AI call is counted with its tokens and, when prices are set, its cost", () => {
  __resetMetricsForTest();
  assert.deepEqual(tokensOf({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 40 }), { input: 100, output: 20, cached: 40 });
  assert.deepEqual(tokensOf({ prompt_tokens: 7, completion_tokens: 3 }), { input: 7, output: 3, cached: 0 });
  const prices = pricesFrom({ LLM_PRICES_JSON: '{"gemini-x": {"input": 1, "output": 10, "cached": 0.25}, "groq": {"input": 2, "output": 2}}' });
  // 60 uncached x $1 + 40 cached x $0.25 + 20 out x $10, per million
  assert.equal(costUsd({ provider: "gemini", model: "gemini-x", usage: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 40 } }, prices), (60 + 10 + 200) / 1e6);
  assert.equal(costUsd({ provider: "groq", model: "llama", usage: { prompt_tokens: 1e6, completion_tokens: 0 } }, prices), 2, "provider price as a fallback");
  assert.equal(costUsd({ provider: "claude", model: "c", usage: {} }, prices), null, "no price, no cost");
  assert.deepEqual(pricesFrom({ LLM_PRICES_JSON: "not json" }), {});

  recordLlm({ provider: "gemini", model: "m", label: "agent", usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, latencyMs: 1200 });
  recordLlm({ provider: "gemini", model: "m", label: "agent", ok: false, latencyMs: 300 });
  assert.equal(value("llm_calls_total", { provider: "gemini", model: "m", purpose: "agent", outcome: "ok" }), 1);
  assert.equal(value("llm_calls_total", { provider: "gemini", model: "m", purpose: "agent", outcome: "error" }), 1);
  assert.equal(value("llm_tokens_total", { provider: "gemini", model: "m", purpose: "agent", kind: "output" }), 5);
  assert.equal(value("llm_call_seconds", { provider: "gemini", model: "m", purpose: "agent" }).count, 2);
});

test("HTTP requests are counted by route and status class; /metrics needs the token", async () => {
  __resetMetricsForTest();
  const app = express();
  app.use(httpMetrics);
  app.get("/metrics", metricsHandler({ env: { METRICS_TOKEN: "x".repeat(32) } }));
  app.get("/items/:id", (req, res) => res.json({ ok: true }));
  app.get("/busy", (req, res) => res.status(429).end());
  const srv = await listen(app);
  try {
    await fetch(`${srv.url}/items/12`);
    await fetch(`${srv.url}/items/13`);
    await fetch(`${srv.url}/busy`);
    assert.equal((await fetch(`${srv.url}/metrics`)).status, 401);
    assert.equal((await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const ok = await fetch(`${srv.url}/metrics`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /http_requests_total\{method="GET",route="\/items\/:id",status="2xx"\} 2/, "by route pattern, not by id");
    assert.match(text, /http_rate_limited_total\{route="\/busy"\} 1/);
  } finally {
    await srv.close();
  }
  const off = express();
  off.get("/metrics", metricsHandler({ env: {} }));
  const srv2 = await listen(off);
  try {
    assert.equal((await fetch(`${srv2.url}/metrics`)).status, 404, "no token configured: nothing exposed");
  } finally {
    await srv2.close();
  }
});

test("alerts go to the webhook as Slack/Discord text, redacted, once per interval per kind", async () => {
  const sent = [];
  let t = 0;
  const alerter = createAlerter({ env: { ALERT_WEBHOOK_URL: "https://hooks.example.com/x", ALERT_MIN_INTERVAL_MINUTES: "10", NODE_ENV: "production" }, now: () => t, fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 200 }); } });
  assert.equal(await alerter.send("db", "MongoDB down, owner asha@example.com"), true);
  assert.equal(await alerter.send("db", "again"), false, "throttled");
  assert.equal(await alerter.send("crash", "other kind"), true);
  t += 10 * 60_000;
  assert.equal(await alerter.send("db", "later"), true);
  assert.equal(sent[0].body.text, "[orbi production] MongoDB down, owner a***@example.com");
  assert.equal(sent[0].body.content, sent[0].body.text);
  assert.equal(await createAlerter({ env: {} }).send("x", "y"), false, "no webhook: counted only");
});

test("a store reaching its ceiling is counted as such", async () => {
  __resetMetricsForTest();
  const budget = createShopBudget({ perMinute: 1, perDay: 0, storeFor: (w) => createSharedRateLimitStore({ prefix: `obs:${w}:`, connected: () => false }), log: { warn() {} } });
  const app = express();
  app.use((req, _res, next) => { req.verifiedShop = "a.myshopify.com"; next(); });
  app.get("/x", ...budget, (req, res) => res.end());
  const srv = await listen(app);
  try {
    await fetch(`${srv.url}/x`);
    assert.equal((await fetch(`${srv.url}/x`)).status, 429);
    assert.equal(value("shop_budget_reached_total", { budget: "ai", window: "minute" }), 1);
  } finally {
    await srv.close();
  }
});

test("Sentry: the DSN is parsed, the envelope is well formed and redacted", () => {
  assert.deepEqual(parseDsn("https://abc123@o1.ingest.sentry.io/4507"), { url: "https://o1.ingest.sentry.io/api/4507/envelope/", key: "abc123", dsn: "https://abc123@o1.ingest.sentry.io/4507" });
  assert.equal(parseDsn("nonsense"), null);
  const { body, eventId } = buildEnvelope(new TypeError("lookup failed for asha@example.com"), { scope: "chat", tags: { shop: "a.myshopify.com" }, env: { NODE_ENV: "production", RELEASE: "1.2.3" }, now: () => 1_700_000_000_000 });
  const [header, item, event] = body.split("\n").map((l) => JSON.parse(l));
  assert.equal(header.event_id, eventId);
  assert.deepEqual(item, { type: "event" });
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.exception.values[0].value, "lookup failed for a***@example.com");
  assert.doesNotMatch(event.extra.stack, /asha@/);
  assert.deepEqual([event.environment, event.release, event.tags.scope, event.tags.shop, event.timestamp], ["production", "1.2.3", "chat", "a.myshopify.com", 1_700_000_000]);
});

test("errors are sent to Sentry with its auth header, the same one at most once a minute", async () => {
  const sent = [];
  let t = 0;
  const reporter = createErrorReporter({ env: { SENTRY_DSN: "https://pub@sentry.example.com/9" }, now: () => t, fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 200 }); } });
  assert.equal(await reporter.report(new Error("boom"), { scope: "voice" }), true);
  assert.equal(await reporter.report(new Error("boom"), { scope: "voice" }), false);
  t += 61_000;
  assert.equal(await reporter.report(new Error("boom"), { scope: "voice" }), true);
  assert.equal(sent[0].url, "https://sentry.example.com/api/9/envelope/");
  assert.match(sent[0].init.headers["x-sentry-auth"], /sentry_version=7, sentry_key=pub/);
  assert.equal(await createErrorReporter({ env: {} }).report(new Error("x")), false, "no DSN: counted only");
});

test("monitoring settings are validated at start-up", () => {
  const base = { MONGODB_URI: "m", SHOPIFY_CLIENT_ID: "i", SHOPIFY_CLIENT_SECRET: "s", SHOPIFY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), GEMINI_API_KEY: "g" };
  assert.ok(validateEnv(base).ok);
  assert.match(validateEnv({ ...base, METRICS_TOKEN: "short" }).errors.join(), /METRICS_TOKEN/);
  assert.match(validateEnv({ ...base, ALERT_WEBHOOK_URL: "http://x" }).errors.join(), /ALERT_WEBHOOK_URL/);
  assert.match(validateEnv({ ...base, SENTRY_DSN: "nope" }).errors.join(), /SENTRY_DSN/);
  assert.match(validateEnv({ ...base, ATTACHMENT_STORAGE: "s3", S3_BUCKET: "b" }).errors.join(), /S3_ENDPOINT/);
  assert.match(validateEnv({ ...base, ATTACHMENT_STORAGE: "ftp" }).errors.join(), /mongo or s3/);
});
