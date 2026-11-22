// Rate limits: a shopper is counted by what they cannot invent (signed customer id, or their network),
// never by the browser's clientId; every store also has its own ceiling; and the counters are shared
// between server instances through the database.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createChatRateLimiter, createShopBudget, visitorKey, ipBucket, envCount } from "../src/http/hardening.js";
import { createSharedRateLimitStore } from "../src/http/rateLimitStore.js";

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// An app shaped like the App Proxy: the shop and the signed customer id are set before the limits run.
function proxyApp(...limits) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.verifiedShop = req.get("x-test-shop") || "a.myshopify.com";
    req.proxyCustomerId = req.get("x-test-customer") || "";
    next();
  });
  app.post("/chat", ...limits, (req, res) => res.json({ ok: true }));
  return app;
}

const sender = (url) => ({ ip = "203.0.113.7", shop, customer, clientId = "" } = {}) =>
  fetch(`${url}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(shop ? { "x-test-shop": shop } : {}), ...(customer ? { "x-test-customer": customer } : {}) },
    body: JSON.stringify({ clientId }),
  });

// a store for tests that never touches a database
const memory = (prefix) => createSharedRateLimitStore({ prefix, connected: () => false });

test("a new clientId on every request does not get around the per-shopper limit", async () => {
  const srv = await listen(proxyApp(createChatRateLimiter({ limit: 2, store: memory("t1:") })));
  const send = sender(srv.url);
  try {
    assert.equal((await send({ clientId: "aaaaaaaaaaaaaaaa1" })).status, 200);
    assert.equal((await send({ clientId: "aaaaaaaaaaaaaaaa2" })).status, 200);
    const limited = await send({ clientId: "aaaaaaaaaaaaaaaa3" });
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.code, "rate_limited");
    assert.ok(body.retryAfterSeconds >= 1);
    assert.equal((await send({ ip: "198.51.100.9" })).status, 200, "a shopper on another network is not affected");
    assert.equal((await send({ shop: "b.myshopify.com" })).status, 200, "the same network in another store is counted apart");
  } finally {
    await srv.close();
  }
});

test("a signed-in shopper is counted by their customer id, so people sharing one network are not blocked by each other", async () => {
  const srv = await listen(proxyApp(createChatRateLimiter({ limit: 1, store: memory("t2:") })));
  const send = sender(srv.url);
  try {
    assert.equal((await send({ customer: "111" })).status, 200);
    assert.equal((await send({ customer: "111" })).status, 429);
    assert.equal((await send({ customer: "222" })).status, 200, "another signed-in shopper on the same network");
    assert.equal((await send({ customer: "111", ip: "198.51.100.1" })).status, 429, "a new network does not reset a signed-in shopper");
  } finally {
    await srv.close();
  }
});

test("the store's own ceiling holds however many networks the requests come from", async () => {
  const warnings = [];
  const budget = createShopBudget({ perMinute: 3, perDay: 0, storeFor: (w) => memory(`t3:${w}:`), log: { warn: (m) => warnings.push(m) } });
  const srv = await listen(proxyApp(createChatRateLimiter({ limit: 100, store: memory("t3v:") }), ...budget));
  const send = sender(srv.url);
  try {
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) assert.equal((await send({ ip })).status, 200);
    const busy = await send({ ip: "10.0.0.4" });
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).code, "store_busy");
    assert.match(warnings[0], /a\.myshopify\.com reached its ai limit of 3 per minute/);
    assert.equal((await send({ shop: "b.myshopify.com" })).status, 200, "another store has its own ceiling");
  } finally {
    await srv.close();
  }
});

test("the daily ceiling is separate from the per-minute one, and 0 turns a ceiling off", async () => {
  assert.equal(createShopBudget({ perMinute: 0, perDay: 0 }).length, 0);
  assert.equal(createShopBudget({ perMinute: 5, perDay: 0, storeFor: () => memory("x:") }).length, 1);
  const budget = createShopBudget({ perMinute: 100, perDay: 2, storeFor: (w) => memory(`t4:${w}:`) });
  const srv = await listen(proxyApp(...budget));
  const send = sender(srv.url);
  try {
    assert.equal((await send({ ip: "10.0.0.1" })).status, 200);
    assert.equal((await send({ ip: "10.0.0.2" })).status, 200);
    assert.equal((await send({ ip: "10.0.0.3" })).status, 429);
  } finally {
    await srv.close();
  }
});

test("one budget on several routes is one shared count", async () => {
  const budget = createShopBudget({ perMinute: 2, perDay: 0, storeFor: (w) => memory(`t5:${w}:`) });
  const app = express();
  app.use((req, _res, next) => { req.verifiedShop = "a.myshopify.com"; next(); });
  app.post("/chat", ...budget, (req, res) => res.json({ ok: true }));
  app.post("/greeting", ...budget, (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    assert.equal((await fetch(`${srv.url}/chat`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${srv.url}/greeting`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${srv.url}/chat`, { method: "POST" })).status, 429);
  } finally {
    await srv.close();
  }
});

test("visitor key: never the clientId; the signed customer id, else the network", () => {
  assert.equal(visitorKey({ verifiedShop: "A.myshopify.com", ip: "1.2.3.4", body: { clientId: "abc" } }), "a.myshopify.com|net:1.2.3.4");
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "1.2.3.4", proxyCustomerId: "987" }), "a.myshopify.com|customer:987");
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "1.2.3.4", uploadCustomerId: "55" }), "a.myshopify.com|customer:55");
  assert.equal(visitorKey({ ip: "1.2.3.4", body: { storeDomain: "evil.myshopify.com" } }), "unverified|net:1.2.3.4", "an unsigned shop name in the body is ignored");
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "1.2.3.4", proxyCustomerId: "not-a-number" }), "a.myshopify.com|net:1.2.3.4");
});

test("an IPv6 shopper is counted by their /64, so changing the last part of the address does not help", () => {
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:0db8:0001:0002:ffff:0:0:9"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(ipBucket("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(ipBucket("203.0.113.5"), "203.0.113.5");
  assert.equal(ipBucket(""), "unknown");
});

test("limits come from the environment; empty or invalid values keep the default and 0 is allowed", () => {
  assert.equal(envCount("X", 10, {}), 10);
  assert.equal(envCount("X", 10, { X: "" }), 10);
  assert.equal(envCount("X", 10, { X: "abc" }), 10);
  assert.equal(envCount("X", 10, { X: "-4" }), 10);
  assert.equal(envCount("X", 10, { X: "0" }), 0);
  assert.equal(envCount("X", 10, { X: "250" }), 250);
});

// ---- the shared store ---------------------------------------------------------------------------------
function fakeCollection() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async findOneAndUpdate(filter, update) {
      calls.push(["inc", filter._id]);
      const row = rows.get(filter._id) || { _id: filter._id, hits: 0, ...update.$setOnInsert };
      row.hits += update.$inc.hits;
      rows.set(filter._id, row);
      return { ...row };
    },
    async updateOne(filter, update) {
      const row = rows.get(filter._id);
      if (row && row.hits > 0) row.hits += update.$inc.hits;
    },
    async deleteOne(filter) {
      rows.delete(filter._id);
    },
  };
}

test("two server instances share one count through the database, so a second instance is not a second allowance", async () => {
  const Model = fakeCollection();
  const at = () => 1_700_000_030_000;
  const one = createSharedRateLimitStore({ prefix: "visitor:chat:", Model, connected: () => true, now: at });
  const two = createSharedRateLimitStore({ prefix: "visitor:chat:", Model, connected: () => true, now: at });
  one.init({ windowMs: 60_000 });
  two.init({ windowMs: 60_000 });
  assert.equal((await one.increment("a.myshopify.com|net:1.2.3.4")).totalHits, 1);
  const second = await two.increment("a.myshopify.com|net:1.2.3.4");
  assert.equal(second.totalHits, 2);
  assert.equal(second.resetTime.getTime(), 1_700_000_040_000, "the window ends on its boundary");
  const [row] = Model.rows.values();
  assert.equal(row._id, "visitor:chat:a.myshopify.com|net:1.2.3.4@1699999980000");
  assert.equal(row.expiresAt.getTime(), 1_700_000_040_000, "the database drops the row when the window ends");
  await two.decrement("a.myshopify.com|net:1.2.3.4");
  assert.equal(row.hits, 1);
  await one.resetKey("a.myshopify.com|net:1.2.3.4");
  assert.equal(Model.rows.size, 0);
});

test("a new window starts a new count", async () => {
  const Model = fakeCollection();
  let t = 1_700_000_000_000;
  const store = createSharedRateLimitStore({ Model, connected: () => true, now: () => t });
  store.init({ windowMs: 60_000 });
  await store.increment("k");
  await store.increment("k");
  t += 60_000;
  assert.equal((await store.increment("k")).totalHits, 1);
});

test("two requests creating the same counter at once: the second still counts", async () => {
  const Model = fakeCollection();
  const real = Model.findOneAndUpdate.bind(Model);
  let first = true;
  Model.findOneAndUpdate = async (...a) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    return real(...a);
  };
  const store = createSharedRateLimitStore({ Model, connected: () => true });
  store.init({ windowMs: 60_000 });
  assert.equal((await store.increment("k")).totalHits, 1);
});

test("without the database the limit still holds, counted in this process, with one warning", async () => {
  const warnings = [];
  const broken = { findOneAndUpdate: async () => { throw new Error("connection reset"); } };
  const store = createSharedRateLimitStore({ Model: broken, connected: () => true, log: { warn: (m) => warnings.push(m) } });
  store.init({ windowMs: 60_000 });
  assert.equal((await store.increment("k")).totalHits, 1);
  assert.equal((await store.increment("k")).totalHits, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /counting in this process/);

  const offline = createSharedRateLimitStore({ Model: { findOneAndUpdate: () => assert.fail("not while disconnected") }, connected: () => false });
  offline.init({ windowMs: 60_000 });
  assert.equal((await offline.increment("k")).totalHits, 1);
  assert.equal((await offline.increment("k")).totalHits, 2);
});

test("on a direct route the shopper comes from the token, and a malformed one is ignored", () => {
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "9.9.9.9", tokenVisitor: "net:1.2.3.4" }), "a.myshopify.com|net:1.2.3.4");
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "9.9.9.9", tokenVisitor: "customer:77" }), "a.myshopify.com|customer:77");
  assert.equal(visitorKey({ verifiedShop: "a.myshopify.com", ip: "9.9.9.9", tokenVisitor: "anything|else" }), "a.myshopify.com|net:9.9.9.9");
});
