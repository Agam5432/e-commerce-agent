import crypto from "node:crypto";

// Short-lived token that proves "this browser session came from a verified Shopify storefront".
// Flow: widget -> Shopify App Proxy (signature verified) -> /proxy/voice-token -> token
//       widget -> wss://backend (token in the WebSocket subprotocol, never the URL) or POST /api/uploads
// Each token is for one purpose (a voice call or one upload), is used once (see tokenReplay.js), and
// carries who asked for it (signed customer id or network, as the App Proxy saw them) so limits on the
// direct routes count the same shopper the proxy did.

export const TOKEN_PURPOSES = ["voice", "upload", "support"];
const ttlSeconds = () => {
  const value = Number(process.env.VOICE_TOKEN_TTL_SECONDS);
  return Number.isFinite(value) && value >= 10 && value <= 600 ? Math.floor(value) : 120; // only needs to last until it is used
};
const VISITOR_PATTERN = /^(?:customer:\d{1,30}|net:[0-9a-f:./]{1,48})$/i;
const REF_PATTERN = /^[a-f0-9]{24}$/i;
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function signingKey() {
  const secret =
    process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

  if (!secret) {
    throw new Error(
      "SHOPIFY_CLIENT_SECRET (or SHOPIFY_API_SECRET) is not configured."
    );
  }

  // Derived key, so the raw app secret is never reused directly for a second purpose.
  return crypto.createHmac("sha256", secret).update("voice-ws-token-v1").digest();
}

function sign(payload) {
  return crypto
    .createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
}

export function createVoiceToken(shop, { customerId = null, purpose = "voice", visitor = "", ref = "" } = {}) {
  const normalized = String(shop || "").trim().toLowerCase();
  if (!SHOP_PATTERN.test(normalized)) {
    throw new Error("Invalid shop domain");
  }
  if (!TOKEN_PURPOSES.includes(purpose)) throw new Error("Invalid token purpose");

  const payload = Buffer.from(
    JSON.stringify({
      shop: normalized,
      customerId: /^\d+$/.test(String(customerId || "")) ? String(customerId) : null,
      pur: purpose,
      vk: VISITOR_PATTERN.test(String(visitor || "")) ? String(visitor) : "",
      // what the token is bound to (a support token: the one call it may join)
      ref: REF_PATTERN.test(String(ref || "")) ? String(ref) : "",
      jti: crypto.randomBytes(16).toString("base64url"),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds(),
    })
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

// The token's verified claims, or null for any invalid, expired or wrong-purpose token.
// It does NOT mark the token used: the caller does that with tokenReplay (consume).
export function verifyVoiceSessionToken(token, { purpose = "" } = {}) {
  if (typeof token !== "string" || token.length > 512) return null;

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payload, signature] = parts;

  try {
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return null;
    }

    const { shop, exp, customerId, pur, vk, jti, ref } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !SHOP_PATTERN.test(shop || "") ||
      !Number.isSafeInteger(exp) ||
      exp < Math.floor(Date.now() / 1000) ||
      !TOKEN_PURPOSES.includes(pur) ||
      (purpose && pur !== purpose) ||
      typeof jti !== "string" ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(jti)
    ) {
      return null;
    }

    return {
      shop,
      customerId: /^\d+$/.test(String(customerId || "")) ? String(customerId) : null,
      purpose: pur,
      visitor: VISITOR_PATTERN.test(String(vk || "")) ? String(vk) : "",
      ref: REF_PATTERN.test(String(ref || "")) ? String(ref) : "",
      jti,
      exp,
    };
  } catch {
    return null;
  }
}

export function verifyVoiceToken(token, options) {
  return verifyVoiceSessionToken(token, options)?.shop || null;
}
