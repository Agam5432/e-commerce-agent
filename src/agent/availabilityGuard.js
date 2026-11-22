// "We don't have bags" while the store's own search just returned three bags is a false "no": the shopper leaves
// without buying something the store sells. This finds that contradiction from the facts of the turn alone (the tool
// results), so it works for any store, product or language.
import { claimsUnavailable } from "./factGuard.js";
import { productsMentionedInAnswer } from "./cardSelection.js";

const SEARCH_TOOLS = new Set(["search_products", "get_recommendations"]);
const SELLABLE_STATUS = new Set(["ok", undefined]);

/** True when a search tool ran this turn. */
export function searchRan(toolLog = []) {
  return (toolLog || []).some((t) => SEARCH_TOOLS.has(t?.name) && t?.result);
}

/**
 * In-stock products the turn's own searches returned as real matches, or [] when there is no such evidence. Only a real
 * search counts (a quick keyword pre-check is too loose: "phone" would find phone cases). A product the same-kind check
 * found to be a different kind of item than the wish (`sameKind[title] === false`) is not a match: "we do not have
 * fitness bands" is true even when the search by meaning returned shoes.
 */
export function storeMatchesForTurn(toolLog = [], sameKind = {}) {
  const searches = (toolLog || []).filter((t) => SEARCH_TOOLS.has(t?.name) && t?.result);
  const found = [];
  for (const { result } of searches) {
    if (!SELLABLE_STATUS.has(result.status)) continue;
    for (const p of [...(Array.isArray(result.products) ? result.products : []), ...(Array.isArray(result.alsoMatchesByMeaning) ? result.alsoMatchesByMeaning : [])]) {
      const sure = p?.matchConfidence == null || Number(p.matchConfidence) >= 0.55;
      if (p?.title && sure && p.matchKind !== "description" && !p.notExactMatch && p.inStock !== false && sameKind?.[p.title] !== false && !found.some((f) => f.title === p.title)) found.push(p);
    }
  }
  return found;
}

/**
 * Titles of in-stock products the reply wrongly leaves out when it says the item is unavailable.
 * [] when the reply is consistent with the data (it does not say "unavailable", or it names a product, or the store has none).
 */
export function contradictedAvailability({ text = "", toolLog = [], sameKind = {} } = {}) {
  if (!claimsUnavailable(text)) return [];
  const matches = storeMatchesForTurn(toolLog, sameKind);
  if (matches.length === 0) return [];
  if (productsMentionedInAnswer(matches, text, { strict: true }).length > 0) return [];
  return matches.slice(0, 6).map((p) => p.title);
}

const PRODUCT_LOOKUP_TOOLS = new Set(["search_products", "get_recommendations", "get_product_details", "compare_products", "check_variant_availability"]);

/**
 * True when the store's product lookups failed this turn (Shopify did not answer) and none of them worked. The reply must then
 * say that the check could not be done: never "we do not have it", and never products or prices made up from memory.
 */
export function productLookupFailed(toolLog = []) {
  const lookups = (toolLog || []).filter((t) => PRODUCT_LOOKUP_TOOLS.has(t?.name) && t?.result);
  if (!lookups.length) return false;
  return lookups.some((t) => t.result.status === "error") && !lookups.some((t) => t.result.status !== "error");
}

/** What the shopper hears when the store could not be asked. No products, no prices, no "not available". */
export function lookupFailedReply(replyLanguage = "en") {
  return replyLanguage === "hi"
    ? "अभी स्टोर का कैटलॉग चेक नहीं हो पा रहा है, इसलिए मैं अंदाज़ा नहीं लगाना चाहती। कृपया थोड़ी देर बाद फिर से पूछें।"
    : "I could not check the store's catalog just now, so I do not want to guess. Please ask me again in a moment.";
}
