import StoreIntegration from "../models/StoreIntegration.js";
import { decryptToken, encryptToken } from "../utils/tokenEncryption.js";
import { alert } from "../observability/alerts.js";

const REFRESH_SKEW_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

const inflightRefreshes = new Map();
const tokenCache = new Map(); // domain -> { token, expiresAt }

export function clearTokenCache(storeDomain) {
  if (storeDomain) {
    tokenCache.delete(String(storeDomain).trim().toLowerCase());
  } else {
    tokenCache.clear();
  }
}

export class ReauthorizationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

export class TransientTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransientTokenError";
  }
}

function loadIntegration(storeDomain) {
  return StoreIntegration.findOne({
    platform: "shopify",
    storeDomain,
    status: "active",
  }).select("+accessTokenEncrypted +refreshTokenEncrypted");
}

async function refreshAccessToken(storeDomain, integration) {
  if (!integration.refreshTokenEncrypted) {
    throw new ReauthorizationRequiredError(
      "No refresh token is stored for this shop. Reinstall the app."
    );
  }

  if (
    integration.refreshTokenExpiresAt &&
    integration.refreshTokenExpiresAt <= new Date()
  ) {
    throw new ReauthorizationRequiredError(
      "The Shopify refresh token has expired. Reinstall the app."
    );
  }

  const clientId =
    process.env.SHOPIFY_CLIENT_ID ||
    process.env.SHOPIFY_API_KEY ||
    "";

  const clientSecret =
    process.env.SHOPIFY_CLIENT_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    "";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Shopify OAuth credentials are missing from environment configuration."
    );
  }

  let decryptedRefreshToken;
  try {
    decryptedRefreshToken = decryptToken(integration.refreshTokenEncrypted);
  } catch (decryptErr) {
    console.error(
      `[Shopify token decrypt failed] Stored token for ${storeDomain} does not match SHOPIFY_TOKEN_ENCRYPTION_KEY. Reinstall via /api/shopify/oauth/install?shop=${storeDomain}`
    );
    throw new ReauthorizationRequiredError(
      `Stored Shopify token key mismatch for ${storeDomain}. Reinstall the app.`
    );
  }

  let response;

  try {
    response = await fetch(
      `https://${storeDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: decryptedRefreshToken,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    console.error("[Shopify token refresh fetch failed]", {
      storeDomain,
      name: error?.name,
      message: error?.message,
      cause: error?.cause?.message,
      causeCode: error?.cause?.code,
    });

    throw new TransientTokenError(
      "Could not reach Shopify to refresh the access token."
    );
  }

  if (response.status === 401) {
    throw new ReauthorizationRequiredError(
      "Shopify rejected the refresh token. Reinstall the app."
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new TransientTokenError(
      `Shopify token refresh is temporarily unavailable (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    console.error("[Shopify token refresh rejected]", {
      storeDomain,
      status: response.status,
    });

    throw new Error(
      `Shopify token refresh failed (HTTP ${response.status}).`
    );
  }

  const data = await response.json();

  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    throw new Error(
      "Shopify returned an incomplete refresh response."
    );
  }

  // Keep the fresh token in memory right away so the next requests do not wait on the database again.
  tokenCache.set(storeDomain, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });

  await StoreIntegration.updateOne(
    { _id: integration._id },
    {
      $set: {
        accessTokenEncrypted: encryptToken(data.access_token),
        refreshTokenEncrypted: encryptToken(data.refresh_token),
        // a refresh that worked proves the token is good: no swap needed on the next app load
        tokenExchangedAt: new Date(),
        accessTokenExpiresAt: new Date(
          Date.now() + data.expires_in * 1000
        ),
        reauthRequiredAt: null,
        reauthReason: null,
        refreshTokenExpiresAt: data.refresh_token_expires_in
          ? new Date(
              Date.now() + data.refresh_token_expires_in * 1000
            )
          : null,
      },
    }
  );

  return data.access_token;
}

export async function getValidAccessToken(
  storeDomain,
  { force = false } = {}
) {
  const domain = String(storeDomain || "")
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  if (!force) {
    const cached = tokenCache.get(domain);

    if (
      cached &&
      cached.expiresAt - Date.now() > REFRESH_SKEW_MS
    ) {
      return cached.token;
    }
  } else {
    tokenCache.delete(domain);
  }

  const integration = await loadIntegration(domain);

  if (!integration?.accessTokenEncrypted) {
    throw new Error(
      "No active Shopify integration found for this store"
    );
  }

  if (!integration.accessTokenExpiresAt && !force) {
    // Legacy non-expiring offline tokens remain usable until Shopify rejects
    // them. A missing expiry is not itself evidence that a token is invalid.
    const token = decryptToken(integration.accessTokenEncrypted);
    tokenCache.set(domain, { token, expiresAt: Infinity });
    return token;
  }

  const expiresSoon =
    (integration.accessTokenExpiresAt?.getTime() || 0) - Date.now() <
    REFRESH_SKEW_MS;

  if (!force && !expiresSoon) {
    try {
      const token = decryptToken(integration.accessTokenEncrypted);
      tokenCache.set(domain, {
        token,
        expiresAt: integration.accessTokenExpiresAt.getTime(),
      });
      return token;
    } catch {
      console.warn(
        `[Shopify token decrypt] Access token decrypt failed for ${domain}; attempting refresh.`
      );
    }
  }

  if (!inflightRefreshes.has(domain)) {
    const task = refreshAccessToken(domain, integration)
      .catch((error) => {
        if (error instanceof ReauthorizationRequiredError) markReauthRequired(domain, integration, error);
        throw error;
      })
      .finally(() => {
        inflightRefreshes.delete(domain);
      });

    inflightRefreshes.set(domain, task);
  }

  return inflightRefreshes.get(domain);
}

// The store's Shopify access is dead (refused or expired refresh token, key mismatch): until the owner opens the app again,
// every shopper of that store gets "a problem on our side". The operator is alerted once (alerts are de-duplicated) and the
// store is marked, so the admin dashboard can show it instead of the problem staying invisible in the logs.
export function markReauthRequired(domain, integration, error) {
  const reason = String(error?.message || error || "Shopify access was refused").slice(0, 300);
  console.error(`[Shopify token] ${domain} needs the app opened again / reinstalled: ${reason}`);
  alert(`shopify_reauth:${domain}`, `Shopify access for ${domain} stopped working: ${reason} The store owner must open the app in Shopify admin (or reinstall it) before the assistant can work for this store.`);
  if (integration?._id && !integration.reauthRequiredAt) {
    StoreIntegration.updateOne({ _id: integration._id }, { $set: { reauthRequiredAt: new Date(), reauthReason: reason } }).catch(() => {});
  }
}
