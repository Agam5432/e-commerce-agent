import { DEFAULT_SCOPES } from "../config/shopifyScopes.js";
import { tokenReplayGuard } from "../services/tokenReplay.js";
import { Router } from "express";
import { requireAdmin, verifySessionToken } from "../admin/auth.js";
import cors from "cors";
import crypto from "node:crypto";
import StoreIntegration from "../models/StoreIntegration.js";
import {
  isValidMyshopifyDomain,
  markStoreUninstalled,
  normalizeShopDomain,
  registerOrUpdateStoreInstallation,
  syncShopifyStoreProfile,
} from "../services/storeIntegrationService.js";

const router = Router();

// Allow Shopify Admin UI Extensions (extensions.shopifycdn.com / admin.shopify.com) to call token-exchange & sync-profile
const oauthCors = cors({
  origin: true,
  credentials: false, // bearer tokens only: the OAuth cookie is read on top-level navigations, never on a cross-origin fetch
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "ngrok-skip-browser-warning",
    "X-Requested-With",
  ],
});

router.use(oauthCors);

function getClientId() {
  return process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
}

function getClientSecret() {
  return process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
}

function getBaseAppUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, "");
  }
  if (process.env.SHOPIFY_OAUTH_REDIRECT_URI) {
    try {
      const u = new URL(process.env.SHOPIFY_OAUTH_REDIRECT_URI);
      return `${u.protocol}//${u.host}`;
    } catch {
      // ignore
    }
  }
  if (req && typeof req.get === "function") {
    const host = req.get("x-forwarded-host") || req.get("host");
    const proto = req.get("x-forwarded-proto") || req.protocol || "https";
    if (host) return `${proto}://${host}`;
  }
  return undefined;
}

function getRedirectUri(req) {
  if (process.env.SHOPIFY_OAUTH_REDIRECT_URI) {
    return process.env.SHOPIFY_OAUTH_REDIRECT_URI;
  }
  const baseUrl = getBaseAppUrl(req);
  if (baseUrl) {
    return `${baseUrl}/api/shopify/oauth/callback`;
  }
  return undefined;
}

export function getWebhookCallbackUrl(req) {
  const baseUrl = getBaseAppUrl(req);
  if (baseUrl) {
    return `${baseUrl}/api/shopify/oauth/webhooks/app-uninstalled`;
  }
  return null;
}

const COOKIE_NAME = "shopify_oauth_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function isValidShopDomain(shop) {
  return isValidMyshopifyDomain(shop);
}

/**
 * Extract the shop domain from a Shopify OIDC Session Token (id_token) JWT payload `dest` claim.
 */
export function extractShopFromIdToken(idToken) {
  if (typeof idToken !== "string" || !idToken.includes(".")) return "";
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return "";
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    return normalizeShopDomain(payload?.dest || payload?.iss || "");
  } catch {
    return "";
  }
}


export function parseScopes(value) {
  return String(value || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function getEffectiveScopes() {
  const configured = parseScopes(process.env.SHOPIFY_SCOPES || DEFAULT_SCOPES);
  const essentialOrderScopes = [
    "read_orders",
    "write_orders",
    "read_draft_orders",
    "write_draft_orders",
    "read_discounts",
  ];
  for (const s of essentialOrderScopes) {
    if (!configured.includes(s)) configured.push(s);
  }
  return configured.join(",");
}

function hasScope(grantedScopes, requiredScope) {
  if (grantedScopes.includes(requiredScope)) return true;

  for (const prefix of ["unauthenticated_", ""]) {
    const readPrefix = `${prefix}read_`;

    if (requiredScope.startsWith(readPrefix)) {
      const resource = requiredScope.slice(readPrefix.length);
      return grantedScopes.includes(`${prefix}write_${resource}`);
    }
  }

  return false;
}

export function findMissingScopes(grantedScopes, requiredScopes) {
  return requiredScopes.filter((scope) => !hasScope(grantedScopes, scope));
}

export function verifyShopifyHmac(query) {
  const secret = getClientSecret();
  if (!secret) return false;

  const params = new URLSearchParams(query);
  const receivedHmac = params.get("hmac");

  if (!receivedHmac || !/^[a-f0-9]{64}$/i.test(receivedHmac)) {
    return false;
  }

  params.delete("hmac");
  params.delete("signature");

  const message = [...params.entries()]
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest();

  const received = Buffer.from(receivedHmac, "hex");

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

export function verifyShopifyWebhookHmac(rawBody, hmacHeader) {
  const secret = getClientSecret();
  if (!secret || !hmacHeader || typeof hmacHeader !== "string") {
    return false;
  }

  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === "string"
    ? Buffer.from(rawBody, "utf8")
    : rawBody && typeof rawBody === "object"
    ? Buffer.from(JSON.stringify(rawBody), "utf8")
    : Buffer.alloc(0);

  const expectedBase64 = crypto
    .createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("base64");

  const expectedBuf = Buffer.from(expectedBase64, "utf8");
  const receivedBuf = Buffer.from(hmacHeader.trim(), "utf8");

  return (
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}

/**
 * The OAuth `state`: a random nonce, the time, and an HMAC binding both to the shop. It is also set as
 * an HttpOnly cookie. Never signed with a made-up secret: without the app secret there is no install.
 */
export function createOAuthState(shop) {
  const secret = getClientSecret();
  if (!secret) throw new Error("Shopify OAuth configuration is incomplete (no client secret).");
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now().toString(36);
  const payload = `${nonce}.${ts}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${payload}.${String(shop || "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `${payload}.${sig}`;
}

/**
 * Checks the state Shopify sent back. It must be signed by us for this shop and not older than 10 minutes.
 * When the browser sent our state cookie, it must also be the very same value (this browser started this
 * install); only a browser that sent no cookie at all (cookie partitioning in the embedded admin) is
 * judged by the signature alone. Each state is accepted once (see consumeOAuthState).
 */
export function verifyOAuthState(shop, state, cookieState) {
  if (typeof state !== "string" || !state) return false;

  // a cookie from another install attempt means another browser flow: refuse
  if (typeof cookieState === "string" && cookieState) {
    if (cookieState.length !== state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) return false;
  }

  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts36, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-z]{1,12}$/.test(ts36) || !/^[0-9a-f]{32}$/.test(sig)) return false;

  const issuedAt = Number.parseInt(ts36, 36);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > STATE_MAX_AGE_MS) {
    return false;
  }

  const secret = getClientSecret();
  if (!secret) return false;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${nonce}.${ts36}.${String(shop || "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);

  return (
    sig.length === expectedSig.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
  );
}

/** Marks a verified state as used; false when it was used before (a replayed callback). */
export async function consumeOAuthState(state, guard = tokenReplayGuard()) {
  const [nonce, ts36] = String(state || "").split(".");
  if (!/^[0-9a-f]{32}$/.test(nonce || "") || !/^[0-9a-z]{1,12}$/.test(ts36 || "")) return false;
  const issuedAt = Number.parseInt(ts36, 36);
  return guard.consume(`oauth:${nonce}`, Math.floor((issuedAt + STATE_MAX_AGE_MS) / 1000));
}

function getCookie(req, name) {
  const cookieHeader = req.headers?.cookie || "";

  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;

    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function cookieOptions() {
  return [
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Max-Age=600",
  ].join("; ");
}

function clearStateCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`
  );
}

async function exchangeAuthCodeForTokens(shop, clientId, clientSecret, code) {
  const requestExpiring = process.env.SHOPIFY_REQUEST_EXPIRING_TOKENS === "true";

  const doExchange = async (includeExpiring) => {
    const params = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
    };
    if (includeExpiring) {
      params.expiring = "1";
    }

    return fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15000),
    });
  };

  let response = await doExchange(requestExpiring);
  if (!response.ok && requestExpiring) {
    // Fallback to standard offline token exchange if expiring offline tokens are not enabled on the app
    response = await doExchange(false);
  }
  return response;
}

/**
 * Exchange a Shopify Session Token (id_token from Shopify Managed Installation / App Home UI Extension)
 * for an offline access token and register/update the store in MongoDB.
 */
/**
 * Whether opening the app must swap the admin's session token for an offline token. Not on every load:
 * only when the store has no usable token, its token expires within the hour, it lacks a scope the app
 * now asks for, or it was last swapped more than TOKEN_EXCHANGE_REFRESH_HOURS ago (default 24, which also
 * repairs a token Shopify revoked without telling us).
 */
export async function needsOfflineToken(shop, { Model = StoreIntegration, now = Date.now, env = process.env } = {}) {
  const row = await Model.findOne({ platform: "shopify", storeDomain: shop, status: "active" })
    .select("+accessTokenEncrypted scopes accessTokenExpiresAt tokenExchangedAt")
    .lean();
  if (!row?.accessTokenEncrypted) return true;
  const t = now();
  if (row.accessTokenExpiresAt && new Date(row.accessTokenExpiresAt).getTime() < t + 60 * 60 * 1000) return true;
  if (findMissingScopes(row.scopes || [], parseScopes(getEffectiveScopes())).length) return true;
  const hours = Number(env.TOKEN_EXCHANGE_REFRESH_HOURS) > 0 ? Number(env.TOKEN_EXCHANGE_REFRESH_HOURS) : 24;
  return !row.tokenExchangedAt || t - new Date(row.tokenExchangedAt).getTime() > hours * 60 * 60 * 1000;
}

export async function exchangeSessionTokenForOfflineToken(
  shop,
  idToken,
  req = null,
  fallbackProfile = null
) {
  const normalizedShop =
    normalizeShopDomain(shop) || extractShopFromIdToken(idToken);
  const clientId = getClientId();
  const clientSecret = getClientSecret();

  if (!isValidShopDomain(normalizedShop)) {
    throw new Error("Invalid Shopify store domain.");
  }
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Shopify session id_token is required.");
  }
  if (!clientId || !clientSecret) {
    throw new Error("Shopify OAuth client credentials are not configured.");
  }
  // S6: the shop came from the request body or an unverified read of the token. Check the token's signature, audience
  // and expiry here and require it to belong to that same shop, before any call to Shopify or any database write.
  let tokenShop = "";
  try { tokenShop = verifySessionToken(idToken).shop; } catch { /* reported below */ }
  if (!tokenShop || tokenShop !== normalizedShop) {
    throw new Error("Shopify session id_token is not valid for this store.");
  }

  const doExchange = (expiring) => {
    const params = {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type:
        "urn:shopify:params:oauth:token-type:offline-access-token",
    };
    // Expiring offline tokens come with a refresh token + expiry dates.
    if (expiring) params.expiring = "1";
    return fetch(`https://${normalizedShop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15000),
    });
  };

  let response = await doExchange(true);
  if (!response.ok) {
    // Fall back to a standard non-expiring offline token if expiring tokens are not enabled.
    response = await doExchange(false);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Shopify token exchange failed (${response.status}): ${errText.slice(0, 200)}`
    );
  }

  const tokenData = await response.json();
  if (!tokenData?.access_token) {
    throw new Error("Shopify token exchange did not return an access_token.");
  }

  const scopes = parseScopes(tokenData.scope || getEffectiveScopes());
  const record = await registerOrUpdateStoreInstallation({
    storeDomain: normalizedShop,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || null,
    expiresIn: tokenData.expires_in || null,
    refreshTokenExpiresIn: tokenData.refresh_token_expires_in || null,
    scopes,
    webhookCallbackUrl: getWebhookCallbackUrl(req),
    syncProfile: true,
    fallbackProfile,
    prewarm: true,
  });

  return record;
}

router.get("/install", (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const redirectUri = getRedirectUri(req);

  if (!isValidShopDomain(shop)) {
    return res.status(400).send("Invalid Shopify store domain.");
  }

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).send("Shopify OAuth configuration is incomplete.");
  }

  const state = createOAuthState(shop);
  const scopes = getEffectiveScopes();

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${state}; ${cookieOptions()}`
  );

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  const targetUrl = authorizeUrl.toString();

  // If called from an embedded iframe, break out to top window so Shopify Admin doesn't block framing
  if (
    req.query.embedded === "1" ||
    req.headers["sec-fetch-dest"] === "iframe"
  ) {
    return res
      .status(200)
      .type("html")
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting to Shopify...</title></head><body><script>window.top.location.href = ${JSON.stringify(
          targetUrl
        )};</script><p>Redirecting to <a href="${targetUrl}" target="_top">Shopify authorization</a>...</p></body></html>`
      );
  }

  return res.redirect(targetUrl);
});

router.get("/callback", async (req, res) => {
  try {
    const shop = normalizeShopDomain(req.query.shop);
    const code = req.query.code;
    const state = req.query.state;
    const savedState = getCookie(req, COOKIE_NAME);
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    const redirectUri = getRedirectUri(req);

    if (!isValidShopDomain(shop)) {
      clearStateCookie(res);
      return res.status(400).send("Invalid Shopify store domain.");
    }

    if (!verifyShopifyHmac(req.query)) {
      clearStateCookie(res);
      return res.status(400).send("Shopify callback verification failed.");
    }

    if (!verifyOAuthState(shop, state, savedState) || !(await consumeOAuthState(state))) {
      clearStateCookie(res);
      return res.status(403).send("OAuth state validation failed.");
    }

    clearStateCookie(res);

    if (
      typeof code !== "string" ||
      !code ||
      !clientId ||
      !clientSecret ||
      !redirectUri
    ) {
      return res.status(400).send("OAuth configuration or code is missing.");
    }

    const tokenResponse = await exchangeAuthCodeForTokens(
      shop,
      clientId,
      clientSecret,
      code
    );

    if (!tokenResponse.ok) {
      console.error("Shopify token exchange failed:", tokenResponse.status);
      return res.status(502).send("Could not complete Shopify authorization.");
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token || !tokenData.scope) {
      return res
        .status(502)
        .send("Shopify returned an incomplete token response.");
    }

    const scopes = parseScopes(tokenData.scope);
    const baseRequired = parseScopes(
      "read_products,read_inventory,read_locations,read_orders"
    );
    const missingScopes = findMissingScopes(scopes, baseRequired);

    if (missingScopes.length > 0) {
      console.error("Shopify OAuth: missing required scopes:", missingScopes);
      console.error("Shopify OAuth: granted scopes:", scopes);

      return res
        .status(403)
        .send(
          "The store did not grant all required permissions. Please reinstall and approve them."
        );
    }

    await registerOrUpdateStoreInstallation({
      storeDomain: shop,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresIn: tokenData.expires_in || null,
      refreshTokenExpiresIn: tokenData.refresh_token_expires_in || null,
      scopes,
      webhookCallbackUrl: getWebhookCallbackUrl(req),
      syncProfile: true,
      prewarm: true,
    });

    console.log(`[Shopify OAuth] Store registered & synced: ${shop}`);

    return res
      .status(200)
      .send(
        "Shopify store connected successfully with Order Creation permissions and store profile synced. You can close this page."
      );
  } catch (error) {
    console.error("Shopify OAuth error:", error.message);
    return res.status(500).send("Shopify installation could not be completed.");
  }
});

/**
 * Token exchange endpoint for Shopify Managed Installation / embedded App Home UI Extension.
 */
router.post("/token-exchange", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const idToken = String(
      req.body?.idToken || req.body?.id_token || bearerToken || ""
    ).trim();
    const shop =
      normalizeShopDomain(
        req.body?.shop ||
          req.query?.shop ||
          req.body?.shopProfile?.myshopifyDomain
      ) || extractShopFromIdToken(idToken);

    if (!isValidShopDomain(shop) || !idToken) {
      return res.status(400).json({
        error: "Valid shop domain and Shopify session id_token are required.",
      });
    }

    const record = await exchangeSessionTokenForOfflineToken(
      shop,
      idToken,
      req,
      req.body?.shopProfile || null
    );

    console.log(
      `[Shopify Token Exchange] Store auto-registered & synced: ${record.storeDomain} (${record.shopName || "active"})`
    );

    return res.json({
      success: true,
      shop: record.storeDomain,
      status: record.status,
      shopName: record.shopName || record.storeProfile?.name || null,
      currencyCode: record.currencyCode || record.storeProfile?.currencyCode || null,
      primaryDomain: record.primaryDomain || null,
      storeProfile: record.storeProfile || null,
    });
  } catch (error) {
    console.error("[Shopify token-exchange error]:", error.message);
    if (/not valid for this store/.test(error.message)) return res.status(401).json({ error: "Invalid Shopify session token." });
    return res.status(502).json({
      error: "Could not complete Shopify token exchange.",
    });
  }
});

/**
 * Trigger a fresh storeProfile sync for an active connected store.
 */
router.post("/sync-profile", requireAdmin(), async (req, res) => {
  try {
    // the signed-in store only: a shop name sent by the caller is never trusted
    const shop = normalizeShopDomain(req.shop);
    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ error: "Invalid Shopify store domain." });
    }

    const existing = await StoreIntegration.findOne({
      platform: "shopify",
      storeDomain: shop,
      status: "active",
    });

    if (!existing) {
      return res.status(404).json({
        error: "Store is not connected or inactive.",
      });
    }

    const updated = await syncShopifyStoreProfile(shop);
    return res.json({
      success: true,
      shop: updated.storeDomain,
      status: updated.status,
      shopName: updated.shopName,
      shopEmail: updated.shopEmail,
      primaryDomain: updated.primaryDomain,
      currencyCode: updated.currencyCode,
      countryCode: updated.countryCode,
      timezone: updated.timezone,
      planName: updated.planName,
      storeProfile: updated.storeProfile,
      lastSyncedAt: updated.lastSyncedAt,
    });
  } catch (error) {
    console.error("[Shopify sync-profile error]:", error.message);
    return res.status(502).json({
      error: "Failed to sync store profile from Shopify.",
    });
  }
});

/**
 * Check store connection status and synced profile summary.
 */
router.get("/status", requireAdmin(), async (req, res) => {
  try {
    const shop = normalizeShopDomain(req.shop);
    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ error: "Invalid Shopify store domain." });
    }

    const record = await StoreIntegration.findOne({
      platform: "shopify",
      storeDomain: shop,
    }).lean();

    if (!record) {
      return res.json({
        connected: false,
        shop,
        status: "not_installed",
        installUrl: `/api/shopify/oauth/install?shop=${encodeURIComponent(shop)}`,
      });
    }

    return res.json({
      connected: record.status === "active",
      shop: record.storeDomain,
      status: record.status,
      shopName: record.shopName || record.storeProfile?.name || null,
      primaryDomain: record.primaryDomain || null,
      currencyCode: record.currencyCode || record.storeProfile?.currencyCode || null,
      countryCode: record.countryCode || null,
      timezone: record.timezone || null,
      planName: record.planName || null,
      installedAt: record.installedAt || null,
      uninstalledAt: record.uninstalledAt || null,
      lastSyncedAt: record.lastSyncedAt || null,
      storeProfile: record.storeProfile || null,
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not check store status." });
  }
});

/**
 * Shopify app/uninstalled webhook handler.
 * Verifies X-Shopify-Hmac-Sha256 and sets StoreIntegration status to "uninstalled".
 */
export async function handleAppUninstalledWebhook(req, res) {
  try {
    const hmacHeader =
      req.get?.("X-Shopify-Hmac-Sha256") ||
      req.headers?.["x-shopify-hmac-sha256"];
    const rawBody = req.rawBody ?? req.body;

    if (!verifyShopifyWebhookHmac(rawBody, hmacHeader)) {
      console.warn("[Shopify Webhook] Invalid HMAC on app/uninstalled webhook");
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const headerShop =
      req.get?.("X-Shopify-Shop-Domain") ||
      req.headers?.["x-shopify-shop-domain"];
    const bodyShop =
      req.body?.myshopify_domain || req.body?.domain || req.body?.shop;
    const shop = normalizeShopDomain(headerShop || bodyShop);

    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ error: "Invalid shop domain in webhook." });
    }

    const triggeredAt = req.get?.("X-Shopify-Triggered-At") || req.headers?.["x-shopify-triggered-at"] || null;
    const updated = await markStoreUninstalled(shop, { reason: "app_uninstalled_webhook", triggeredAt });
    if (!updated) {
      // no such store, or it was installed again after this uninstall happened: nothing to switch off, and no retry wanted
      console.log(`[Shopify Webhook] Uninstall ignored (no install older than it): ${shop}`);
      return res.status(200).json({ success: true, shop, status: "ignored" });
    }
    console.log(`[Shopify Webhook] Store marked as uninstalled: ${shop}`);

    return res.status(200).json({ success: true, shop, status: "uninstalled" });
  } catch (error) {
    console.error("[Shopify Webhook] Error handling app/uninstalled:", error.message);
    return res.status(500).json({ error: "Webhook processing failed." });
  }
}

router.post("/webhooks/app-uninstalled", handleAppUninstalledWebhook);

export default router;