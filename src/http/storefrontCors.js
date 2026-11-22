// Which browser origins may call the storefront routes directly (uploads, and the proxy routes when a
// store is opened outside Shopify's proxy): a connected, active store's own https domain, its
// myshopify.com name or its custom domain. Local pages (localhost) only outside production.
// A refused origin simply gets no CORS headers, so the browser blocks it: it is not a server error.
// Answers are cached briefly so a page full of requests does not hit the database each time.

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function storefrontOriginCheck({ isActive, env = process.env, now = Date.now, okForMs = 60_000, refusedForMs = 10_000, maxEntries = 2000 } = {}) {
  const cache = new Map();
  const devAllowed = env.NODE_ENV !== "production" || env.CORS_ALLOW_LOCALHOST === "1";

  async function allowed(origin) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (DEV_HOSTS.has(url.hostname)) return devAllowed;
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const hit = cache.get(host);
    if (hit && hit.until > now()) return hit.ok;
    let ok = false;
    try {
      ok = Boolean(await isActive(host));
    } catch {
      return false; // not cached: the next request asks again
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(host, { ok, until: now() + (ok ? okForMs : refusedForMs) });
    return ok;
  }

  return (origin, callback) => {
    if (!origin) return callback(null, false);
    allowed(origin).then((ok) => callback(null, ok), () => callback(null, false));
  };
}
