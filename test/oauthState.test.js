// OAuth install: the state is signed with the app secret only (no stand-in secret), tied to this
// browser when it sent our cookie, and accepted once. Opening the app swaps tokens only when needed.
import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthState, verifyOAuthState, consumeOAuthState, needsOfflineToken } from "../src/routes/shopifyOAuthRoutes.js";
import { createTokenReplayGuard } from "../src/services/tokenReplay.js";
import { readFileSync } from "node:fs";

const SHOP = "a-store.myshopify.com";

function withSecret(fn) {
  const saved = { a: process.env.SHOPIFY_CLIENT_SECRET, b: process.env.SHOPIFY_API_SECRET };
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      process.env.SHOPIFY_CLIENT_SECRET = saved.a ?? "";
      process.env.SHOPIFY_API_SECRET = saved.b ?? "";
    }
  };
}

test("no app secret, no state: there is no stand-in secret any more", withSecret(() => {
  process.env.SHOPIFY_CLIENT_SECRET = "";
  process.env.SHOPIFY_API_SECRET = "";
  assert.throws(() => createOAuthState(SHOP), /no client secret/);
  const source = readFileSync(new URL("../src/routes/shopifyOAuthRoutes.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fallback-state-secret/);
}));

test("the state is signed for one shop; the cookie, when sent, must be the same state", withSecret(() => {
  process.env.SHOPIFY_CLIENT_SECRET = "oauth-test-secret";
  const state = createOAuthState(SHOP);
  assert.equal(verifyOAuthState(SHOP, state, state), true, "this browser started this install");
  assert.equal(verifyOAuthState(SHOP, state, null), true, "no cookie at all (partitioned iframe): the signature decides");
  assert.equal(verifyOAuthState(SHOP, state, createOAuthState(SHOP)), false, "a cookie from another attempt");
  assert.equal(verifyOAuthState("other.myshopify.com", state, null), false, "signed for another shop");
  const [nonce, ts, sig] = state.split(".");
  assert.equal(verifyOAuthState(SHOP, `${nonce}.${ts}.${"0".repeat(32)}`, null), false, "a forged signature");
  assert.equal(verifyOAuthState(SHOP, `${nonce}.${(Date.now() - 11 * 60_000).toString(36)}.${sig}`, null), false, "too old");
}));

test("a state is accepted once: a replayed callback is refused", withSecret(async () => {
  process.env.SHOPIFY_CLIENT_SECRET = "oauth-test-secret";
  const guard = createTokenReplayGuard({ connected: () => false });
  const state = createOAuthState(SHOP);
  assert.equal(await consumeOAuthState(state, guard), true);
  assert.equal(await consumeOAuthState(state, guard), false);
  assert.equal(await consumeOAuthState(createOAuthState(SHOP), guard), true, "another install attempt is fine");
  assert.equal(await consumeOAuthState("garbage", guard), false);
}));

function storeRow(row) {
  return { findOne: () => ({ select: () => ({ lean: async () => row }) }) };
}

test("opening the app swaps tokens only when the stored one is missing, expiring, short of scopes or old", async () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const full = "read_products,read_inventory,read_locations,read_customers,write_customers,read_orders,write_orders,read_draft_orders,write_draft_orders,read_discounts,read_legal_policies".split(",");
  const saved = process.env.SHOPIFY_SCOPES;
  process.env.SHOPIFY_SCOPES = full.join(",");
  try {
    const good = { accessTokenEncrypted: "v2.x", scopes: full, accessTokenExpiresAt: null, tokenExchangedAt: new Date(now - 3_600_000) };
    const ask = (row, env = {}) => needsOfflineToken(SHOP, { Model: storeRow(row), now: () => now, env });
    assert.equal(await ask(good), false, "a good token: no swap on this load");
    assert.equal(await ask(null), true, "not installed");
    assert.equal(await ask({ ...good, accessTokenEncrypted: null }), true, "no token");
    assert.equal(await ask({ ...good, accessTokenExpiresAt: new Date(now + 10 * 60_000) }), true, "expires within the hour");
    assert.equal(await ask({ ...good, scopes: full.filter((s) => s !== "write_orders") }), true, "a scope the app now asks for is missing");
    assert.equal(await ask({ ...good, tokenExchangedAt: new Date(now - 25 * 3_600_000) }), true, "last swapped over a day ago");
    assert.equal(await ask({ ...good, tokenExchangedAt: null }), true, "never recorded");
    assert.equal(await ask({ ...good, tokenExchangedAt: new Date(now - 25 * 3_600_000) }, { TOKEN_EXCHANGE_REFRESH_HOURS: "48" }), false);
  } finally {
    process.env.SHOPIFY_SCOPES = saved ?? "";
  }
});
