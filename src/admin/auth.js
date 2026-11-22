// Who is calling the admin API. The store owner's dashboard runs inside Shopify admin, which gives it
// a short-lived session token signed with the app secret. We verify that signature and claims
// ourselves; the store comes ONLY from the verified token, never from the URL or the body.
import crypto from "node:crypto";
import { isActiveStore, normalizeShopDomain } from "../services/storeIntegrationService.js";
import { verifyConsoleToken } from "./consoleAuth.js";

const CLOCK_SKEW_S = 10;
const MYSHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const appSecret = () => process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "";
const appKey = () => process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || "";

function decode(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Verifies a Shopify session token (HS256 JWT).
 * @returns {{ shop: string, userId: string }} for a valid token
 * @throws Error("invalid_token") for anything else (the reason is never sent to the caller)
 */
export function verifySessionToken(token, { now = Date.now(), secret = appSecret(), key = appKey() } = {}) {
  const fail = () => { throw new Error("invalid_token"); };
  if (typeof token !== "string" || token.length > 4096 || !secret || !key) fail();
  const parts = token.split(".");
  if (parts.length !== 3) fail();
  let header, payload;
  try {
    header = decode(parts[0]);
    payload = decode(parts[1]);
  } catch {
    return fail();
  }
  // only HS256 is accepted ("none" or any other algorithm must never pass)
  if (header?.alg !== "HS256") fail();
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let given;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return fail();
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) fail();

  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) fail();
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) fail();
  if (payload.aud !== key) fail();

  const shop = normalizeShopDomain(hostOf(payload.dest));
  if (!MYSHOPIFY.test(shop) || hostOf(payload.iss) !== shop) fail();
  return { shop, userId: String(payload.sub || "").slice(0, 60) };
}

/**
 * Express middleware: a valid token for an installed store, or 401. On success `req.shop` is the
 * store and `req.adminUser` the Shopify user who is signed in.
 */
export function requireAdmin({ verify = verifySessionToken, active = isActiveStore, verifyConsole = verifyConsoleToken } = {}) {
  return async (req, res, next) => {
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.get?.("Authorization") || req.headers?.authorization || "");
      if (!match) return res.status(401).json({ error: "Sign in again." });
      let shop;
      let userId;
      let consoleOnly = false;
      try {
        ({ shop, userId } = verify(match[1]));
      } catch (error) {
        // the call window has no Shopify session token: it carries the console token its ticket was swapped for
        const known = verifyConsole(match[1]);
        if (!known) throw error;
        ({ shop, userId } = known);
        consoleOnly = true;
      }
      let installed;
      try {
        installed = await active(shop);
      } catch {
        return res.status(503).json({ error: "Temporarily unavailable. Try again." });
      }
      if (!installed) return res.status(401).json({ error: "This store is not connected." });
      req.shop = shop;
      req.adminUser = userId;
      req.consoleOnly = consoleOnly;
      return next();
    } catch {
      return res.status(401).json({ error: "Sign in again." });
    }
  };
}