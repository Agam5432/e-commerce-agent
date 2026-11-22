// The per-store caches (search results, catalog summary, store info, discounts, policies) and how long each lives.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.

const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
// A catalog older than this is never shown: prices and stock come from Shopify, not from an old copy.
const CATALOG_STALE_MAX_MS = (Number(process.env.CATALOG_STALE_MAX_SECONDS) || 5 * 60) * 1000;
const STORE_INFO_TTL_MS = 10 * 60 * 1000;
const CATALOG_SUMMARY_TTL_MS = 2 * 60 * 1000;

const searchCaches = new Map();
const inflightListPromises = new Map();
const storeInfoCaches = new Map();
const productCountCaches = new Map();
const catalogSummaryCaches = new Map();
const hiddenProductTitles = new Map(); // domain -> titles that are ACTIVE but not published to the Online Store

// ---------------------------------------------------------------------------------------------
// Store vocabulary: every word that appears in THIS store's catalog. Used to repair typos
// ("bootle" -> "bottle") and to ignore conversational words, with no hardcoded lists.
// ---------------------------------------------------------------------------------------------
const vocabCache = new Map();

const discountCaches = new Map();
const DISCOUNT_CACHE_TTL_MS = 2 * 60 * 1000;

const policyCaches = new Map();
const POLICY_CACHE_TTL_MS = 30 * 60 * 1000;

export { SEARCH_CACHE_TTL_MS, CATALOG_STALE_MAX_MS, STORE_INFO_TTL_MS, CATALOG_SUMMARY_TTL_MS, searchCaches, inflightListPromises, storeInfoCaches, productCountCaches, catalogSummaryCaches, hiddenProductTitles, vocabCache, discountCaches, DISCOUNT_CACHE_TTL_MS, policyCaches, POLICY_CACHE_TTL_MS };
