import { claimsUnavailable } from "./factGuard.js";
import { SEARCH_STOPWORDS } from "../tools/shopify/words.js";

// Product cards must match what the assistant actually talks about. The catalog tools can return more
// products than the model chooses to mention (e.g. 6 found, 4 named in the reply); this keeps only the
// ones the answer names, in the order it names them.
//
// Nothing here is a word list. When a title is shortened by the model, the words that most of the found
// products share (e.g. "women's", "cotton", "set") are treated as generic for THIS set of products, so
// matching relies on the words that actually tell the products apart. That works for any store, category
// or language.

function matchKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleTokens(title) {
  return [...new Set(matchKey(title).split(" ").filter((t) => t.length > 1))];
}

// The reply's words in order: the matching key of each and whether it starts with a capital letter.
function wordsWithCase(text) {
  return String(text || "")
    .split(/\s+/)
    .map((raw) => ({ key: matchKey(raw), cap: /^[^\p{L}\p{N}]*\p{Lu}/u.test(raw) }))
    .filter((w) => w.key)
    .flatMap((w) => w.key.split(" ").map((key, i) => ({ key, cap: w.cap && i === 0 })));
}

// Two or more capitalised words in a row inside a sentence read as a product name ("Samsonite Laptop Backpack").
function namesOtherProducts(words) {
  let run = 0;
  for (let i = 1; i < words.length; i++) {
    run = words[i].cap && words[i - 1].cap ? run + 1 : words[i].cap ? 0 : -1;
    if (run >= 1) return true;
  }
  return false;
}

function singleAnchorNames(words, anchor, titleTokens, vendor) {
  const own = new Set(titleTokens);
  const at = words.findIndex((w) => w.key === anchor);
  if (at < 0) return false;
  let start = at;
  let end = at;
  while (start > 0 && own.has(words[start - 1].key)) start--;
  while (end + 1 < words.length && own.has(words[end + 1].key)) end++;
  const next = words[end + 1];
  if (next && next.cap && !own.has(next.key)) return false; // the reply goes on with another name
  if (end > start) return true; // next to another word of the same title
  // the brand alone ("the Fossil"): the product's vendor, or the first word of its name (names lead with the brand)
  return anchor === titleTokens[0] || matchKey(vendor).split(" ").includes(anchor);
}

// Where the reply says this product's name as a name: words of the title standing side by side, in the title's order,
// covering at least half of it (never fewer than two). Used for products no tool was asked for, where a few everyday
// words of a title scattered over the reply ("the ... price" for "The Compare at Price Snowboard") must not count.
function nameRunStart(words, tokens) {
  const need = Math.max(2, Math.ceil(tokens.length / 2));
  let run = 0;
  let last = -1;
  for (let i = 0; i < words.length; i++) {
    const at = tokens.indexOf(words[i].key);
    run = at < 0 ? 0 : at > last && run > 0 ? run + 1 : 1;
    last = at;
    if (run >= need) return i - run + 1;
  }
  return -1;
}

export function replyNamesOtherProducts(text) {
  return namesOtherProducts(wordsWithCase(text));
}

// `strict`: return only the products the answer really names (used for products nobody asked a tool
// for, such as the live search run before the model answers). Without it, an answer that names none of
// the found products ("here are some options") keeps them all.
export function productsMentionedInAnswer(products, answerText, { strict = false, nameRun = false } = {}) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  if (!strict && list.length < 2) return list;
  const hay = ` ${matchKey(answerText)} `;
  if (hay.trim() === "") return strict ? [] : list;

  const entries = list.map((product) => ({
    product,
    title: matchKey(product.title),
    main: mainTitle(product.title),
    tokens: titleTokens(product.title),
  }));

  // How many of the found products' titles each word appears in: a word only ONE found title has tells that product apart.
  const titleCount = new Map();
  for (const { tokens } of entries) for (const t of tokens) titleCount.set(t, (titleCount.get(t) || 0) + 1);

  const replyWords = wordsWithCase(answerText);
  const hits = [];
  for (const { product, title, main, tokens } of entries) {
    if (!title) continue;
    let pos = hay.indexOf(` ${title} `);
    // "Analog Wrist Watch" for "Analog Wrist Watch - Rose Gold", "Samsung Galaxy A55" for "Samsung Galaxy A55 5G": the name without its tail.
    if (pos < 0 && main && main !== title && main.split(" ").length >= 2) pos = hay.indexOf(` ${main} `);
    if (pos < 0 && nameRun) {
      const start = nameRunStart(replyWords, tokens);
      if (start >= 0) pos = hay.indexOf(` ${replyWords[start].key} `);
    } else if (pos < 0 && tokens.length >= 2) {
      // A shortened name ("Samsonite backpack"): one word that belongs to this product alone must be there, together with
      // another word of its name. Words shared with other found products never count on their own.
      const anchors = tokens.filter((t) => (titleCount.get(t) || 0) < 2 && !/^\d/.test(t));
      const present = tokens.filter((t) => hay.includes(` ${t} `));
      const anchored = anchors.filter((t) => present.includes(t));
      // Two words that tell the products apart are a name. ONE such word only counts when it stands where the name would
      // stand: next to another word of the same title, or as the product's brand on its own, and the reply does not go on
      // with a different capitalised name ("HP Prelude Pro ..." is not "HP Pavilion 14 Laptop"; "Women's Black High-Waist ..."
      // is not "Women's Black Palazzo Pants"). The found set alone cannot say a word is common to the whole store.
      if (anchored.length >= 2 && present.length >= 2) pos = Math.min(...present.map((t) => hay.indexOf(` ${t} `)));
      else if (anchored.length === 1 && singleAnchorNames(replyWords, anchored[0], tokens, product.vendor)) pos = hay.indexOf(` ${anchored[0]} `);
    }
    if (pos >= 0) hits.push({ product, pos });
  }

  // Nothing named (e.g. "here are some options") -> keep every card, unless only named ones may show.
  // Not one found product is named. A generic answer ("here are some options") keeps them all, but an answer that names other
  // products (capitalised multi-word names, none of them found by the tools) is about those, so these cards would be wrong.
  if (hits.length === 0) return strict || namesOtherProducts(replyWords) ? [] : list;
  hits.sort((a, b) => a.pos - b.pos);
  return hits.map((h) => h.product);
}

// The name before a " - colour" / ": edition" / "(size)" tail.
function mainTitle(title) {
  return matchKey(String(title || "").split(/\s+[-–—|]\s+|:\s|\(/)[0]);
}

/**
 * Products found only "by meaning" (the store had nothing under the shopper's word, so its own types that might serve
 * the need were listed) are the model's material, not an answer by themselves. If the reply says the item is not
 * sold and names none of them, showing them as cards contradicts the text ("no TVs" above four phones), so only the
 * ones the reply names are shown. Products from a normal match keep the usual rule.
 */
// "iske liye cover", "a case for this", "compatible with it": the shopper asks for things that fit ONE product, so the cards are the ones the
// reply names as fitting it, not every product of that kind (a real run showed iPhone and Galaxy S24 cases under "the ESR case fits your
// A55", 2026-11-21).
const FOR_ONE_PRODUCT = /\b(?:iske|iski|iska|uske|uski|uska|is|us)\s+(?:liye|lie|sath|saath|ke\s+liye|wale|vale)\b|\bfor\s+(?:this|that|it|the\s+same)\b|\b(?:compatible|fits?|fitting|match(?:es|ing)?)\b|इसके\s+लिए|उसके\s+लिए/i;

export function cardsForAnswer(cards = [], toolLog = [], text = "", userMessage = "") {
  // A reply that says the item is not available shows only the products it names (an honest "no" has no look-alike cards).
  if (claimsUnavailable(text)) return productsMentionedInAnswer(cards, text, { strict: true });
  const searches = (toolLog || []).filter((t) => ["search_products", "get_recommendations"].includes(t?.name) && t?.result);
  const byMeaning = searches.some((t) => t.result.mode === "need_match");
  const normalMatch = searches.some((t) => t.result.mode !== "need_match" && t.result.status === "ok");
  if (byMeaning && !normalMatch) return productsMentionedInAnswer(cards, text, { strict: true });
  // Matches that rest only on a word in a description are the model's material too: a card needs a mention.
  const listed = searches.flatMap((t) => (Array.isArray(t.result.products) ? t.result.products : []));
  const weakOnly = !byMeaning && listed.length > 0 && listed.every((p) => Number(p?.matchConfidence) > 0 && Number(p.matchConfidence) < 0.55);
  if (weakOnly) return productsMentionedInAnswer(cards, text, { strict: true });
  // "Nearest of the same kind" is not what was asked: such a card needs a mention in the reply too.
  const closestOnly = !byMeaning && !normalMatch && searches.some((t) => ["closest_alternatives", "over_budget"].includes(t.result.status));
  if (closestOnly) return productsMentionedInAnswer(cards, text, { strict: true });
  const named = productsMentionedInAnswer(cards, text);
  // The reply names products, none of them among these cards: these cards belong to another answer.
  if (named.length === 0 && cards.length > 0 && replyNamesOtherProducts(text)) return [];
  // A shopper who asked for a KIND of product ("show me jeans") is choosing, so the cards are the products the search returned for
  // that kind, whether or not the model happened to name each of them. A shopper who asked about ONE product keeps the rule above.
  if (FOR_ONE_PRODUCT.test(String(userMessage || "")) && named.length > 0 && named.length < cards.length) {
    const strictNamed = productsMentionedInAnswer(cards, text, { strict: true });
    // the product it is for ("Galaxy A55") is named too, but it is not what was asked: the cards are what this turn's search found
    const lastFound = new Set(([...searches].reverse().find((t) => Array.isArray(t?.result?.products) && t.result.products.length)?.result.products || []).map((p) => String(p.title).toLowerCase()));
    const fromSearch = strictNamed.filter((p) => lastFound.has(String(p.title).toLowerCase()));
    if (fromSearch.length > 0) return fromSearch;
    if (strictNamed.length > 0) return strictNamed;
  }
  const browse = browseCards(cards, searches, named);
  if (browse) return browse;
  return named.length > 0 && named.length < cards.length ? named : cards;
}

// "jeans" and "jean", "watches" and "watch": the same word for matching.
function stem(word) {
  const w = String(word || "");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(?:ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}
const stems = (text) => [...new Set(matchKey(text).split(" ").filter((t) => t.length > 1).map(stem))];

/**
 * Is the search the shopper's request names a KIND of product, and which of the found products are of that kind?
 *  - every word of the search is in the titles of two or more found products ("jeans" -> six jeans): those products;
 *  - no title has all the words, but two or more found products share one category ("smartphone" -> four phones whose titles say
 *    iPhone, Nord, Redmi, Galaxy): the largest category;
 *  - exactly one title has all the words ("iPhone 15", "Samsung Galaxy A55"): the shopper asked about one product, not a kind.
 * Only products this search returned are ever used, so nothing is invented and nothing unrelated is added.
 * @returns {object[] | null} the cards to show (the ones the reply names first), or null when this is not a browse request.
 */
export function browseCards(cards = [], searches = [], named = []) {
  const search = [...searches].reverse().find((t) => t?.result?.mode === "single" && t.result.status === "ok" && !t.result.sortedBy && Array.isArray(t.result.products) && t.result.products.length >= 2);
  if (!search || cards.length < 2) return null;
  // Words that never name a kind of product ("inch", "show", "the") must not be required in a title: "15 inch laptop" has no title with "inch".
  const tokens = stems(search.result.searchedCategory).filter((t) => !SEARCH_STOPWORDS.has(t));
  if (tokens.length === 0) return null;
  const found = search.result.products;
  const withAll = found.filter((p) => tokens.every((t) => stems(p.title).includes(t)));
  let kind = [];
  if (withAll.length >= 2) kind = withAll;
  else if (withAll.length === 0) {
    const byCategory = new Map();
    for (const p of found) if (p?.category) byCategory.set(p.category, [...(byCategory.get(p.category) || []), p]);
    const groups = [...byCategory.values()].sort((a, b) => b.length - a.length);
    // two categories of the same size (backpacks and laptops for "15 inch laptop") do not say which one the shopper meant: keep every card
    if (groups.length > 1 && groups[0].length === groups[1].length) return null;
    kind = groups[0] || [];
  }
  if (kind.length < 2) return null;
  const titles = new Set(kind.map((p) => p.title));
  const ofKind = cards.filter((c) => titles.has(c.title));
  const first = named.filter((c) => titles.has(c.title));
  // The reply names products, and none of them is of the kind this search found (a gift search listed women's accessories while the
  // reply recommended earbuds): the shopper is told about the named products, so those are the cards, never the search's kind.
  if (named.length > 0 && first.length === 0) {
    // a named product this search did not even return came from somewhere else; one the search did return may still be of the kind
    // ("Lenovo IdeaPad Slim 3" is a laptop although its title lacks the word)
    const returned = new Set(found.map((p) => p.title));
    if (!named.some((c) => returned.has(c.title))) return null;
  }
  const shown = [...first, ...ofKind.filter((c) => !first.includes(c))].filter((c, i, all) => all.findIndex((x) => (x.id && c.id ? x.id === c.id : x.title === c.title)) === i);
  return shown.length >= 2 ? shown : null;
}

/**
 * Cards from the quick pre-check that ran before the model answered. When a search tool ran this turn and found
 * nothing, that IS the answer: the pre-check's loose guesses (jeans for "PlayStation") are not shown next to it.
 */
export function speculativeCards(toolLog = [], speculative = [], text = "") {
  const searchFoundNothing = (toolLog || []).some(
    (t) => ["search_products", "get_recommendations", "get_product_details"].includes(t?.name) && ["no_match", "not_found"].includes(String(t?.result?.status || ""))
  );
  if (searchFoundNothing || !Array.isArray(speculative) || speculative.length === 0) return [];
  return productsMentionedInAnswer(speculative, text, { strict: true, nameRun: true });
}
