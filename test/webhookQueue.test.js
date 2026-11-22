// Webhooks: Shopify gets its 200 at once, the same delivery is done once, failed work is retried by us
// with growing waits and given up (with an alert) after the last attempt, and work a crashed instance
// left half done is picked up again.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createWebhookQueue, retryDelayMs } from "../src/services/webhookQueue.js";
import { webhookHandler, deliveryId } from "../src/routes/shopifyWebhookRoutes.js";

const SHOP = "a-store.myshopify.com";
process.env.SHOPIFY_CLIENT_SECRET = "test-secret";
process.env.SHOPIFY_API_SECRET = "test-secret";

// An in-memory collection that understands the queries the queue sends.
function fakeReceipts() {
  const rows = new Map();
  const cmp = (v, cond) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$in" in cond) return cond.$in.includes(v);
      if ("$lte" in cond) return v != null && v <= cond.$lte;
      if ("$lt" in cond) return v != null && v < cond.$lt;
    }
    return v === cond;
  };
  const matches = (row, f) => Object.entries(f).every(([k, c]) => (k === "$or" ? c.some((x) => matches(row, x)) : cmp(row[k], c)));
  const apply = (row, u) => {
    Object.assign(row, u.$set || {});
    for (const [k, by] of Object.entries(u.$inc || {})) row[k] = (row[k] || 0) + by;
    for (const k of Object.keys(u.$unset || {})) delete row[k];
  };
  return {
    rows,
    async create(doc) {
      if (rows.has(doc._id)) throw Object.assign(new Error("E11000"), { code: 11000 });
      rows.set(doc._id, structuredClone(doc));
    },
    async findOneAndUpdate(f, u) {
      const row = [...rows.values()].find((r) => matches(r, f));
      if (!row) return null;
      apply(row, u);
      return structuredClone(row);
    },
    async updateOne(f, u) {
      const row = [...rows.values()].find((r) => matches(r, f));
      if (row) apply(row, u);
    },
    find(f) {
      const found = [...rows.values()].filter((r) => matches(r, f));
      const q = { limit: (n) => ({ lean: async () => found.slice(0, n) }) };
      return q;
    },
  };
}

test("the wait between attempts grows and is capped at an hour", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(retryDelayMs(20), 3_600_000);
});

test("a delivery is done once, its payload dropped when done", async () => {
  const Model = fakeReceipts();
  const done = [];
  const queue = createWebhookQueue({ Model, connected: () => true }).register("orders", async (ctx) => done.push(ctx));
  assert.equal(await queue.accept({ id: "w1", kind: "orders", shop: SHOP, topic: "orders/create", body: { name: "#1001", email: "a@b.com" } }), "queued");
  assert.equal(await queue.accept({ id: "w1", kind: "orders", shop: SHOP, topic: "orders/create", body: {} }), "duplicate");
  assert.equal(await queue.run("w1"), "done");
  assert.equal(await queue.run("w1"), "skipped", "a second run does nothing");
  assert.deepEqual(done, [{ shop: SHOP, topic: "orders/create", body: { name: "#1001", email: "a@b.com" } }]);
  const row = Model.rows.get("w1");
  assert.equal(row.status, "done");
  assert.equal(row.body, undefined, "the customer's data is not kept after the work");
  assert.ok(row.expiresAt > Date.now(), "the receipt stays a while, to recognise repeats");
});

test("a failure is retried after a wait, then given up with an alert", async () => {
  const Model = fakeReceipts();
  let t = 1_000_000;
  let calls = 0;
  const errors = [];
  const queue = createWebhookQueue({ Model, connected: () => true, now: () => t, maxAttempts: 3, log: { error: (m) => errors.push(m) } }).register("x", async () => {
    calls++;
    throw new Error("shopify timeout");
  });
  await queue.accept({ id: "w2", kind: "x", shop: SHOP });
  assert.equal(await queue.run("w2"), "failed");
  assert.equal(await queue.sweep(), 0, "not due yet");
  t += retryDelayMs(1);
  assert.equal(await queue.sweep(), 1);
  assert.equal(Model.rows.get("w2").status, "failed");
  t += retryDelayMs(2);
  await queue.sweep();
  assert.equal(Model.rows.get("w2").status, "dead");
  assert.equal(calls, 3);
  t += 10 * 3_600_000;
  assert.equal(await queue.sweep(), 0, "a dead receipt is not retried");
  assert.match(Model.rows.get("w2").lastError, /shopify timeout/);
  assert.match(errors.at(-1), /attempt 3 of 3/);
});

test("work a crashed instance left half done is picked up once its lock runs out", async () => {
  const Model = fakeReceipts();
  let t = 5_000_000;
  let ran = 0;
  const queue = createWebhookQueue({ Model, connected: () => true, now: () => t }).register("x", async () => { ran++; });
  await queue.accept({ id: "w3", kind: "x", shop: SHOP });
  Object.assign(Model.rows.get("w3"), { status: "processing", lockedUntil: new Date(t + 60_000), attempts: 1 });
  assert.equal(await queue.sweep(), 0, "still locked by the other instance");
  t += 61_000;
  assert.equal(await queue.sweep(), 1);
  assert.equal(ran, 1);
  assert.equal(Model.rows.get("w3").status, "done");
});

// ---- through the HTTP handler ----------------------------------------------------------------
const sign = (raw) => crypto.createHmac("sha256", "test-secret").update(raw).digest("base64");
function call(handler, { body = {}, headers = {} } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const h = { "x-shopify-hmac-sha256": sign(raw), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/create", ...headers };
  const req = { rawBody: raw, body, headers: h, get: (n) => h[n.toLowerCase()] };
  return new Promise((resolve) => {
    const res = { code: 0, status(s) { this.code = s; return this; }, json(b) { resolve({ status: this.code, body: b }); return this; } };
    handler(req, res);
  });
}

test("Shopify gets 200 before the work runs; a repeat delivery is skipped", async () => {
  const Model = fakeReceipts();
  const queue = createWebhookQueue({ Model, connected: () => true });
  let release;
  const gate = new Promise((r) => (release = r));
  let runs = 0;
  const handler = webhookHandler(async () => { runs++; await gate; }, { kind: "slow", queue });
  const first = await call(handler, { headers: { "x-shopify-webhook-id": "abc-123-def" } });
  assert.deepEqual(first, { status: 200, body: { ok: true } }, "answered while the work is still waiting");
  const again = await call(handler, { headers: { "x-shopify-webhook-id": "abc-123-def" } });
  assert.deepEqual(again.body, { ok: true, duplicate: true });
  release();
  // wait for the background work to finish (a busy machine can take longer than a fixed pause)
  for (let i = 0; i < 100 && Model.rows.get("abc-123-def")?.status !== "done"; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1);
  assert.equal(Model.rows.get("abc-123-def").status, "done");
});

test("without the database the work is done before answering, and a failure is a 500", async () => {
  const queue = createWebhookQueue({ Model: fakeReceipts(), connected: () => false });
  const ok = webhookHandler(async () => {}, { kind: "a", queue });
  assert.equal((await call(ok)).status, 200);
  const bad = webhookHandler(async () => { throw new Error("db down"); }, { kind: "b", queue });
  assert.equal((await call(bad)).status, 500);
  const broken = createWebhookQueue({ Model: { create: async () => { throw new Error("write failed"); } }, connected: () => true });
  assert.equal((await call(webhookHandler(async () => {}, { kind: "c", queue: broken }))).status, 500, "could not write it down: Shopify must retry");
});

test("the delivery id is Shopify's, or a hash of the signed delivery", () => {
  const header = (h) => (name) => h[name];
  assert.equal(deliveryId(header({ "X-Shopify-Webhook-Id": "b5e6c3a8-1111" }), "{}", "t", SHOP), "b5e6c3a8-1111");
  const a = deliveryId(header({}), Buffer.from("{\"id\":1}"), "orders/create", SHOP);
  assert.match(a, /^sha:[0-9a-f]{64}$/);
  assert.equal(a, deliveryId(header({}), Buffer.from("{\"id\":1}"), "orders/create", SHOP));
  assert.notEqual(a, deliveryId(header({}), Buffer.from("{\"id\":2}"), "orders/create", SHOP));
  assert.match(deliveryId(header({ "X-Shopify-Webhook-Id": "bad id with spaces" }), "x", "t", SHOP), /^sha:/);
});
