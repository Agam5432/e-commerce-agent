// The store as a whole: its info and addresses, product count, and the catalog summary (categories, gendered or not).
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { CATALOG_SUMMARY_TTL_MS, STORE_INFO_TTL_MS, catalogSummaryCaches, hiddenProductTitles, productCountCaches, storeInfoCaches } from "./caches.js";
import { getStoreCredentials, shopifyGraphQL } from "./client.js";
import { classifyProductCategory, hasStock, indexCategories, matchesRequestedCategory } from "./products.js";
import { graphqlListProducts } from "./search.js";
import { GENDER_WORDS, productGenders } from "./words.js";

export async function getWebsiteProductCount(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const cached = productCountCaches.get(domain);

  if (cached && Date.now() - cached.at < STORE_INFO_TTL_MS) {
    return { productCount: cached.count };
  }

  const credentials = await getStoreCredentials(domain);

  try {
    const data = await shopifyGraphQL(
      credentials,
      `query Count {
        productsCount(query: "status:active") { count }
      }`
    );
    const count = data?.productsCount?.count ?? 0;
    productCountCaches.set(domain, { at: Date.now(), count });
    return { productCount: count };
  } catch {
    const listed = await graphqlListProducts(credentials, { first: 1 });
    return { productCount: listed.length > 0 ? -1 : 0 };
  }
}

export function getCachedCatalogSummary(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  if (!domain) return null;
  const cached = catalogSummaryCaches.get(domain);
  if (cached && Date.now() - cached.at < CATALOG_SUMMARY_TTL_MS) {
    return cached.summary;
  }
  return null;
}

function countBy(values = []) {
  const m = new Map();
  for (const v of values) {
    const k = String(v || "").trim();
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * True when this store's own products carry men/women/kids wording (so "who is it for?" is a
 * sensible question). Read from the cached catalog, so it is synchronous and store-specific.
 */
export function isStoreGendered(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const products = catalogSummaryCaches.get(domain)?.summary?.allProducts;
  if (!Array.isArray(products) || products.length === 0) return false;
  const gendered = products.filter((p) => [...productGenders(p)].some((g) => GENDER_WORDS[g])).length;
  return gendered >= 3 && gendered / products.length >= 0.2;
}

/**
 * True when most of this store's own products in `category` carry men/women/kids wording, so asking
 * "who is it for?" makes sense for that category. Read from the cached catalog (store-specific data).
 */
export function isCategoryGendered(storeDomain, category) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const products = catalogSummaryCaches.get(domain)?.summary?.allProducts;
  if (!Array.isArray(products) || !category) return false;
  const inCategory = products.filter((p) => matchesRequestedCategory(p, category));
  if (inCategory.length < 2) return false;
  const gendered = inCategory.filter((p) => [...productGenders(p)].some((g) => GENDER_WORDS[g])).length;
  return gendered / inCategory.length >= 0.5;
}

export async function getCatalogSummary(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  if (!domain) return { categories: [], categoryMap: {}, sampleTitles: [], products: [] };

  const cached = catalogSummaryCaches.get(domain);
  if (cached && Date.now() - cached.at < CATALOG_SUMMARY_TTL_MS) {
    return cached.summary;
  }

  try {
    const credentials = await getStoreCredentials(domain);
    const products = await graphqlListProducts(credentials, { first: 250 });
    const inStockProducts = products.filter((p) => hasStock(p));
    const index = indexCategories(domain, products);

    // Categories and the category map describe what the store CARRIES (sold out included),
    // so "do you sell X" is never answered "no" just because X is temporarily out of stock.
    const categoryMap = {};
    for (const p of products) {
      const cat = p.category || classifyProductCategory(p);
      (categoryMap[cat] ||= []).push(p.title);
    }
    const categories = [...index.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 24)
      .map((e) => e.label);

    const vendors = countBy(products.map((p) => p.vendor));
    const tags = countBy(products.flatMap((p) => p.tags || []));
    const prices = products.map((p) => Number(p.price)).filter((n) => Number.isFinite(n) && n > 0);

    let storeName = null;
    let shopCurrency = null;
    try {
      const info = await getStoreInfo(domain);
      storeName = info?.storeName || null;
      shopCurrency = info?.currencyCode || null;
    } catch {
      /* the name is nice to have; the catalog is what matters */
    }

    const summary = {
      storeName,
      categories,
      categoryCounts: [...index.values()].map((e) => ({ label: e.label, count: e.count })),
      categoryMap,
      vendors: vendors.slice(0, 15),
      topTags: tags.slice(0, 20),
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      sampleTitles: inStockProducts.slice(0, 25).map((p) => p.title),
      allTitles: products.slice(0, 60).map((p) => p.title),
      outOfStockTitles: products.filter((p) => !hasStock(p)).slice(0, 25).map((p) => p.title),
      // Products the merchant has not published are admin data: shared only if allowed.
      unpublishedTitles: process.env.SHARE_UNPUBLISHED_TITLES === "1" ? (hiddenProductTitles.get(domain) || []).slice(0, 25) : [],
      totalActive: products.length,
      totalProducts: inStockProducts.length,
      products: inStockProducts,
      allProducts: products,
      currency: shopCurrency || products[0]?.currency || "USD",
    };
    catalogSummaryCaches.set(domain, { at: Date.now(), summary });
    return summary;
  } catch (error) {
    console.error(`[catalog] getCatalogSummary FAILED for ${domain}:`, error.message);
    return {
      categories: [],
      categoryMap: {},
      sampleTitles: [],
      products: [],
      error: String(error.message || error).slice(0, 200),
    };
  }
}

export async function listCategories(storeDomain) {
  const summary = await getCatalogSummary(storeDomain);
  if (summary.categories.length > 0) return summary.categories;
  return summary.sampleTitles.slice(0, 15);
}

/** STORE_ADDRESS_SHARING: "pickup" (default) = only local-pickup locations; "all"; "none". */
export function storeAddressSharing(env = process.env) {
  const m = String(env.STORE_ADDRESS_SHARING || "pickup").toLowerCase();
  return ["pickup", "all", "none"].includes(m) ? m : "pickup";
}

export async function getStoreInfo(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const cached = storeInfoCaches.get(domain);

  if (cached && Date.now() - cached.at < STORE_INFO_TTL_MS) {
    return cached.info;
  }

  const credentials = await getStoreCredentials(domain);
  const mode = storeAddressSharing();

  // Shopify locations include warehouses and the merchant's own addresses. Customers are told only
  // about locations that offer local pickup (made to be visited), unless the merchant chooses
  // otherwise. The merchant's billing address is never used.
  let data;
  try {
    data = await shopifyGraphQL(
      credentials,
      `query StoreInfo {
        shop { name currencyCode contactEmail primaryDomain { url } shipsToCountries ianaTimezone paymentSettings { supportedDigitalWallets } }
        locations(first: 10) {
          edges { node { name isActive localPickupSettingsV2 { pickupTime } address { formatted phone } } }
        }
      }`
    );
  } catch (error) {
    console.warn("[store-info] location details unavailable; sharing no address:", String(error.message).slice(0, 160));
    data = await shopifyGraphQL(credentials, `query StoreName { shop { name currencyCode } }`);
  }
  const shop = data?.shop || {};

  const addresses = mode === "none"
    ? []
    : (data?.locations?.edges || [])
        .map((edge) => edge.node)
        .filter((loc) => loc.isActive && loc.address?.formatted?.length)
        .filter((loc) => mode === "all" || Boolean(loc.localPickupSettingsV2))
        .map((loc) => ({
          name: loc.name,
          address: loc.address.formatted.join(", "),
          phone: loc.address.phone || null,
        }));

  const info = {
    storeName: shop.name || null,
    currencyCode: shop.currencyCode || null,
    website: shop.primaryDomain?.url || null,
    // The shop's contact email is often the owner's own mailbox (a gmail.com address): it is not handed to shoppers as "the store's contact"
    // unless the merchant opts in. A business address on the store's own domain is still shared.
    contactEmail: shareableContactEmail(shop.contactEmail),
    contactEmailWithheld: Boolean(shop.contactEmail) && !shareableContactEmail(shop.contactEmail),
    ...(Boolean(shop.contactEmail) && !shareableContactEmail(shop.contactEmail) ? { contactNote: "The merchant's contact email is a personal mailbox and is not shared in chat. Never give an email address as the store's contact; offer to pass the request to the team (flag_for_owner) or to connect a person instead." } : {}),
    shipsToCountries: Array.isArray(shop.shipsToCountries) ? shop.shipsToCountries : [],
    timezone: shop.ianaTimezone || null,
    paymentWallets: Array.isArray(shop.paymentSettings?.supportedDigitalWallets) ? shop.paymentSettings.supportedDigitalWallets : [],
    locations: addresses,
  };
  storeInfoCaches.set(domain, { at: Date.now(), info });
  return info;
}

const PERSONAL_MAIL_RE = /@(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|rediffmail)\.[a-z.]+$/i;
/** The shop's contact email, or null when it is a personal mailbox (and SHARE_PERSONAL_CONTACT_EMAIL is not set). */
export function shareableContactEmail(email) {
  const e = String(email || "").trim();
  if (!e) return null;
  if (PERSONAL_MAIL_RE.test(e) && !/^(?:1|true|yes)$/i.test(String(process.env.SHARE_PERSONAL_CONTACT_EMAIL || ""))) return null;
  return e;
}

export { countBy };
