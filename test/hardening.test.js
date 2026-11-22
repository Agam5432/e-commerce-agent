import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { validateEnv } from "../src/config/env.js";
import { redact, createLogger } from "../src/utils/logger.js";
import { securityHeaders, createHealthHandlers, installGracefulShutdown } from "../src/http/hardening.js";
import { sweepCaches, __cachesForTest } from "../src/tools/shopifyService.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const goodEnv = {
  NODE_ENV: "production", MONGODB_URI: "mongodb://x", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret",
  SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY, GEMINI_API_KEY: "k", APP_URL: "https://app.example.com",
  EMAIL_USER: "a", EMAIL_APP_PASSWORD: "b", SHOPIFY_SCOPES: "read_products,read_legal_policies", CLAMAV_HOST: "clamav",
  METRICS_TOKEN: "m".repeat(32), ALERT_WEBHOOK_URL: "https://alerts.example.com/hook",
};

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("env validation: a complete production config passes", () => {
  const r = validateEnv(goodEnv);
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.warnings, []);
});

test("env validation: missing secrets, a bad key and no AI provider block production start", () => {
  const r = validateEnv({ ...goodEnv, SHOPIFY_CLIENT_SECRET: "", SHOPIFY_TOKEN_ENCRYPTION_KEY: "short", GEMINI_API_KEY: "", APP_URL: "http://x" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /CLIENT_SECRET/.test(e)));
  assert.ok(r.errors.some((e) => /32 bytes/.test(e)));
  assert.ok(r.errors.some((e) => /AI provider/.test(e)));
  assert.ok(r.errors.some((e) => /APP_URL/.test(e)));
});

test("env validation warns about retired hardcoded shipping and missing policy scope", () => {
  const r = validateEnv({ ...goodEnv, EXPRESS_SHIPPING_COST: "15", SHOPIFY_SCOPES: "read_products" });
  assert.ok(r.warnings.some((w) => /EXPRESS_SHIPPING_COST/.test(w)));
  assert.ok(r.warnings.some((w) => /read_legal_policies/.test(w)));
});

test("logs never carry a shopper's email or phone", () => {
  const out = redact("buyer agam.tyagi@gmail.com phone +91 98765 43210 order #1001");
  assert.doesNotMatch(out, /agam\.tyagi@/);
  assert.doesNotMatch(out, /98765/);
  assert.match(out, /a\*\*\*@gmail\.com/);
  assert.match(out, /#1001/);
});

test("logger honours LOG_LEVEL", () => {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  const log = createLogger("t");
  assert.equal(log.enabled("debug"), false);
  assert.equal(log.enabled("warn"), true);
  if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
});

test("security headers are set on every response and x-powered-by is gone", async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.get("/x", (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    const r = await fetch(`${srv.url}/x`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors/);
    assert.equal(r.headers.get("x-powered-by"), null);
  } finally {
    await srv.close();
  }
});

test("readiness reports 503 until the database is connected", async () => {
  const fakeMongoose = { connection: { readyState: 0 } };
  const h = createHealthHandlers({ mongoose: fakeMongoose });
  const app = express();
  app.get("/healthz", h.liveness);
  app.get("/readyz", h.readiness);
  const srv = await listen(app);
  try {
    assert.equal((await fetch(`${srv.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${srv.url}/readyz`)).status, 503);
    fakeMongoose.connection.readyState = 1;
    const ready = await fetch(`${srv.url}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).database, "connected");
  } finally {
    await srv.close();
  }
});

test("graceful shutdown closes sockets, the server and the database, then exits 0", async () => {
  const events = [];
  const fake = {
    server: { close: (cb) => { events.push("server"); cb(); } },
    wss: { clients: [{ close: () => events.push("socket") }] },
    mongoose: { connection: { readyState: 1 }, disconnect: async () => events.push("db") },
  };
  let code = null;
  const state = installGracefulShutdown({ ...fake, log: { info() {}, error() {} }, exit: (c) => { code = c; } });
  await state.shutdown("SIGTERM");
  assert.deepEqual(events, ["socket", "server", "db"]);
  assert.equal(code, 0);
  assert.equal(state.isShuttingDown(), true);
});

test("caches drop entries older than the max age", () => {
  const { searchCaches, policyCaches } = __cachesForTest;
  searchCaches.set("old", { at: Date.now() - 2 * 60 * 60 * 1000, products: [] });
  searchCaches.set("new", { at: Date.now(), products: [] });
  policyCaches.set("old.myshopify.com", { at: 0, policies: [] });
  sweepCaches();
  assert.equal(searchCaches.has("old"), false);
  assert.equal(searchCaches.has("new"), true);
  assert.equal(policyCaches.has("old.myshopify.com"), false);
  searchCaches.delete("new");
});

test("the real server app exposes /healthz, /readyz and the security headers", async () => {
  const { app } = await import("../server.js");
  const srv = await listen(app);
  try {
    const live = await fetch(`${srv.url}/healthz`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("x-content-type-options"), "nosniff");
    assert.equal(live.headers.get("x-powered-by"), null);
    const ready = await fetch(`${srv.url}/readyz`);
    assert.equal(ready.status, 503); // no database in unit tests
  } finally {
    await srv.close();
  }
});

// ---- a dropped database connection must not turn into "store not connected" -------------------
test("a store verified a moment ago stays active while the database is unreachable", async () => {
  const mongoose = (await import("mongoose")).default;
  const { default: StoreIntegration } = await import("../src/models/StoreIntegration.js");
  const { resolveActiveStoreDomain, markStoreUninstalled } = await import("../src/services/storeIntegrationService.js");
  const original = { exists: StoreIntegration.exists, update: StoreIntegration.findOneAndUpdate };
  const shop = "grace-test.myshopify.com";
  try {
    StoreIntegration.exists = async () => ({ _id: "1" });
    assert.equal(await resolveActiveStoreDomain(shop), shop);
    // the database goes away: the lookup throws (and the connection is not ready)
    StoreIntegration.exists = async () => { throw new Error("buffering timed out"); };
    assert.equal(await resolveActiveStoreDomain(shop), shop);
    // a store never verified is still refused, not assumed active
    await assert.rejects(resolveActiveStoreDomain("never-seen.myshopify.com"), /buffering/);
    // uninstalling forgets the grace entry
    StoreIntegration.findOneAndUpdate = async () => ({});
    await markStoreUninstalled(shop);
    await assert.rejects(resolveActiveStoreDomain(shop), /buffering/);
    // with a healthy connection, "not active" is never overridden by the grace entry
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
    StoreIntegration.exists = async () => ({ _id: "1" });
    assert.equal(await resolveActiveStoreDomain(shop), shop);
    StoreIntegration.exists = async () => null;
    assert.equal(await resolveActiveStoreDomain(shop), null);
  } finally {
    delete mongoose.connection.readyState;
    StoreIntegration.exists = original.exists;
    StoreIntegration.findOneAndUpdate = original.update;
  }
});

test("oauth status and sync-profile need a Shopify session: no token, no store data", async () => {
  const { default: oauthRouter } = await import("../src/routes/shopifyOAuthRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/shopify/oauth", oauthRouter);
  const srv = await listen(app);
  try {
    const status = await fetch(`${srv.url}/api/shopify/oauth/status?shop=victim.myshopify.com`);
    assert.equal(status.status, 401);
    const sync = await fetch(`${srv.url}/api/shopify/oauth/sync-profile`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shop: "victim.myshopify.com" }),
    });
    assert.equal(sync.status, 401);
    const forged = await fetch(`${srv.url}/api/shopify/oauth/status?shop=victim.myshopify.com`, { headers: { authorization: "Bearer a.b.c" } });
    assert.equal(forged.status, 401);
  } finally {
    await srv.close();
  }
});

test("a crash shutdown exits non-zero so a supervisor restarts the server", async () => {
  const fake = { server: { close: (cb) => cb() }, wss: { clients: [] }, mongoose: { connection: { readyState: 0 } } };
  let code = null;
  const state = installGracefulShutdown({ ...fake, log: { info() {}, error() {} }, exit: (c) => { code = c; } });
  await state.shutdown("uncaughtException");
  assert.equal(code, 1);
});

test("env validation: a tunnel or local APP_URL blocks production start", () => {
  for (const APP_URL of ["https://violin-mayflower-sandstorm.ngrok-free.dev", "https://abc.trycloudflare.com", "https://localhost:3000", "https://192.168.1.5", "https://172.20.0.4", "https://my-app.loca.lt"]) {
    const r = validateEnv({ ...goodEnv, APP_URL });
    assert.equal(r.ok, false, APP_URL);
    assert.ok(r.errors.some((e) => /tunnel or a local address/.test(e)), APP_URL);
  }
  assert.equal(validateEnv({ ...goodEnv, APP_URL: "https://ngrok.example.com" }).ok, true, "a real domain that only contains the word is allowed");
});

test("env validation: production warns when nothing watches the server", () => {
  const { METRICS_TOKEN, ALERT_WEBHOOK_URL, ...bare } = goodEnv;
  const r = validateEnv(bare);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /METRICS_TOKEN/.test(w)));
  assert.ok(r.warnings.some((w) => /SENTRY_DSN nor ALERT_WEBHOOK_URL/.test(w)));
  assert.equal(validateEnv({ ...bare, NODE_ENV: "development", APP_URL: "https://x.ngrok-free.dev" }).warnings.some((w) => /METRICS_TOKEN/.test(w)), false, "development is not nagged");
});

test("env validation: in production the OAuth redirect address must be real and on the same host as APP_URL", () => {
  const ok = validateEnv({ ...goodEnv, SHOPIFY_OAUTH_REDIRECT_URI: "https://app.example.com/api/shopify/oauth/callback" });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  const tunnel = validateEnv({ ...goodEnv, SHOPIFY_OAUTH_REDIRECT_URI: "https://abc.ngrok-free.dev/api/shopify/oauth/callback" });
  assert.equal(tunnel.ok, false);
  assert.ok(tunnel.errors.some((e) => /SHOPIFY_OAUTH_REDIRECT_URI points at a tunnel/.test(e)));
  const other = validateEnv({ ...goodEnv, SHOPIFY_OAUTH_REDIRECT_URI: "https://other.example.org/callback" });
  assert.ok(other.errors.some((e) => /same host as APP_URL/.test(e)));
  assert.equal(validateEnv({ ...goodEnv }).ok, true, "an unset redirect address is not an error (the app builds it from APP_URL)");
  assert.equal(validateEnv({ ...goodEnv, NODE_ENV: "development", SHOPIFY_OAUTH_REDIRECT_URI: "https://abc.ngrok-free.dev/cb", APP_URL: "https://abc.ngrok-free.dev" }).ok, true, "development is not blocked");
});

test("error reporting and metrics behave safely without their settings", async () => {
  const { createErrorReporter, buildEnvelope } = await import("../src/observability/errors.js");
  const { metricsHandler } = await import("../src/observability/metrics.js");
  // no SENTRY_DSN: nothing is sent, nothing throws, the report just returns false
  const quiet = createErrorReporter({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(quiet.enabled, false);
  assert.equal(await quiet.report(new Error("boom")), false);
  // the report names the environment and carries no e-mail address or phone number from the message
  const { body } = buildEnvelope(new Error("could not mail jane.doe@example.com or +1 555 123 4567"), { env: { NODE_ENV: "production" } });
  const event = JSON.parse(body.split("\n")[2]);
  assert.equal(event.environment, "production");
  assert.doesNotMatch(JSON.stringify(event), /jane\.doe@example\.com|555 123 4567/);
  // no METRICS_TOKEN: the route does not exist; a wrong token: 401; the right token: the metrics
  const res = (store) => ({ status(c) { store.code = c; return this; }, end() { store.ended = true; return this; }, set() { return this; }, send(b) { store.body = b; return this; } });
  const none = {}; metricsHandler({ env: {} })({ headers: {} }, res(none)); assert.equal(none.code, 404);
  const wrong = {}; metricsHandler({ env: { METRICS_TOKEN: "t".repeat(32) } })({ headers: { authorization: "Bearer nope" } }, res(wrong)); assert.equal(wrong.code, 401);
  const right = {}; metricsHandler({ env: { METRICS_TOKEN: "t".repeat(32) } })({ headers: { authorization: `Bearer ${"t".repeat(32)}` } }, res(right)); assert.ok(typeof right.body === "string" && right.body.length > 0);
});

test("BUG-12: the OAuth routes never ask the browser to send cookies on a cross-origin request", async () => {
  const express = (await import("express")).default;
  const { default: router } = await import("../src/routes/shopifyOAuthRoutes.js");
  const app = express();
  app.use("/api/shopify/oauth", router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/shopify/oauth/status`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    assert.notEqual(res.headers.get("access-control-allow-credentials"), "true");
  } finally {
    server.close();
  }
});
