import { getValidAccessToken } from "./shopifyTokenService.js";
import { shopifyApiVersion } from "../config/env.js";

export class ShopifyRequestError extends Error {
  constructor(message, { uncertain = false, code = "SHOPIFY_ERROR" } = {}) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Shopify says "slow down" with HTTP 429, or with a 200 and a THROTTLED error. Either way the call did NOT run.
const throttled = (response, body) => response.status === 429 || (body?.errors || []).some((e) => e?.extensions?.code === "THROTTLED");
const pause = (response, attempt) => Math.min(2000, (Number(response?.headers?.get?.("retry-after")) || 0) * 1000 || 300 * (attempt + 1));

/**
 * One Shopify Admin GraphQL call for one store (its own token, its own domain). Reads are retried a couple of times
 * on throttling, a 5xx or a timeout; a write is retried ONLY when Shopify says it did not run (throttled, or the
 * token was rejected), because repeating a write that may have run could create a second order.
 */
export async function adminGraphql(shop, query, variables = {}) {
  const domain = String(shop || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new ShopifyRequestError("Invalid shop domain.");
  }
  const mutation = /^\s*(?:#.*\n\s*)*mutation\b/.test(query);
  let token = await getValidAccessToken(domain);
  let refreshed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS - 1;
    let response;
    let body;
    try {
      response = await fetch(`https://${domain}/admin/api/${shopifyApiVersion()}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      });
      body = await response.json();
    } catch (error) {
      // a read can simply be asked again; a write that timed out may have run
      if (!mutation && !last) { await sleep(300 * (attempt + 1)); continue; }
      // what actually went wrong (the error's own name and code, e.g. "TimeoutError" or "fetch failed: ECONNRESET"), never a header or token
      const why = [error?.name, error?.cause?.code || error?.code, error?.cause?.message && error.cause.message !== error.message ? String(error.cause.message).slice(0, 80) : ""].filter(Boolean).join(": ").slice(0, 140);
      throw new ShopifyRequestError(`Shopify response could not be confirmed${why ? ` (${why})` : ""}.`, { uncertain: mutation });
    }
    // Authentication rejection means the mutation did not run; refreshing is safe.
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      token = await getValidAccessToken(domain, { force: true });
      continue;
    }
    if (!last && (throttled(response, body) || (!mutation && response.status >= 500))) {
      await sleep(pause(response, attempt));
      continue;
    }
    if (!response.ok || body.errors?.length) {
      const messages = (body.errors || []).map(e => e.message).join("; ");
      const denied = response.status === 403 || /access denied|access scope|not approved|protected.customer.data/i.test(messages);
      throw new ShopifyRequestError(denied
        ? "Shopify access is blocked. In the app's API access requests, enable Protected customer data (name, address, email and phone); also check order/customer scopes."
        : messages || `Shopify request failed (${response.status}).`, {
        code: denied ? "SHOPIFY_ACCESS_DENIED" : "SHOPIFY_ERROR",
        uncertain: mutation && !throttled(response, body) && (response.status >= 500 || Boolean(body.data)),
      });
    }
    return body.data;
  }
}
