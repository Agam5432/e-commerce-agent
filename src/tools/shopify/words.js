// Reading what the shopper typed: normalising words, stems, sizes, colours, gender words, negations, budgets and variant hints.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { canonicalToken, extractColors } from "../productMatch.js";

export const SIZE_ALIASES = {
  xxs: ["xxs", "2xs", "xxsmall"],
  "2xs": ["xxs", "2xs", "xxsmall"],
  xs: ["xs", "xsmall"],
  xsmall: ["xs", "xsmall"],
  s: ["s", "sm", "small"],
  sm: ["s", "sm", "small"],
  small: ["s", "sm", "small"],
  m: ["m", "md", "med", "medium"],
  md: ["m", "md", "med", "medium"],
  med: ["m", "md", "med", "medium"],
  medium: ["m", "md", "med", "medium"],
  l: ["l", "lg", "large"],
  lg: ["l", "lg", "large"],
  large: ["l", "lg", "large"],
  xl: ["xl", "xlarge", "1xl"],
  xlarge: ["xl", "xlarge", "1xl"],
  xxl: ["xxl", "2xl", "xxlarge"],
  "2xl": ["xxl", "2xl", "xxlarge"],
  xxlarge: ["xxl", "2xl", "xxlarge"],
  xxxl: ["xxxl", "3xl", "xxxlarge"],
  "3xl": ["xxxl", "3xl", "xxxlarge"],
  xxxlarge: ["xxxl", "3xl", "xxxlarge"],
};

const VARIANT_NOISE_WORDS = new Set([
  "size",
  "colour",
  "color",
  "the",
  "a",
  "an",
  "in",
  "of",
  "for",
  "with",
  "wala",
  "wali",
  "wale",
  "karo",
  "kardo",
  "mera",
  "meri",
  "hi",
  "please",
  "option",
  "variant",
]);

const NEGATION_RE =
  /\b(nahi|nahin|nhi|no|not|mat|hato|hata|without|except|leave|skip|don'?t\s+want|ni\s+krna|nhi\s+chahiye|nahi\s+chahiye)\b|नहीं|मत|हटा/;

function positiveText(text = "") {
  const raw = normalizeSearchTypos(String(text || "")).toLowerCase().trim();
  if (!raw) return "";
  const clauses = raw
    .split(/[,;.!?।]+|\b(?:but|instead|rather|lekin|par|balki)\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const positive = clauses.filter((c) => !NEGATION_RE.test(c));
  return positive.length > 0 ? positive.join(" ") : raw;
}

/**
 * Gender is read from the product's own words (title/type/tags). A product that carries no gender
 * signal is open to everyone, so non-gendered stores (electronics, grocery...) are never filtered.
 */
export function matchesGender(product, gender) {
  if (!gender) return true;
  const found = productGenders(product);
  if (found.size === 0 || found.has("unisex")) return true;
  if (found.has(gender)) return true;
  return false;
}

function expandWordForms(word) {
  const w = String(word || "").toLowerCase();
  if (!w || w.length < 2) return [];
  if (w === "tshirt") return ['"t-shirt"', '"t-shirts"', "tshirt", "tee", "tees"];
  const forms = new Set([w]);
  if (w.endsWith("ies") && w.length > 4) forms.add(w.slice(0, -3) + "y");
  else if (w.endsWith("ses") && w.length > 4) forms.add(w.slice(0, -2));
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) forms.add(w.slice(0, -1));
  else forms.add(w + "s");
  return [...forms];
}

const SEARCH_STOPWORDS = new Set([
  // replies to the assistant ("not now", "no thanks", "ok later", "abhi nahi") are never a product search
  "not", "now", "no", "yes", "yeah", "ok", "okay", "thanks", "thank", "later", "maybe", "sure", "fine", "nope",
  "haan", "han", "abhi", "baad", "badme", "baadme", "shukriya", "dhanyavad", "thik", "theek",
  "a", "an", "the", "for", "of", "and", "or", "with", "in", "on", "to", "me", "my", "some", "any",
  "show", "find", "get", "want", "need", "please", "looking", "look", "search", "searching", "searing", "comformt", "confort", "comfert", "i", "you", "do", "does", "did", "have", "has", "had", "size", "colour", "color",
  "this", "that", "these", "those", "into", "cart", "add", "product", "products", "item", "items",
  "inch", "inches", "actually", "really", "just", "very", "so", "too", "also", "her", "him", "his", "them", "their", "she", "he", "they", "we", "us",
  "is", "am", "are", "was", "were", "be", "been", "can", "could", "would", "should", "will", "shall", "may", "might",
  "about", "from", "at", "by", "as", "like", "something", "anything", "options", "option", "month", "months", "year", "years", "old",
  "pregnant", "pregnancy", "maternity", "expecting", "motherhood", "comfort", "comfortable", "comfy", "wear", "wearing",
  "dikhao", "dikhaiye", "dikha", "mujhe", "muje", "mereko", "mujhko", "chahiye", "chaiye", "hai", "hain", "h", "hu", "hoon", "ho",
  "ka", "ki", "ke", "k", "ko", "se", "pe", "par", "liye", "lie", "mein", "me", "wala", "wali", "wale", "batao", "bataiye", "btao",
  "available", "kya", "koi", "kuch", "kch", "unke", "uske", "apni", "apne", "apna", "mere", "mera", "meri", "khud", "kisi", "aur",
  "store", "shop", "shopping", "dukaan", "collection", "range", "variety", "outfit", "outfits", "clothes", "clothing", "kapde", "kapda", "attire",
  "acchi", "acha", "accha", "achi", "badhiya", "badiya", "mast", "shandaar", "sahi", "shi", "si", "sa", "ek", "do", "lena", "leni", "lene",
  "krni", "karni", "krna", "karna", "dekhna", "dekh", "raha", "rha", "rahi", "rhi", "gift", "present", "dost", "friend", "family",
  "bhai", "bhaiya", "brother", "sister", "didi", "bhabhi", "mother", "mom", "mummy", "father", "dad", "papa", "husband", "boyfriend",
  "ye", "yeh", "wo", "woh", "bhi", "to", "toh", "na", "nhi", "nahi", "nahin", "mat", "esa", "aisa", "esi", "aisi", "aise",
  "jisme", "jismein", "jisko", "jisse", "krana", "karana", "krne", "karne", "krte", "karte", "krr", "kr", "kar", "do", "de", "doon", "du",
  "bol", "bolra", "bolrha", "bolrahi", "bolri", "ari", "aari", "aa", "aaya", "aayi", "gaya", "gayi", "rhe", "rahe",
  "problem", "dikkat", "pareshani", "preshani", "website", "webite", "site", "listed", "list", "stock",
  "mil", "milega", "milegi", "milta", "milti", "rakhte", "rakha", "pass", "paas", "tumhre", "tumhare", "apke", "aapke",
  "iske", "uske", "inke", "unke", "alava", "alawa", "siva", "siway", "dekho", "check", "try",
]);

const OPTIONAL_ADJECTIVES = new Set([
  "classic", "stylish", "casual", "formal", "office", "party", "festive", "festival", "diwali", "deepawali", "navratri", "eid", "wedding", "shaadi",
  "comfortable", "comfort", "comfy", "soft", "breathable", "flowy", "relaxed", "loose", "lightweight", "fitted", "slim", "regular",
  "maternity", "pregnant", "pregnancy", "motherhood", "daily", "everyday", "summer", "winter", "ethnic", "traditional", "western", "modern",
  "elegant", "new", "latest", "trending", "popular", "nice", "good", "best", "pretty", "beautiful", "graceful", "smart", "cool", "fancy",
  "affordable", "budget", "premium", "quality", "acchi", "acha", "accha", "badhiya", "shandaar", "mast",
]);

const GENDER_WORDS = {
  men: ["men", "mens", "man", "male", "gents", "gentlemen", "guy", "guys", "husband", "boyfriend", "brother", "bhai", "bhaiya", "father", "dad", "papa"],
  women: ["women", "womens", "woman", "female", "ladies", "lady", "wife", "girlfriend", "sister", "didi", "behen", "bhabhi", "mother", "mom", "mummy"],
  kids: ["kids", "kid", "boys", "boy", "girls", "girl", "children", "child", "son", "daughter", "beta", "beti", "bacha", "bachcha", "baccha", "bachche", "bacche", "bachchon", "toddler"],
};
const GENDER_OF = Object.fromEntries(
  Object.entries(GENDER_WORDS).flatMap(([group, words]) => words.map((w) => [w, group]))
);

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/\bt[\s-]*shirts?\b|\btshirts?\b|\btees?\b/g, " tshirt ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/).map(canonicalToken).join(" ")
    .trim();
}

function stemWord(w) {
  if (!w) return "";
  if (w === "mens" || w === "men" || w === "man") return "men";
  if (w === "womens" || w === "women" || w === "woman") return "women";
  if (w === "feeding" || w === "feeds") return "feed";
  if (w === "nursing" || w === "nurses") return "nurse";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function wordSet(text) {
  const set = new Set(normalizeForMatch(text).split(/\s+/).filter(Boolean).map(stemWord));
  if (set.has("nurse") || set.has("nurs") || set.has("breastfeed") || set.has("lactation")) {
    set.add("feed");
    set.add("nurse");
  }
  if (set.has("feed")) {
    set.add("nurse");
  }
  return set;
}

export function parseSearchTerm(term) {
  const tokens = normalizeForMatch(term).split(/\s+/).filter(Boolean);
  let gender = "";
  const words = [];

  for (const token of tokens) {
    if (GENDER_OF[token]) {
      gender = gender || GENDER_OF[token];
    } else if (!SEARCH_STOPWORDS.has(token)) {
      words.push(token);
    }
  }

  return { gender, words };
}

export function productGenders(product) {
  const tokens = normalizeForMatch(
    [product?.title, product?.productType, (product?.tags || []).join(" "), product?.handle]
      .filter(Boolean)
      .join(" ")
  ).split(/\s+/);

  const found = new Set();
  for (const token of tokens) {
    if (GENDER_OF[token]) found.add(GENDER_OF[token]);
    else if (token === "unisex") found.add("unisex");
  }
  return found;
}

function matchesAllWords(product, words) {
  if (words.length === 0) return true;

  const haystack = wordSet(
    [
      product.title,
      product.description,
      product.productType,
      product.vendor,
      (product.tags || []).join(" "),
      product.handle,
      ...(product.variants || []).map((v) => v.title),
    ]
      .filter(Boolean)
      .join(" ")
  );

  if (words.every((w) => haystack.has(stemWord(w)))) return true;

  const coreWords = words.filter((w) => !OPTIONAL_ADJECTIVES.has(w) && w !== "down" && w !== "up");
  if (coreWords.length >= 1 && coreWords.length < words.length && coreWords.every((w) => haystack.has(stemWord(w)))) {
    return true;
  }

  return false;
}

const CONTEXT_NON_BRAND_WORDS = new Set([
  "hall", "living", "room", "bedroom", "kitchen", "home", "house", "office", "work",
  "daily", "everyday", "gift", "present", "wife", "husband", "kid", "kids", "family",
  "friend", "month", "months", "feed", "feeding", "nursing", "problem", "issue",
  "wear", "wearing", "outfit", "outfits", "clothing", "clothes", "collection",
  "diwali", "festive", "festival", "wedding", "party", "summer", "winter", "casual", "formal",
]);

/** Optimal-string-alignment distance (insert/delete/substitute/transpose) with an early exit. */
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

export function variantTokens(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\bextra\s+extra\s+small\b|\bxx[\s-]*small\b/g, " xxs ")
    .replace(/\bextra\s+small\b|\bx[\s-]*small\b/g, " xs ")
    .replace(/\bextra\s+extra\s+large\b|\bxx[\s-]*large\b/g, " xxl ")
    .replace(/\bextra\s+large\b|\bx[\s-]*large\b/g, " xl ")
    .replace(/\b(?:en\s+el|n\s+l|el)\b/g, " l ")
    .replace(/\b(?:em|am)\b/g, " m ")
    .replace(/\b(?:es)\b/g, " s ")
    .replace(/[^a-z0-9]+/g, " ");

  return normalized
    .split(/\s+/)
    .map((t) => canonicalToken(t))
    .filter((t) => t && !VARIANT_NOISE_WORDS.has(t));
}

export function tokenMatchesTitle(token, titleTokens) {
  const t = canonicalToken(String(token || "").toLowerCase());
  if (!t) return false;
  if (titleTokens.has(t)) return true;

  const aliases = SIZE_ALIASES[t];
  if (aliases) {
    return aliases.some((alias) => titleTokens.has(alias));
  }

  if (t.length >= 4) {
    for (const x of titleTokens) {
      if (x.length >= 4 && !SIZE_ALIASES[x] && (x.includes(t) || t.includes(x))) {
        return true;
      }
    }
  }

  return false;
}

export function variantMatchesWanted(variantTitle, wanted) {
  const titleTokens = new Set(variantTokens(variantTitle));
  const need = variantTokens(wanted);
  if (need.length === 0) return false;
  return need.every((t) => tokenMatchesTitle(t, titleTokens));
}

function isSizeToken(t) {
  return /^\d{1,2}$/.test(t) || Boolean(SIZE_ALIASES[t]);
}

// The most a shopper says they will spend: "under 5000", "budget of $500", "within 300", and the Hinglish / Hindi way, with the
// number first: "4000 ke andar", "4000 tak", "5000 से कम". The number is in the store's currency, as written.
const BUDGET_BEFORE_RE = /\b(?:under|below|less\s+than|up\s+to|upto|within|at\s+most|no\s+more\s+than|not\s+more\s+than|max(?:imum)?|budget(?:\s+(?:of|is))?)\s*(?:rs\.?|inr|usd|[$₹])?\s*(\d+(?:\.\d+)?)/i;
const BUDGET_AFTER_RE = /(\d+(?:\.\d+)?)\s*(?:rs\.?|rupees?|rupaye|inr|usd|dollars?|[$₹])?\s*(?:ke\s+(?:andar|ander|neeche|bheetar|bhitar)|se\s+kam|tak|के\s*(?:अंदर|अन्दर|नीचे|भीतर)|से\s+कम|तक)(?![\p{L}\p{M}])/iu;
export function budgetFromText(text = "") {
  const value = String(text || "");
  return Number(value.match(BUDGET_BEFORE_RE)?.[1]) || Number(value.match(BUDGET_AFTER_RE)?.[1]) || null;
}

export function parseSearchFilters(text = "", explicit = {}) {
  const normalized = normalizeSearchTypos(String(text || ""))
    .replace(/['\u2019]s\b/g, "s")
    .replace(/लाल/g, " red ").replace(/नील[ाीे]/g, " blue ")
    .replace(/काल[ाीे]/g, " black ").replace(/सफेद/g, " white ")
    .replace(/हर[ाीे]/g, " green ").replace(/पी[लळ][ाीे]/g, " yellow ");
  // Speech aliases ("am" -> M, "el" -> L) and shorthand ("i m" -> "I'm") apply to dictated sizes,
  // not ordinary sentences such as "I am looking" or "i m looking for dress".
  const sizeText = normalized.replace(/\bi['\u2019]m\b|\bi\s+am\b|\bi\s+m\b/gi, " ")
    .replace(/\bsize\s+(am|em|es|el)\b/gi, (_, value) => `size ${({ am: "m", em: "m", es: "s", el: "l" })[value.toLowerCase()]}`)
    .replace(/\b(?:am|em|es|el)\b/gi, " ");
  const tokens = variantTokens(sizeText);
  const hasExplicitSizeWord = /\bsize\b/i.test(sizeText);
  const wordCount = sizeText.trim().split(/\s+/).filter(Boolean).length;
  const numericSizes = [...normalized.matchAll(/\bsize\s*(?:is\s+)?(\d{1,2})\b|\b(\d{1,2})\s*(?:size|waist|inches?)\b/gi)].map(m => m[1] || m[2]);
  if (/^\d{1,2}$/.test(normalized.trim())) numericSizes.push(normalized.trim());
  const sizes = [...new Set([
    ...tokens.filter(t => {
      if (!SIZE_ALIASES[t]) return false;
      if (t.length === 1 && !hasExplicitSizeWord && wordCount > 4) return false;
      return true;
    }),
    ...numericSizes,
  ])];
  const negationRe = /\b(nahi|nahin|nhi|no|not|mat|thodi|hato|hata|without|except|leave|skip|don'?t\s+want|ni\s+krna|nhi\s+chahiye|nahi\s+chahiye)\b|नहीं|थोड़ी|मत|हटा/;
  const clauses = normalized
    .split(/[,;.!?।]+|\b(?:but|instead|rather|lekin|par|balki|i'?m\s+looking\s+for|i\s+want|mujhe\s+chahiye|unke\s+liye|uske\s+liye|mere\s+liye)\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const posClauses = clauses.filter((c) => !negationRe.test(c));
  const activeColorText = posClauses.length > 0 ? posClauses.join(" ") : normalized;
  const colorText = explicit.color || activeColorText;
  const colors = extractColors(colorText);
  if (explicit.size) sizes.splice(0, sizes.length, ...variantTokens(explicit.size).filter(isSizeToken));
  return {
    gender: parseSearchTerm(normalized).gender || explicit.gender || "",
    colors, sizes,
    maxPrice: Number(explicit.maxPrice) > 0 ? Number(explicit.maxPrice) : budgetFromText(normalized),
  };
}

// The headline price of a product is its lowest price among the variants that fit: the same number the card shows and the
// same one the cheapest option in the tool result carries, so a reply and its card can never quote two different prices.
export function cheapestPrice(variants = []) {
  let best = null;
  for (const v of variants || []) {
    const n = Number(v?.price);
    if (Number.isFinite(n) && (best === null || n < Number(best))) best = v.price;
  }
  return best;
}

// "cheapest phone" / "sabse mehnga watch": the wish is an ORDER (by price) of one kind of item, not a qualifier the products
// must contain. Returns the order and the term without those words.
const LOW_PRICE_RE = /\b(?:cheapest|cheaper|lowest[\s-]+priced?|lower[\s-]+priced?|least\s+expensive|less\s+expensive|more\s+affordable|sabse\s+(?:sasta|sasti)|sasta|sasti|cheap)\b/gi;
const HIGH_PRICE_RE = /\b(?:most\s+expensive|more\s+expensive|costliest|costlier|highest[\s-]+priced?|priciest|pricier|sabse\s+(?:mehnga|mehngi|costly)|mehnga|mehngi|expensive)\b/gi;
export function parsePriceSort(text = "") {
  const source = String(text || "");
  // The low words are tested first: "less expensive" and "least expensive" contain the word "expensive" but ask for the opposite order.
  const low = new RegExp(LOW_PRICE_RE.source, "i").test(source);
  const high = !low && new RegExp(HIGH_PRICE_RE.source, "i").test(source);
  if (!high && !low) return { sort: "", term: source.trim() };
  const term = source.replace(high ? HIGH_PRICE_RE : LOW_PRICE_RE, " ").replace(/\s+/g, " ").trim();
  return { sort: high ? "price_high" : "price_low", term };
}

/**
 * The options of a product that have the storage size the shopper named ("256gb"), with the price and the preselected
 * option following them. A product without such an option comes back unchanged.
 */
export function narrowVariantsByStorage(product, text = "") {
  const storage = [...new Set(String(text || "").toLowerCase().match(/\b\d+\s?(?:gb|tb)\b/g) || [])].map(s => s.replace(/\s/g, ""));
  if (!storage.length || !Array.isArray(product?.variants)) return product;
  const hits = product.variants.filter(v => v.sellable && storage.every(s => String(v.title || "").toLowerCase().replace(/\s/g, "").includes(s)));
  if (!hits.length) return product;
  const best = hits.reduce((b, v) => (b == null || Number(v.price) < Number(b.price) ? v : b), null);
  return { ...product, variants: hits, price: cheapestPrice(hits) ?? product.price, ...(best?.id ? { variantId: String(best.id) } : {}) };
}

export function filterProductsByVariantHints(products, hintText = "", explicit = {}) {
  const { colors, sizes, maxPrice } = parseSearchFilters(hintText, explicit);
  const gender = explicit.gender || "";
  const matched = [];
  for (const product of products || []) {
    if (gender && !matchesGender(product, gender)) continue;
    const hits = (product.variants || []).filter(v => {
      // keepSoldOut (plain product searches only): let a sold-out product through so the agent can
      // say "it exists but is out of stock". Colour/size/price searches stay strict.
      if (!v.sellable && !(explicit.keepSoldOut && !colors.length && !sizes.length && maxPrice == null)) return false;
      if (maxPrice != null && Number(v.price) > maxPrice) return false;
      const colorOptions = (v.selectedOptions || []).filter(o => /colou?r/i.test(o.name));
      const variantColors = extractColors(colorOptions.length ? colorOptions.map(o => o.value).join(" ") : v.title);
      const productColors = variantColors.length ? variantColors : extractColors(product.title);
      // Colour and size must belong to the SAME available variant.
      // A colour counts when the colour list has it or the product's own name / variant says the word ("Navy Blue" is two colour words).
      const nameWords = wordSet(variantColors.length ? (v.title || "") : `${product.title || ""} ${v.title || ""}`);
      // "Navy Blue" is two colour words but ONE colour: the variant says "Navy", the product's name says "Navy Blue". At least one requested
      // colour must be the variant's own colour; the others may come from the product's name (so "Red" never matches a blue variant of a red-named item).
      const nameAndTitleWords = variantColors.length ? wordSet(`${product.title || ""} ${v.title || ""}`) : nameWords;
      if (colors.length) {
        const own = colors.some(c => productColors.includes(c)) || !variantColors.length;
        if (!own || !colors.every(c => productColors.includes(c) || nameAndTitleWords.has(stemWord(c)))) return false;
      }
      const sizeOptions = (v.selectedOptions || []).filter(o => /size/i.test(o.name));
      const sizeTokens = new Set(variantTokens(sizeOptions.length ? sizeOptions.map(o => o.value).join(" ") : v.title));
      return sizes.every(size => tokenMatchesTitle(size, sizeTokens));
    });
    if (!hits.length) continue;
    // A storage size the shopper named ("256gb") picks that option among the ones that already match; when no
    // option has it the wish is simply not narrowed (the model still says what is and is not available).
    const storage = [...new Set(`${hintText || ""} ${explicit.storageText || ""}`.toLowerCase().match(/\b\d+\s?(?:gb|tb)\b/g) || [])].map(s => s.replace(/\s/g, ""));
    const byStorage = storage.length ? hits.filter(v => storage.every(s => String(v.title || "").toLowerCase().replace(/\s/g, "").includes(s))) : [];
    const chosen = byStorage.length ? byStorage : hits;
    const narrowed = Boolean(colors.length || sizes.length || maxPrice != null || byStorage.length);
    // the cheapest option that fits: the card preselects it, so card and reply quote the same price
    const best = chosen.reduce((b, v) => (b == null || Number(v.price) < Number(b.price) ? v : b), null);
    matched.push({ ...product, matchedVariant: chosen[0].title,
      matchedVariants: chosen.map(v => v.title),
      variants: narrowed ? chosen : product.variants,
      price: cheapestPrice(chosen) ?? product.price,
      ...(narrowed && best?.id ? { variantId: String(best.id) } : {}),
      image: chosen[0].image || product.image,
    });
  }
  // An unavailable colour/size is a zero-result search, not a category fallback.
  return matched;
}

/**
 * Intentionally a pass-through. Spelling mistakes are repaired against THIS store's own catalog
 * vocabulary (see correctToVocabulary), never with a hardcoded word/brand list.
 */
export function normalizeSearchTypos(term) {
  return String(term || "");
}

// A budget the shopper states ("under 5000") is in the currency they browse in. The catalog is cached in
// the store's base currency, so while browsing in a shopper currency the budget is applied AFTER the
// products are re-priced into it (never to the base price). Products Shopify could not re-price
// cannot be checked against the budget, so they are left out of a budget search.
const BUDGET_IN_TEXT_RE = /\b(?:under|below|less\s+than|up\s+to|upto|budget(?:\s+of)?)\s*(?:rs\.?|inr|usd|[$₹])?\s*\d+(?:\.\d+)?/gi;

export function applyShopperBudget(products = [], budget, currency) {
  const limit = Number(budget);
  if (!(limit > 0)) return products;
  const wanted = String(currency || "").toUpperCase();
  return filterProductsByVariantHints(
    products.filter((p) => !wanted || String(p.currency || "").toUpperCase() === wanted),
    "",
    { maxPrice: limit }
  );
}

/**
 * Of the keywords the model chose, the ones the shopper actually named in a positive (not negated)
 * part of their message. Compares the model's arguments with the shopper's own words: no word lists.
 */
export function keywordsNamedByShopper(keywords = [], message = "") {
  const said = wordSet(positiveText(message));
  if (said.size === 0) return [];
  return (Array.isArray(keywords) ? keywords : []).filter((k) => {
    const tokens = [...wordSet(k)].filter((w) => !SEARCH_STOPWORDS.has(w));
    return tokens.length > 0 && tokens.every((w) => said.has(w));
  });
}

export { VARIANT_NOISE_WORDS, NEGATION_RE, positiveText, expandWordForms, SEARCH_STOPWORDS, OPTIONAL_ADJECTIVES, GENDER_WORDS, GENDER_OF, normalizeForMatch, stemWord, wordSet, matchesAllWords, CONTEXT_NON_BRAND_WORDS, editDistance, isSizeToken, BUDGET_IN_TEXT_RE };
