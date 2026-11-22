// The Shopify catalog functions the shopping flow uses (with safe fallbacks) and its shared limits.
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import * as shopifyService from "../../tools/shopifyService.js";
import { createOrderLookupService } from "../../services/shopifyOrderLookupService.js";

const defaultOrderLookup = createOrderLookupService();

const {
  searchShopifyProducts,
  searchShopifyProductsMany,
  getWebsiteProductCount,
  recommendProducts,
  listCategories,
  resolveCartItem,
  getStoreInfo,
  compactProduct,
  filterProductsByVariantHints,
  parseSearchFilters,
  extractRequestedCategories = () => [],
  matchesRequestedCategory = () => true,
  getProductDetails,
  compareProducts,
  checkVariantAvailability,
  getProductDiscountsAndOffers,
  getStoreShopifyDiscounts,
  getProductWarrantyAndPolicy,
  getCachedCatalogSummary,
  createShopifyAdminOrder,
  GENERIC_RECOMMENDATION_WORDS = new Set(),
  normalizeSearchTypos = (s) => s,
  SIZE_ALIASES = {},
  tokenMatchesTitle = () => false,
  variantTokens = () => [],
} = shopifyService;

const extractKeyFeatures =
  typeof shopifyService.extractKeyFeatures === "function"
    ? shopifyService.extractKeyFeatures
    : function fallbackExtractKeyFeatures(product, maxPoints = 3) {
        const rawDesc = String(product?.description || "")
          .replace(/sample\s+product\s+for\s+demo\s+store\.?/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const points = [];
        if (rawDesc) {
          const parts = rawDesc
            .split(/(?<=[.!?])\s+|\s*[•·|-]\s+|\s*;\s*/)
            .map((s) => s.replace(/^[•·\-*\s]+/, "").trim())
            .filter((s) => s.length >= 10 && s.length <= 165);
          for (const part of parts) {
            if (points.length >= maxPoints) break;
            points.push(part.endsWith(".") ? part.slice(0, -1) : part);
          }
        }
        if (points.length === 0 && rawDesc) {
          points.push(
            rawDesc.length > 130 ? `${rawDesc.slice(0, 130).trim()}…` : rawDesc,
          );
        }
        return points.slice(0, maxPoints);
      };

const getPrepaidDiscountOffer =
  typeof shopifyService.getPrepaidDiscountOffer === "function"
    ? shopifyService.getPrepaidDiscountOffer
    : async function fallbackGetPrepaidDiscountOffer(
        _storeDomain,
        cartTotal = 0,
      ) {
        const totalNum = Math.max(0, Number(cartTotal) || 0);
        const envPct = Number(process.env.PREPAID_DISCOUNT_PERCENT || 0);
        if (Number.isFinite(envPct) && envPct > 0) {
          const discountAmount = Number(((totalNum * envPct) / 100).toFixed(2));
          return {
            hasDiscount: discountAmount > 0,
            source: "env_config",
            title: `Prepaid ${envPct}% Instant Discount`,
            code: process.env.PREPAID_DISCOUNT_CODE || null,
            discountPercent: envPct,
            discountAmount,
            originalTotal: totalNum,
            prepaidTotal: Math.max(
              0,
              Number((totalNum - discountAmount).toFixed(2)),
            ),
          };
        }
        return {
          hasDiscount: false,
          source: "none",
          title: null,
          code: null,
          discountPercent: 0,
          discountAmount: 0,
          originalTotal: totalNum,
          prepaidTotal: totalNum,
        };
      };

const getCatalogSummary =
  typeof shopifyService.getCatalogSummary === "function"
    ? shopifyService.getCatalogSummary
    : async function fallbackGetCatalogSummary(storeDomain) {
        try {
          const cats =
            typeof listCategories === "function"
              ? await listCategories(storeDomain)
              : [];
          return {
            categories: Array.isArray(cats) ? cats : [],
            categoryMap: {},
            sampleTitles: [],
            products: [],
          };
        } catch {
          return {
            categories: [],
            categoryMap: {},
            sampleTitles: [],
            products: [],
          };
        }
      };


// How long the order reply waits for the confirmation email before saying it is on its way.
const EMAIL_WAIT_MS = Number(process.env.ORDER_EMAIL_WAIT_MS) || 2500;

const CARD_MIN_CONFIDENCE = 0.45;
const MAX_CARDS = 12;
const MAX_RECOMMENDATIONS = 8;
const DEFAULT_RECOMMENDATIONS = 6;

export { assessDiscountOnCart } from "../../tools/shopify/offers.js";
export { defaultOrderLookup, extractKeyFeatures, getPrepaidDiscountOffer, getCatalogSummary, EMAIL_WAIT_MS, CARD_MIN_CONFIDENCE, MAX_CARDS, MAX_RECOMMENDATIONS, DEFAULT_RECOMMENDATIONS, searchShopifyProducts, searchShopifyProductsMany, getWebsiteProductCount, recommendProducts, listCategories, resolveCartItem, getStoreInfo, compactProduct, filterProductsByVariantHints, parseSearchFilters, extractRequestedCategories, matchesRequestedCategory, getProductDetails, compareProducts, checkVariantAvailability, getProductDiscountsAndOffers, getStoreShopifyDiscounts, getProductWarrantyAndPolicy, getCachedCatalogSummary, createShopifyAdminOrder, GENERIC_RECOMMENDATION_WORDS, normalizeSearchTypos, SIZE_ALIASES, tokenMatchesTitle, variantTokens };
