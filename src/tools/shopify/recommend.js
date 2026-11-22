// Recommendations from the store's real, in-stock catalog for a need, a budget or a person.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { getStoreCredentials, localizeProducts, pricingContext } from "./client.js";
import { extractRequestedCategories, hasStock, indexCategories, inferRequestedCategory, slugProductType } from "./products.js";
import { graphqlListProducts, graphqlSearch } from "./search.js";
import { GENDER_OF, GENDER_WORDS, applyShopperBudget, matchesGender, normalizeForMatch, normalizeSearchTypos, parseSearchTerm, productGenders, wordSet } from "./words.js";

export async function recommendProducts(storeDomain, options = {}) {
  const ctx = pricingContext.getStore();
  const budget = Number(options?.maxPrice) > 0 ? Number(options.maxPrice) : 0;
  if (!ctx || !budget) return localizeProducts(storeDomain, await recommendProductsRaw(storeDomain, options));
  // every candidate without the budget, re-priced, then the shopper's budget, then the requested count
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 4;
  const priced = await localizeProducts(storeDomain, await recommendProductsRaw(storeDomain, { ...options, maxPrice: null, limit, wide: true }));
  return applyShopperBudget(priced, budget, ctx.currency).slice(0, limit);
}

export const GENERIC_RECOMMENDATION_WORDS = new Set([
  "recommendation", "recommendations", "recommend", "recommended",
  "suggest", "suggestion", "suggestions", "popular", "trending",
  "bestseller", "bestsellers", "best", "top", "gifts", "gift", "present",
  "all", "anything", "options", "option", "more", "products", "product",
  "items", "item", "stuff", "nice", "good", "something", "kuch", "kch",
  "aur", "dikhao", "dikhaiye", "collection", "naya", "naye", "new",
  "latest", "variety", "shopping", "shop", "store", "outfit", "outfits",
  "clothes", "clothing", "kapde", "kapda", "wear", "attire", "fashion",
  "style", "look", "men", "mens", "women", "womens", "gents", "gent",
  "ladies", "lady", "male", "female", "boy", "boys", "girl", "girls",
  "kids", "apne", "mere", "liye", "self", "casual", "formal", "party",
  "festive", "diwali", "wedding", "summer", "winter", "daily", "comfort", "comfortable",
]);

/**
 * Recommendations built only from this store's own catalog: relevance to what the shopper said,
 * budget, gender when the store's products carry it, exclusions, "already shown" tracking, and
 * variety across the store's own categories. No built-in notion of what any product is for.
 */
async function recommendProductsRaw(
  storeDomain,
  {
    keywords = [],
    keyword = "",
    excludeKeywords = [],
    excludeProductIds = [],
    seenProductTitles = [],
    maxPrice = null,
    limit = 4,
    gender = "",
    seed = 0,
    neutralOnly = false,
    userQuery = "",
    strictCategories = [],
    wide = false,
  } = {}
) {
  // `wide`: the caller filters by a budget in the shopper's currency afterwards, so it needs every eligible
  // candidate (spread over the store's categories), not just the first 8.
  const credentials = await getStoreCredentials(storeDomain);
  const catalog = await graphqlListProducts(credentials, { first: 250 });
  indexCategories(credentials.domain, catalog);

  const rawTerms = [...(Array.isArray(keywords) ? keywords : [keywords]), keyword]
    .map((t) => normalizeSearchTypos(String(t || "").trim()))
    .filter(Boolean);
  const terms = rawTerms
    .filter((t) => !GENERIC_RECOMMENDATION_WORDS.has(t.toLowerCase()))
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 6);

  const toList = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean);
  const excludedWords = toList(excludeKeywords);
  const excludedIds = new Set(toList(excludeProductIds));
  const excludedTitles = new Set(toList(seenProductTitles));
  const isAlreadySeen = (p) =>
    Boolean(p) &&
    ((p.id && excludedIds.has(String(p.id).toLowerCase())) ||
      (p.title && excludedTitles.has(String(p.title).toLowerCase().trim())));

  let targetGender = normalizeForMatch(gender);
  if (GENDER_OF[targetGender]) targetGender = GENDER_OF[targetGender];
  if (!GENDER_WORDS[targetGender]) targetGender = "";
  if (!targetGender) {
    for (const t of [...rawTerms, String(userQuery || "")]) {
      const g = parseSearchTerm(t).gender;
      if (g) {
        targetGender = g;
        break;
      }
    }
  }

  const wanted = wide ? 250 : Math.min(Math.max(Number(limit) || 6, 1), 8);
  const maxRank = wide ? 250 : 8;
  const budget = maxPrice == null ? NaN : Number(maxPrice);
  const withinBudget = (p) => !(Number.isFinite(budget) && budget > 0) || Number(p.price) <= budget;

  const notExcluded = (p) => {
    if (neutralOnly && [...productGenders(p)].some((g) => GENDER_WORDS[g]) && !productGenders(p).has("unisex")) return false;
    if (excludedWords.length === 0) return true;
    const blob = `${p.title || ""} ${p.productType || ""} ${(p.tags || []).join(" ")} ${p.vendor || ""}`.toLowerCase();
    return !excludedWords.some((w) => blob.includes(w));
  };
  // Items made for children are recommended only when the shopper asked for children's things (a boys' puffer jacket is not
  // an answer to "going on a trip"); a search for the word itself still lists them, last.
  const storeHasAdultItems = catalog.some((p) => !productGenders(p).has("kids"));
  const kidsOk = (p) => targetGender === "kids" || !storeHasAdultItems || !productGenders(p).has("kids") || productGenders(p).size > 1;
  const baseEligible = (p) => hasStock(p) && withinBudget(p) && matchesGender(p, targetGender) && notExcluded(p) && kidsOk(p);

  // Categories the shopper named, resolved against THIS store's own product types.
  const named = new Set(
    (Array.isArray(strictCategories) && strictCategories.length > 0
      ? strictCategories.filter(Boolean)
      : [
          ...extractRequestedCategories(userQuery, credentials.domain),
          ...terms.map((t) => inferRequestedCategory(t, credentials.domain)).filter(Boolean),
        ]
    ).filter((c) => !excludedWords.some((w) => c.includes(slugProductType(w))))
  );
  const locked = named.size > 0 && catalog.some((p) => baseEligible(p) && named.has(p.category)) ? named : new Set();
  // Only a gender was asked for ("girls", "for men"): items made for that group, not a mix with neutral items (a power bank for "girls").
  const explicitOnly =
    Boolean(targetGender) && terms.length === 0 && locked.size === 0 &&
    catalog.filter((p) => baseEligible(p) && productGenders(p).has(targetGender)).length >= 3;
  const eligible = (p) =>
    baseEligible(p) && (locked.size === 0 || locked.has(p.category)) && (!explicitOnly || productGenders(p).has(targetGender));

  const picked = [];
  const pickedIds = new Set();
  const take = (p) => {
    if (!p || pickedIds.has(p.id) || picked.length >= wanted) return false;
    pickedIds.add(p.id);
    picked.push(p);
    return true;
  };
  const rotate = (arr) => {
    if (!seed || arr.length < 2) return arr;
    const shift = Math.abs(Number(seed)) % arr.length;
    return [...arr.slice(shift), ...arr.slice(0, shift)];
  };

  // 1) Relevance to what the shopper asked for (one list per term, interleaved).
  const searchTerms = terms.length > 0 ? terms : [];
  const lists = await Promise.all(
    searchTerms.map(async (term) => {
      const hits = await graphqlSearch(credentials, term, { first: wide ? 60 : 8, defaultGender: targetGender });
      const valid = hits
        .filter((p) => !p.notExactMatch && (p.matchConfidence ?? 0) >= 0.45 && eligible(p))
        .map((p) => ({ ...p, forKeyword: term }));
      const unseen = rotate(valid.filter((p) => !isAlreadySeen(p)));
      return [...unseen, ...valid.filter(isAlreadySeen)];
    })
  );
  for (let rank = 0; picked.length < wanted && rank < maxRank; rank++) {
    for (const list of lists) {
      const p = list[rank];
      if (p && !isAlreadySeen(p)) take(p);
    }
  }

  // The shopper named something: items they were already shown may repeat, but we never invent
  // unrelated "recommendations". If the store has nothing for it, the honest answer is an empty list.
  if (terms.length > 0) {
    for (const list of lists) for (const p of list) take(p);
    return picked;
  }

  // 2) Nothing specific asked: spread across the store's own categories.
  if (picked.length < wanted) {
    const pool = catalog.filter((p) => !pickedIds.has(p.id) && eligible(p));
    const queryTokens = wordSet([...terms, String(userQuery || "")].join(" "));
    const score = (p) => {
      const title = wordSet(p.title);
      const rest = wordSet(`${p.productType} ${(p.tags || []).join(" ")} ${p.vendor} ${p.description}`);
      let sc = 0;
      for (const w of queryTokens) {
        if (GENDER_OF[w]) continue;
        if (title.has(w)) sc += 3;
        else if (rest.has(w)) sc += 1.5;
      }
      if (targetGender && productGenders(p).has(targetGender)) sc += 2;
      return sc - (isAlreadySeen(p) ? 50 : 0);
    };
    const ranked = pool.map((p) => ({ p, sc: score(p) })).sort((a, b) => b.sc - a.sc);
    const groups = new Map();
    for (const { p } of ranked) {
      const key = p.category !== "uncategorized" ? p.category : p.vendor || "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const buckets = rotate([...groups.values()]);
    for (let rank = 0; picked.length < wanted && rank < maxRank; rank++) {
      for (const bucket of buckets) {
        const p = bucket[rank];
        if (p && !isAlreadySeen(p)) take(p);
      }
    }
    // 3) Last resort: allow items the shopper has already seen.
    for (const { p } of ranked) take(p);
  }

  return picked;
}

export { recommendProductsRaw };
