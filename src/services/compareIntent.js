// A shopper who asks to compare two named products wants compare_products (both cards + a head-to-head), not a plain
// search that returns look-alikes and accessories. Only the WORDS OF THE REQUEST are recognised here (compare, versus,
// difference between, in English, Hinglish and Hindi); product names come from the shopper's own message.

const COMPARE_RES = [
  /\bcompar(?:e|es|ed|ing|ison|isons)\b/i,
  /\b(?:vs\.?|versus)\b/i,
  /\bdifference(?:s)?\s+between\b/i,
  /\bwhich\s+(?:one\s+)?(?:is|are)\s+better\b/i,
  /\b(?:tulna|tulana|muqabla|muqabala|farak|fark)\b/i,
  /\b(?:kaun|kaunsa|konsa|kaunsi)\s*(?:sa|si)?\s+(?:behtar|better|accha|achha|badhiya)\b/i,
  /(?:तुलना|मुकाबला|फर्क|अंतर)/,
];

export function isComparisonRequest(text = "") {
  const value = String(text || "");
  return COMPARE_RES.some((re) => re.test(value));
}

const REQUEST_WORDS = /\b(?:compare|comparison|comparisons|tulna|tulana|muqabla|muqabala|karo|kro|kijiye|kariye|kar\s+do|between|difference|differences|farak|fark|vs|versus|please|plz|pls|batao|bataiye|dikhao)\b\.?/gi;

/** The product names being compared: the model's own search terms when it gave two or more, else the names in the message. */
export function comparedNames(message = "", searchTerms = []) {
  const given = (Array.isArray(searchTerms) ? searchTerms : []).map((t) => String(t || "").trim()).filter(Boolean);
  if (given.length >= 2) return [...new Set(given)].slice(0, 4);
  const parts = String(message || "")
    .split(/\s+(?:and|aur|vs\.?|versus|with|or|ya|&|\+)\s+|[,;]|\bvs\.?\b/i)
    .map((part) => part.replace(REQUEST_WORDS, " ").replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 1);
  return [...new Set(parts)].slice(0, 4);
}
