// Storefront CORS: active stores' https domains only; localhost only outside production; a refused
// origin is not a server error; answers are cached briefly.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import { storefrontOriginCheck } from "../src/http/storefrontCors.js";

const ask = (check, origin) => new Promise((resolve, reject) => check(origin, (err, ok) => (err ? reject(err) : resolve(ok))));

test("an active store's https domain (myshopify or custom) is allowed; anything else is not", async () => {
  const active = new Set(["a.myshopify.com", "gada-electronics.in"]);
  const check = storefrontOriginCheck({ isActive: async (h) => active.has(h), env: { NODE_ENV: "production" } });
  assert.equal(await ask(check, "https://a.myshopify.com"), true);
  assert.equal(await ask(check, "https://GADA-electronics.in"), true);
  assert.equal(await ask(check, "http://a.myshopify.com"), false, "not https");
  assert.equal(await ask(check, "https://evil.example.com"), false);
  assert.equal(await ask(check, "https://user:pw@a.myshopify.com"), false);
  assert.equal(await ask(check, "not a url"), false);
  assert.equal(await ask(check, undefined), false);
});

test("localhost only outside production, unless explicitly allowed", async () => {
  const none = async () => false;
  assert.equal(await ask(storefrontOriginCheck({ isActive: none, env: { NODE_ENV: "production" } }), "http://localhost:3000"), false);
  assert.equal(await ask(storefrontOriginCheck({ isActive: none, env: { NODE_ENV: "development" } }), "http://localhost:3000"), true);
  assert.equal(await ask(storefrontOriginCheck({ isActive: none, env: { NODE_ENV: "production", CORS_ALLOW_LOCALHOST: "1" } }), "http://127.0.0.1:9000"), true);
});

test("answers are cached: allowed for a minute, refused for a few seconds, a lookup error is not cached", async () => {
  let t = 0;
  let calls = 0;
  let fail = true;
  const check = storefrontOriginCheck({ isActive: async (h) => { calls++; if (fail && h === "x.myshopify.com") throw new Error("db"); return h === "a.myshopify.com" || h === "x.myshopify.com"; }, now: () => t, env: { NODE_ENV: "production" } });
  await ask(check, "https://a.myshopify.com");
  await ask(check, "https://a.myshopify.com");
  assert.equal(calls, 1);
  t += 61_000;
  await ask(check, "https://a.myshopify.com");
  assert.equal(calls, 2);
  assert.equal(await ask(check, "https://x.myshopify.com"), false);
  fail = false;
  assert.equal(await ask(check, "https://x.myshopify.com"), true, "the error was not remembered");
});

test("a refused origin gets no CORS headers and no 500", async () => {
  const app = express();
  app.use(cors({ origin: storefrontOriginCheck({ isActive: async (h) => h === "a.myshopify.com", env: { NODE_ENV: "production" } }) }));
  app.get("/x", (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  try {
    const bad = await fetch(url, { headers: { origin: "https://evil.example.com" } });
    assert.equal(bad.status, 200, "not turned into a server error");
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
    const good = await fetch(url, { headers: { origin: "https://a.myshopify.com" } });
    assert.equal(good.headers.get("access-control-allow-origin"), "https://a.myshopify.com");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
