// Voice and upload tokens: one purpose each, used once, never in a URL, and carrying the shopper the
// App Proxy saw. The handshake test uses a real WebSocket server and client.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createVoiceToken, verifyVoiceSessionToken } from "../src/services/voiceTokenService.js";
import { createTokenReplayGuard } from "../src/services/tokenReplay.js";
import { tokenFromUpgrade, authorizeVoiceUpgrade, voiceUpgradeOptions, chooseProtocol, VOICE_PROTOCOL } from "../src/voice/voiceAuth.js";

process.env.SHOPIFY_CLIENT_SECRET = "voice-auth-test-secret";
const SHOP = "a.myshopify.com";
const offline = () => createTokenReplayGuard({ connected: () => false });

test("a token names its purpose and the shopper; a token for one purpose fails for the other", () => {
  const voice = createVoiceToken(SHOP, { purpose: "voice", visitor: "net:203.0.113.7", customerId: "42" });
  const claims = verifyVoiceSessionToken(voice, { purpose: "voice" });
  assert.deepEqual([claims.shop, claims.purpose, claims.visitor, claims.customerId], [SHOP, "voice", "net:203.0.113.7", "42"]);
  assert.match(claims.jti, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(verifyVoiceSessionToken(voice, { purpose: "upload" }), null);
  assert.throws(() => createVoiceToken(SHOP, { purpose: "admin" }), /purpose/);
  assert.equal(verifyVoiceSessionToken(createVoiceToken(SHOP, { visitor: "x-forwarded-for: 1.1.1.1" })).visitor, "", "a malformed visitor is dropped");
  assert.notEqual(verifyVoiceSessionToken(createVoiceToken(SHOP)).jti, claims.jti, "every token has its own id");
});

test("a token from before this change (no purpose, no id) is refused", () => {
  // correctly signed with the real key, in the old shape
  const key = createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET).update("voice-ws-token-v1").digest();
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("base64url");
  const legacy = Buffer.from(JSON.stringify({ shop: SHOP, customerId: null, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  assert.equal(verifyVoiceSessionToken(`${legacy}.${sign(legacy)}`), null);
  const current = createVoiceToken(SHOP).split(".")[0];
  assert.ok(verifyVoiceSessionToken(`${current}.${sign(current)}`), "the same signing works for a current token");
});

test("each token id is accepted once; an expired one never", async () => {
  const guard = offline();
  const exp = Math.floor(Date.now() / 1000) + 60;
  assert.equal(await guard.consume("id-1", exp), true);
  assert.equal(await guard.consume("id-1", exp), false);
  assert.equal(await guard.consume("id-2", exp), true);
  assert.equal(await guard.consume("id-3", Math.floor(Date.now() / 1000) - 1), false);
  assert.equal(await guard.consume("", exp), false);
});

test("the use-once list is shared through the database, so a second instance refuses a replay", async () => {
  const rows = new Set();
  const Model = { create: async ({ _id }) => { if (rows.has(_id)) throw Object.assign(new Error("dup"), { code: 11000 }); rows.add(_id); } };
  const one = createTokenReplayGuard({ Model, connected: () => true });
  const two = createTokenReplayGuard({ Model, connected: () => true });
  const exp = Math.floor(Date.now() / 1000) + 60;
  assert.equal(await one.consume("shared", exp), true);
  assert.equal(await two.consume("shared", exp), false);
  const warnings = [];
  const broken = createTokenReplayGuard({ Model: { create: async () => { throw new Error("down"); } }, connected: () => true, log: { warn: (m) => warnings.push(m) } });
  assert.equal(await broken.consume("x", exp), true);
  assert.equal(await broken.consume("x", exp), false, "still single use on this instance");
  assert.equal(warnings.length, 1);
});

test("the token is read from the subprotocol; the URL only when explicitly allowed", () => {
  const req = (protocols, url = "/") => ({ url, headers: protocols ? { "sec-websocket-protocol": protocols } : {} });
  assert.deepEqual(tokenFromUpgrade(req(`${VOICE_PROTOCOL}, orbi.token.abc.def`), { allowUrlToken: false }), { token: "abc.def", via: "protocol" });
  assert.equal(tokenFromUpgrade(req("orbi.token.abc"), { allowUrlToken: false }), null, "the voice protocol must be offered too");
  assert.equal(tokenFromUpgrade(req(null, "/?token=abc"), { allowUrlToken: false }), null);
  assert.deepEqual(tokenFromUpgrade(req(null, "/?token=abc"), { allowUrlToken: true }), { token: "abc", via: "url" });
  assert.equal(chooseProtocol(new Set([VOICE_PROTOCOL, "orbi.token.secret"])), VOICE_PROTOCOL, "the server never echoes the token");
  assert.equal(chooseProtocol(new Set(["other"])), false);
});

test("an upload token cannot open a voice call, and a voice token works once", async () => {
  const guard = offline();
  const upgrade = (token) => ({ url: "/", headers: { "sec-websocket-protocol": `${VOICE_PROTOCOL}, orbi.token.${token}` } });
  assert.equal(await authorizeVoiceUpgrade(upgrade(createVoiceToken(SHOP, { purpose: "upload" })), { guard, allowUrlToken: false }), null);
  const voice = createVoiceToken(SHOP, { purpose: "voice" });
  assert.equal((await authorizeVoiceUpgrade(upgrade(voice), { guard, allowUrlToken: false }))?.shop, SHOP);
  assert.equal(await authorizeVoiceUpgrade(upgrade(voice), { guard, allowUrlToken: false }), null);
});

test("real handshake: subprotocol token connects once; a replay, a URL token and no token are refused", async () => {
  const server = createServer();
  const quiet = { log() {}, error() {} };
  const wss = new WebSocketServer({ server, ...voiceUpgradeOptions({ guard: offline(), allowUrlToken: false, log: quiet }) });
  const shops = [];
  wss.on("connection", (socket, request) => { shops.push(request.voiceClaims?.shop); socket.close(); });
  await new Promise((r) => server.listen(0, r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  const open = (url, protocols) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, protocols);
      ws.once("open", () => resolve({ ok: true, protocol: ws.protocol }));
      ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.once("error", () => resolve({ ok: false }));
    });
  try {
    const token = createVoiceToken(SHOP, { purpose: "voice" });
    const first = await open(`${base}/`, [VOICE_PROTOCOL, `orbi.token.${token}`]);
    assert.deepEqual(first, { ok: true, protocol: VOICE_PROTOCOL });
    assert.deepEqual(shops, [SHOP]);
    assert.equal((await open(`${base}/`, [VOICE_PROTOCOL, `orbi.token.${token}`])).status, 401, "replayed");
    assert.equal((await open(`${base}/?token=${encodeURIComponent(createVoiceToken(SHOP))}`)).status, 401, "token in the URL");
    assert.equal((await open(`${base}/`, [VOICE_PROTOCOL])).status, 401, "no token");
  } finally {
    wss.close();
    await new Promise((r) => server.close(r));
  }
});

test("a verified email lasts 1 day by default, and the store can change that", async () => {
  const { execFileSync } = await import("node:child_process");
  const days = (env) => Number(execFileSync(process.execPath, ["--input-type=module", "-e", "const m = await import('./src/services/orderLookupAuth.js'); console.log(m.VERIFIED_TTL_MS / 86400000);"], { env: { ...process.env, ...env }, cwd: new URL("..", import.meta.url) }).toString().trim());
  assert.equal(days({ ORDER_LOOKUP_VERIFIED_DAYS: "" }), 1);
  assert.equal(days({ ORDER_LOOKUP_VERIFIED_DAYS: "2" }), 2);
  assert.equal(days({ ORDER_LOOKUP_VERIFIED_DAYS: "nonsense" }), 1);
});
