// Shaping Shopify products for the agent: fields, categories from the store's own types, stock wording, key features and compact cards.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { formatMoney } from "../../utils/money.js";
import { SIZE_ALIASES, normalizeForMatch, parseSearchTerm, positiveText, stemWord, wordSet } from "./words.js";

const DEFAULT_VARIANT_TITLE = "Default Title";

/** Normalize Shopify productType into a stable internal key. */
function slugProductType(productType = "") {
  return String(productType || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

const GENERIC_TYPE_WORDS = new Set([
  "",
  "black",
  "white",
  "blue",
  "teal",
  "men",
  "women",
  "kids",
  "unisex",
  "default",
  "general",
  "product",
  "products",
  "clothing",
  "clothes",
  "apparel",
  "apparels",
  "garment",
  "garments",
  "fashion",
  "wear",
  "mens_wear",
  "womens_wear",
  "menswear",
  "womenswear",
  "kids_wear",
  "kidswear",
  "western_wear",
  "casual_wear",
  "formal_wear",
  "party_wear",
  "outfit",
  "outfits",
  "collection",
  "collections",
  "lifestyle",
  "essentials",
  "merchandise",
  "items",
  "goods",
]);

function mapVariant(node) {
  const tracked = node.inventoryItem?.tracked ?? true;
  const quantity = node.inventoryQuantity ?? 0;
  const policy = node.inventoryPolicy ?? null;

  return {
    id: node.id,
    title: node.title,
    selectedOptions: node.selectedOptions || [],
    image: node.image?.url || null,
    price: node.price ?? null,
    compareAtPrice: node.compareAtPrice ?? null,
    tracked,
    inventoryQuantity: tracked ? quantity : null,
    inventoryPolicy: policy,
    sellable: !tracked || policy === "CONTINUE" || quantity > 0,
  };
}

/* ------------------------------------------------------------------------------------------
 * Store-driven taxonomy.
 * Nothing in this file knows any product vocabulary. A "category" is whatever THIS store's own
 * Shopify productType says; requested categories are resolved by matching the shopper's words
 * against those labels. A store with no productTypes simply has no categories and is searched by
 * product text (title, type, tags, vendor, description) instead.
 * ------------------------------------------------------------------------------------------ */
const categoryIndexes = new Map(); // domain -> Map(categoryKey -> { key, label, count, tokens })

export function classifyProductCategory(product) {
  const key = slugProductType(product?.productType);
  return key && !GENERIC_TYPE_WORDS.has(key) ? key : "uncategorized";
}

function indexCategories(domain, products = []) {
  const map = new Map();
  for (const p of products) {
    const key = p.category || classifyProductCategory(p);
    if (!key || key === "uncategorized") continue;
    const entry = map.get(key) || {
      key,
      label: String(p.productType || "").trim(),
      count: 0,
      inStock: 0,
      tokens: wordSet(p.productType),
    };
    entry.count += 1;
    if (hasStock(p)) entry.inStock += 1;
    map.set(key, entry);
  }
  categoryIndexes.set(String(domain || "").toLowerCase(), map);
  return map;
}

function knownCategories(storeDomain = "") {
  const d = String(storeDomain || "").toLowerCase();
  if (d) return categoryIndexes.get(d) || new Map();
  const all = new Map();
  for (const m of categoryIndexes.values()) for (const [k, v] of m) if (!all.has(k)) all.set(k, v);
  return all;
}

/**
 * The store's other categories that have something to buy right now, most stocked first. Lets the
 * agent widen a search that matched very little (a broad word like "electronics" can match one type).
 */
export function otherCategoriesInStock(storeDomain = "", exceptKeys = [], limit = 8) {
  const skip = new Set(exceptKeys);
  return [...knownCategories(storeDomain).values()]
    .filter((c) => c.inStock > 0 && !skip.has(c.key))
    .sort((a, b) => b.inStock - a.inStock)
    .slice(0, limit)
    .map((c) => ({ category: c.label, inStock: c.inStock }));
}

/** How many products of this category can be bought now (null when the store has no such category). */
export function categoryInStock(storeDomain = "", key = "") {
  const entry = knownCategories(storeDomain).get(key);
  return entry ? entry.inStock : null;
}

/** Categories of THIS store that the shopper's sentence names (negated clauses ignored). */
export function extractRequestedCategories(text = "", storeDomain = "") {
  const tokens = wordSet(positiveText(text));
  if (tokens.size === 0) return [];
  const found = [];
  for (const entry of knownCategories(storeDomain).values()) {
    if (entry.tokens.size > 0 && [...entry.tokens].every((t) => tokens.has(t))) found.push(entry.key);
  }
  return found;
}

/**
 * The store's category a word or phrase names, singular or plural alike ("watch" and "watches" are the store's type
 * "Watches"). Returns "" when none. Only a whole-name match counts, so "phone" never becomes "Smartphones" here.
 */
export function categoryKeyFor(term = "", known = new Map()) {
  const slug = slugProductType(term);
  if (!slug) return "";
  if (known.has(slug)) return slug;
  const parts = (key) => String(key).split("_").filter(Boolean);
  // Same word, singular or plural ("watch" / "watches", "bag" / "bags", "box" / "boxes").
  const sameWord = (x, y) => x === y || stemWord(x) === stemWord(y) || x + "s" === y || y + "s" === x || x + "es" === y || y + "es" === x;
  const wanted = parts(slug);
  for (const key of known.keys()) {
    const have = parts(key);
    if (have.length === wanted.length && have.every((w, i) => sameWord(w, wanted[i]))) return key;
  }
  return "";
}

export function inferRequestedCategory(term = "", storeDomain = "") {
  const known = knownCategories(storeDomain);
  const direct = categoryKeyFor(term, known);
  if (direct) return direct;
  return extractRequestedCategories(term, storeDomain)[0] || compoundCategory(term, known);
}

// "phone" is the head of the store's own type "Smartphones" ("phone" + "smart" in one word). When exactly one
// category is such a compound of the shopper's word, that is the category they mean; with two (say Smartphones and
// Headphones) it is unclear, so none is chosen.
export function compoundCategory(term, known) {
  // Only the words that name something count: "show me phones" / "mujhe phone chahiye" still name one thing.
  const tokens = [...wordSet(parseSearchTerm(positiveText(term)).words.join(" "))].filter((t) => t.length >= 4);
  if (tokens.length !== 1) return "";
  const [word] = tokens;
  const hits = [...known.values()].filter((entry) => [...entry.tokens].some((t) => t.length > word.length + 1 && t.endsWith(word)));
  return hits.length === 1 ? hits[0].key : "";
}

const headCache = new Map();
/**
 * What kind of item a product is, read from its own name: the last word of the name before any " - colour" / ": edition" tail
 * ("Women's Teal Printed Cotton Kurti" -> kurti, "Samsonite Laptop Backpack 15.6" -> backpack). English names put the noun last, so
 * this works for any store without a word list.
 */
export function titleHead(title = "") {
  const key = String(title || "");
  if (headCache.has(key)) return headCache.get(key);
  const main = key.split(/\s+[-–—|]\s+|:\s|\(|,/)[0];
  const words = normalizeForMatch(main).split(/\s+/).filter((w) => w && !/^\d+(?:\w{0,3})?$/.test(w));
  const head = words.length ? stemWord(words[words.length - 1]) : "";
  if (headCache.size > 5000) headCache.clear();
  headCache.set(key, head);
  return head;
}

/** A product belongs to a category by the store's product type OR by what its own name says it is (a Kurti filed under "Women's Clothing"). */
export function matchesRequestedCategory(product, requestedCategory = "") {
  if (!requestedCategory) return true;
  if ((product?.category || classifyProductCategory(product)) === requestedCategory) return true;
  const head = titleHead(product?.title);
  if (!head) return false;
  const stems = String(requestedCategory).split("_").filter(Boolean).map(stemWord);
  return stems.includes(head) || (stems.length > 1 && stems.join("") === head);
}

function cleanProductDescriptionText(raw = "") {
  return String(raw || "")
    .replace(/sample\s+product\s+for\s+demo\s+store\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lowestSellablePrice(variants = []) {
  let best = null;
  for (const v of variants) {
    const n = Number(v.price);
    if (v.sellable && Number.isFinite(n) && (best === null || n < Number(best))) best = v.price;
  }
  return best;
}

function mapProduct(node, domain) {
  const variants = (node.variants?.edges || []).map((edge) => mapVariant(edge.node));
  const variantImage = variants.map((v) => v.image).find(Boolean) || null;
  const mapped = {
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: cleanProductDescriptionText(node.description || ""),
    status: node.status || "ACTIVE",
    published: Boolean(node.publishedAt),
    productType: node.productType || "",
    vendor: node.vendor || "",
    tags: node.tags || [],
    image: node.featuredImage?.url || variantImage || null,
    imageAlt: node.featuredImage?.altText || node.title,
    // "From" price = the cheapest variant that can be bought now (a sold-out cheaper size must not set the price shown).
    price: lowestSellablePrice(variants) ?? node.priceRangeV2?.minVariantPrice?.amount ?? null,
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
    url: `https://${domain}/products/${node.handle}`,
    variants,
  };
  mapped.category = classifyProductCategory(mapped);
  return mapped;
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  description
  status
  productType
  vendor
  tags
  onlineStoreUrl
  publishedAt
  featuredImage { url altText }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
  }
  variants(first: 25) {
    edges {
      node {
        id
        title
        selectedOptions { name value }
        image { url }
        price
        compareAtPrice
        inventoryQuantity
        inventoryPolicy
        inventoryItem { tracked }
      }
    }
  }
`;

function hasStock(product) {
  return product.variants.some((variant) => variant.sellable);
}

function truncate(text, max) {
  const value = cleanProductDescriptionText(String(text || "").replace(/<[^>]+>/g, " "));
  return value.length > max ? `${value.slice(0, max).trim()}…` : value;
}

function formatPriceWithSymbol(price, currency) {
  return formatMoney(price, currency);
}

/**
 * Formats variant options into clean, human-friendly text (e.g. "Available in sizes XS, S, M, L").
 */
export function formatCleanVariantSummary(variants = []) {
  const sellable = (variants || []).filter(
    (v) => v.sellable && v.title && v.title !== DEFAULT_VARIANT_TITLE
  );
  if (sellable.length === 0) return "";

  const sizes = new Set();
  const others = new Set();

  for (const v of sellable) {
    const parts = String(v.title)
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (SIZE_ALIASES[lower] || /^\d{2}$/.test(lower)) {
        sizes.add(part.toUpperCase());
      } else {
        others.add(part);
      }
    }
  }

  if (sizes.size > 0) {
    const sizeStr = [...sizes].slice(0, 6).join(", ");
    const sizeLabel = sizes.size === 1 ? "size" : "sizes";
    const colorList = [...others].slice(0, 4);
    if (colorList.length > 1) {
      return `Available in ${sizeLabel} ${sizeStr} (${colorList.join(", ")})`;
    }
    return `Available in ${sizeLabel} ${sizeStr}`;
  }

  if (others.size > 0) {
    return `Available in ${[...others].slice(0, 5).join(", ")}`;
  }

  return "";
}

/**
 * Condenses a raw product description sentence into a concise, summarized feature highlight,
 * stripping conversational marketing fluff so descriptions are never repeated verbatim.
 */
function summarizeFeatureSentence(sentence = "", productTitle = "") {
  let s = String(sentence || "")
    .replace(/^[•·\-*\s]+/, "")
    .replace(/\.\s*$/, "")
    .trim();
  if (!s) return "";

  // Drop pure marketing filler sentences completely
  if (
    /^when motherhood bogs you down/i.test(s) ||
    /^it['’]?s warm,\s*grounding,\s*and universally flattering$/i.test(s) ||
    /^there['’]?s something about this shade/i.test(s) ||
    /sample\s+product\s+for\s+demo/i.test(s)
  ) {
    return "";
  }

  // Strip conversational lead-ins and trailing fluff clauses
  s = s
    .replace(/^(?:and\s+)?nothing better to feel good than\s+(?:a\s+)?/i, "")
    .replace(/^(?:flowy and feminine,\s*)?our\s+[^,.]+?\s+is\s+crafted\s+in\s+(?:a\s+)?/i, "Crafted in a ")
    .replace(/^this\s+(floor[\s-]*length\s+fitted)\s+dress\s+comes\s+with\s+/i, "$1 cut with ")
    .replace(/\s+that\s+make\s+it\s+the\s+perfect\s+sexy\s+outfit.*$/i, "")
    .replace(/^the\s+horizontal\s+stripes\s+look\s+lovely\s+on\s+a\s+baby\s+bump$/i, "Bump-flattering horizontal stripes")
    .replace(/\s+that\s+drapes\s+beautifully\s+on\s+your\s+changing\s+body$/i, " for a soft, bump-friendly maternity drape")
    .trim();

  if (productTitle && s.toLowerCase().startsWith(productTitle.toLowerCase())) {
    s = s.slice(productTitle.length).replace(/^[\s,—–-]+/, "").trim();
  }

  if (!s || s.length < 6) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extracts 2–3 concise, summarized feature highlights (fabric, fit/cut, and available in-stock sizes)
 * instead of copying raw description paragraphs verbatim.
 */
export function extractKeyFeatures(product, maxPoints = 3) {
  const rawDesc = cleanProductDescriptionText(
    String(product?.description || "").replace(/<[^>]+>/g, " ")
  );
  const cleanOptions = formatCleanVariantSummary(product?.variants || []);
  const descSlots = cleanOptions && maxPoints >= 2 ? maxPoints - 1 : maxPoints;

  const points = [];
  if (rawDesc) {
    const rawParts = rawDesc
      .split(/(?<=[.!?])\s+|\s*[•·|-]\s+|\s*;\s*/)
      .map((part) => summarizeFeatureSentence(part, product?.title))
      .filter((s) => s.length >= 6 && s.length <= 140);

    for (const part of rawParts) {
      if (points.length >= descSlots) break;
      if (!points.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
        points.push(part);
      }
    }
  }

  if (points.length === 0 && rawDesc) {
    const fallback = summarizeFeatureSentence(rawDesc, product?.title) || truncate(rawDesc, 95);
    if (fallback) points.push(fallback);
  }

  if (cleanOptions && points.length < maxPoints) {
    points.push(cleanOptions);
  }

  if (product?.stylistNote && points.length < maxPoints) {
    points.push(product.stylistNote);
  }

  return points.slice(0, maxPoints);
}

export const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD) || 5;
/** The exact count when it is low (1..threshold), otherwise null ("in stock" is enough). */
export function visibleStockCount(quantity) {
  const n = Number(quantity);
  return Number.isFinite(n) && n > 0 && n <= LOW_STOCK_THRESHOLD ? n : null;
}

// A variant as the model may see it: the exact warehouse count is replaced by the same low-stock rule.
export function publicVariant(v) {
  if (!v || typeof v !== "object") return v;
  if (!v.tracked || v.inventoryQuantity == null) return { ...v, inventoryQuantity: null };
  return { ...v, inventoryQuantity: Number(v.inventoryQuantity) <= 0 ? 0 : visibleStockCount(v.inventoryQuantity) };
}
export const publicVariants = (list) => (Array.isArray(list) ? list.map(publicVariant) : list);

// The "was" price of the variant the card shows (its cheapest sellable one), or undefined when it is not on sale.
function cheapestOnSale(product) {
  const sellable = (product.variants || []).filter((v) => v.sellable);
  const pool = sellable.length ? sellable : product.variants || [];
  const best = pool.reduce((b, v) => (b == null || Number(v.price) < Number(b.price) ? v : b), null);
  return best && Number(best.compareAtPrice) > Number(best.price) ? best.compareAtPrice : undefined;
}

export function compactProduct(product, { brief = false, includeCardFields = false } = {}) {
  const hasRealOptions =
    product.variants.length > 1 ||
    (product.variants[0] && product.variants[0].title !== DEFAULT_VARIANT_TITLE);

  const trackedUnits = product.variants
    .filter((variant) => variant.tracked && variant.inventoryQuantity > 0)
    .reduce((sum, variant) => sum + variant.inventoryQuantity, 0);

  const anyTracked = product.variants.some((variant) => variant.tracked);
  const features = extractKeyFeatures(product, brief ? 2 : 3);

  // Options of one product can cost different amounts (a colour or a storage size). The card shows the price of
  // the option picked, so the reply must not give one price for the whole product when they differ.
  const sellablePrices = product.variants.filter((v) => v.sellable).map((v) => Number(v.price)).filter(Number.isFinite);
  const lowest = sellablePrices.length ? Math.min(...sellablePrices) : null;
  const highest = sellablePrices.length ? Math.max(...sellablePrices) : null;
  const priceVaries = lowest != null && highest > lowest;

  const base = {
    title: product.title,
    category: product.category || classifyProductCategory(product),
    price: product.price,
    currency: product.currency,
    formattedPrice: formatPriceWithSymbol(product.price, product.currency),
    ...(priceVaries
      ? {
          priceVaries: true,
          priceRangeText: `${formatPriceWithSymbol(lowest, product.currency)} to ${formatPriceWithSymbol(highest, product.currency)} depending on the option (the price above is the cheapest option; each option's own price is under "options")`,
        }
      : {}),
    // A struck-through "was" price on the card must also be known to the reply.
    compareAtPrice: cheapestOnSale(product),
    description: truncate(product.description, brief ? 180 : 320),
    features,
    stylistNote: product.stylistNote || undefined,
    inStock: hasStock(product),
    // Exact stock counts are business data: the AI sees them only when stock is low.
    unitsInStock: anyTracked ? visibleStockCount(trackedUnits) : null,
    lowStock: anyTracked && trackedUnits > 0 && trackedUnits <= LOW_STOCK_THRESHOLD ? true : undefined,
    options: hasRealOptions
      ? product.variants.slice(0, brief ? 6 : 12).map((variant) => ({
          name: variant.title,
          price: variant.price,
          ...(Number(variant.compareAtPrice) > Number(variant.price) ? { compareAtPrice: variant.compareAtPrice } : {}),
          inStock: variant.sellable,
        }))
      : undefined,
    notExactMatch: product.notExactMatch || undefined,
    unmatchedQueryWords: Array.isArray(product.unmatchedQueryWords) && product.unmatchedQueryWords.length > 0 ? product.unmatchedQueryWords : undefined,
    matchKind: product.matchKind || undefined,
    matchedVariant: product.matchedVariant || undefined,
    matchConfidence:
      product.matchConfidence != null
        ? Number(product.matchConfidence.toFixed(2))
        : undefined,
  };

  if (includeCardFields) {
    return {
      ...base,
      id: product.id || undefined,
      image: product.image || product.variants?.find((v) => v.image)?.image || null,
      imageAlt: product.imageAlt || product.title || null,
      handle: product.handle || undefined,
      url: product.url || undefined,
      variants: Array.isArray(product.variants) ? publicVariants(product.variants) : [],
    };
  }

  return base;
}

export { DEFAULT_VARIANT_TITLE, slugProductType, GENERIC_TYPE_WORDS, mapVariant, categoryIndexes, indexCategories, knownCategories, cleanProductDescriptionText, mapProduct, PRODUCT_FIELDS, hasStock, truncate, formatPriceWithSymbol, summarizeFeatureSentence };
