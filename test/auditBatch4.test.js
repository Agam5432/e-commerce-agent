// Audit batch 4: S3 (guessable client id for signed-in shoppers) and S6 (token exchange trusted an unverified token).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "test-app-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "test-app-secret";
const { resolveClientId, CLIENT_ID_PATTERN } = await import("../src/services/customerContext.js");
const { exchangeSessionTokenForOfflineToken } = await import("../src/routes/shopifyOAuthRoutes.js");

const SHOP = "alpha.myshopify.com";
const GID = "gid://shopify/Customer/7001";

// S3: the id of a signed-in shopper without a browser id was sha256("shop:gid"). It is a valid client id, so anyone who
// knew the store and a customer number could send it and reach that customer's email-verified order lookup.
test("the client id of a signed-in shopper cannot be worked out from the store and customer number", () => {
  const derived = resolveClientId({ shop: SHOP, customerId: GID });
  const guess = crypto.createHash("sha256").update(`${SHOP}:${GID}`).digest("hex");
  assert.notEqual(derived, guess, "anyone can compute this id");
  assert.match(derived, CLIENT_ID_PATTERN);
  // still the same id every time for the same shopper (their chat and order lookup carry on)
  assert.equal(resolveClientId({ shop: SHOP, customerId: GID }), derived);
  // and a different one in another store
  assert.notEqual(resolveClientId({ shop: "beta.myshopify.com", customerId: GID }), derived);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sessionToken = (shop, { secret = process.env.SHOPIFY_API_SECRET, aud = process.env.SHOPIFY_API_KEY } = {}) => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: "1", exp: now + 60, nbf: now - 5, iat: now });
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
};

// S6: /token-exchange took the shop from the body and only decoded the token. Nothing was checked before a call to
// Shopify; a made-up token reached the exchange (and the database write after it, if Shopify ever said yes).
test("a token exchange with a forged, foreign or other-store token is refused before any call to Shopify", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("{}", { status: 400 }); };
  t.after(() => { globalThis.fetch = realFetch; });

  const forged = sessionToken(SHOP, { secret: "not-the-app-secret" });
  const otherApp = sessionToken(SHOP, { aud: "some-other-app" });
  const otherStore = sessionToken("beta.myshopify.com");
  for (const token of [forged, otherApp, otherStore, "a.b.c"]) {
    await assert.rejects(exchangeSessionTokenForOfflineToken(SHOP, token), /not valid for this store/);
  }
  assert.deepEqual(calls, [], "Shopify was called with a token that is not valid for this store");

  // a real token for this store still goes on to Shopify
  await assert.rejects(exchangeSessionTokenForOfflineToken(SHOP, sessionToken(SHOP)), /token exchange failed/);
  assert.ok(calls.length > 0 && calls.every((u) => u.startsWith(`https://${SHOP}/`)));
});
