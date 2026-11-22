// Finding the exact product and variant the shopper means, to add it to the cart.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { getStoreCredentials, localizeProducts, shopifyGraphQL } from "./client.js";
import { DEFAULT_VARIANT_TITLE, PRODUCT_FIELDS, mapProduct, publicVariants, visibleStockCount } from "./products.js";
import { graphqlSearch } from "./search.js";
import { SEARCH_STOPWORDS, SIZE_ALIASES, normalizeForMatch, normalizeSearchTypos, stemWord, variantMatchesWanted, variantTokens, wordSet } from "./words.js";

const CART_MIN_CONFIDENCE = 0.55;
const CART_AMBIGUITY_GAP = 0.12;
// Not a store rule: only a request so large it is almost certainly a typo (99999) is asked about instead of being added.
// The ONLY real limit on a quantity is the option's stock, which Shopify enforces itself.
const IMPLAUSIBLE_CART_QUANTITY = 999;

/** How many of this option can be bought: its stock when Shopify tracks it and does not allow overselling; null = no stock limit. */
export function stockLimitOf(variant) {
  if (!variant || !variant.tracked || variant.inventoryPolicy === "CONTINUE") return null;
  // null is "unknown" (the app hides exact stock above the low-stock threshold), never zero
  if (variant.inventoryQuantity == null || variant.inventoryQuantity === "") return null;
  const q = Number(variant.inventoryQuantity);
  return Number.isFinite(q) ? Math.max(0, Math.floor(q)) : null;
}

export function resolveVariant(product, variantName) {
  const allVariants = Array.isArray(product?.variants) ? product.variants : [];
  const sellable = allVariants.filter((v) => v.sellable);

  if (allVariants.length > 0 && sellable.length === 0) {
    return { status: "out_of_stock", title: product.title };
  }

  const wanted = String(variantName || "").trim().toLowerCase();

  if (wanted) {
    let matches = allVariants.filter((candidate) =>
      variantMatchesWanted(candidate.title, wanted)
    );

    // Pure size token (S/M/L/XL): require an exact size token on the variant so "L" never hits "XL"
    const wantedTokens = variantTokens(wanted);
    const pureSize =
      wantedTokens.length === 1 && Boolean(SIZE_ALIASES[wantedTokens[0]]);
    if (pureSize) {
      const sizeKey = wantedTokens[0];
      const sizeAliasSet = new Set(SIZE_ALIASES[sizeKey] || [sizeKey]);
      matches = allVariants.filter((candidate) => {
        const toks = variantTokens(candidate.title);
        // Variant must contain this size alias AND must not be a longer different size
        // e.g. wanted L → allow "L", "L / Blue"; reject "XL", "XXL"
        const hasSize = toks.some((t) => sizeAliasSet.has(t));
        if (!hasSize) return false;
        if (sizeKey === "l" || sizeKey === "lg" || sizeKey === "large") {
          // reject tokens that are xl/xxl/xxxl when asking for L
          if (toks.some((t) => t === "xl" || t === "xxl" || t === "xxxl" || t === "2xl" || t === "3xl")) {
            return false;
          }
        }
        return true;
      });
    }

    if (matches.length === 0 && wanted.length >= 4) {
      matches = allVariants.filter((candidate) => {
        const title = candidate.title.toLowerCase();
        return title.includes(wanted) || wanted.includes(title);
      });
    }

    const sellableMatches = matches.filter((m) => m.sellable);
    if (sellableMatches.length === 1) {
      return { status: "ok", variant: sellableMatches[0] };
    }
    if (sellableMatches.length > 1) {
      // Size matched several colourways — ask which option, list only matching in-stock ones
      return {
        status: "needs_variant",
        title: product.title,
        product,
        options: sellableMatches.map((c) => c.title),
      };
    }
    if (matches.length === 1) {
      const variant = matches[0];
      if (!variant.sellable) {
        return {
          status: "out_of_stock",
          title: product.title,
          variant: variant.title,
          options: sellable.map((c) => c.title).filter((t) => t && t !== DEFAULT_VARIANT_TITLE),
        };
      }
      return { status: "ok", variant };
    }
    if (matches.length > 1) {
      // All matching sizes sold out — report OOS with other in-stock options
      return {
        status: "out_of_stock",
        title: product.title,
        variant: wanted,
        options: sellable.map((c) => c.title).filter((t) => t && t !== DEFAULT_VARIANT_TITLE),
      };
    }

    return {
      status: "needs_variant",
      title: product.title,
      product,
      options: sellable.map((c) => c.title),
    };
  }

  if (product.variants.length === 1) {
    return { status: "ok", variant: product.variants[0] };
  }
  if (sellable.length === 1) {
    return { status: "ok", variant: sellable[0] };
  }

  return {
    status: "needs_variant",
    title: product.title,
    product,
    options: sellable.map((c) => c.title),
  };
}

/**
 * Live re-fetch a single product by GID so cart/stock decisions use current inventory,
 * not a stale card snapshot from an earlier turn.
 */
async function fetchProductById(credentials, productId) {
  const gid = String(productId || "").trim();
  if (!gid) return null;
  const id = gid.startsWith("gid://") ? gid : `gid://shopify/Product/${gid}`;
  try {
    const data = await shopifyGraphQL(
      credentials,
      `query ProductById($id: ID!) {
        product(id: $id) { ${PRODUCT_FIELDS} }
      }`,
      { id }
    );
    if (!data?.product) return null;
    const mapped = mapProduct(data.product, credentials.domain);
    if (mapped.status !== "ACTIVE" || !mapped.published) return null;
    return mapped;
  } catch (err) {
    console.warn(`[cart] fetchProductById failed for ${id}:`, err.message);
    return null;
  }
}

/**
 * Score how well a catalog product title matches the name the customer/LLM used.
 * Prefers exact / substring title matches so we never swap a kurta for a formal shirt.
 */
function scoreCartTitleMatch(product, termNorm) {
  const titleNorm = normalizeForMatch(product?.title || "");
  if (!termNorm || !titleNorm) return 0;
  if (titleNorm === termNorm) return 1;
  if (titleNorm.includes(termNorm) || termNorm.includes(titleNorm)) return 0.92;
  const tWords = termNorm.split(/\s+/).filter((w) => w.length > 1 && !SEARCH_STOPWORDS.has(w));
  if (tWords.length === 0) return 0;
  const titleSet = wordSet(titleNorm);
  let hits = 0;
  for (const w of tWords) {
    if (titleSet.has(stemWord(w)) || titleNorm.includes(w)) hits += 1;
  }
  return hits / tWords.length;
}

export async function resolveCartItem(
  storeDomain,
  { productName = "", variantName = "", quantity = 1, preferredProducts = [] } = {}
) {
  const rawName = String(productName || "")
    .replace(/\([^)]*\)\s*$/, "")
    .trim();
  const term = normalizeSearchTypos(rawName);
  if (!term) return { status: "not_found" };

  const credentials = await getStoreCredentials(storeDomain);
  const termNorm = normalizeForMatch(term);

  // 1) Prefer products already shown in THIS conversation (multi-store safe: per storeId memory).
  //    This stops "add the kurta" from resolving to a different shirt that merely shares a size.
  let best = null;
  const preferred = (Array.isArray(preferredProducts) ? preferredProducts : []).filter(
    (p) => p && (p.title || p.id)
  );
  if (preferred.length > 0) {
    let topScore = 0;
    let top = null;
    for (const p of preferred) {
      const s = scoreCartTitleMatch(p, termNorm);
      // Strong boost when the spoken name is clearly this card
      const boost = s >= 0.5 ? 0.15 : 0;
      const score = s + boost;
      if (score > topScore) {
        topScore = score;
        top = p;
      }
    }
    // Require a real title relationship — never pick preferred[0] just because memory exists
    if (top && topScore >= 0.5) {
      let live = top;
      if (top.id) {
        const refreshed = await fetchProductById(credentials, top.id);
        if (refreshed) live = refreshed;
      } else if (top.title) {
        const hits = await graphqlSearch(credentials, top.title, { first: 3 });
        const exact = hits.find(
          (h) => normalizeForMatch(h.title) === normalizeForMatch(top.title)
        );
        if (exact) live = exact;
        else if (hits[0] && scoreCartTitleMatch(hits[0], normalizeForMatch(top.title)) >= 0.85) {
          live = hits[0];
        }
      }
      best = { ...live, matchConfidence: Math.max(topScore, 0.9) };
    }
  }

  // 2) Catalog search if conversation did not pin a product
  if (!best) {
    const hits = (await graphqlSearch(credentials, term, { first: 5 })).slice(0, 5);
    if (hits.length === 0) return { status: "not_found" };

    const [first, second] = hits;
    const unsure = (first.matchConfidence ?? 0) < CART_MIN_CONFIDENCE;
    const tooClose =
      second &&
      (second.matchConfidence ?? 0) >= CART_MIN_CONFIDENCE &&
      (first.matchConfidence ?? 0) - (second.matchConfidence ?? 0) < CART_AMBIGUITY_GAP;

    // The shopper named one product by its full title ("Boys Kids Wrist Watch"): a close sibling ("Girls Kids Wrist Watch") does not make it ambiguous.
    const sameTitle = hits.filter((h) => normalizeForMatch(h.title) === termNorm);
    const namedExactly = sameTitle.length === 1;
    if (!namedExactly && (unsure || tooClose)) {
      return {
        status: "ambiguous",
        options: hits.map((h) => h.title),
        products: hits,
      };
    }
    best = namedExactly ? sameTitle[0] : first;
    // Live inventory for the chosen hit when we have an id
    if (best.id) {
      const refreshed = await fetchProductById(credentials, best.id);
      if (refreshed) best = { ...refreshed, matchConfidence: best.matchConfidence ?? first.matchConfidence };
    }
  }

  // Every price said to the shopper (cart reply, option list) is in their own currency, like the product cards.
  best = (await localizeProducts(storeDomain, [best]))[0] || best;
  const resolved = resolveVariant(best, variantName);
  if (resolved.status !== "ok") {
    // Always attach LIVE variant list so the agent does not invent "L/M/XL sold out"
    return {
      ...resolved,
      product: { ...best, variants: publicVariants(best.variants) },
      options:
        resolved.options ||
        (best.variants || [])
          .filter((v) => v.sellable)
          .map((v) => v.title)
          .filter((t) => t && t !== DEFAULT_VARIANT_TITLE),
      allVariants: (best.variants || []).map((v) => ({
        name: v.title,
        inStock: Boolean(v.sellable),
        unitsInStock: v.tracked ? visibleStockCount(v.inventoryQuantity) : null,
      })),
    };
  }

  const { variant } = resolved;
  // Final guard: never add a non-sellable variant
  if (variant && variant.sellable === false) {
    const inStockOptions = (best.variants || [])
      .filter((v) => v.sellable)
      .map((v) => v.title)
      .filter((t) => t && t !== DEFAULT_VARIANT_TITLE);
    return {
      status: "out_of_stock",
      title: best.title,
      product: { ...best, variants: publicVariants(best.variants) },
      variant: variant.title,
      options: inStockOptions,
      allVariants: (best.variants || []).map((v) => ({
        name: v.title,
        inStock: Boolean(v.sellable),
        unitsInStock: v.tracked ? visibleStockCount(v.inventoryQuantity) : null,
      })),
    };
  }

  // A quantity the shopper gave that is zero, negative or not a number is asked about, never turned into 1 (it used to be: "add 0" added one).
  const given = quantity !== undefined && quantity !== null && quantity !== "";
  const parsedQuantity = Number.parseInt(quantity, 10);
  if (given && !(parsedQuantity >= 1)) {
    return { status: "quantity_unclear", nonPositive: true, title: best.title, variant: variant.title === DEFAULT_VARIANT_TITLE ? null : variant.title, requestedQuantity: Number.isFinite(parsedQuantity) ? parsedQuantity : null };
  }
  const requested = given ? parsedQuantity : 1;
  const availableQuantity = stockLimitOf(variant);
  if (availableQuantity == null && requested > IMPLAUSIBLE_CART_QUANTITY) {
    return { status: "quantity_unclear", title: best.title, variant: variant.title === DEFAULT_VARIANT_TITLE ? null : variant.title, requestedQuantity: requested };
  }
  const safeQuantity = availableQuantity == null ? requested : Math.min(requested, availableQuantity);

  return {
    status: "ok",
    title: best.title,
    product: { ...best, variants: publicVariants(best.variants) },
    variantTitle: variant.title === DEFAULT_VARIANT_TITLE ? null : variant.title,
    variantId: String(variant.id || "").split("/").pop(),
    quantity: safeQuantity,
    requestedQuantity: requested,
    availableQuantity,
    price: variant.price,
    currency: best.currency,
  };
}

/** Stock limit of one cart line's option, read live from Shopify (cart lines carry no stock). null = no limit or unknown. */
export async function variantStockLimit(storeDomain, productId, variantId) {
  try {
    const credentials = await getStoreCredentials(storeDomain);
    const product = await fetchProductById(credentials, productId);
    const id = String(variantId || "");
    const variant = (product?.variants || []).find((v) => String(v.id || "").split("/").pop() === id);
    return stockLimitOf(variant);
  } catch {
    return null;
  }
}

export { CART_MIN_CONFIDENCE, CART_AMBIGUITY_GAP, IMPLAUSIBLE_CART_QUANTITY, fetchProductById, scoreCartTitleMatch };
