import mongoose from "mongoose";
import StoreIntegration from "../models/StoreIntegration.js";
import { clearTokenCache, getValidAccessToken } from "./shopifyTokenService.js";
import { shopifyApiVersion } from "../config/env.js";
import { clearStoreProductCache, prewarmStore } from "../tools/shopifyService.js";
import { encryptToken } from "../utils/tokenEncryption.js";

const API_VERSION = shopifyApiVersion();
const FALLBACK_API_VERSIONS = Array.from(
  new Set([API_VERSION, "2025-01", "2024-10"])
);
const REQUEST_TIMEOUT_MS = 12000;
const backgroundSyncTimestamps = new Map();
const BACKGROUND_SYNC_COOLDOWN_MS = 60 * 1000;

export function normalizeShopDomain(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return new URL(raw).hostname.toLowerCase();
    }
  } catch {
    // ignore URL parse error and strip manually
  }
  return raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].trim();
}

export function isValidMyshopifyDomain(domain) {
  return (
    typeof domain === "string" &&
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
  );
}

export function isValidHostname(hostname) {
  return (
    typeof hostname === "string" &&
    hostname.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      hostname
    )
  );
}

// Primary GraphQL query using valid Shopify Admin API Shop fields
const SHOP_PROFILE_QUERY = `
  query FetchShopifyStoreProfile {
    shop {
      id
      name
      email
      contactEmail
      myshopifyDomain
      url
      primaryDomain {
        host
        url
        sslEnabled
      }
      currencyCode
      ianaTimezone
      timezoneOffset
      weightUnit
      plan {
        publicDisplayName
        partnerDevelopment
        shopifyPlus
      }
      billingAddress {
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
      }
    }
  }
`;

// Minimal GraphQL fallback query if any optional field is restricted/unsupported on a shop's API version
const SHOP_PROFILE_MINIMAL_QUERY = `
  query FetchShopifyStoreMinimalProfile {
    shop {
      id
      name
      email
      contactEmail
      myshopifyDomain
      url
      primaryDomain {
        host
        url
        sslEnabled
      }
      currencyCode
      ianaTimezone
      weightUnit
      billingAddress {
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
      }
    }
  }
`;

// Ultra-basic GraphQL fallback guaranteed to succeed on every Shopify Admin API version
const SHOP_PROFILE_CORE_QUERY = `
  query FetchShopifyStoreCoreProfile {
    shop {
      id
      name
      email
      contactEmail
      myshopifyDomain
      url
      primaryDomain {
        host
        url
      }
      currencyCode
      ianaTimezone
    }
  }
`;

export function normalizeGraphqlShopProfile(shopNode, fallbackDomain = "") {
  if (!shopNode || typeof shopNode !== "object") return null;

  const myshopifyDomain = normalizeShopDomain(
    shopNode.myshopifyDomain || fallbackDomain
  );
  const primaryHost = normalizeShopDomain(
    shopNode.primaryDomain?.host || shopNode.url || myshopifyDomain
  );
  const syncedAt = new Date();
  const planDisplayName =
    shopNode.plan?.publicDisplayName ||
    shopNode.plan?.displayName ||
    null;
  const tzAbbrev =
    shopNode.timezoneAbbreviation ||
    shopNode.timezoneOffset ||
    null;

  const storeProfile = {
    shopifyShopId: shopNode.id ? String(shopNode.id) : null,
    name: shopNode.name ? String(shopNode.name).trim() : null,
    email: shopNode.email ? String(shopNode.email).trim() : null,
    contactEmail: shopNode.contactEmail
      ? String(shopNode.contactEmail).trim()
      : shopNode.email
      ? String(shopNode.email).trim()
      : null,
    myshopifyDomain: myshopifyDomain || null,
    shopUrl:
      shopNode.url ||
      shopNode.primaryDomain?.url ||
      (myshopifyDomain ? `https://${myshopifyDomain}` : null),
    primaryDomain: {
      host: primaryHost || myshopifyDomain || null,
      url:
        shopNode.primaryDomain?.url ||
        shopNode.url ||
        (primaryHost ? `https://${primaryHost}` : null),
      sslEnabled:
        typeof shopNode.primaryDomain?.sslEnabled === "boolean"
          ? shopNode.primaryDomain.sslEnabled
          : true,
    },
    currencyCode: shopNode.currencyCode ? String(shopNode.currencyCode) : null,
    ianaTimezone: shopNode.ianaTimezone ? String(shopNode.ianaTimezone) : null,
    timezoneAbbreviation: tzAbbrev ? String(tzAbbrev) : null,
    weightUnit: shopNode.weightUnit ? String(shopNode.weightUnit) : null,
    plan: {
      displayName: planDisplayName ? String(planDisplayName) : null,
      partnerDevelopment: Boolean(shopNode.plan?.partnerDevelopment),
      shopifyPlus: Boolean(shopNode.plan?.shopifyPlus),
    },
    billingAddress: {
      address1: shopNode.billingAddress?.address1 || null,
      address2: shopNode.billingAddress?.address2 || null,
      city: shopNode.billingAddress?.city || null,
      province: shopNode.billingAddress?.province || null,
      provinceCode: shopNode.billingAddress?.provinceCode || null,
      country: shopNode.billingAddress?.country || null,
      countryCode:
        shopNode.billingAddress?.countryCodeV2 ||
        shopNode.billingAddress?.countryCode ||
        null,
      zip: shopNode.billingAddress?.zip || null,
      phone: shopNode.billingAddress?.phone || null,
    },
    syncedAt,
  };

  const topLevelFields = {
    shopId: storeProfile.shopifyShopId,
    shopName: storeProfile.name,
    shopEmail: storeProfile.email,
    contactEmail: storeProfile.contactEmail,
    primaryDomain: storeProfile.primaryDomain.host,
    currencyCode: storeProfile.currencyCode,
    countryCode: storeProfile.billingAddress.countryCode,
    timezone: storeProfile.ianaTimezone,
    planName: storeProfile.plan.displayName,
    lastSyncedAt: syncedAt,
  };

  return { storeProfile, topLevelFields };
}

export function normalizeRestShopProfile(restShop, fallbackDomain = "") {
  if (!restShop || typeof restShop !== "object") return null;

  const myshopifyDomain = normalizeShopDomain(
    restShop.myshopify_domain || fallbackDomain
  );
  const primaryHost = normalizeShopDomain(restShop.domain || myshopifyDomain);
  const syncedAt = new Date();

  const storeProfile = {
    shopifyShopId: restShop.id ? `gid://shopify/Shop/${restShop.id}` : null,
    name: restShop.name ? String(restShop.name).trim() : null,
    email: restShop.email ? String(restShop.email).trim() : null,
    contactEmail: restShop.customer_email || restShop.email || null,
    myshopifyDomain: myshopifyDomain || null,
    shopUrl: primaryHost ? `https://${primaryHost}` : null,
    primaryDomain: {
      host: primaryHost || myshopifyDomain || null,
      url: primaryHost ? `https://${primaryHost}` : null,
      sslEnabled: true,
    },
    currencyCode: restShop.currency || null,
    ianaTimezone: restShop.iana_timezone || null,
    timezoneAbbreviation: restShop.timezone || null,
    weightUnit: restShop.weight_unit || null,
    plan: {
      displayName: restShop.plan_display_name || restShop.plan_name || null,
      partnerDevelopment:
        restShop.plan_name === "affiliate" ||
        restShop.plan_name === "partner_test",
      shopifyPlus: restShop.plan_name === "shopify_plus",
    },
    billingAddress: {
      address1: restShop.address1 || null,
      address2: restShop.address2 || null,
      city: restShop.city || null,
      province: restShop.province || null,
      provinceCode: restShop.province_code || null,
      country: restShop.country_name || restShop.country || null,
      countryCode: restShop.country_code || null,
      zip: restShop.zip || null,
      phone: restShop.phone || null,
    },
    syncedAt,
  };

  const topLevelFields = {
    shopId: storeProfile.shopifyShopId,
    shopName: storeProfile.name,
    shopEmail: storeProfile.email,
    contactEmail: storeProfile.contactEmail,
    primaryDomain: storeProfile.primaryDomain.host,
    currencyCode: storeProfile.currencyCode,
    countryCode: storeProfile.billingAddress.countryCode,
    timezone: storeProfile.ianaTimezone,
    planName: storeProfile.plan.displayName,
    lastSyncedAt: syncedAt,
  };

  return { storeProfile, topLevelFields };
}

/**
 * Fetch permitted store details from Shopify Admin API (multi-query GraphQL with multi-version REST fallback).
 */
export async function fetchShopifyStoreProfile(storeDomain, accessToken = null) {
  const domain = normalizeShopDomain(storeDomain);
  if (!isValidMyshopifyDomain(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  const token = accessToken || (await getValidAccessToken(domain));
  const queries = [
    SHOP_PROFILE_QUERY,
    SHOP_PROFILE_MINIMAL_QUERY,
    SHOP_PROFILE_CORE_QUERY,
  ];

  // 1) Try GraphQL shop queries across configured and stable API versions
  for (const apiVer of FALLBACK_API_VERSIONS) {
    let versionSupported = true;
    for (const query of queries) {
      try {
        const gqlRes = await fetch(
          `https://${domain}/admin/api/${apiVer}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }
        );

        if (gqlRes.status === 404) {
          versionSupported = false;
          break;
        }

        if (!gqlRes.ok) {
          const failBody = await gqlRes.text().catch(() => "");
          console.warn(
            `[StoreProfile] ${domain} (${apiVer}) responded ${gqlRes.status}: ${failBody.slice(0, 300)}`
          );
          break;
        }

        const gqlBody = await gqlRes.json().catch(() => ({}));
        if (gqlBody?.data?.shop) {
          return normalizeGraphqlShopProfile(gqlBody.data.shop, domain);
        }

        if (Array.isArray(gqlBody?.errors) && gqlBody.errors.length > 0) {
          console.warn(
            `[StoreProfile] GraphQL query warning on ${domain} (${apiVer}):`,
            gqlBody.errors.map((e) => e.message).join("; ")
          );
          // Try the next (simpler) GraphQL query on the same API version
          continue;
        }
      } catch (gqlErr) {
        console.warn(
          `[StoreProfile] GraphQL profile fetch fallback for ${domain} (${apiVer}):`,
          gqlErr.message
        );
        break;
      }
    }
    if (!versionSupported) continue;
  }

  // 2) Fallback to REST /admin/api/<ver>/shop.json across configured and stable API versions
  let lastStatus = 0;
  for (const apiVer of FALLBACK_API_VERSIONS) {
    try {
      const restRes = await fetch(
        `https://${domain}/admin/api/${apiVer}/shop.json`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Shopify-Access-Token": token,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );

      lastStatus = restRes.status;
      if (!restRes.ok) {
        continue;
      }

      const restBody = await restRes.json().catch(() => ({}));
      if (restBody?.shop) {
        return normalizeRestShopProfile(restBody.shop, domain);
      }
    } catch (restErr) {
      console.warn(
        `[StoreProfile] REST profile fetch fallback for ${domain} (${apiVer}):`,
        restErr.message
      );
    }
  }

  throw new Error(
    `Shopify store profile request failed (${lastStatus || "network_error"})`
  );
}

/**
 * Fetch permitted store details from Shopify and persist them in MongoDB StoreIntegration.
 */
export async function syncShopifyStoreProfile(storeDomain, accessToken = null) {
  const domain = normalizeShopDomain(storeDomain);
  if (!isValidMyshopifyDomain(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  const profileData = await fetchShopifyStoreProfile(domain, accessToken);
  if (!profileData) return null;

  const { storeProfile, topLevelFields } = profileData;

  const updated = await StoreIntegration.findOneAndUpdate(
    { platform: "shopify", storeDomain: domain },
    {
      $set: {
        ...topLevelFields,
        storeProfile,
      },
    },
    { new: true }
  );

  if (updated?.shopName) {
    console.log(
      `[StoreProfile] Synced profile for ${domain}: "${updated.shopName}" (${updated.currencyCode || "N/A"})`
    );
  }

  return updated;
}

/**
 * Register the APP_UNINSTALLED webhook subscription with Shopify Admin API.
 */
export async function registerUninstallWebhook(
  storeDomain,
  accessToken,
  callbackUrl
) {
  const domain = normalizeShopDomain(storeDomain);
  if (!isValidMyshopifyDomain(domain) || !accessToken || !callbackUrl) {
    return false;
  }

  // Only register HTTPS webhook URLs with Shopify
  if (!String(callbackUrl).startsWith("https://")) {
    return false;
  }

  const mutation = `
    mutation RegisterAppUninstalledWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            topic: "APP_UNINSTALLED",
            webhookSubscription: {
              callbackUrl,
              format: "JSON",
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    const created = body?.data?.webhookSubscriptionCreate?.webhookSubscription?.id;
    const userErrors = body?.data?.webhookSubscriptionCreate?.userErrors || [];
    const alreadyExists = userErrors.some((e) =>
      /already taken|already exists|address for this topic has already been/i.test(
        String(e?.message || "")
      )
    );
    return Boolean(created || alreadyExists);
  } catch (err) {
    console.warn(`[Webhook] Could not register APP_UNINSTALLED for ${domain}:`, err.message);
    return false;
  }
}

/**
 * Complete store installation registration:
 * 1) Upsert StoreIntegration in MongoDB with status: "active" and encrypted tokens.
 * 2) Sync storeProfile from Shopify Admin API into MongoDB.
 * 3) Register APP_UNINSTALLED webhook with Shopify.
 * 4) Clear stale token/catalog caches and prewarm catalog.
 */
export async function registerOrUpdateStoreInstallation({
  storeDomain,
  accessToken,
  refreshToken = null,
  expiresIn = null,
  refreshTokenExpiresIn = null,
  scopes = [],
  webhookCallbackUrl = null,
  syncProfile = true,
  fallbackProfile = null,
  prewarm = true,
}) {
  const domain = normalizeShopDomain(storeDomain);
  if (!isValidMyshopifyDomain(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("Shopify access token is required to register store");
  }

  const parsedScopes = Array.isArray(scopes)
    ? scopes
    : String(scopes || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const now = new Date();
  const integrationUpdate = {
    industry: "ecommerce",
    platform: "shopify",
    storeDomain: domain,
    accessTokenEncrypted: encryptToken(accessToken),
    refreshTokenEncrypted: refreshToken ? encryptToken(refreshToken) : null,
    accessTokenExpiresAt:
      Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
        ? new Date(Date.now() + Number(expiresIn) * 1000)
        : null,
    refreshTokenExpiresAt:
      Number.isFinite(Number(refreshTokenExpiresIn)) &&
      Number(refreshTokenExpiresIn) > 0
        ? new Date(Date.now() + Number(refreshTokenExpiresIn) * 1000)
        : null,
    scopes: parsedScopes,
    tokenExchangedAt: now,
    reauthRequiredAt: null,
    reauthReason: null,
    status: "active",
    uninstalledAt: null,
    uninstallReason: null,
  };

  // installedAt is set on first install or re-install only, not on every token refresh.
  const existing = await StoreIntegration.findOne({
    platform: "shopify",
    storeDomain: domain,
  })
    .select("status installedAt")
    .lean();
  if (!(existing?.status === "active" && existing.installedAt)) {
    integrationUpdate.installedAt = now;
  }

  let profilePopulated = false;
  if (syncProfile) {
    try {
      const profileData = await fetchShopifyStoreProfile(domain, accessToken);
      if (profileData) {
        Object.assign(integrationUpdate, profileData.topLevelFields, {
          storeProfile: profileData.storeProfile,
        });
        profilePopulated = true;
      }
    } catch (profileErr) {
      console.warn(
        `[StoreProfile] Initial profile sync warning for ${domain}:`,
        profileErr.message
      );
    }
  }

  if (!profilePopulated && fallbackProfile && typeof fallbackProfile === "object") {
    const normalizedFallback = normalizeGraphqlShopProfile(
      fallbackProfile,
      domain
    );
    if (normalizedFallback) {
      Object.assign(integrationUpdate, normalizedFallback.topLevelFields, {
        storeProfile: normalizedFallback.storeProfile,
      });
    }
  }

  const savedRecord = await StoreIntegration.findOneAndUpdate(
    { platform: "shopify", storeDomain: domain },
    { $set: integrationUpdate },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  clearTokenCache(domain);
  clearStoreProductCache(domain);

  if (webhookCallbackUrl) {
    registerUninstallWebhook(domain, accessToken, webhookCallbackUrl).catch(
      () => {}
    );
  }

  if (prewarm) {
    try {
      prewarmStore(domain);
    } catch {
      // ignore prewarm failure
    }
  }

  return savedRecord;
}

/**
 * Mark a store's integration status as "uninstalled" in MongoDB and purge its tokens & caches.
 */
export async function markStoreUninstalled(
  storeDomain,
  { reason = "app_uninstalled_webhook", triggeredAt = null } = {}
) {
  const domain = normalizeShopDomain(storeDomain);
  if (!isValidMyshopifyDomain(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  clearTokenCache(domain);
  clearStoreProductCache(domain);
  lastActiveStores.delete(domain);

  // Shopify retries webhooks for hours and does not keep their order. An uninstall that happened before the store was
  // installed again must not switch the new install off: it only applies to an install that is not newer than it.
  const happenedAt = triggeredAt ? new Date(triggeredAt) : null;
  const notNewer = happenedAt && !Number.isNaN(happenedAt.getTime())
    ? { $or: [{ installedAt: null }, { installedAt: { $lte: happenedAt } }] }
    : {};

  const updated = await StoreIntegration.findOneAndUpdate(
    { platform: "shopify", storeDomain: domain, ...notNewer },
    {
      $set: {
        status: "uninstalled",
        uninstalledAt: new Date(),
        uninstallReason: reason,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    },
    { new: true }
  );

  return updated;
}

function triggerBackgroundProfileSyncIfMissing(domain) {
  const lastAttempt = backgroundSyncTimestamps.get(domain) || 0;
  if (Date.now() - lastAttempt < BACKGROUND_SYNC_COOLDOWN_MS) return;

  try {
    const q = StoreIntegration.findOne({
      platform: "shopify",
      storeDomain: domain,
      status: "active",
    });
    if (!q || typeof q.select !== "function") return;
    q.select("shopName lastSyncedAt storeProfile.name")
      .lean()
      .then((doc) => {
        if (doc && (!doc.shopName || !doc.lastSyncedAt || !doc.storeProfile?.name)) {
          backgroundSyncTimestamps.set(domain, Date.now());
          return syncShopifyStoreProfile(domain);
        }
      })
      .catch(() => {});
  } catch {
    // ignore in unit test mocks
  }
}

/**
 * Resolve an incoming store domain or storefront custom domain to the active myshopify.com storeDomain.
 * Returns null if the store is not found or its status is not "active".
 */
export async function resolveActiveStoreDomain(shopOrHostname) {
  const normalized = normalizeShopDomain(shopOrHostname);
  if (!normalized || !isValidHostname(normalized)) {
    return null;
  }

  // A store that was verified active a moment ago stays usable while the database is briefly unreachable
  // (a dropped connection must not turn every storefront request into "store not connected").
  const lastActive = lastActiveStores.get(normalized);
  const graceValid = lastActive && Date.now() - lastActive.at < ACTIVE_STORE_GRACE_MS;
  if (graceValid && mongoose.connection.readyState !== 1) return lastActive.domain;
  try {
    const domain = await lookupActiveStoreDomain(normalized);
    if (domain) lastActiveStores.set(normalized, { domain, at: Date.now() });
    else lastActiveStores.delete(normalized);
    return domain;
  } catch (error) {
    if (graceValid) return lastActive.domain;
    throw error;
  }
}

const ACTIVE_STORE_GRACE_MS = 30 * 60 * 1000;
const lastActiveStores = new Map();

async function lookupActiveStoreDomain(normalized) {

  if (isValidMyshopifyDomain(normalized)) {
    const exists = await StoreIntegration.exists({
      platform: "shopify",
      storeDomain: normalized,
      status: "active",
    });
    if (exists) {
      triggerBackgroundProfileSyncIfMissing(normalized);
      return normalized;
    }
    return null;
  }

  // Also support active stores using a custom primaryDomain synced in storeProfile
  const queryResult = StoreIntegration.findOne({
    platform: "shopify",
    status: "active",
    $or: [
      { primaryDomain: normalized },
      { "storeProfile.primaryDomain.host": normalized },
    ],
  });

  const doc =
    typeof queryResult?.lean === "function"
      ? await queryResult.lean()
      : await queryResult;

  if (doc && doc.status === "active" && doc.storeDomain) {
    const resolvedDomain = String(doc.storeDomain).toLowerCase();
    triggerBackgroundProfileSyncIfMissing(resolvedDomain);
    return resolvedDomain;
  }

  return null;
}

export async function isActiveStore(shopOrHostname) {
  const resolved = await resolveActiveStoreDomain(shopOrHostname);
  return Boolean(resolved);
}



