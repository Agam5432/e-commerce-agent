// The Shopify app config (the TOML that `shopify app deploy` releases) and the server must agree. A deploy from a copy of the project
// with an older TOML once removed the orders/cancelled and refunds/create subscriptions: the release dropped them, Shopify stopped
// sending those webhooks, and cancelled / refunded orders went on counting as revenue. This test makes that mistake visible in CI.
// STATIC check of local files (AUTOMATED TESTED): it cannot see what is released in Shopify; the Dev Dashboard's version page does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shopifyApiVersion } from "../src/config/env.js";

const TOML = fs.readFileSync(process.env.TOML_UNDER_TEST || new URL("../shopify-app/shopify.app.ai-commerce-agent.toml", import.meta.url), "utf8");
const SERVER = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

/** Every [[webhooks.subscriptions]] block: its topics, compliance topics and uri (comments ignored). */
function subscriptions(toml) {
  const clean = toml.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");
  return clean.split("[[webhooks.subscriptions]]").slice(1).map((block) => {
    const body = block.split(/\n\[(?!\[webhooks)/)[0];
    const list = (key) => (body.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))?.[1] || "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    return { topics: list("topics"), compliance: list("compliance_topics"), uri: body.match(/^\s*uri\s*=\s*"([^"]+)"/m)?.[1] || "" };
  });
}

const REQUIRED = {
  "orders/create": "/api/shopify/webhooks/orders-create",
  "orders/cancelled": "/api/shopify/webhooks/orders-cancelled",
  "refunds/create": "/api/shopify/webhooks/refunds-create",
};
const COMPLIANCE = ["customers/data_request", "customers/redact", "shop/redact"];

test("the TOML subscribes to every order topic the revenue rules depend on, each with its own endpoint", () => {
  const subs = subscriptions(TOML);
  for (const [topic, uri] of Object.entries(REQUIRED)) {
    const found = subs.find((s) => s.topics.includes(topic));
    assert.ok(found, `${topic} is not subscribed: a deploy of this TOML would remove it from Shopify (cancelled and refunded orders would keep counting)`);
    assert.equal(found.uri, uri, `${topic} must be delivered to ${uri}`);
  }
});

test("the three mandatory privacy topics are declared, on one compliance endpoint", () => {
  const compliance = subscriptions(TOML).find((s) => s.compliance.length);
  assert.ok(compliance, "compliance_topics missing");
  for (const topic of COMPLIANCE) assert.ok(compliance.compliance.includes(topic), topic);
  assert.equal(compliance.uri, "/api/shopify/webhooks/compliance");
});

test("every subscription endpoint in the TOML is a POST route the server really registers, wired to the right handler", () => {
  const handlerFor = { "/api/shopify/webhooks/orders-create": "ordersCreateWebhook", "/api/shopify/webhooks/orders-cancelled": "ordersCancelledWebhook", "/api/shopify/webhooks/refunds-create": "refundsCreateWebhook", "/api/shopify/webhooks/compliance": "complianceWebhook" };
  for (const { uri } of subscriptions(TOML)) {
    assert.ok(handlerFor[uri], `unexpected endpoint ${uri}: add its handler to this test`);
    assert.ok(SERVER.includes(`app.post("${uri}", ${handlerFor[uri]})`), `server.js does not register ${uri} with ${handlerFor[uri]}`);
  }
});

test("no topic is subscribed twice (a duplicate subscription would deliver every event twice)", () => {
  const all = subscriptions(TOML).flatMap((s) => [...s.topics, ...s.compliance]);
  assert.equal(new Set(all).size, all.length, JSON.stringify(all));
});

test("the TOML's webhook API version is the one the backend reads orders with (the state it writes comes from the same version)", () => {
  const version = TOML.match(/^\s*api_version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(version, "[webhooks] api_version missing");
  assert.equal(version, shopifyApiVersion(), "webhook payloads and the Admin API queries must come from one API version");
});

test("the app has the order-read scope the order webhooks and the order-state query need", () => {
  const scopes = (TOML.match(/^\s*scopes\s*=\s*"([^"]+)"/m)?.[1] || "").split(",");
  assert.ok(scopes.includes("read_orders"), "read_orders is needed for orders/* and refunds/* topics and the order-state lookup");
});

test("the app proxy and the OAuth redirect live on the application's own host (one app, one tunnel or domain)", () => {
  const host = (url) => new URL(url).host;
  const appUrl = TOML.match(/^\s*application_url\s*=\s*"(https:\/\/[^"]+)"/m)?.[1];
  assert.ok(appUrl, "application_url must be https");
  const proxy = TOML.split("[app_proxy]")[1]?.match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(proxy, "[app_proxy] url missing");
  assert.equal(host(proxy), host(appUrl), "the app proxy must be on the application's host");
  const redirects = [...(TOML.split("[auth]")[1] || "").split("[app_proxy]")[0].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(redirects.length > 0, "[auth] redirect_urls missing");
  for (const r of redirects) assert.equal(host(r), host(appUrl), `OAuth redirect must be on the application's host: ${r}`);
  assert.match(TOML, /^\s*client_id\s*=\s*"[0-9a-f]{32}"/m);
});
