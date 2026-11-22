// Who may open the live-support socket, the call token, and the owner's support settings (no database needed).
import test from "node:test";
import assert from "node:assert/strict";
import { authorizeSupportUpgrade, SUPPORT_PROTOCOL } from "../src/services/supportWs.js";
import { createVoiceToken, verifyVoiceSessionToken, TOKEN_PURPOSES } from "../src/services/voiceTokenService.js";
import { validateSettingsPatch, mergeSettings } from "../src/admin/settings.js";
import { supportOn, liveSupportEnabled, audioCallEnabled, recordingAllowed } from "../src/services/bookingSettings.js";

process.env.SHOPIFY_CLIENT_SECRET = "unit-secret";
const CALL = "a1b2c3d4e5f60718293a4b5c";
const req = (...protocols) => ({ headers: { "sec-websocket-protocol": protocols.join(", ") } });
const guard = () => { const seen = new Set(); return { consume: async (jti) => (seen.has(jti) ? false : (seen.add(jti), true)) }; };

test("a shopper's call token is for support only and carries the one call it may join", () => {
  assert.ok(TOKEN_PURPOSES.includes("support"));
  const token = createVoiceToken("alpha.myshopify.com", { purpose: "support", ref: CALL });
  const claims = verifyVoiceSessionToken(token, { purpose: "support" });
  assert.equal(claims.shop, "alpha.myshopify.com");
  assert.equal(claims.ref, CALL);
  assert.equal(verifyVoiceSessionToken(token, { purpose: "voice" }), null, "a support token is not a voice token");
  assert.equal(verifyVoiceSessionToken(createVoiceToken("alpha.myshopify.com", { purpose: "voice", ref: CALL }), { purpose: "support" }), null, "a voice token is not a support token");
  assert.equal(createVoiceToken("alpha.myshopify.com", { purpose: "support", ref: "not-an-id" }) && verifyVoiceSessionToken(createVoiceToken("alpha.myshopify.com", { purpose: "support", ref: "not-an-id" }), { purpose: "support" }).ref, "", "a bad reference is dropped");
});

test("the socket needs the support protocol and a valid token", async () => {
  const g = guard();
  const customer = createVoiceToken("alpha.myshopify.com", { purpose: "support", ref: CALL });
  assert.equal(await authorizeSupportUpgrade(req(), { guard: g }), null);
  assert.equal(await authorizeSupportUpgrade(req(`orbi.token.${customer}`), { guard: g }), null, "the real protocol must be offered too");
  const ok = await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, `orbi.token.${customer}`), { guard: g });
  assert.deepEqual(ok, { role: "customer", shop: "alpha.myshopify.com", callId: CALL });
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, `orbi.token.${customer}`), { guard: g }), null, "a token opens a socket once");
});

test("a support token without a call, a voice token and garbage are refused", async () => {
  const g = guard();
  const noRef = createVoiceToken("alpha.myshopify.com", { purpose: "support" });
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, `orbi.token.${noRef}`), { guard: g }), null);
  const voice = createVoiceToken("alpha.myshopify.com", { purpose: "voice", ref: CALL });
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, `orbi.token.${voice}`), { guard: g }), null);
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, "orbi.token.not.a.token"), { guard: g }), null);
});

test("a team member's socket takes the store and user from the verified session token only", async () => {
  const verify = (token) => { if (token !== "good") throw new Error("invalid_token"); return { shop: "alpha.myshopify.com", userId: "42" }; };
  const active = async (shop) => shop === "alpha.myshopify.com";
  assert.deepEqual(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, "orbi.admin.good"), { verifyAdmin: verify, active }), { role: "admin", shop: "alpha.myshopify.com", userId: "42" });
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, "orbi.admin.bad"), { verifyAdmin: verify, active }), null);
  assert.equal(await authorizeSupportUpgrade(req(SUPPORT_PROTOCOL, "orbi.admin.good"), { verifyAdmin: verify, active: async () => false }), null, "a store that is not installed gets nothing");
});

test("the owner's live-help settings: all off by default, validated, and only booleans", () => {
  assert.equal(liveSupportEnabled({}), false);
  assert.equal(audioCallEnabled({}), false);
  assert.equal(recordingAllowed({}), false);
  assert.equal(supportOn({ support: { liveEnabled: true } }, "audioEnabled"), true, "audio is on once live help is on, unless switched off");
  assert.equal(recordingAllowed({ support: { liveEnabled: true } }), false, "recording needs the owner's explicit yes");
  assert.equal(recordingAllowed({ support: { liveEnabled: true, recordingEnabled: true } }), true);
  assert.equal(recordingAllowed({ support: { liveEnabled: true, audioEnabled: false, recordingEnabled: true } }), false, "no audio, no recording");
  assert.equal(audioCallEnabled({ support: { audioEnabled: true } }), false, "audio alone, with live help off, offers nothing");
  const good = validateSettingsPatch({ support: { liveEnabled: true, recordingEnabled: false } });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.value.support, { liveEnabled: true, recordingEnabled: false });
  assert.ok(validateSettingsPatch({ support: { liveEnabled: "yes" } }).errors.length);
  assert.ok(validateSettingsPatch({ support: { video: true } }).errors.length, "there is no video setting");
  const merged = mergeSettings({ support: { liveEnabled: true, audioEnabled: false } }, { support: { recordingEnabled: true } });
  assert.deepEqual(merged.settings.support, { liveEnabled: true, audioEnabled: false, recordingEnabled: true });
});
