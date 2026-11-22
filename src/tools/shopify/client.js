// Talking to a store's Shopify Admin API: credentials, GraphQL with a timeout, and prices in the shopper's own market.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { getValidAccessToken } from "../../services/shopifyTokenService.js";
import { shopifyApiVersion } from "../../config/env.js";
import { AsyncLocalStorage } from "node:async_hooks";

const API_VERSION = shopifyApiVersion();

const GRAPHQL_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------------------------------
 * Shopper pricing (Shopify Markets).
 * The catalog is cached in the store's base currency. When the shopper browses in another
 * currency, the products about to be shown are re-priced with Shopify's own contextual pricing
 * for the shopper's country (never an exchange rate computed here). If Shopify cannot answer, the
 * products keep their base price AND base currency label, so a price is never mislabeled.
 * ------------------------------------------------------------------------------------------ */
const pricingContext = new AsyncLocalStorage();
const contextualPriceCache = new Map(); // domain|country|variantId -> { at, price, compareAt, currency }
const CONTEXTUAL_PRICE_TTL_MS = 10 * 60 * 1000;

export function withShopperPricing(ctx, fn) {
  const country = String(ctx?.country || "").trim().toUpperCase();
  const currency = String(ctx?.currency || "").trim().toUpperCase();
  return pricingContext.run(/^[A-Z]{2}$/.test(country) && /^[A-Z]{3}$/.test(currency) ? { country, currency } : null, fn);
}

export async function localizeProducts(storeDomain, products) {
  const ctx = pricingContext.getStore();
  if (!ctx || !Array.isArray(products) || !products.length) return products;
  const domain = String(storeDomain || "").toLowerCase();
  const sameCurrency = products.every((p) => !p.currency || String(p.currency).toUpperCase() === ctx.currency);
  if (sameCurrency) return products;

  const ids = [...new Set(products.flatMap((p) => (p.variants || []).map((v) => v.id)).filter(Boolean))];
  const now = Date.now();
  const missing = ids.filter((id) => {
    const hit = contextualPriceCache.get(`${domain}|${ctx.country}|${id}`);
    return !hit || now - hit.at > CONTEXTUAL_PRICE_TTL_MS;
  });
  if (missing.length) {
    try {
      const credentials = await getStoreCredentials(domain);
      // Up to 100 variants per request; the requests run together so a wide catalog window costs one round trip.
      const chunks = [];
      for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
      const answers = await Promise.all(
        chunks.map((chunk) =>
          shopifyGraphQL(
            credentials,
            `query ShopperPrices($ids: [ID!]!, $country: CountryCode!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                contextualPricing(context: { country: $country }) {
                  price { amount currencyCode }
                  compareAtPrice { amount currencyCode }
                }
              }
            }
          }`,
            { ids: chunk, country: ctx.country }
          )
        )
      );
      for (const data of answers) {
        for (const node of data?.nodes || []) {
          const cp = node?.contextualPricing;
          if (!node?.id || !cp?.price) continue;
          contextualPriceCache.set(`${domain}|${ctx.country}|${node.id}`, {
            at: now,
            price: cp.price.amount,
            compareAt: cp.compareAtPrice?.amount ?? null,
            currency: cp.price.currencyCode,
          });
        }
      }
    } catch (err) {
      console.warn(`[pricing] contextual pricing unavailable for ${domain} (${ctx.country}): ${err.message}`);
    }
  }

  return products.map((p) => {
    const priced = (p.variants || []).map((v) => {
      const hit = contextualPriceCache.get(`${domain}|${ctx.country}|${v.id}`);
      return hit && hit.currency === ctx.currency ? { ...v, price: hit.price, compareAtPrice: hit.compareAt } : null;
    });
    // Mixed or missing answers: keep the base price and base currency for this product.
    if (!priced.length || priced.some((v) => !v)) return p;
    const buyable = priced.filter((v) => v.sellable);
    const min = (buyable.length ? buyable : priced).reduce((m, v) => (Number(v.price) < m ? Number(v.price) : m), Infinity);
    return { ...p, variants: priced, price: String(min), currency: ctx.currency, basePrice: p.price, baseCurrency: p.currency };
  });
}

async function getStoreCredentials(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("Invalid Shopify store domain");
  }

  const accessToken = await getValidAccessToken(domain);
  return { domain, accessToken };
}

async function shopifyGraphQL(credentials, query, variables = {}, retried = false) {
  const response = await fetch(
    `https://${credentials.domain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": credentials.accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    }
  );

  if (response.status === 401 && !retried) {
    credentials.accessToken = await getValidAccessToken(credentials.domain, {
      force: true,
    });
    return shopifyGraphQL(credentials, query, variables, true);
  }

  if (!response.ok) {
    const failBody = await response.text().catch(() => "");
    console.warn(
      `[Shopify API] ${credentials.domain} responded ${response.status}: ${failBody.slice(0, 300)}`
    );
    throw new Error(`Shopify API request failed with status ${response.status}`);
  }

  const result = await response.json();

  if (result.errors?.length) {
    const msg = result.errors.map((e) => e.message).join("; ");
    throw new Error(`Shopify GraphQL errors: ${msg}`);
  }

  return result.data;
}

export { API_VERSION, GRAPHQL_TIMEOUT_MS, pricingContext, contextualPriceCache, CONTEXTUAL_PRICE_TTL_MS, getStoreCredentials, shopifyGraphQL };
