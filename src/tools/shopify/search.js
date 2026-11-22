// Product search: Shopify queries, the store's own vocabulary for typos, scoring, and the quick catalog probe.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { isColorToken } from "../productMatch.js";
import { CATALOG_STALE_MAX_MS, SEARCH_CACHE_TTL_MS, hiddenProductTitles, inflightListPromises, searchCaches, vocabCache } from "./caches.js";
import { getStoreCredentials, localizeProducts, pricingContext, shopifyGraphQL } from "./client.js";
import { PRODUCT_FIELDS, categoryKeyFor, classifyProductCategory, hasStock, indexCategories, inferRequestedCategory, compoundCategory, knownCategories, mapProduct, matchesRequestedCategory } from "./products.js";
import { BUDGET_IN_TEXT_RE, CONTEXT_NON_BRAND_WORDS, GENDER_OF, OPTIONAL_ADJECTIVES, SEARCH_STOPWORDS, applyShopperBudget, editDistance, expandWordForms, filterProductsByVariantHints, matchesAllWords, matchesGender, normalizeForMatch, normalizeSearchTypos, parseSearchFilters, parseSearchTerm, productGenders, stemWord, wordSet } from "./words.js";

function buildSearchQuery(term) {
  const cleaned = String(term || "")
    .trim()
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80);

  if (!cleaned) return "status:active";

  const words = cleaned.split(" ").filter((w) => w.length >= 2);
  if (words.length === 0) return `status:active ${cleaned}`;

  const clauses = [];
  for (const w of words) {
    for (const form of expandWordForms(w)) {
      clauses.push(`title:${form}`);
      clauses.push(`tag:${form}`);
      clauses.push(`product_type:${form}`);
    }
  }
  const unique = [...new Set(clauses)];
  return `status:active (${unique.join(" OR ")} OR ${cleaned})`;
}

function buildStrictQuery(words) {
  const groups = words.slice(0, 6).map((w) => {
    const forms = expandWordForms(w);
    const parts = [];
    for (const form of forms) {
      parts.push(`title:${form}`, `tag:${form}`, `product_type:${form}`, `vendor:${form}`, `variant_title:${form}`);
    }
    return `(${parts.join(" OR ")})`;
  });
  return `status:active ${groups.join(" AND ")}`;
}

function scoreMatch(product, term) {
  const qNorm = normalizeForMatch(term);
  if (!qNorm) return 0.5;


  const { gender } = parseSearchTerm(term);
  if (gender && !matchesGender(product, gender)) {
    return 0.05;
  }

  const titleNorm = normalizeForMatch(product.title || "");
  const typeNorm = normalizeForMatch(product.productType || "");
  const tagsNorm = normalizeForMatch((product.tags || []).join(" "));
  const handleNorm = normalizeForMatch(product.handle || "");
  const descNorm = normalizeForMatch((product.description || "").slice(0, 220));

  if (titleNorm === qNorm) return 1;

  const paddedTitle = ` ${titleNorm} `;
  const paddedQ = ` ${qNorm} `;
  if (paddedTitle.startsWith(paddedQ) || paddedQ.startsWith(paddedTitle)) return 0.95;
  if (paddedTitle.includes(paddedQ)) return 0.92;

  const words = qNorm
    .split(/\s+/)
    .filter((w) => w && !SEARCH_STOPWORDS.has(w) && !GENDER_OF[w]);
  if (words.length === 0) return 0.55;

  const titleSet = wordSet(titleNorm);
  const otherSet = wordSet(`${typeNorm} ${tagsNorm} ${handleNorm}`);
  const descSet = wordSet(descNorm);
  const has = (set, w) => set.has(stemWord(w));

  let hit = 0;
  let titleHitCount = 0;
  for (const w of words) {
    if (has(titleSet, w)) {
      hit += 1.0;
      titleHitCount++;
    } else if (has(otherSet, w)) {
      hit += 0.7;
    } else if (has(descSet, w)) {
      hit += 0.65;
    }
  }

  const ratio = hit / words.length;
  const titleBoost = titleHitCount === words.length ? 0.2 : titleHitCount >= 2 ? 0.12 : 0;

  return Math.min(1, Math.max(0.15, ratio * 0.8 + titleBoost));
}

async function runProductQuery(credentials, query, first) {
  const gql = `
    query SearchProducts($first: Int!, $query: String!) {
      products(first: $first, query: $query) {
        edges {
          node { ${PRODUCT_FIELDS} }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(credentials, gql, { first, query });

  return (data?.products?.edges || [])
    .map((edge) => mapProduct(edge.node, credentials.domain))
    .filter((p) => p.status === "ACTIVE" && p.published);
}

// The catalog is read up to MAX_CATALOG_PAGES * 250 products. A caller asking for 250 or more wants the WHOLE catalog (the search
// weighs the store's categories over all of it): cutting it to 250 hid every product after the newest 250 from category search.
const MAX_CATALOG_PAGES = 4;
const MAX_CATALOG_PRODUCTS = MAX_CATALOG_PAGES * 250;
async function graphqlListProducts(credentials, { first = 250 } = {}) {
  const wanted = first >= 250 ? Number.POSITIVE_INFINITY : Math.max(first, 1);
  const fullKey = `${credentials.domain}::list::250`;
  const cachedFull = searchCaches.get(fullKey);

  if (cachedFull && Date.now() - cachedFull.at < SEARCH_CACHE_TTL_MS) {
    return cachedFull.products.slice(0, wanted);
  }

  // Stale-while-revalidate: a catalog that is merely a bit old is served instantly while a fresh copy
  // loads in the background, so the shopper never waits 1-3 s for a re-fetch of the whole catalog.
  const staleUsable = Boolean(cachedFull) && Date.now() - cachedFull.at < CATALOG_STALE_MAX_MS;

  if (inflightListPromises.has(fullKey)) {
    if (staleUsable) return cachedFull.products.slice(0, wanted);
    const all = await inflightListPromises.get(fullKey);
    return all.slice(0, wanted);
  }

  const task = (async () => {
    const fetchStartedAt = Date.now();
    const query = `
      query ListProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
          edges {
            node { ${PRODUCT_FIELDS} }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    // Walk every page so bigger stores are fully visible to the agent (up to 1000 products).
    const MAX_PAGES = MAX_CATALOG_PAGES;
    let after = null;
    const raw = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await shopifyGraphQL(credentials, query, { first: 250, after });
      raw.push(
        ...(data?.products?.edges || []).map((edge) =>
          mapProduct(edge.node, credentials.domain)
        )
      );
      const info = data?.products?.pageInfo;
      if (!info?.hasNextPage || !info?.endCursor) break;
      after = info.endCursor;
    }

    const active = raw.filter((p) => p.status === "ACTIVE");
    const products = active.filter((p) => p.published);
    const hidden = active.filter((p) => !p.published);
    console.log(
      `[catalog] ${credentials.domain}: fetched=${raw.length} active=${active.length} published=${products.length} inStock=${products.filter(hasStock).length} in ${Date.now() - fetchStartedAt} ms${staleUsable ? " (background refresh)" : " (a request waited for this)"}`
    );
    if (hidden.length) {
      console.warn(
        `[catalog] ${credentials.domain}: ${hidden.length} ACTIVE product(s) are not published to the Online Store, so the agent cannot sell them: ${hidden
          .slice(0, 5)
          .map((p) => p.title)
          .join(" | ")}`
      );
    }

    hiddenProductTitles.set(credentials.domain, hidden.map((p) => p.title));
    searchCaches.set(fullKey, { at: Date.now(), products });
    return products;
  })();

  inflightListPromises.set(fullKey, task);
  if (staleUsable) {
    task
      .catch((error) => console.warn("[catalog] background refresh failed:", error.message))
      .finally(() => inflightListPromises.delete(fullKey));
    return cachedFull.products.slice(0, wanted);
  }
  try {
    const all = await task;
    return all.slice(0, wanted);
  } finally {
    inflightListPromises.delete(fullKey);
  }
}

function computeUnmatchedQueryWords(product, words = [], requestedCategory = "") {
  if (!Array.isArray(words) || words.length === 0) return [];
  const haystack = wordSet(
    [
      product?.title,
      product?.description,
      product?.productType,
      product?.vendor,
      (product?.tags || []).join(" "),
      product?.handle,
      ...(product?.variants || []).map((v) => v.title),
    ]
      .filter(Boolean)
      .join(" ")
  );
  const unmatched = [];
  for (const w of words) {
    const cleanW = String(w || "").toLowerCase().trim();
    if (!cleanW || cleanW.length < 2) continue;
    if (SEARCH_STOPWORDS.has(cleanW) || OPTIONAL_ADJECTIVES.has(cleanW) || CONTEXT_NON_BRAND_WORDS.has(cleanW)) continue;
    if (GENDER_OF[cleanW] || isColorToken(cleanW)) continue;
    const wCat = inferRequestedCategory(cleanW);
    if (wCat && (wCat === requestedCategory || wCat === (product?.category || classifyProductCategory(product)))) continue;
    if (haystack.has(stemWord(cleanW)) || haystack.has(cleanW)) continue;
    if (!unmatched.includes(cleanW)) unmatched.push(cleanW);
  }
  return unmatched;
}

function storeVocabulary(domain, catalog = []) {
  const key = String(domain || "").toLowerCase();
  const sig = `${catalog.length}:${catalog[0]?.id || ""}:${catalog[catalog.length - 1]?.id || ""}`;
  const hit = vocabCache.get(key);
  if (hit && hit.sig === sig) return hit;
  const core = new Set();
  const named = new Set();
  const all = new Set();
  for (const p of catalog) {
    for (const t of wordSet([p.title, p.productType, p.vendor, (p.tags || []).join(" "), p.handle].filter(Boolean).join(" "))) {
      core.add(t);
      all.add(t);
    }
    for (const t of wordSet([p.title, p.productType, (p.tags || []).join(" "), p.handle].filter(Boolean).join(" "))) named.add(t);
    for (const t of wordSet(p.description || "")) all.add(t);
  }
  // coreList also holds brand names; a short word ("band") must not turn into a brand ("brand"), so it only looks at the
  // words used for the products themselves (namedList).
  const vocab = { sig, core, all, named, coreList: [...core].filter((w) => w.length >= 4), namedList: [...named].filter((w) => w.length >= 4) };
  vocabCache.set(key, vocab);
  return vocab;
}

// Letters next to each other on a QWERTY keyboard: a slip of the finger lands on one of them.
const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function adjacentKeys(a, b) {
  for (let r = 0; r < KEY_ROWS.length; r++) {
    const i = KEY_ROWS[r].indexOf(a);
    if (i < 0) continue;
    for (const rr of [r - 1, r, r + 1]) {
      const j = KEY_ROWS[rr]?.indexOf(b);
      if (j >= 0 && Math.abs(i - j) <= 1 && !(rr === r && i === j)) return true;
    }
  }
  return false;
}

// A one-letter swap ("band" -> "bank", "tracker" -> "trucker") turns a real word into another real word. It is a typo
// only when the two letters sit next to each other on the keyboard; missing, extra or transposed letters are typos anyway.
// Letters people mix up when typing a word the way it sounds (labtop for laptop), in any language written in Roman letters.
const SOUND_PAIRS = ["bp", "dt", "gk", "ck", "sz", "vw"];
const soundAlike = (a, b) => SOUND_PAIRS.some((p) => (p[0] === a && p[1] === b) || (p[1] === a && p[0] === b));

function plausibleTypo(word, candidate) {
  if (word.length !== candidate.length) return true;
  const diff = [];
  for (let i = 0; i < word.length; i++) if (word[i] !== candidate[i]) diff.push(i);
  if (diff.length !== 1) return true;
  const [i] = diff;
  // The last letter of a longer word carries its meaning (printer/printed, worker/worked): a slip there is not assumed.
  if (i === word.length - 1 && word.length >= 5) return false;
  return adjacentKeys(word[i], candidate[i]) || soundAlike(word[i], candidate[i]);
}

function nearestVocabWord(word, vocab) {
  const w = stemWord(String(word || "").toLowerCase());
  if (w.length < 4 || !/^[a-z]+$/.test(w)) return null;
  if (vocab.all.has(w) || SEARCH_STOPWORDS.has(w) || GENDER_OF[w]) return null;
  const maxD = w.length >= 8 ? 2 : 1;
  let best = null;
  let bestScore = Infinity;
  for (const c of w.length < 6 && vocab.namedList ? vocab.namedList : vocab.coreList) {
    if (c[0] !== w[0] || Math.abs(c.length - w.length) > maxD) continue;
    const d = editDistance(w, c, maxD);
    if (d > maxD || !plausibleTypo(w, c)) continue;
    // On a tie a missing or extra letter ("wach" -> "watch") beats swapping one for another ("wash").
    const score = d * 2 + (c.length === w.length ? 1 : 0);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// "powerbank" for the store's "Power Banks", "gift card" for its "giftcard": shoppers split and join words differently
// from the store. Only a spelling the store itself uses (never a guess) is taken.
function reshapeWords(term, vocab) {
  const tokens = String(term || "").split(/\s+/).filter(Boolean);
  const plain = (t) => /^[a-z]+$/.test(t);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i].toLowerCase();
    const b = (tokens[i + 1] || "").toLowerCase();
    if (b && plain(a) && plain(b) && vocab.core.has(stemWord(a + b)) && !vocab.core.has(stemWord(a + " " + b))) {
      out.push(a + b);
      i++;
      continue;
    }
    if (plain(a) && a.length >= 6 && !vocab.all.has(stemWord(a))) {
      let split = null;
      for (let k = 3; k <= a.length - 3 && !split; k++) {
        const left = a.slice(0, k);
        const right = a.slice(k);
        if (vocab.core.has(stemWord(left)) && vocab.core.has(stemWord(right))) split = `${left} ${right}`;
      }
      if (split) {
        out.push(split);
        continue;
      }
    }
    out.push(tokens[i]);
  }
  return out.join(" ");
}

/** Replaces words that are not in the store's vocabulary by their closest vocabulary word. */
export function correctToVocabulary(term, vocab) {
  if (!vocab) return String(term || "");
  return reshapeWords(String(term || ""), vocab)
    .split(/(\s+)/)
    .map((tok) => {
      const lower = tok.toLowerCase().replace(/[^a-z]/g, "");
      if (!lower || lower !== tok.toLowerCase()) return tok;
      return nearestVocabWord(lower, vocab) || tok;
    })
    .join("");
}

// Confidence of a product whose only link to the search is a word in its description: shown to the model, but a card
// appears only when the reply names it.
export const DESCRIPTION_ONLY_CONFIDENCE = 0.5;

async function graphqlSearchOnce(credentials, searchTerm, { first = 12, defaultGender = "", maxPrice = 0, ignoreGender = false } = {}) {
  // The store's own catalog drives everything: load it first and learn this store's categories.
  const catalog = await graphqlListProducts(credentials, { first: 250 });
  indexCategories(credentials.domain, catalog);
  const vocab = storeVocabulary(credentials.domain, catalog);
  const term = correctToVocabulary(String(searchTerm || "").trim(), vocab);
  const parsed = parseSearchTerm(term);
  const gender = ignoreGender ? "" : parsed.gender || defaultGender || "";
  const filters = parseSearchFilters(term, { gender });
  // "phone" names the store's whole Smartphones category even though most phones never use the word "phone" in their text
  // ...but only while the store can sell something from that category: a one-item "Bags" type that is sold out must not
  // hide the Laptop Bags and School Bags that the shopper's word "bag" also names.
  const categoryOf = (p) => p.category || classifyProductCategory(p);
  const keyStems = (key) => String(key).split("_").filter(Boolean).map(stemWord);
  const categoryHasStock = (key) => {
    if (!key) return false;
    // Stock counts by the store's own type: an item that merely NAMES the kind (a "School Bag" for the type "Bags") does not make the type stocked.
    if (catalog.some((p) => categoryOf(p) === key && hasStock(p))) return true;
    // Sold out: still the category asked for, unless a related category (sharing a word) has stock to offer instead.
    const stems = keyStems(key);
    return !catalog.some((p) => hasStock(p) && categoryOf(p) !== key && keyStems(categoryOf(p)).some((t) => stems.includes(t)));
  };
  const isCanonicalCatKey =
    categoryHasStock(categoryKeyFor(term, knownCategories(credentials.domain))) ||
    categoryHasStock(compoundCategory(term, knownCategories(credentials.domain)));
  const queryWords = parsed.words.filter((w) => !isColorToken(w) && !filters.sizes.includes(w));
  // A query made only of colour words ("navy blue") is matched on those words instead of matching nothing.
  let words = isCanonicalCatKey ? [] : queryWords.length > 0 ? queryWords : parsed.words.filter((w) => !filters.sizes.includes(w));
  // Two or more words that ALL stand in a product's own name name that product, whatever store type it is filed under
  // ("laptop backpack" is a backpack even though the word "laptop" is also the store's type "Laptops").
  const namedInTitle = (p) => queryWords.length >= 2 && matchesAllWords({ title: p.title }, queryWords);

  const cacheKey = `${credentials.domain}::search::${term.toLowerCase()}::${gender}::${ignoreGender ? "ig" : ""}::${first}::${maxPrice}`;
  const cached = searchCaches.get(cacheKey);

  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return cached.products;
  }

  const inferredCategory =
    inferRequestedCategory(term, credentials.domain) ||
    categoryKeyFor(term, knownCategories(credentials.domain));
  // A category label is only trusted when THIS store really has products in it (matching gender if gendered).
  let requestedCategory = !categoryHasStock(inferredCategory)
    ? ""
    : inferredCategory && catalog.some((p) => matchesRequestedCategory(p, inferredCategory) && matchesGender(p, gender))
      ? inferredCategory
      : inferredCategory && catalog.some((p) => matchesRequestedCategory(p, inferredCategory))
      ? inferredCategory
      : "";
  // complete unless the read stopped at its page limit (then some products are not here)
  const isCompleteCatalogInMemory = catalog.length > 0 && catalog.length < MAX_CATALOG_PRODUCTS;

  // Build store vocabulary from the live catalog so conversational words not in this store don't block real matches
  const storeWordSet = new Set();
  for (const p of catalog) {
    const pSet = wordSet(
      [p.title, p.description, p.productType, p.vendor, (p.tags || []).join(" "), p.handle]
        .filter(Boolean)
        .join(" ")
    );
    for (const tok of pSet) storeWordSet.add(tok);
  }
  // "samsung phone", "cell phone": one word names a whole category of this store ("phone" = Smartphones). The category is
  // kept and the other words only narrow it; words the store never uses ("cell") are noise and do not block the answer.
  const knownCats = knownCategories(credentials.domain);
  const categoryOfWord = (w) => {
    const direct = categoryKeyFor(w, knownCats) || compoundCategory(w, knownCats);
    return categoryHasStock(direct) ? direct : "";
  };
  const categoryWords = words.filter((w) => categoryOfWord(w));
  if (categoryWords.length === 1 && words.length > 1) {
    const category = categoryOfWord(categoryWords[0]);
    const narrowing = words.filter((w) => w !== categoryWords[0] && storeWordSet.has(stemWord(w)));
    const narrowed = catalog.some((p) => matchesRequestedCategory(p, category) && matchesAllWords({ ...p, description: "" }, narrowing));
    // "phone case" must stay the phone covers: the category is taken only when the other words fit something in it.
    if (narrowing.length === 0 || narrowed) {
      requestedCategory = category;
      words = narrowing;
    }
  }
  const knownStoreWords = words.filter((w) => storeWordSet.has(stemWord(w)));

  let strictProducts = [];
  if (words.length > 0) {
    if (isCompleteCatalogInMemory) {
      strictProducts = catalog
        .filter(
          (p) =>
            matchesAllWords(p, words) &&
            (matchesRequestedCategory(p, requestedCategory, term) || namedInTitle(p)) &&
            matchesGender(p, gender)
        )
        .map((p) => {
          const isKidsItem = productGenders(p).has("kids");
          const kidsPenalty = gender !== "kids" && isKidsItem ? -0.15 : 0;
          // A word found only in the description of an item ("tv" in a phone's text) does not make it that item.
          const named = matchesAllWords({ ...p, description: "" }, words);
          return {
            ...p,
            matchConfidence: named ? Math.max(scoreMatch(p, term) + kidsPenalty, 0.72) : DESCRIPTION_ONLY_CONFIDENCE,
            matchKind: named ? "exact" : "description",
          };
        });
      // If conversational noise words prevented strict match, match against knownStoreWords when there are no unmatched brand words
      // Only real words count here: a leftover number ("5" from "PlayStation 5") is not the item.
      const meaningfulWords = knownStoreWords.filter((w) => w.length >= 2 && !/^\d+$/.test(w));
      if (strictProducts.length === 0 && meaningfulWords.length > 0 && !requestedCategory) {
        // Only products that name the word count: an item that merely mentions "fitness" in its text is not a fitness band.
        strictProducts = catalog
          .filter(
            (p) =>
              matchesAllWords({ ...p, description: "" }, meaningfulWords) &&
              matchesGender(p, gender)
          )
          .map((p) => {
            const unmatched = computeUnmatchedQueryWords(p, words, requestedCategory);
            return {
              ...p,
              ...(unmatched.length > 0 ? { unmatchedQueryWords: unmatched } : {}),
              matchConfidence: Math.max(scoreMatch(p, meaningfulWords.join(" ")), 0.7),
              matchKind: unmatched.length > 0 ? "category" : "exact",
            };
          });
      }
    } else {
      const fetchCount = Math.min(Math.max(first * (gender ? 3 : 2), first, 12), 30);
      try {
        const strict = await runProductQuery(credentials, buildStrictQuery(words), fetchCount);
        strictProducts = strict
          .filter(
            (p) =>
              matchesAllWords(p, words) &&
              (matchesRequestedCategory(p, requestedCategory) || namedInTitle(p)) &&
              matchesGender(p, gender)
          )
          .map((p) => ({ ...p, matchConfidence: Math.max(scoreMatch(p, term), 0.65), matchKind: "exact" }));
      } catch (error) {
        console.warn("[catalog] strict search failed:", error.message);
      }
    }
  }

  // "girls", "for men": only a gender was named, so the items made for that group are the answer (not a loose guess).
  if (strictProducts.length === 0 && !requestedCategory && parsed.words.length === 0 && gender) {
    strictProducts = catalog
      .filter((p) => productGenders(p).has(gender))
      .map((p) => ({ ...p, matchConfidence: 0.7, matchKind: "exact" }));
  }

  let categoryMatches = [];
  if (requestedCategory && strictProducts.length === 0) {
    categoryMatches = catalog
      .filter(
        (p) =>
          matchesRequestedCategory(p, requestedCategory, term) &&
          matchesGender(p, gender)
      )
      .map((p) => {
        const isKidsItem = productGenders(p).has("kids");
        const kidsPenalty = gender !== "kids" && isKidsItem ? -0.18 : 0;
        const unmatched = computeUnmatchedQueryWords(p, words, requestedCategory);
        return {
          ...p,
          ...(unmatched.length > 0 ? { unmatchedQueryWords: unmatched } : {}),
          matchConfidence: Math.max(scoreMatch(p, term) + kidsPenalty, 0.58),
          matchKind: "category",
        };
      });
    // Products whose own name says the word but that the owner filed under a catch-all type ("Boys Kids Wrist Watch" under "Gift",
    // while the store's "Watches" type holds the adult ones) are watches too. A type is a catch-all when few of its products name
    // the word; a type of its own (the "Phone Covers" for "phone") is left alone.
    if (categoryMatches.length > 0 && queryWords.length > 0) {
      const namesWord = (p) => matchesAllWords({ title: p.title }, queryWords) || matchesAllWords({ title: p.title }, queryWords.map(stemWord));
      const sizeOfType = new Map();
      const namingInType = new Map();
      for (const p of catalog) {
        const key = categoryOf(p);
        sizeOfType.set(key, (sizeOfType.get(key) || 0) + 1);
        if (namesWord(p)) namingInType.set(key, (namingInType.get(key) || 0) + 1);
      }
      const already = new Set(categoryMatches.map((p) => p.id));
      for (const p of catalog) {
        if (already.has(p.id) || !namesWord(p) || !matchesGender(p, gender)) continue;
        const key = categoryOf(p);
        if ((namingInType.get(key) || 0) / (sizeOfType.get(key) || 1) > 0.3) continue;
        categoryMatches.push({ ...p, matchConfidence: 0.7, matchKind: "exact" });
      }
    }
  }

  let looseProducts = [];
  if (strictProducts.length === 0 && categoryMatches.length === 0) {
    if (requestedCategory) {
      searchCaches.set(cacheKey, { at: Date.now(), products: [] });
      return [];
    }

    if (isCompleteCatalogInMemory) {
      looseProducts = catalog
        .filter(
          (p) =>
            matchesGender(p, gender)
        )
        .map((p) => {
          const unmatched = computeUnmatchedQueryWords(p, words, requestedCategory);
          return {
            ...p,
            ...(unmatched.length > 0 ? { unmatchedQueryWords: unmatched } : {}),
            matchConfidence: scoreMatch(p, term),
            matchKind: "loose",
          };
        })
        .filter((p) => p.matchConfidence >= 0.48);
    } else {
      const fetchCount = Math.min(Math.max(first * 2, 12), 25);
      const loose = await runProductQuery(
        credentials,
        buildSearchQuery(words.length ? words.join(" ") : term),
        fetchCount
      );
      looseProducts = loose
        .filter((p) => matchesGender(p, gender))
        .map((p) => {
          const unmatched = computeUnmatchedQueryWords(p, words, requestedCategory);
          return {
            ...p,
            ...(words.length > 0 ? { notExactMatch: true } : {}),
            ...(unmatched.length > 0 ? { unmatchedQueryWords: unmatched } : {}),
            matchConfidence: words.length > 0 ? Math.min(scoreMatch(p, term), 0.45) : 0.6,
          };
        });
    }
  }

  const mergedMap = new Map();
  for (const item of [...strictProducts, ...categoryMatches, ...looseProducts]) {
    const existing = mergedMap.get(item.id);
    if (!existing || (item.matchConfidence ?? 0) > (existing.matchConfidence ?? 0)) {
      mergedMap.set(item.id, item);
    }
  }

  // Prefer sellable products, but never hide a real match just because it is sold out:
  // the agent must be able to say "it exists but is out of stock" instead of "we don't have it".
  const mergedAll = [...mergedMap.values()];
  const mergedInStock = mergedAll.filter((p) => hasStock(p));
  let candidatePool = mergedInStock.length > 0 ? mergedInStock : mergedAll;
  // A word found only in a description ("shirt" in a pair of jeans' text) never sits beside products that are named by it.
  if (candidatePool.some((p) => p.matchKind !== "description")) candidatePool = candidatePool.filter((p) => p.matchKind !== "description");

  // A describing word the search ignores ("maternity", "party", "summer") still tells products apart when THIS store uses it in
  // its own names, types or tags: "maternity dress" is the store's maternity dresses, not every dress. Taken only when some
  // product has the word, so a store that never uses it still answers with the plain item.
  const describing = normalizeForMatch(term).split(/\s+/).filter((w) => w.length >= 4 && OPTIONAL_ADJECTIVES.has(w) && vocab.named.has(stemWord(w)));
  if (describing.length > 0) {
    const named = (p) => wordSet([p.title, p.productType, (p.tags || []).join(" "), p.handle].filter(Boolean).join(" "));
    const preferred = candidatePool.filter((p) => {
      const set = named(p);
      return describing.every((w) => set.has(stemWord(w)));
    });
    if (preferred.length > 0) candidatePool = preferred;
  }

  // A sold-out product the shopper named in full stays in the answer beside the in-stock ones, so the agent can say
  // "that one is sold out, these are available" instead of acting as if it did not exist.
  if (mergedInStock.length > 0) candidatePool = [...candidatePool, ...mergedAll.filter((p) => !hasStock(p) && namedInTitle(p) && !candidatePool.includes(p))];

  const genderLead = (p) => {
    if (!gender) return 0;
    const made = productGenders(p);
    return made.has(gender) && !made.has("unisex") ? 0.4 : 0;
  };
  const products = filterProductsByVariantHints(candidatePool, term, { gender, maxPrice, keepSoldOut: true })
    // made for the group asked for ("watch for my son"): those lead, the unisex items follow
    .sort((a, b) => ((b.matchConfidence ?? 0) + genderLead(b)) - ((a.matchConfidence ?? 0) + genderLead(a)))
    .slice(0, Math.max(first, 1));

  searchCaches.set(cacheKey, { at: Date.now(), products });
  return products;
}

/**
 * Gender is a preference, not a wall: if nothing matches for that gender but the store does have the
 * item, return it flagged (genderMismatch) so the agent can say so honestly instead of "we have none".
 */
async function graphqlSearch(credentials, searchTerm, opts = {}) {
  const found = await graphqlSearchOnce(credentials, searchTerm, opts);
  if (found.length > 0) return found;
  const wanted = parseSearchTerm(String(searchTerm || "")).gender || opts.defaultGender || "";
  if (!wanted) return found;
  const relaxed = await graphqlSearchOnce(credentials, searchTerm, { ...opts, ignoreGender: true });
  return relaxed.map((p) => ({
    ...p,
    genderMismatch: true,
    notExactMatch: true,
    requestedGender: wanted,
    matchConfidence: Math.min(p.matchConfidence ?? 0.45, 0.45),
  }));
}

/**
 * Cheap, data-driven look at the live catalog for a free-form customer message. No keyword lists:
 * words are mapped onto the store's own vocabulary and a product must contain all of them.
 * Returns [] when the message has no product words at all.
 */
export async function probeCatalog(storeDomain, message = "", { limit = 6 } = {}) {
  try {
    const credentials = await getStoreCredentials(storeDomain);
    const catalog = await graphqlListProducts(credentials, { first: 250 });
    if (!catalog.length) return [];
    indexCategories(credentials.domain, catalog);
    const vocab = storeVocabulary(credentials.domain, catalog);
    const corrected = correctToVocabulary(String(message || ""), vocab);
    const parsed = parseSearchTerm(corrected);
    const known = parsed.words.filter((w) => vocab.all.has(stemWord(w)));
    if (known.length === 0) return [];
    // The same matching the search tool uses (the store's own categories, brand and describing words), on the words the
    // store knows: the model reads these results first, so a loose guess here ("phone" -> phone cases) would mislead it.
    const hits = (await graphqlSearch(credentials, known.join(" "), { first: 60, defaultGender: parsed.gender || "" }))
      .filter((p) => Number(p.matchConfidence ?? 1) >= 0.55);
    // Every product in the store matching is not a signal (e.g. a store-wide word): skip.
    if (hits.length === 0 || hits.length > Math.max(12, catalog.length * 0.6)) return [];
    // The shopper's own limits (a budget, a colour, a size) apply here exactly as in the search tool. The model reads this list
    // before anything else, and a phone over the stated budget in it was offered as "within your budget".
    const ranked = filterProductsByVariantHints(
      hits.sort((a, b) => (hasStock(b) ? 1 : 0) - (hasStock(a) ? 1 : 0) || b.matchConfidence - a.matchConfidence),
      String(message || ""),
      { keepSoldOut: true }
    ).slice(0, limit);
    return await localizeProducts(storeDomain, ranked);
  } catch (error) {
    console.warn("[probe] catalog probe failed:", error.message);
    return [];
  }
}

async function searchShopifyProductsRaw(
  storeDomain,
  searchTerm = "",
  { defaultGender = "", color = "", size = "", maxPrice = 0, excludeProductIds = [], seenProductTitles = [], seed = 0, wide = false } = {}
) {
  // `wide`: the caller will filter by a budget in the shopper's currency afterwards, so it needs the whole
  // catalog window, not just the few best matches (a cheap item ranked 40th must still be found).
  const credentials = await getStoreCredentials(storeDomain);
  const term = normalizeSearchTypos([String(searchTerm || "").trim(), color, size].filter(Boolean).join(" "));

  const excludedIds = new Set((excludeProductIds || []).map(String).filter(Boolean));
  const excludedTitles = new Set(
    (seenProductTitles || []).map((t) => String(t || "").toLowerCase().trim()).filter(Boolean)
  );
  const isAlreadySeen = (p) =>
    (p?.id && excludedIds.has(String(p.id))) ||
    (p?.title && excludedTitles.has(String(p.title).toLowerCase().trim()));

  if (!term) {
    const all = await graphqlListProducts(credentials, { first: wide ? 250 : 30 });
    let filtered = defaultGender ? all.filter((p) => matchesGender(p, defaultGender)) : all;
    filtered = filtered.filter(
      (p) => hasStock(p)
    );

    const unseen = filtered.filter((p) => !isAlreadySeen(p));
    let candidates = unseen.length >= 4 ? unseen : filtered;
    if (seed && candidates.length > 1) {
      const shift = Math.abs(Number(seed)) % candidates.length;
      candidates = [...candidates.slice(shift), ...candidates.slice(0, shift)];
    }
    return candidates.slice(0, wide ? 250 : 12);
  }

  const productQuery = term;
  let products = await graphqlSearch(credentials, productQuery || term, {
    first: wide ? 100 : 15,
    defaultGender, maxPrice,
  });

  const genderRelaxed = products.length > 0 && products.every((p) => p.genderMismatch);
  products = filterProductsByVariantHints(products, term, { gender: genderRelaxed ? "" : parseSearchFilters(term).gender || defaultGender, color, size, maxPrice, keepSoldOut: true });

  if (products.length > 1) {
    const unseen = products.filter((p) => !isAlreadySeen(p));
    const seenItems = products.filter((p) => isAlreadySeen(p));
    if (unseen.length > 0) {
      products = [...unseen, ...seenItems];
    } else if (seed && products.length > 1) {
      const shift = Math.abs(Number(seed)) % products.length;
      products = [...products.slice(shift), ...products.slice(0, shift)];
    }
  }

  return products;
}

async function searchShopifyProductsManyRaw(
  storeDomain,
  searchTerms = [],
  { defaultGender = "" } = {}
) {
  const credentials = await getStoreCredentials(storeDomain);
  const terms = [...new Set(
    (Array.isArray(searchTerms) ? searchTerms : [searchTerms])
      .map((t) => normalizeSearchTypos(String(t || "").trim()))
      .filter(Boolean)
  )].slice(0, 5);

  if (terms.length === 0) {
    const products = await graphqlListProducts(credentials, { first: 6 });
    return [{ term: "", products }];
  }

  if (terms.length === 1) {
    const products = await graphqlSearch(credentials, terms[0], {
      first: 10,
      defaultGender,
    });
    return [{ term: terms[0], products }];
  }

  const groups = await Promise.all(
    terms.map(async (term) => {
      const rawProducts = await graphqlSearch(credentials, term, {
        first: 8,
        defaultGender,
      });
      const inStock = rawProducts.filter((p) => hasStock(p));
      return { term, products: inStock.length > 0 ? inStock : rawProducts };
    })
  );

  return groups;
}

// Public product producers: same results as before, re-priced into the shopper's currency when needed.
export async function searchShopifyProducts(storeDomain, searchTerm = "", options = {}) {
  const ctx = pricingContext.getStore();
  const budget = Number(options?.maxPrice) > 0 ? Number(options.maxPrice) : parseSearchFilters(searchTerm).maxPrice;
  // "cheapest" / "most expensive": the whole catalog is looked at, in the shopper's currency, then ordered by price.
  const sort = options?.sort === "price_low" || options?.sort === "price_high" ? options.sort : "";
  if (sort) {
    const shopperBudget = ctx && budget > 0;
    const term = shopperBudget ? String(searchTerm || "").replace(BUDGET_IN_TEXT_RE, " ").replace(/\s+/g, " ").trim() : searchTerm;
    let priced = await localizeProducts(storeDomain, await searchShopifyProductsRaw(storeDomain, term, { ...options, maxPrice: shopperBudget ? 0 : options.maxPrice, wide: true }));
    if (shopperBudget) priced = applyShopperBudget(priced, budget, ctx.currency);
    const direction = sort === "price_low" ? 1 : -1;
    return [...priced].sort((a, b) => (Number(a.price) - Number(b.price)) * direction).slice(0, 12);
  }
  if (!ctx || !(budget > 0)) {
    return localizeProducts(storeDomain, await searchShopifyProductsRaw(storeDomain, searchTerm, options));
  }
  const term = String(searchTerm || "").replace(BUDGET_IN_TEXT_RE, " ").replace(/\s+/g, " ").trim();
  const priced = await localizeProducts(storeDomain, await searchShopifyProductsRaw(storeDomain, term, { ...options, maxPrice: 0, wide: true }));
  return applyShopperBudget(priced, budget, ctx.currency).slice(0, 12);
}
export async function searchShopifyProductsMany(storeDomain, ...rest) {
  const groups = await searchShopifyProductsManyRaw(storeDomain, ...rest);
  return Promise.all(groups.map(async (g) => ({ ...g, products: await localizeProducts(storeDomain, g.products) })));
}

export { buildSearchQuery, buildStrictQuery, scoreMatch, runProductQuery, graphqlListProducts, computeUnmatchedQueryWords, storeVocabulary, nearestVocabWord, graphqlSearchOnce, graphqlSearch, searchShopifyProductsRaw, searchShopifyProductsManyRaw };
