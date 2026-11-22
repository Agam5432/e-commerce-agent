// The pieces live in ./shopify/ (client, caches, words, products, search, catalog, recommend, offers, policies, cart);
// this file keeps product details, comparisons, cache upkeep and re-exports everything, so imports of it do not change.
import { contextualPriceCache } from "./shopify/client.js";
import { catalogSummaryCaches, discountCaches, policyCaches, productCountCaches, searchCaches, storeInfoCaches } from "./shopify/caches.js";
import { filterProductsByVariantHints, normalizeSearchTypos, variantMatchesWanted } from "./shopify/words.js";
import { DEFAULT_VARIANT_TITLE, classifyProductCategory, compactProduct, extractKeyFeatures, formatPriceWithSymbol, hasStock, publicVariants, truncate, visibleStockCount } from "./shopify/products.js";
import { searchShopifyProducts, searchShopifyProductsMany } from "./shopify/search.js";
import { getCatalogSummary } from "./shopify/catalog.js";
import { fetchProductById, stockLimitOf } from "./shopify/cart.js";
import { getStoreCredentials } from "./shopify/client.js";
export { localizeProducts, withShopperPricing } from "./shopify/client.js";
export { SIZE_ALIASES, applyShopperBudget, keywordsNamedByShopper, matchesGender, parseSearchFilters, parseSearchTerm, productGenders, tokenMatchesTitle, variantTokens } from "./shopify/words.js";
export { filterProductsByVariantHints, normalizeSearchTypos, variantMatchesWanted };
export { LOW_STOCK_THRESHOLD, categoryInStock, extractRequestedCategories, formatCleanVariantSummary, inferRequestedCategory, matchesRequestedCategory, otherCategoriesInStock, visibleStockCount } from "./shopify/products.js";
export { classifyProductCategory, compactProduct, extractKeyFeatures };
export { correctToVocabulary, probeCatalog } from "./shopify/search.js";
export { searchShopifyProducts, searchShopifyProductsMany };
export { getCachedCatalogSummary, getStoreInfo, getWebsiteProductCount, isCategoryGendered, isStoreGendered, listCategories, storeAddressSharing } from "./shopify/catalog.js";
export { getCatalogSummary };
export { GENERIC_RECOMMENDATION_WORDS, recommendProducts } from "./shopify/recommend.js";
export { discountCodeIsPublic, getPrepaidDiscountOffer, getProductDiscountsAndOffers, getStoreShopifyDiscounts } from "./shopify/offers.js";
export { getProductWarrantyAndPolicy, getStorePolicies } from "./shopify/policies.js";
export { resolveCartItem, resolveVariant } from "./shopify/cart.js";

export async function getProductDetails(storeDomain, productName = "") {
  const term = normalizeSearchTypos(String(productName || "").trim());
  if (!term) {
    return { status: "error", note: "Need a product name." };
  }
  const products = await searchShopifyProducts(storeDomain, term);
  if (!products.length) {
    return { status: "not_found", note: "No matching product.", product: null };
  }
  const product = products[0];
  const hasRealOptions =
    product.variants.length > 1 ||
    (product.variants[0] && product.variants[0].title !== DEFAULT_VARIANT_TITLE);

  return {
    status: "ok",
    matchConfidence: product.matchConfidence ?? null,
    product: {
      id: product.id,
      handle: product.handle,
      title: product.title,
      category: product.category || classifyProductCategory(product),
      price: product.price,
      currency: product.currency,
      formattedPrice: formatPriceWithSymbol(product.price, product.currency),
      description: truncate(product.description, 600),
      features: extractKeyFeatures(product, 3),
      productType: product.productType || null,
      tags: (product.tags || []).slice(0, 12),
      inStock: hasStock(product),
      url: product.url,
      image: product.image || product.variants?.find((v) => v.image)?.image || null,
      imageAlt: product.imageAlt || product.title,
      variants: publicVariants(product.variants),
      options: hasRealOptions
        ? product.variants.slice(0, 20).map((variant) => ({
            id: variant.id,
            name: variant.title,
            price: variant.price,
            inStock: variant.sellable,
            unitsInStock: variant.tracked ? visibleStockCount(variant.inventoryQuantity) : null,
          }))
        : [
            {
              id: product.variants?.[0]?.id || null,
              name: "Default",
              price: product.price,
              inStock: hasStock(product),
            },
          ],
    },
  };
}

export async function compareProducts(storeDomain, productNames = []) {
  const names = [...new Set(
    (Array.isArray(productNames) ? productNames : [productNames])
      .map((n) => String(n || "").trim())
      .filter(Boolean)
  )].slice(0, 3);

  if (names.length < 2) {
    return {
      status: "error",
      note: "Need at least two product names to compare.",
      items: [],
    };
  }

  const groups = await searchShopifyProductsMany(storeDomain, names);
  const items = groups.map((group) => {
    const product = group.products?.[0];
    if (!product) {
      return { asked: group.term, found: false, product: null };
    }
    return {
      asked: group.term,
      found: true,
      product: compactProduct(product, { brief: false, includeCardFields: true }),
    };
  });

  return {
    status: "ok",
    items,
    note: "Compare only using these fields. Say honestly if any name was not found.",
  };
}

export async function checkVariantAvailability(
  storeDomain,
  { productName = "", variantName = "", quantity = 0 } = {}
) {
  const term = String(productName || "").trim();
  if (!term) {
    return { status: "error", note: "Need a product name." };
  }

  let products = await searchShopifyProducts(storeDomain, term);
  if (variantName) {
    products = filterProductsByVariantHints(products, variantName);
  }

  if (!products.length) {
    return {
      status: "not_found",
      note: "Product not found or no variant matched that colour/size.",
      available: false,
      options: [],
    };
  }

  const product = products[0];
  const wanted = String(variantName || "").trim().toLowerCase();
  let variants = product.variants.filter((v) => v.sellable);

  if (wanted) {
    const matched = product.variants.filter((v) =>
      variantMatchesWanted(v.title, wanted)
    );
    if (matched.length) {
      variants = matched;
    } else {
      variants = [];
    }
  }

  const inStock = variants.some((v) => v.sellable);
  // "Do you have 100 of these?": the exact count stays hidden (the store only shows low stock), but whether the asked number can be supplied is
  // answered from the real stock. Unknown stock (untracked, or unreadable) is never claimed to be enough.
  let quantityCheck = null;
  const wantedQuantity = Math.floor(Number(quantity));
  if (inStock && Number.isFinite(wantedQuantity) && wantedQuantity > 1) {
    try {
      const fresh = await fetchProductById(await getStoreCredentials(storeDomain), product.id);
      const ids = new Set(variants.filter((v) => v.sellable).map((v) => String(v.id || "").split("/").pop()));
      const known = (fresh?.variants || []).filter((v) => ids.has(String(v.id || "").split("/").pop()));
      const limits = known.map((v) => (v.inventoryPolicy === "CONTINUE" || !v.tracked ? Infinity : stockLimitOf(v)));
      if (known.length && limits.every((l) => l != null)) quantityCheck = { requested: wantedQuantity, canSupply: limits.some((l) => l >= wantedQuantity) };
    } catch { /* unknown: no claim either way */ }
  }
  return {
    status: "ok",
    title: product.title,
    ...(quantityCheck ? { quantityCheck } : {}),
    available: inStock,
    requestedVariant: variantName || null,
    options: (wanted && variants.length ? variants : product.variants)
      .slice(0, 15)
      .map((v) => ({
        name: v.title,
        price: v.price,
        currency: product.currency,
        inStock: v.sellable,
        unitsInStock: v.tracked ? visibleStockCount(v.inventoryQuantity) : null,
      })),
    currency: product.currency,
    note: inStock
      ? "At least one matching option is in stock."
      : "Matching options are out of stock (or none match).",
  };
}

export function prewarmStore(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  if (!domain) return;

  getCatalogSummary(domain).catch((error) =>
    console.error("[catalog] prewarm failed:", error.message)
  );
}

export function clearStoreProductCache(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  storeInfoCaches.delete(domain);
  productCountCaches.delete(domain);
  catalogSummaryCaches.delete(domain);
  discountCaches.delete(domain);
  for (const key of searchCaches.keys()) {
    if (key.startsWith(`${domain}::`)) searchCaches.delete(key);
  }
}


// Kept as re-exports for callers of the original catalog service.
export { normalizeAddressForShopify } from "../services/shopifyAddress.js";
export { createShopifyAdminOrder } from "../services/shopifyOrderService.js";
// ---------------------------------------------------------------------------------------------
// Memory hygiene: every cache above is per process. Old entries are dropped periodically and
// each cache is size-capped, so a long-running server never grows without bound.
// ---------------------------------------------------------------------------------------------
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS) || 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 5000;

export function sweepCaches(now = Date.now()) {
  let removed = 0;
  for (const map of [searchCaches, storeInfoCaches, productCountCaches, catalogSummaryCaches, contextualPriceCache, discountCaches, policyCaches]) {
    for (const [key, value] of map) {
      const at = Number(value?.at);
      if (Number.isFinite(at) && now - at > CACHE_MAX_AGE_MS) {
        map.delete(key);
        removed++;
      }
    }
    while (map.size > CACHE_MAX_ENTRIES) {
      map.delete(map.keys().next().value);
      removed++;
    }
  }
  return removed;
}

if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  setInterval(() => sweepCaches(), 5 * 60 * 1000).unref();
}

export const __cachesForTest = { searchCaches, policyCaches, catalogSummaryCaches };

