// The store sells in ONE currency (its Shopify base currency). A storefront with Shopify Markets can hand the widget a
// cart in another one (a visitor from India sees rupees at the India market's own prices). Everything the assistant says,
// shows, calculates and orders must stay in the store's currency, so a cart in another currency is priced again from the
// store's own variant prices: same products and quantities, the store's prices and currency.
import { adminGraphql } from "./shopifyAdminService.js";

const QUERY = `query CartVariantPrices($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) { ... on ProductVariant { id price } }
}`;

const TTL_MS = 60_000;
const cache = new Map(); // shop -> { at, currency, prices: Map(variantGid -> price in major units) }

const gidOf = (item) => {
  const raw = String(item?.variant_id ?? item?.id ?? "").trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) return raw;
  return /^\d+$/.test(raw) ? `gid://shopify/ProductVariant/${raw}` : "";
};

export function clearCartPricingCache() {
  cache.clear();
}

/**
 * @param {string} shop
 * @param {object|null} cart a normalized cart snapshot (see normalizeCartSnapshot)
 * @returns the same cart when it already is in the store's currency (or cannot be priced again), otherwise a copy priced
 *          from the store's own prices, with `currency` set to the store's and `repricedFrom` naming the one it came in.
 */
export async function cartInStoreCurrency(shop, cart, { graphql = adminGraphql, now = Date.now } = {}) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0 || !shop) return cart;
  try {
    const ids = [...new Set(cart.items.map(gidOf))];
    if (ids.some((id) => !id)) return cart;
    let entry = cache.get(shop);
    if (!entry || now() - entry.at > TTL_MS || ids.some((id) => !entry.prices.has(id))) {
      const raw = await graphql(shop, QUERY, { ids });
      const data = raw?.data && !raw.shop ? raw.data : raw;
      const prices = new Map(entry && now() - entry.at <= TTL_MS ? entry.prices : []);
      for (const node of data?.nodes || []) if (node?.id && node.price != null) prices.set(node.id, Number(node.price));
      entry = { at: now(), currency: String(data?.shop?.currencyCode || "").toUpperCase(), prices };
      cache.set(shop, entry);
    }
    const cartCurrency = String(cart.currency || "").toUpperCase();
    if (!entry.currency) return cart;
    const sameCurrency = cartCurrency === entry.currency;
    // The browser sent the prices, so they are only a claim. In the store's own currency a line is kept when its list price
    // matches Shopify's; a line that does not match (a stale or edited cart) is priced from Shopify and the cart says so.
    const listPrice = (item) => Number(item.original_price ?? item.price);
    const wrongLine = (item) => {
      const unit = entry.prices.get(gidOf(item));
      return Number.isFinite(unit) && Math.round(unit * 100) !== listPrice(item);
    };
    if (sameCurrency && !cart.items.some(wrongLine)) return cart;
    const items = cart.items.map((item) => {
      const unit = entry.prices.get(gidOf(item));
      if (!Number.isFinite(unit)) return null;
      if (sameCurrency && !wrongLine(item)) return item;
      const price = Math.round(unit * 100);
      const quantity = Number(item.quantity) || 0;
      const line = price * quantity;
      return { ...item, price, original_price: price, original_line_price: line, line_price: line, final_line_price: line, final_price: price };
    });
    if (items.some((item) => item === null)) return cart;
    const total = items.reduce((sum, item) => sum + item.line_price, 0);
    return sameCurrency
      ? { ...cart, items, original_total_price: total, total_price: total, priceCorrected: true }
      : { ...cart, items, currency: entry.currency, repricedFrom: cartCurrency || undefined, original_total_price: total, total_price: total, pricingComplete: true };
  } catch (error) {
    console.warn("[cart] could not price the cart in the store's currency:", String(error?.message || error).slice(0, 160));
    return cart;
  }
}
