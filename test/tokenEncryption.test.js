// Stored Shopify tokens: each says which key encrypted it, old tokens stay readable while a key is
// rotated, and a rotation re-encrypts every store's token exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptToken, decryptToken, needsReencryption, keyIdOf, tokenKeys } from "../src/utils/tokenEncryption.js";
import { reencryptStoredTokens } from "../src/services/tokenRotation.js";
import { validateEnv } from "../src/config/env.js";

const key = () => crypto.randomBytes(32).toString("base64");
const OLD = key();
const NEW = key();

// how tokens were written before key ids existed
function legacyEncrypt(token, base64Key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
  const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

test("a new token names its key and reads back", () => {
  const env = { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW };
  const sealed = encryptToken("shpat_secret", env);
  const [v, id] = sealed.split(".");
  assert.equal(v, "v2");
  assert.equal(id, keyIdOf(Buffer.from(NEW, "base64")));
  assert.equal(decryptToken(sealed, env), "shpat_secret");
  assert.equal(needsReencryption(sealed, env), false);
  assert.notEqual(encryptToken("shpat_secret", env), sealed, "a fresh IV every time");
});

test("while rotating, tokens under the old key and in the old format are still read", () => {
  const rotating = { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_PREVIOUS_KEYS: ` ${OLD} ` };
  const underOld = encryptToken("old-v2", { SHOPIFY_TOKEN_ENCRYPTION_KEY: OLD });
  const legacy = legacyEncrypt("old-legacy", OLD);
  assert.equal(decryptToken(underOld, rotating), "old-v2");
  assert.equal(decryptToken(legacy, rotating), "old-legacy");
  assert.equal(decryptToken(legacyEncrypt("legacy-current", NEW), rotating), "legacy-current");
  assert.equal(needsReencryption(underOld, rotating), true);
  assert.equal(needsReencryption(legacy, rotating), true);
});

test("a token whose key was removed fails clearly; a tampered one fails", () => {
  const underOld = encryptToken("x", { SHOPIFY_TOKEN_ENCRYPTION_KEY: OLD });
  assert.throws(() => decryptToken(underOld, { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW }), /not configured.*TOKEN_ENCRYPTION_PREVIOUS_KEYS/);
  assert.throws(() => decryptToken(legacyEncrypt("x", OLD), { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW }), /any configured key/);
  const sealed = encryptToken("x", { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW }).split(".");
  sealed[4] = Buffer.from("tampered!").toString("base64");
  assert.throws(() => decryptToken(sealed.join("."), { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW }));
  assert.throws(() => tokenKeys({ SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_PREVIOUS_KEYS: "short" }), /32 random bytes/);
});

function fakeStores(rows) {
  const store = rows.map((r) => ({ ...r }));
  return {
    store,
    find() {
      return { select: () => ({ lean: async () => store.map((r) => ({ ...r })) }) };
    },
    async updateOne(guard, { $set }) {
      const row = store.find((r) => Object.entries(guard).every(([k, v]) => r[k] === v));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, $set);
      return { modifiedCount: 1 };
    },
  };
}

test("rotation re-encrypts every stored token once, and a dry run changes nothing", async () => {
  const env = { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_PREVIOUS_KEYS: OLD };
  const Model = fakeStores([
    { _id: 1, storeDomain: "a.myshopify.com", accessTokenEncrypted: legacyEncrypt("tok-a", OLD), refreshTokenEncrypted: encryptToken("ref-a", { SHOPIFY_TOKEN_ENCRYPTION_KEY: OLD }) },
    { _id: 2, storeDomain: "b.myshopify.com", accessTokenEncrypted: encryptToken("tok-b", env) },
    { _id: 3, storeDomain: "c.myshopify.com", accessTokenEncrypted: "garbage" },
  ]);
  const before = JSON.stringify(Model.store);
  const dry = await reencryptStoredTokens({ Model, env, dryRun: true });
  assert.equal(JSON.stringify(Model.store), before);
  assert.deepEqual([dry.reencrypted, dry.alreadyCurrent, dry.failed.length], [1, 1, 1]);

  const out = await reencryptStoredTokens({ Model, env });
  assert.deepEqual([out.stores, out.reencrypted, out.alreadyCurrent], [3, 1, 1]);
  assert.equal(out.failed[0].store, "c.myshopify.com");
  const onlyNew = { SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW };
  assert.equal(decryptToken(Model.store[0].accessTokenEncrypted, onlyNew), "tok-a", "readable without the old key now");
  assert.equal(decryptToken(Model.store[0].refreshTokenEncrypted, onlyNew), "ref-a");
  assert.equal((await reencryptStoredTokens({ Model, env })).reencrypted, 0, "running it again changes nothing");
});

test("start-up refuses two different keys under the two names, and a malformed previous key", () => {
  const base = { MONGODB_URI: "m", SHOPIFY_CLIENT_ID: "i", SHOPIFY_CLIENT_SECRET: "s", SHOPIFY_TOKEN_ENCRYPTION_KEY: NEW, GEMINI_API_KEY: "g" };
  assert.ok(validateEnv(base).ok);
  assert.ok(validateEnv({ ...base, TOKEN_ENCRYPTION_KEY: NEW }).ok, "the same key under both names is fine");
  assert.match(validateEnv({ ...base, TOKEN_ENCRYPTION_KEY: OLD }).errors.join(), /both set but differ/);
  assert.match(validateEnv({ ...base, TOKEN_ENCRYPTION_PREVIOUS_KEYS: `${OLD},nope` }).errors.join(), /entry 2/);
});
