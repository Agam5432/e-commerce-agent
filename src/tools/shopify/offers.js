// Discounts: the store's active codes (only public ones are shared), the prepaid offer, and offers for a product.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { DISCOUNT_CACHE_TTL_MS, discountCaches } from "./caches.js";
import { getCachedCatalogSummary, getCatalogSummary } from "./catalog.js";
import { getStoreCredentials, pricingContext, shopifyGraphQL } from "./client.js";
import { formatPriceWithSymbol } from "./products.js";
import { searchShopifyProducts } from "./search.js";
import { variantMatchesWanted } from "./words.js";
import { cartInStoreCurrency } from "../../services/cartPricing.js";

export async function getPrepaidDiscountOffer(storeDomain, cartTotal = 0) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const totalNum = Math.max(0, Number(cartTotal) || 0);

  let rawOffer = null;
  const cached = discountCaches.get(domain);
  if (cached && Date.now() - cached.at < DISCOUNT_CACHE_TTL_MS) {
    rawOffer = cached.offer;
  } else {
    try {
      const credentials = await getStoreCredentials(domain);
      const data = await shopifyGraphQL(
        credentials,
        `query ActiveDiscounts {
          discountNodes(first: 25, query: "status:active") {
            edges {
              node {
                id
                discount {
                  __typename
                  ... on DiscountCodeBasic {
                    title
                    status
                    summary
                    minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
                    codes(first: 5) { nodes { code } }
                    customerGets {
                      value {
                        __typename
                        ... on DiscountPercentage { percentage }
                        ... on DiscountAmount { amount { amount currencyCode } }
                      }
                    }
                  }
                  ... on DiscountAutomaticBasic {
                    title
                    status
                    summary
                    minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
                    customerGets {
                      value {
                        __typename
                        ... on DiscountPercentage { percentage }
                        ... on DiscountAmount { amount { amount currencyCode } }
                      }
                    }
                  }
                }
              }
            }
          }
        }`
      );

      const nodes = (data?.discountNodes?.edges || [])
        .map((e) => e?.node?.discount)
        .filter((d) => d && (d.status === "ACTIVE" || !d.status));

      // Shopify has no "pay online" condition on discounts, so the merchant marks the prepaid discount by
      // its title/code (default: containing "prepaid"; configurable via PREPAID_DISCOUNT_MATCH).
      // Any other automatic discount is NOT a prepaid discount: Shopify already applies it to every order.
      const prepaidWords = String(process.env.PREPAID_DISCOUNT_MATCH || "prepaid")
        .split(",")
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      const prepaidMatch = nodes.find((d) => {
        const codeStr = (d.codes?.nodes || []).map((c) => c.code).join(" ");
        const blob = `${d.title || ""} ${d.summary || ""} ${codeStr}`.toLowerCase();
        return prepaidWords.some((w) => blob.includes(w));
      });

      if (prepaidMatch) {
        const val = prepaidMatch.customerGets?.value;
        const minReq = prepaidMatch.minimumRequirement || {};
        const minimum = minReq.greaterThanOrEqualToSubtotal ? { minSubtotal: Number(minReq.greaterThanOrEqualToSubtotal.amount) || 0, minCurrency: String(minReq.greaterThanOrEqualToSubtotal.currencyCode || "").toUpperCase() } : { minSubtotal: 0, minCurrency: "" };
        const code = prepaidMatch.codes?.nodes?.[0]?.code || null;
        if (val?.__typename === "DiscountPercentage" && Number(val.percentage) > 0) {
          const pct = Number(val.percentage) <= 1 ? Number((val.percentage * 100).toFixed(2)) : Number(val.percentage);
          rawOffer = {
            hasDiscount: true,
            source: "shopify_discounts_api",
            title: prepaidMatch.title || code || "Prepaid Discount",
            code,
            type: "percentage",
            percent: pct,
            flatAmount: 0,
            ...minimum,
          };
        } else if (val?.__typename === "DiscountAmount" && Number(val.amount?.amount) > 0) {
          rawOffer = {
            hasDiscount: true,
            source: "shopify_discounts_api",
            title: prepaidMatch.title || code || "Prepaid Discount",
            code,
            type: "fixed_amount",
            percent: 0,
            flatAmount: Number(val.amount.amount),
            amountCurrency: val.amount.currencyCode || null,
            ...minimum,
          };
        }
      }
    } catch (err) {
      console.log("[discount-check] Shopify discountNodes check skipped/fell back:", err.message);
    }

    if (!rawOffer) {
      try {
        const summary = await getCatalogSummary(domain);
        for (const p of summary.products || []) {
          for (const tag of p.tags || []) {
            const m = String(tag).match(/^prepaid[_:\-\s]*(\d+(?:\.\d+)?)%?$/i);
            if (m && Number(m[1]) > 0) {
              rawOffer = {
                hasDiscount: true,
                source: "shopify_product_tag",
                title: `Prepaid ${m[1]}% Off`,
                code: null,
                type: "percentage",
                percent: Number(m[1]),
                flatAmount: 0,
              };
              break;
            }
          }
          if (rawOffer) break;
        }
      } catch {}
    }

    if (!rawOffer) {
      const envPct = Number(process.env.PREPAID_DISCOUNT_PERCENT || 0);
      const envFlat = Number(process.env.PREPAID_DISCOUNT_FLAT || 0);
      const envCode = String(process.env.PREPAID_DISCOUNT_CODE || "").trim() || null;

      if (Number.isFinite(envPct) && envPct > 0) {
        rawOffer = {
          hasDiscount: true,
          source: "env_config",
          title: envCode ? `Prepaid Offer (${envCode})` : `Prepaid ${envPct}% Instant Discount`,
          code: envCode,
          type: "percentage",
          percent: envPct,
          flatAmount: 0,
        };
      } else if (Number.isFinite(envFlat) && envFlat > 0) {
        rawOffer = {
          hasDiscount: true,
          source: "env_config",
          title: envCode ? `Prepaid Offer (${envCode})` : "Prepaid Instant Discount",
          code: envCode,
          type: "fixed_amount",
          percent: 0,
          flatAmount: envFlat,
        };
      } else {
        rawOffer = {
          hasDiscount: false,
          source: "none",
          title: null,
          code: null,
          type: "none",
          percent: 0,
          flatAmount: 0,
        };
      }
    }

    discountCaches.set(domain, { at: Date.now(), offer: rawOffer });
  }

  // A fixed amount is set in one currency (the discount's, else the store's). Applied to a total in
  // another currency it would be a wrong number, so it is not offered there; percentages work in any.
  const shopperCurrency = String(pricingContext.getStore()?.currency || "").toUpperCase();
  const fixedCurrency = String(rawOffer?.amountCurrency || getCachedCatalogSummary(domain)?.currency || "").toUpperCase();
  if (rawOffer?.hasDiscount && rawOffer.type === "fixed_amount" && shopperCurrency && fixedCurrency && shopperCurrency !== fixedCurrency) {
    console.log(`[discount-check] prepaid ${rawOffer.flatAmount} ${fixedCurrency} not offered to a ${shopperCurrency} cart (fixed amounts are not converted)`);
    return {
      hasDiscount: false,
      source: "currency_mismatch",
      title: null,
      code: null,
      discountPercent: 0,
      discountAmount: 0,
      originalTotal: totalNum,
      prepaidTotal: totalNum,
    };
  }

  // The discount's own minimum spend (Shopify: "minimum purchase $20,000"): it is set in ONE currency, so the cart total is compared with it only when
  // it is in that same currency. In another currency the comparison cannot be made here, and a discount whose condition is not known to be met is not offered.
  if (rawOffer?.hasDiscount && Number(rawOffer.minSubtotal) > 0) {
    const cartCurrency = shopperCurrency || fixedCurrency;
    const comparable = !rawOffer.minCurrency || !cartCurrency || rawOffer.minCurrency === cartCurrency;
    if (!comparable || totalNum < Number(rawOffer.minSubtotal)) {
      console.log(`[discount-check] prepaid ${rawOffer.title} needs a cart of at least ${rawOffer.minSubtotal} ${rawOffer.minCurrency}; not offered`);
      return { hasDiscount: false, source: "minimum_not_met", title: null, code: null, discountPercent: 0, discountAmount: 0, originalTotal: totalNum, prepaidTotal: totalNum, minimumSubtotal: rawOffer.minSubtotal, minimumCurrency: rawOffer.minCurrency || null };
    }
  }

  if (!rawOffer || !rawOffer.hasDiscount) {
    return {
      hasDiscount: false,
      source: rawOffer?.source || "none",
      title: null,
      code: null,
      discountPercent: 0,
      discountAmount: 0,
      originalTotal: totalNum,
      prepaidTotal: totalNum,
    };
  }

  const discountAmount =
    rawOffer.type === "percentage"
      ? Number(((totalNum * rawOffer.percent) / 100).toFixed(2))
      : Math.min(totalNum, Number(rawOffer.flatAmount.toFixed(2)));
  const prepaidTotal = Math.max(0, Number((totalNum - discountAmount).toFixed(2)));

  return {
    hasDiscount: discountAmount > 0 || rawOffer.percent > 0 || rawOffer.flatAmount > 0,
    source: rawOffer.source,
    title: rawOffer.title,
    code: rawOffer.code,
    discountPercent: rawOffer.percent,
    discountAmount,
    originalTotal: totalNum,
    prepaidTotal,
  };
}

/**
 * DISCOUNT_CODE_SHARING: "public" (default) = a code is mentioned only when every buyer can use it
 * and it has no usage limit; "none" = never mention codes; "all" = mention every active code.
 */
export function discountCodeIsPublic(discount, mode = process.env.DISCOUNT_CODE_SHARING || "public") {
  const m = String(mode).toLowerCase();
  if (m === "all") return true;
  if (m === "none") return false;
  return discount?.context?.__typename === "DiscountBuyerSelectionAll" && discount?.usageLimit == null;
}

/**
 * Can this discount be used on the shopper's cart right now, and what must they know about it? Pure: the cart is {total (major units), itemCount}.
 * Returns {eligible, conditions[]}; conditions are plain sentences the reply may repeat (minimum spend, minimum quantity, limited scope).
 */
export function discountEligibility(discount, cart = {}, currency = "") {
  const total = Number(cart.total) || 0;
  const count = Number(cart.itemCount) || 0;
  const conditions = [];
  let eligible = true;
  if (discount.minSubtotal > 0) {
    // The minimum is set in the store's currency. The cart may be in the shopper's currency, so a number in one is never compared with a
    // number in the other: the cart's total in the store's own currency (from Shopify's own prices, see cartPricing.js) is used, and when
    // that is not known the reply says the minimum could not be checked.
    const minCurrency = String(discount.minCurrency || discount.currencyCode || cart.storeCurrency || currency || "").toUpperCase();
    const cartCurrency = String(currency || "").toUpperCase();
    const differs = cartCurrency && minCurrency && cartCurrency !== minCurrency;
    // In another currency than the cart's the amount is written with its currency CODE so it is never read as the shopper's own currency.
    conditions.push(differs ? `needs a cart worth at least ${minCurrency} ${Number(discount.minSubtotal).toLocaleString("en-US", { minimumFractionDigits: 2 })} (the store's own currency, ${minCurrency})` : `needs a cart of at least ${formatPriceWithSymbol(discount.minSubtotal, minCurrency)}`);
    if (!cartCurrency || !minCurrency || cartCurrency === minCurrency) {
      if (total < discount.minSubtotal) eligible = false;
    } else if (cart.storeTotal != null && String(cart.storeCurrency || "").toUpperCase() === minCurrency) {
      if (Number(cart.storeTotal) < discount.minSubtotal) { eligible = false; conditions.push(`your cart is worth ${minCurrency} ${Number(cart.storeTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in the store's currency`); }
    } else {
      eligible = false;
      conditions.push("whether this cart reaches that minimum could not be checked in your currency");
    }
  }
  if (discount.minQuantity > 0) {
    conditions.push(`needs at least ${discount.minQuantity} items in the cart`);
    if (count < discount.minQuantity) eligible = false;
  }
  if (discount.limitedTo) {
    const names = (discount.scopeNames || []).slice(0, 3).join(", ");
    conditions.push(names ? `applies only to items in the ${names} ${discount.limitedTo === "collection" ? "collection" + (discount.scopeNames.length > 1 ? "s" : "") : "product" + (discount.scopeNames.length > 1 ? "s" : "")}, not the whole store` : `applies only to selected ${discount.limitedTo}s, not the whole store`);
  }
  return { eligible, conditions };
}

/** The cart's total in the store's own currency (Shopify's prices for these variants), or null when it cannot be known. */
async function cartTotalInStoreCurrency(domain, cart, currency) {
  const summaryCurrency = String(getCachedCatalogSummary(domain)?.currency || "").toUpperCase();
  if (!summaryCurrency || !cart?.items?.length) return { storeTotal: null, storeCurrency: "" };
  if (summaryCurrency === String(currency || "").toUpperCase()) return { storeTotal: Number(cart.total_price) / 100, storeCurrency: summaryCurrency };
  const inStore = await cartInStoreCurrency(domain, cart).catch(() => null);
  if (inStore && String(inStore.currency || "").toUpperCase() === summaryCurrency && inStore.total_price != null) return { storeTotal: Number(inStore.total_price) / 100, storeCurrency: summaryCurrency };
  return { storeTotal: null, storeCurrency: "" };
}

/**
 * What a discount really does on THIS cart: whether the shopper meets its minimum spend / quantity, and which cart lines it covers (a code limited to
 * a collection or to named products discounts only those lines, never the whole cart). Returns
 * { eligible, conditions[], scopeKnown, eligibleSubtotal (major units, cart currency), coveredVariantIds[], coveredTitles[] }.
 */
export async function assessDiscountOnCart(storeDomain, cart, discount) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const currency = String(cart?.currency || "");
  const cartTotal = cart?.total_price != null ? Number(cart.total_price) / 100 : 0;
  const itemCount = cart?.item_count ?? items.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  const { storeTotal, storeCurrency } = discount.minSubtotal > 0 ? await cartTotalInStoreCurrency(domain, cart, currency) : { storeTotal: null, storeCurrency: "" };
  const { eligible, conditions } = discountEligibility(discount, { total: cartTotal, itemCount, storeTotal, storeCurrency }, currency);
  const lineSubtotal = (item) => Number(item.final_line_price ?? item.line_price ?? 0) / 100;
  const out = { eligible, conditions, scopeKnown: true, eligibleSubtotal: items.reduce((s, i) => s + lineSubtotal(i), 0) || cartTotal, coveredVariantIds: items.map((i) => String(i.variant_id ?? i.id ?? "")), coveredTitles: items.map((i) => i.product_title || i.title) };
  if (!discount.limitedTo || !items.length) return out;
  const scope = new Set((discount.scopeNames || []).map((n) => String(n).toLowerCase()));
  try {
    const credentials = await getStoreCredentials(domain);
    const ids = [...new Set(items.map((i) => String(i.variant_id ?? i.id ?? "")).filter((id) => /^\d+$/.test(id)).map((id) => `gid://shopify/ProductVariant/${id}`))];
    if (!ids.length) throw new Error("no variant ids");
    const data = await shopifyGraphQL(credentials, `query LineScope($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id product { title collections(first: 50) { nodes { title } } } } } }`, { ids });
    const byVariant = new Map();
    for (const node of data?.nodes || []) if (node?.id) byVariant.set(node.id.split("/").pop(), node.product);
    // A collection-limited code is only trusted when every collection of the code was read: a code on more collections than were read is not guessed.
    if (discount.limitedTo === "collection" && (discount.scopeNames || []).length >= 10) throw new Error("scope too wide to verify");
    const covered = [];
    for (const item of items) {
      const product = byVariant.get(String(item.variant_id ?? item.id ?? ""));
      if (!product) throw new Error("line not found");
      const hit = discount.limitedTo === "collection"
        ? (product.collections?.nodes || []).some((c) => scope.has(String(c.title).toLowerCase()))
        : scope.has(String(product.title).toLowerCase());
      if (hit) covered.push(item);
    }
    out.eligibleSubtotal = Number(covered.reduce((s, i) => s + lineSubtotal(i), 0).toFixed(2));
    out.coveredVariantIds = covered.map((i) => String(i.variant_id ?? i.id ?? ""));
    out.coveredTitles = covered.map((i) => i.product_title || i.title);
  } catch (error) {
    console.warn("[discounts] could not read which cart lines a limited code covers:", String(error.message).slice(0, 120));
    out.scopeKnown = false;
  }
  return out;
}

export async function getStoreShopifyDiscounts(storeDomain) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  if (!domain) return [];

  const cacheKey = `all_discounts::${domain}`;
  const cached = discountCaches.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOUNT_CACHE_TTL_MS) {
    return cached.discounts;
  }

  try {
    const credentials = await getStoreCredentials(domain);
    // Eligibility fields tell a public promotion (every buyer, unlimited uses) from a private code
    // (staff, influencer, one customer, single-use). Older API versions may lack them: then no code
    // is treated as shareable (fail closed).
    // What a code needs (a minimum spend or quantity) and what it applies to (everything, or named collections/products): without these
    // the assistant offered a code with a $20,000 minimum as if it worked on any cart, and called a one-collection code "store-wide".
    const MIN = `minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }`;
    const ITEMS = `items { __typename ... on DiscountCollections { collections(first: 10) { nodes { title } } } ... on DiscountProducts { products(first: 10) { nodes { title } } } }`;
    const buildQuery = (withEligibility, withDetails = false) => `query ActiveStoreDiscounts {
      discountNodes(first: 25) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountCodeBasic {
              title
              status
              summary
              codes(first: 5) { nodes { code } }${withEligibility ? " usageLimit context { __typename }" : ""}
              ${withDetails ? MIN : ""}
              customerGets {
                ${withDetails ? ITEMS : ""}
                value {
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount currencyCode } }
                }
              }
            }
            ... on DiscountCodeBxgy {
              title
              status
              summary
              codes(first: 5) { nodes { code } }${withEligibility ? " usageLimit context { __typename }" : ""}
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              summary
              codes(first: 5) { nodes { code } }${withEligibility ? " usageLimit context { __typename }" : ""}
              ${withDetails ? MIN : ""}
            }
            ... on DiscountAutomaticBasic {
              title
              status
              summary
              ${withDetails ? MIN : ""}
              customerGets {
                ${withDetails ? ITEMS : ""}
                value {
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount currencyCode } }
                }
              }
            }
            ... on DiscountAutomaticBxgy {
              title
              status
              summary
            }
            ... on DiscountAutomaticFreeShipping {
              title
              status
              summary
              ${withDetails ? MIN : ""}
            }
            ... on DiscountCodeApp {
              title
              status
              codes(first: 5) { nodes { code } }${withEligibility ? " usageLimit context { __typename }" : ""}
            }
            ... on DiscountAutomaticApp {
              title
              status
            }
          }
        }
      }
    }`;

    let data;
    let eligibilityKnown = true;
    try {
      try {
        data = await shopifyGraphQL(credentials, buildQuery(true, true));
      } catch (detailError) {
        console.warn("[discounts] minimum/scope fields unavailable:", String(detailError.message).slice(0, 160));
        data = await shopifyGraphQL(credentials, buildQuery(true));
      }
    } catch (error) {
      console.warn("[discounts] eligibility fields unavailable; no discount code will be shared:", String(error.message).slice(0, 160));
      eligibilityKnown = false;
      data = await shopifyGraphQL(credentials, buildQuery(false));
    }
    const nodes = data?.discountNodes?.nodes || [];
    const activeDiscounts = [];

    for (const node of nodes) {
      const d = node?.discount;
      if (!d || d.status !== "ACTIVE") continue;

      const codeNode = d.codes?.nodes?.[0]?.code || null;
      const code = codeNode ? codeNode.toUpperCase() : null;
      const isAutomatic = d.__typename?.startsWith("DiscountAutomatic") || !code;
      const isFreeShipping = Boolean(d.__typename?.includes("FreeShipping"));
      const isBxgy = Boolean(d.__typename?.includes("Bxgy"));

      let percentage = 0;
      let amount = 0;
      let currencyCode = null;

      if (d.customerGets?.value) {
        const val = d.customerGets.value;
        if (val.percentage != null) {
          const p = Number(val.percentage);
          percentage = p <= 1 ? Math.round(p * 100) : Math.round(p);
        } else if (val.amount != null) {
          amount = Number(val.amount.amount) || 0;
          currencyCode = val.amount.currencyCode;
        }
      }

      const minSubtotal = Number(d.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount) || 0;
      const minCurrency = String(d.minimumRequirement?.greaterThanOrEqualToSubtotal?.currencyCode || "").toUpperCase();
      const minQuantity = Number(d.minimumRequirement?.greaterThanOrEqualToQuantity) || 0;
      const itemsNode = d.customerGets?.items;
      const scopeNames = itemsNode?.__typename === "DiscountCollections"
        ? (itemsNode.collections?.nodes || []).map((c) => c.title).filter(Boolean)
        : itemsNode?.__typename === "DiscountProducts"
          ? (itemsNode.products?.nodes || []).map((c) => c.title).filter(Boolean)
          : [];
      const limitedTo = itemsNode && itemsNode.__typename !== "AllDiscountItems" && itemsNode.__typename ? (itemsNode.__typename === "DiscountCollections" ? "collection" : "product") : "";

      activeDiscounts.push({
        minSubtotal,
        minCurrency,
        minQuantity,
        limitedTo,
        scopeNames,
        id: node.id,
        // May the assistant tell customers about this discount (and its code)?
        shareable: isAutomatic || (eligibilityKnown && discountCodeIsPublic(d)),
        title: d.title || code || "Store Discount",
        code: code,
        summary:
          d.summary ||
          (percentage > 0
            ? `${percentage}% OFF`
            : amount > 0
            ? `Flat discount`
            : isFreeShipping
            ? `Free Shipping`
            : d.title),
        type: isFreeShipping
          ? "free_shipping"
          : isBxgy
          ? "bxgy"
          : percentage > 0
          ? "percentage"
          : amount > 0
          ? "amount"
          : "store_coupon",
        percentage,
        amount,
        currencyCode,
        isFreeShipping,
        isAutomatic,
        status: d.status,
      });
    }

    discountCaches.set(cacheKey, { at: Date.now(), discounts: activeDiscounts });
    return activeDiscounts;
  } catch (error) {
    console.error(
      "[discounts] failed to fetch active discounts from shopify:",
      error.message
    );
    return [];
  }
}

/**
 * The sale on a product, worked out from ONE option's own price and compare-at price. Options of a product can cost and have been
 * marked down differently (TechStore's Xiaomi: 128GB $229 was $269, 256GB $269 was $309), so the original price of one option must never
 * be paired with the price of another. The headline is the requested option, else the cheapest one that is on sale.
 */
export function computeProductSale(product, { variantName = "" } = {}) {
  const currency = product?.currency;
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const money = (n) => formatPriceWithSymbol(n, currency);
  const asSale = (v) => {
    const price = Number(v?.price), was = Number(v?.compareAtPrice);
    if (!(was > price) || !(price > 0)) return null;
    const amount = Number((was - price).toFixed(2));
    return { option: v.title, price, was, amount, percent: Math.round((amount / was) * 100), sellable: v.sellable !== false };
  };
  const all = variants.map(asSale).filter(Boolean);
  const wanted = String(variantName || "").trim().toLowerCase();
  let pool = all;
  let optionAsked = false;
  if (wanted) {
    const matching = variants.filter((v) => variantMatchesWanted(v.title, wanted));
    if (matching.length) {
      optionAsked = true;
      pool = matching.map(asSale).filter(Boolean);
    }
  }
  const variantSales = all.map((x) => ({
    option: x.option, price: x.price, compareAtPrice: x.was, discountAmount: x.amount, discountPercent: x.percent,
    formattedPrice: money(x.price), formattedCompareAtPrice: money(x.was), formattedDiscount: money(x.amount),
  }));
  if (!pool.length) {
    // the option asked for is real but not on sale: say that, never borrow another option's discount
    return { productSale: null, variantSales, requestedOptionNotOnSale: optionAsked };
  }
  const best = [...pool].sort((a, b) => Number(b.sellable) - Number(a.sellable) || a.price - b.price)[0];
  const multiple = variants.length > 1 && !(variants.length === 1 && variants[0].title === "Default Title");
  return {
    variantSales,
    productSale: {
      hasDiscount: true,
      optionName: multiple ? best.option : "",
      originalPrice: best.was,
      salePrice: best.price,
      discountAmount: best.amount,
      discountPercent: best.percent,
      formattedOriginalPrice: money(best.was),
      formattedSalePrice: money(best.price),
      formattedDiscount: money(best.amount),
      saleVariesByOption: new Set(all.map((x) => `${x.percent}|${x.amount}`)).size > 1,
      title: `Direct Sale: ${best.percent}% OFF (Save ${money(best.amount)})`,
    },
  };
}

export async function getProductDiscountsAndOffers(
  storeDomain,
  { productName = "", variantName = "", cart = null } = {}
) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const term = String(productName || "").trim();

  let targetProduct = null;
  let productSale = null;
  let variantSales = [];
  let requestedOptionNotOnSale = false;

  if (term) {
    const products = await searchShopifyProducts(domain, term);
    if (products.length > 0) {
      targetProduct = products[0];
      const computed = computeProductSale(targetProduct, { variantName });
      productSale = computed.productSale;
      variantSales = computed.variantSales;
      requestedOptionNotOnSale = computed.requestedOptionNotOnSale === true;
    }
  }

  const cartItemsCount = cart?.item_count ?? cart?.items?.length ?? 0;
  const cartTotal =
    cart?.total_price != null ? Number(cart.total_price) / 100 : 0;
  const currency = cart?.currency || targetProduct?.currency || ""; // never assumed: unknown means no symbol
  // The cart's total in the store's own currency, for minimum-spend checks (Shopify's own prices; null when not available).
  let storeTotal = null, storeCurrency = "";
  if (cart?.items?.length) {
    const summaryCurrency = String(getCachedCatalogSummary(domain)?.currency || "").toUpperCase();
    if (summaryCurrency && summaryCurrency !== String(currency).toUpperCase()) {
      const inStore = await cartInStoreCurrency(domain, cart).catch(() => null);
      if (inStore && String(inStore.currency || "").toUpperCase() === summaryCurrency && inStore.total_price != null) { storeTotal = Number(inStore.total_price) / 100; storeCurrency = summaryCurrency; }
    }
  }

  const offers = [];

  if (productSale) {
    const on = productSale.optionName ? ` (${productSale.optionName})` : "";
    offers.push({
      type: "product_sale",
      title: productSale.title,
      description: `${targetProduct.title}${on} is on direct ${productSale.discountPercent}% sale (down from ${productSale.formattedOriginalPrice} to ${productSale.formattedSalePrice}).`,
      descriptionHi: `${targetProduct.title}${on} par direct ${productSale.discountPercent}% discount active hai! Original MRP ${productSale.formattedOriginalPrice} se ghat kar ab sirf ${productSale.formattedSalePrice} mein mil raha hai.`,
      appliedAutomatically: true,
      code: null,
      savings: productSale.formattedDiscount,
    });
  }

  const allDiscounts = await getStoreShopifyDiscounts(domain);
  const storeDiscounts = allDiscounts.filter((sd) => sd.shareable !== false);
  for (const sd of storeDiscounts) {
    const { eligible, conditions } = discountEligibility(sd, { total: cartTotal, itemCount: cartItemsCount, storeTotal, storeCurrency }, currency);
    offers.push({
      conditions,
      eligibleForThisCart: eligible,
      type: sd.isFreeShipping
        ? "free_shipping"
        : sd.type === "bxgy"
        ? "bundle_combo"
        : "store_coupon",
      code: sd.code,
      title: sd.title,
      description: sd.summary,
      descriptionHi: sd.summary,
      discountPercent: sd.percentage || 0,
      discountAmount: sd.amount || 0,
      isFreeShipping: sd.isFreeShipping,
      isAutomatic: sd.isAutomatic,
      isEligibleNow: eligible,
      instructions: !eligible
        ? `NOT usable on the current cart: it ${conditions.join("; ")}. Do not offer to apply it; say what it needs.`
        : sd.code
          ? `Say 'apply ${sd.code}' to apply this promo code to your cart.${conditions.length ? " It " + conditions.join("; ") + "." : ""}`
          : `This automatic discount is active on the store.${conditions.length ? " It " + conditions.join("; ") + "." : ""}`,
    });
  }

  const prepaidOffer = await getPrepaidDiscountOffer(domain, cartTotal);
  if (prepaidOffer?.hasDiscount) {
    const alreadyListed = offers.some(
      (o) =>
        o.code &&
        prepaidOffer.code &&
        o.code.toUpperCase() === prepaidOffer.code.toUpperCase()
    );
    if (!alreadyListed) {
      offers.push({
        type: "prepaid_discount",
        code: prepaidOffer.code || null,
        title: prepaidOffer.title || "Prepaid Instant Discount",
        description:
          prepaidOffer.description ||
          "Extra instant discount when paying online via UPI or Card.",
        descriptionHi:
          prepaidOffer.description ||
          "UPI, Cards, ya Online payment karne par extra instant discount milta hai!",
        discountPercent: prepaidOffer.discountPercent || 0,
        discountAmount: prepaidOffer.discountAmount || 0,
        formattedDiscount: prepaidOffer.discountAmount
          ? formatPriceWithSymbol(prepaidOffer.discountAmount, currency)
          : `${prepaidOffer.discountPercent}%`,
        isEligibleNow: true,
        ...(() => {
          const match = allDiscounts.find((d) => d.code && prepaidOffer.code && d.code.toUpperCase() === prepaidOffer.code.toUpperCase());
          if (!match) return {};
          const { eligible, conditions } = discountEligibility(match, { total: cartTotal, itemCount: cartItemsCount, storeTotal, storeCurrency }, currency);
          return { isEligibleNow: eligible, eligibleForThisCart: eligible, conditions };
        })(),
      });
    }
  }

  return {
    status: "ok",
    product: targetProduct
      ? {
          title: targetProduct.title,
          price: targetProduct.price,
          formattedPrice: formatPriceWithSymbol(targetProduct.price, targetProduct.currency),
          currency: targetProduct.currency,
          saleDiscount: productSale,
          // every option's OWN (compare-at -> price): a reply may only quote these pairs, never mix one option's original price with another's price
          variantSales,
          requestedOptionNotOnSale,
        }
      : null,
    cartSummary: {
      itemCount: cartItemsCount,
      total: cartTotal,
      currency,
    },
    offers,
    note: "Share these real-time offers with the customer. If they say 'apply kar do' / 'apply this offer', call apply_discount_or_offer immediately!",
  };
}
