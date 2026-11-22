// Which message a stated budget comes from: this message, or (only for a SHORT refinement such as "black one" or "in size M") the previous one.
// A new full question has its own wishes; the budget of an earlier request must not filter it (real widget, 2026-11-17: "under $100" for
// sneakers made "compare the Samsung and the OnePlus" answer "both are over your $100 budget").
// A short message that asks for a DIFFERENT kind of product ("laptop dikhao" after "phones under 45000") is a new request too. A budget
// asked on its own ("1000 ke andar kya milega?") still applies to the product named next ("t-shirt chahiye"): the shopper set that limit.
import { budgetFromText, SEARCH_STOPWORDS, OPTIONAL_ADJECTIVES } from "../tools/shopify/words.js";

const ASKS_FOR = /\b(?:show|want|need|looking\s+for|find|have|chahiye|chahie|chaiye|dikhao|dikhaiye|dikha|milega|milegi|milta|batao|bataiye|suggest|recommend)\b|चाहिए|दिखाओ|दिखाइए|मिलेगा|बताओ/i;
const BUDGET_WORDS = new Set(["under", "below", "less", "than", "within", "upto", "up", "max", "maximum", "budget", "andar", "tak", "kam", "neeche", "rupees", "rupaye", "rupay", "rs", "inr", "usd", "dollars", "price", "range", "around", "about", "kya", "kuch", "koi", "mil", "sakta", "sakti", "milega", "milegi", "hazar", "hazaar", "thousand", "lakh", "k"]);

/** The words of a message that can name a product (not fillers, budget words, numbers or adjectives). */
export function productWords(text = "") {
  return String(text || "")
    .toLowerCase()
    // eslint-disable-next-line no-misleading-character-class -- a whole Devanagari block range, vowel signs included on purpose
    .split(/[^a-z\u0900-\u097F]+/)
    .filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w) && !OPTIONAL_ADJECTIVES.has(w) && !BUDGET_WORDS.has(w) && !ASKS_FOR.test(w));
}

export function budgetSourceMessage(userMessage, history = []) {
  const now = String(userMessage || "");
  if (budgetFromText(now)) return now;
  const short = now.trim().split(/\s+/).filter(Boolean).length <= 5;
  if (!short) return null;
  const previous = [...(history || [])].reverse().find((m) => m?.role === "user");
  const text = previous ? String(previous.content || "") : "";
  if (!budgetFromText(text)) return null;
  // a new request for another kind of product: its own wishes, not the earlier product's budget
  if (ASKS_FOR.test(now)) {
    const before = new Set(productWords(text));
    const fresh = productWords(now).filter((w) => !before.has(w));
    if (before.size > 0 && fresh.length > 0) return null;
  }
  return text;
}
