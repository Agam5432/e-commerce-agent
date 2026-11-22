import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient, withQuery } from "../../src/public/admin/api.js";

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, blob: async () => "blob" });
const make = (answer, calls = []) => createClient({
  getToken: async () => "session-token",
  fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof answer === "function" ? answer(url, init) : answer; },
});

test("withQuery keeps real values and drops empty ones", () => {
  assert.equal(withQuery("/x", { a: 1, b: "", c: undefined, d: null, e: "q r" }), "/x?a=1&e=q+r");
  assert.equal(withQuery("/x", {}), "/x");
  assert.equal(withQuery("/x"), "/x");
});

test("every call carries the session token, and nothing else says which store this is", async () => {
  const calls = [];
  const data = await make(reply(200, { ok: 1 }), calls).get("/overview", { from: "2026-10-01" });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls[0].url, "/admin/api/overview?from=2026-10-01");
  assert.equal(calls[0].init.headers.Authorization, "Bearer session-token");
  assert.equal(calls[0].init.body, undefined);
});

test("bodies are sent as JSON with the right verb", async () => {
  const calls = [];
  const client = make(reply(200, {}), calls);
  await client.put("/settings", { settings: { a: 1 } });
  await client.patch("/conversations/c1", { status: "resolved" });
  await client.post("/bookings/b1/confirm");
  await client.delete("/customers/p1");
  assert.deepEqual(calls.map((c) => c.init.method), ["PUT", "PATCH", "POST", "DELETE"]);
  assert.equal(calls[0].init.body, JSON.stringify({ settings: { a: 1 } }));
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[2].init.body, "{}");
  assert.equal(calls[3].init.body, undefined);
});

test("the server's own words reach the owner, with the status for the page to act on", async () => {
  await assert.rejects(make(reply(409, { error: "Someone else changed these." })).get("/settings"), (e) => e instanceof ApiError && e.status === 409 && e.message === "Someone else changed these.");
  await assert.rejects(make(reply(400, { errors: [{ message: "Name is too long." }] })).put("/settings", {}), /Name is too long\./);
  await assert.rejects(make(reply(500, null)).get("/x"), /Something went wrong/);
});

test("a dropped connection becomes a plain message, not a stack trace", async () => {
  const down = make(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(down.get("/x"), (e) => e instanceof ApiError && e.status === 0 && /Could not reach the server/.test(e.message));
  await assert.rejects(down.file("/attachments/a1"), /Could not reach the server/);
});

test("files are fetched with the token and come back as a blob", async () => {
  const calls = [];
  assert.equal(await make(reply(200, null), calls).file("/attachments/a1"), "blob");
  assert.equal(calls[0].init.headers.Authorization, "Bearer session-token");
  await assert.rejects(make(reply(404, null)).file("/attachments/a1"), /not available any more/);
});

test("outside Shopify admin there is no token, and the error says what to do", async () => {
  const before = globalThis.shopify;
  delete globalThis.shopify;
  try {
    await assert.rejects(createClient({ fetchImpl: async () => reply(200, {}) }).get("/me"), (e) => e.status === 401 && /Open this app from your Shopify admin/.test(e.message));
  } finally {
    if (before !== undefined) globalThis.shopify = before;
  }
});

test("a refused token is replaced once and the call repeated; a second refusal is reported", async () => {
  const tokens = [];
  let n = 0;
  const client = createClient({
    getToken: async () => `t${++n}`,
    fetchImpl: async (url, init) => { tokens.push(init.headers.Authorization); return tokens.length === 1 ? reply(401, { error: "expired" }) : reply(200, { ok: true }); },
  });
  assert.deepEqual(await client.get("/me"), { ok: true });
  assert.deepEqual(tokens, ["Bearer t1", "Bearer t2"]);

  const always = createClient({ getToken: async () => "x", fetchImpl: async () => reply(401, { error: "Sign in again." }) });
  await assert.rejects(always.get("/me"), (e) => e.status === 401 && e.message === "Sign in again.");
});

test("a call that never answers ends with a plain message instead of hanging", async () => {
  const hang = createClient({
    getToken: async () => "x",
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  await assert.rejects(hang.get("/slow"), (e) => e.status === 0 && /took too long/.test(e.message));
});

test("an order is asked for by its number only, whatever way it was written", async () => {
  const { getOrder, getPerformance } = await import("../../src/public/admin/api.js");
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.shopify = { idToken: async () => "t" };
  globalThis.fetch = async (url) => { urls.push(String(url)); return reply(200, {}); };
  try {
    await getOrder("#1042");
    await getOrder("../../settings");
    await getPerformance({ from: "2026-10-01", to: "2026-10-30" });
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.shopify;
  }
  assert.deepEqual(urls, ["/admin/api/orders/1042", "/admin/api/orders/", "/admin/api/performance?from=2026-10-01&to=2026-10-30"]);
});
