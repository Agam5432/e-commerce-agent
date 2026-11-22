import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceToken, verifyVoiceSessionToken, verifyVoiceToken } from "../src/services/voiceTokenService.js";
import { guestCustomer, verifiedCustomerGid, resolveClientId } from "../src/services/customerContext.js";

process.env.SHOPIFY_CLIENT_SECRET = "test-signing-secret";
test("voice token binds customer identity to the signed Shopify storefront", () => {
  const token = createVoiceToken("test.myshopify.com", { customerId: "1234" });
  const claims = verifyVoiceSessionToken(token);
  assert.deepEqual([claims.shop, claims.customerId, claims.purpose], ["test.myshopify.com", "1234", "voice"]);
  assert.equal(verifyVoiceToken(token), "test.myshopify.com");
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), customerId: "9999" })).toString("base64url");
  assert.equal(verifyVoiceSessionToken(`${forged}.${signature}`), null);
});
test("browser-provided customer IDs and saved addresses are not trusted", () => {
  assert.deepEqual(guestCustomer({ id: "gid://shopify/Customer/999", email: "guest@example.com", defaultAddress: { address1: "private" } }), { email: "guest@example.com" });
  assert.equal(verifiedCustomerGid("not-an-id"), null);
  assert.equal(verifiedCustomerGid("123"), "gid://shopify/Customer/123");
});
test("anonymous shoppers get separate sessions instead of sharing anon/voice state", () => {
  assert.notEqual(resolveClientId({ clientId: "anon" }), resolveClientId({ clientId: "anon" }));
  const a = resolveClientId({ shop: "test.myshopify.com", cartToken: "cart-a" });
  assert.equal(a, resolveClientId({ shop: "test.myshopify.com", cartToken: "cart-a" }));
  assert.notEqual(a, resolveClientId({ shop: "test.myshopify.com", cartToken: "cart-b" }));
});
