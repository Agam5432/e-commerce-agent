// Shopify access and refresh tokens are stored encrypted (AES-256-GCM).
//
// Format: v2.<key id>.<iv>.<tag>.<ciphertext> (base64 parts). The key id is derived from the key itself
// (first 8 hex characters of its SHA-256), so no extra setting is needed and the right key is found
// directly. Tokens written before key ids existed (iv.tag.ciphertext) are still read.
//
// Rotating the key, without breaking any store:
//   1. new key in SHOPIFY_TOKEN_ENCRYPTION_KEY, the old one added to TOKEN_ENCRYPTION_PREVIOUS_KEYS
//      (comma separated). New tokens use the new key; old ones are still readable.
//   2. node scripts/rotate-token-key.mjs  (re-encrypts every stored token with the new key; --dry-run first)
//   3. remove the old key from TOKEN_ENCRYPTION_PREVIOUS_KEYS.
import crypto from "node:crypto";

const AAD = Buffer.from("orbi-shopify-token-v2");

function parseKey(base64, name) {
  const key = Buffer.from(String(base64 || "").trim(), "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded`);
  return key;
}

export const keyIdOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

/** The current key and the old ones still accepted for reading, from the environment. */
export function tokenKeys(env = process.env) {
  const primaryRaw = env.SHOPIFY_TOKEN_ENCRYPTION_KEY || env.TOKEN_ENCRYPTION_KEY;
  if (!primaryRaw) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY) is not configured");
  const primary = parseKey(primaryRaw, "SHOPIFY_TOKEN_ENCRYPTION_KEY");
  const previous = String(env.TOKEN_ENCRYPTION_PREVIOUS_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k, i) => parseKey(k, `TOKEN_ENCRYPTION_PREVIOUS_KEYS[${i}]`));
  const all = [primary, ...previous.filter((k) => !k.equals(primary))];
  return { primary, primaryId: keyIdOf(primary), all, byId: new Map(all.map((k) => [keyIdOf(k), k])) };
}

function open(key, iv, tag, encrypted, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function pieces(ivB64, tagB64, encB64) {
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error("Invalid encrypted Shopify token data");
  return { iv, tag, encrypted };
}

export function decryptToken(encryptedToken, env = process.env) {
  if (!encryptedToken || typeof encryptedToken !== "string") {
    throw new Error("Encrypted Shopify token is missing");
  }
  const keys = tokenKeys(env);
  const parts = encryptedToken.split(".");

  if (parts.length === 5 && parts[0] === "v2") {
    const key = keys.byId.get(parts[1]);
    if (!key) throw new Error(`Shopify token was encrypted with a key that is not configured (key id ${parts[1]}); add it to TOKEN_ENCRYPTION_PREVIOUS_KEYS`);
    const { iv, tag, encrypted } = pieces(parts[2], parts[3], parts[4]);
    return open(key, iv, tag, encrypted, AAD);
  }

  if (parts.length === 3) {
    // written before key ids: try the current key, then the old ones
    const { iv, tag, encrypted } = pieces(parts[0], parts[1], parts[2]);
    for (const key of keys.all) {
      try {
        return open(key, iv, tag, encrypted, null);
      } catch {
        /* not this key */
      }
    }
    throw new Error("Shopify token could not be decrypted with any configured key");
  }

  throw new Error("Invalid encrypted Shopify token format");
}

export function encryptToken(token, env = process.env) {
  if (!token || typeof token !== "string") {
    throw new Error("Shopify token to encrypt is missing");
  }
  const { primary, primaryId } = tokenKeys(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", primary, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v2", primaryId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

/** True when a stored token is not yet under the current key in the current format. */
export function needsReencryption(encryptedToken, env = process.env) {
  if (!encryptedToken || typeof encryptedToken !== "string") return false;
  const parts = encryptedToken.split(".");
  return !(parts.length === 5 && parts[0] === "v2" && parts[1] === tokenKeys(env).primaryId);
}
