// Fact guard: the AI writes every reply in its own words, and this module only checks that it did not
// invent money amounts or order IDs. Any amount or order ID in the reply must appear in the verified
// tool data of this turn (Shopify results, the cart, the verified summary). If not, the caller falls
// back to the verified wording for that turn.
import { currencyMark } from "../utils/money.js";

// Money as people write it: with a currency mark, with decimals, or with thousands grouping
// (Western 1,234,567 and Indian 1,23,456). Bare small integers ("2 items") are not money claims.
const MONEY_RE =
  /(?:(?:[$€£₹]|rs\.?|inr|usd|eur|gbp|aed|cad|aud)\s?-?\d[\d,]*(?:\.\d{1,2})?)|(?:-?\d[\d,]*\.\d{2}\b)|(?:\b\d{1,3}(?:,\d{2,3})+\b)/gi;
const ORDER_ID_RE = /#\s?[A-Z]{0,4}\d{3,}\b/gi;
const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

// ---- currency sign ----------------------------------------------------------------------------------------------------------
// The AI copies amounts from the tool results, but it once wrote a USD store's "$429" as "₹429". The number was right, so the
// amount check above passed. Every currency sign or code written next to an amount is therefore also checked against the one
// currency the tool results name, and a wrong sign is replaced (never the amount, and never converted).
const CURRENCY_WORDS = "inr|usd|eur|gbp|aed|cad|aud";
const MARKED_MONEY_RE = new RegExp(String.raw`([$€£₹¥]|\brs\.?|\b(?:${CURRENCY_WORDS})\b)\s?(-?\d[\d,]*(?:\.\d{1,2})?)|(-?\d[\d,]*(?:\.\d{1,2})?)\s?\b(${CURRENCY_WORDS})\b`, "gi");
// "$" is the dollar of several countries, so it can name any of these; the other signs name one currency
const MARK_CODES = { "$": ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"], "₹": ["INR"], "€": ["EUR"], "£": ["GBP"], "¥": ["JPY", "CNY"], rs: ["INR"], "rs.": ["INR"] };
const codesFor = (mark) => {
  const m = String(mark || "").toLowerCase();
  return MARK_CODES[m] || (/^[a-z]{3}$/.test(m) ? [m.toUpperCase()] : []);
};
const ISO_CODES = (() => {
  try { return new Set(Intl.supportedValuesOf("currency")); } catch { return new Set(); }
})();

/** The one currency the verified data names; "" when it names none or several (then nothing is guessed). */
export function dataCurrency(sources = []) {
  const strings = [];
  collectStrings(sources, strings);
  const codes = new Set(strings.map((s) => s.trim()).filter((s) => /^[A-Z]{3}$/.test(s) && ISO_CODES.has(s)));
  return codes.size === 1 ? [...codes][0] : "";
}

/** Amounts in the text written with a sign or code that is not `currency`'s. */
export function findWrongCurrency(text = "", currency = "") {
  const want = String(currency || "").toUpperCase();
  if (!want) return [];
  const wrong = [];
  for (const m of String(text || "").matchAll(MARKED_MONEY_RE)) {
    const codes = codesFor(m[1] || m[4]);
    if (codes.length && !codes.includes(want)) wrong.push(m[0].trim());
  }
  return wrong;
}

/** The text with every wrong currency sign replaced by `currency`'s own sign; the amounts are left exactly as written. */
export function repairCurrencyMarks(text = "", currency = "") {
  const want = String(currency || "").toUpperCase();
  const sign = currencyMark(want);
  if (!want || !sign) return { text, repaired: [] };
  const repaired = [];
  const fixed = String(text || "").replace(MARKED_MONEY_RE, (whole, markBefore, amountAfterMark, amountBeforeWord, wordAfter) => {
    const codes = codesFor(markBefore || wordAfter);
    if (!codes.length || codes.includes(want)) return whole;
    repaired.push(whole.trim());
    return markBefore ? `${sign}${amountAfterMark}` : `${amountBeforeWord} ${want}`;
  });
  return { text: fixed, repaired };
}

function toCents(raw) {
  const cleaned = String(raw || "").replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) * 100);
}

function normalizeOrderId(raw) {
  return String(raw || "").replace(/\s+/g, "").toUpperCase();
}

/** Money amounts (in cents) and order IDs the text states. */
export function extractClaims(text = "") {
  const value = String(text || "");
  const amounts = [];
  for (const match of value.matchAll(MONEY_RE)) {
    const cents = toCents(match[0]);
    if (cents != null && cents > 0) amounts.push({ raw: match[0].trim(), cents });
  }
  const orderIds = [...value.matchAll(ORDER_ID_RE)].map((m) => normalizeOrderId(m[0]));
  return { amounts, orderIds };
}

function collectStrings(value, out, depth = 0) {
  if (value == null || depth > 8) return;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

/**
 * Every amount and order ID that the verified sources contain. Cart snapshots use minor units
 * (Shopify Ajax cart), so integers are also accepted divided by 100.
 */
export function knownFacts(sources = []) {
  const strings = [];
  collectStrings(sources, strings);
  const cents = new Set();
  const orderIds = new Set();
  for (const s of strings) {
    for (const m of s.matchAll(NUMBER_RE)) {
      const c = toCents(m[0]);
      if (c == null) continue;
      cents.add(c);
      if (/^\d+$/.test(m[0].replace(/,/g, ""))) cents.add(Math.round(c / 100));
    }
    for (const m of s.matchAll(ORDER_ID_RE)) orderIds.add(normalizeOrderId(m[0]));
    // Bare order names stored without "#" ("1001") still count.
    for (const m of s.matchAll(/\b\d{3,}\b/g)) orderIds.add(`#${m[0]}`);
  }
  return { cents, orderIds };
}

/**
 * Checks an AI reply against verified data.
 * @returns {{ ok: boolean, unknownAmounts: string[], unknownOrderIds: string[], missingOrderId: string }}
 */
// Product specs the model may not make up: a number with a unit ("42 hours", "20000mAh", "6.1-inch", "128GB").
// The number must appear somewhere in the verified data of the turn (title, description, options) or in the
// shopper's own words; the unit is not compared, so "20000 mAh" matches a title that says "20000mAh".
const SPEC_RE = /(\d+(?:\.\d+)?)\s?-?\s?(?:hours?|hrs?|mah|gb|tb|mp|megapixels?|inch(?:es)?|watts?|w|hz|mm|kg|grams?|months?|years?|yrs?)\b/gi;

/** Numbers-with-units in the text, as {raw, number}. */
export function extractSpecClaims(text = "") {
  const out = [];
  for (const m of String(text || "").matchAll(SPEC_RE)) out.push({ raw: m[0].trim(), number: String(Number(m[1])) });
  return out;
}

// Named product features the model may not add on its own ("triple camera", "in-display fingerprint sensor", "Sony sensor",
// "expandable storage"): each must be in the store's data the reply is checked against. Found on a real run (2026-11-21): the
// listing said "multi-lens camera", the reply said "triple camera ... in-display fingerprint ... 50 megapixel Sony camera".
const FEATURE_CLAIMS = [
  { re: /\b(?:triple|dual|quad|penta|double)[\s-]+(?:rear\s+)?(?:camera|lens|cam)\w*/i, any: ["triple", "dual", "quad", "penta", "double"] },
  { re: /\bfingerprint\b|फिंगरप्रिंट/i, any: ["fingerprint"] },
  { re: /\bface\s*(?:id|unlock)\b/i, any: ["face"] },
  { re: /\bexpandable\b|\bmicro\s*-?\s*sd\b|\bmemory\s+card\b/i, any: ["expandable", "microsd", "micro sd", "memory card", "sd card"] },
  { re: /\bsony\b|सोनी/i, any: ["sony"] },
  { re: /\b(?:snapdragon|dimensity|helio|exynos|bionic|tensor)\b/i, any: ["snapdragon", "dimensity", "helio", "exynos", "bionic", "tensor"] },
  { re: /\b(?:super\s+)?amoled\b|एमोलेड|अमोलेड/i, any: ["amoled"] },
  { re: /\boled\b/i, any: ["oled"] },
  { re: /\b(?:ois|optical\s+image\s+stabili[sz]ation)\b/i, any: ["ois", "optical image"] },
  { re: /\bwireless\s+charging\b/i, any: ["wireless charging"] },
  { re: /\b(?:active\s+)?noise[\s-]+cancel\w*|\banc\b/i, any: ["noise cancel", "noise-cancel", "anc"] },
  { re: /\b(?:waterproof|water[\s-]+resistant|ip\s?6[4-8]|ip\s?5[3-5]|splash[\s-]+proof)\b/i, any: ["waterproof", "water-resistant", "water resistant", "ip6", "ip5", "splash"] },
  { re: /\bheadphone\s+jack\b|\b3\.5\s*mm\b/i, any: ["headphone jack", "3.5mm", "3.5 mm"] },
  { re: /\bnfc\b/i, any: ["nfc"] },
  { re: /\b(?:120|90|144|165)\s*hz\b|\brefresh\s+rate\b/i, any: ["hz", "refresh"] },
  { re: /\bgorilla\s+glass\b/i, any: ["gorilla"] },
  { re: /\bstereo\s+speakers?\b|\bdolby\b/i, any: ["stereo", "dolby"] },
  { re: /\blow[\s-]+light\b/i, any: ["low light", "low-light", "night"] },
];
// "the listing does not mention a headphone jack" names a feature without claiming it
const NEGATED_FEATURE = /\b(?:not|no|doesn'?t|does not|isn'?t|nahi|nahin|nhi|without)\b|नहीं/i;

/** Named features in the reply that none of the verified data mentions. */
export function unknownFeatureClaims(reply = "", sources = []) {
  const strings = [];
  collectStrings(sources, strings);
  const ev = strings.join(" ").toLowerCase();
  const out = [];
  for (const sentence of String(reply || "").split(/(?<=[.!?\n])\s+|\n/)) {
    if (!sentence.trim() || NEGATED_FEATURE.test(sentence)) continue;
    for (const f of FEATURE_CLAIMS) {
      const m = sentence.match(f.re);
      if (m && !f.any.some((w) => ev.includes(w))) out.push(m[0].trim());
    }
  }
  return [...new Set(out)];
}

function knownNumbers(sources = []) {
  const strings = [];
  collectStrings(sources, strings);
  const numbers = new Set();
  for (const s of strings) for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) numbers.add(String(Number(m[0])));
  return numbers;
}

export function verifyReplyFacts(reply, sources = [], { requiredOrderId = "", currency = "" } = {}) {
  const claims = extractClaims(reply);
  // amounts written with another currency's sign than the one the tool results name (only when `currency` is known)
  const wrongCurrency = findWrongCurrency(reply, currency);
  const facts = knownFacts(sources);
  const numbers = knownNumbers(sources);
  const unknownSpecs = [...extractSpecClaims(reply).filter((c) => !numbers.has(c.number)).map((c) => c.raw), ...unknownFeatureClaims(reply, sources)];
  const unknownAmounts = claims.amounts
    .filter((a) => !facts.cents.has(a.cents))
    .map((a) => a.raw);
  const unknownOrderIds = claims.orderIds.filter((id) => !facts.orderIds.has(id));
  const wanted = requiredOrderId ? normalizeOrderId(requiredOrderId.startsWith("#") ? requiredOrderId : `#${requiredOrderId}`) : "";
  const replyIds = new Set([
    ...claims.orderIds,
    ...[...String(reply || "").matchAll(/\b\d{3,}\b/g)].map((m) => `#${m[0]}`),
  ]);
  const missingOrderId = wanted && !replyIds.has(wanted) ? wanted : "";
  return {
    ok: unknownAmounts.length === 0 && unknownOrderIds.length === 0 && !missingOrderId && wrongCurrency.length === 0,
    wrongCurrency,
    unknownSpecs,
    unknownAmounts,
    unknownOrderIds,
    missingOrderId,
  };
}
// Some models narrate their own working before the reply ("The customer asked in English, so I'll reply in
// English."). That is never for the shopper: those sentences are cut, the rest of the reply is kept.
const NARRATION = [
  /\b(?:so|thus|therefore|hence)\b[^.!?\n]{0,40}\bI(?:'ll| will|'m going to| am going to)\s+(?:reply|respond|answer|write|speak)\b/i,
  /\b(?:customer|user|shopper)(?:'s|s)?\s+(?:last |latest |current )?(?:message|query|request|text)\b[^.!?\n]{0,60}\b(?:is|was|says|said|in)\b/i,
  /\b(?:this|the|your)\s+(?:last |latest )?message\s+(?:is|was)\s+(?:in|written in)\b/i,
  /\b(?:customer|user|shopper)\s+(?:asked|asks|says|said|wants|wrote|writes|is asking)\b[^.!?\n]{0,60}\b(?:in\s+(?:English|Hindi|Hinglish)|so I)\b/i,
  /\bHinglish\b[^.!?\n]{0,30}\b(?:jawab|reply|baat|answer)\b[^.!?\n]{0,20}\b(?:deti|dungi|karti|karta|karunga|karungi|karte|hoon|hu|hain)\b/i,
  /\blive search\b/i,
  /\b(?:Hinglish|English|Hindi)\s+reply\s+(?:needed|required)\b/i,
  /^\s*(?:the\s+)?(?:customer|user|shopper)\s+(?:wants|needs|is looking for|is asking for)\b[^.!?]{0,80}\b(?:gender|unknown|live search|search results?)\b/i,
  /\b(?:so\s+)?(?:the\s+)?reply\s+(?:is|will be)\s+in\s+(?:English|Hindi|Hinglish)\b/i,
  /\b(?:reply|respond|answer)\s+(?:in|only in)\s+(?:English|Hindi|Hinglish)\s+(?:only|since|because)\b/i,
];
export function stripReasoningLeak(text = "") {
  const lines = String(text ?? "").split("\n").map((line) => {
    const parts = line.match(/[^.!?:]+[.!?:]*\s*/g) || [line];
    return parts.filter((part) => !NARRATION.some((re) => re.test(part))).join("");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A reply that says the cart was changed ("I have added another pair to your cart", "cart me daal diya") while no
// cart action happened this turn is a false promise: the shopper's cart did not change. Wording in English, Hinglish
// and Devanagari Hindi; asking about the cart or showing it never matches.
const CART_WORD = String.raw`(?:cart|bag|basket|कार्ट|कार्ट)`;
const CART_CHANGE_RES = [
  new RegExp(String.raw`\b(?:added|removed|updated|cleared|emptied|deleted|put|moved)\b[^.\n!?]{0,70}\b${CART_WORD}\b`, "i"),
  new RegExp(String.raw`\b${CART_WORD}\b[^.\n!?]{0,40}\b(?:updated|cleared|emptied)\b`, "i"),
  new RegExp(String.raw`\b${CART_WORD}\s*(?:me|mein|se)\b[^.\n!?]{0,50}\b(?:diya|diye|kar\s+diya|kar\s+di|ho\s+gaya|ho\s+gayi)\b`, "i"),
  /\b(?:add|jod|daal|dal|hata|nikal)\w*\s+(?:kar\s+)?(?:diya|diye|di)\b/i,
  /(?:कार्ट)[^.\n!?]{0,40}(?:जोड़|डाल|हटा|खाली)[^.\n!?]{0,15}(?:दिया|दी|दिये)/,
];
/** Action types that really change the shopper's cart. Showing the cart ("show_cart") changes nothing. */
export const CART_CHANGE_ACTIONS = new Set(["add_to_cart", "cart_add", "update_cart", "clear_cart"]);
export const changedCart = (actions = []) => (actions || []).some((a) => CART_CHANGE_ACTIONS.has(String(a?.type || "")));

// A reply that says a discount code is applied ("CHAT20 laga diya", "applied the code", "कोड लगा दिया") while no discount was applied
// this turn and none is on the checkout is a false promise: the total the shopper pays has no discount.
const DISCOUNT_APPLIED_RES = [
  /\b(?:applied|added|activated|redeemed)\b[^.\n!?]{0,40}\b(?:code|coupon|discount|offer)\b/i,
  /\b(?:code|coupon|discount|offer)\b[^.\n!?]{0,40}\b(?:applied|activated|redeemed|laga\s+(?:diya|di|diye|gaya|gayi)|lag\s+(?:gaya|gayi)|apply\s+(?:kar\s+)?(?:diya|di|ho\s+gaya|ho\s+gayi))\b/i,
  /\b(?:laga|apply\s+kar)\s+(?:diya|di|diye)\b[^.\n!?]{0,40}\b(?:code|coupon|discount)\b/i,
  /(?:कोड|कूपन|डिस्काउंट)[^.\n!?]{0,30}(?:लगा|अप्लाई)[^.\n!?]{0,10}(?:दिया|दी|गया|गई)/,
  // a code named by itself ("CHAT20 apply ho gaya", "SAVE10 is applied")
  /\b[A-Z][A-Z0-9]{3,}\b[^.\n!?]{0,30}\b(?:(?:is|has\s+been|was)\s+applied|applied|apply\s+(?:kar\s+)?(?:diya|di|ho\s+gaya|ho\s+gayi)|laga\s+(?:diya|di|gaya|gayi)|lag\s+(?:gaya|gayi))/,
];
export function claimsDiscountApplied(text = "") {
  const value = String(text || "");
  return value.split(/(?<=[.!?\n])\s+/).some((s) => !/\?\s*$/.test(s) && !/\b(?:not|nahi|nahin|nhi|can'?t|cannot|won'?t)\b|नहीं/i.test(s) && DISCOUNT_APPLIED_RES.some((re) => re.test(s)));
}

export function claimsCartChange(text = "") {
  // The dot inside a price ("$19.00") is not the end of a sentence: "added the earbuds ($19.00) to your cart" is one claim.
  const value = String(text || "").replace(/(\d)[.,](?=\d)/g, "$1");
  return CART_CHANGE_RES.some((re) => re.test(value));
}

// A reply that tells the shopper the item is NOT available while the store's own search found it in stock is a false
// "no". Wording in English, Hinglish and Devanagari Hindi; it describes the reply, never a product, so it works for any
// store. Used together with the products the tools returned (see availabilityGuard.js), never alone.
const UNAVAILABLE_RES = [
  /\b(?:do(?:es)?\s*n(?:o|')?t|don[’']?t|doesn[’']?t|dont|cannot|can[’']?t|currently\s+(?:do(?:es)?\s*not|don[’']?t))\s+(?:currently\s+|really\s+)?(?:have|carry|sell|stock|offer)\b/i,
  /\b(?:not|isn[’']?t|aren[’']?t|unavailable)\b[^.\n!?]{0,15}\bavailable\b/i,
  /\bunavailable\b/i,
  /\bno\s+[^.\n!?]{0,40}\b(?:available|in\s+stock)\b/i,
  /\b(?:out\s+of\s+stock|sold\s+out)\b/i,
  /\bnot\s+(?:sold|stocked|carried|offered)\b/i,
  /\b(?:available|stock(?:\s+mein)?|milta|milti|mil\s+raha|hamare\s+paas|humare\s+paas|store\s+(?:me|mein))\b[^.\n!?]{0,30}\b(?:nahi|nahin|nhi)\b/i,
  /\b(?:nahi|nahin|nhi)\b[^.\n!?]{0,15}\b(?:hai|hain|milta|milti|available)\b/i,
  /(?:उपलब्ध|स्टॉक)[^.\n!?]{0,15}नहीं|नहीं\s+(?:है|हैं|मिल)/,
];
export function claimsUnavailable(text = "") {
  // "Abhi aapke cart mein koi item nahi hai" says the CART is empty, not that the store lacks something (live 2026-11-22: it set off a
  // rewrite that brought back claims an earlier check had removed)
  const value = String(text || "").split(/(?<=[.!?\n])\s*/).filter((sentence) => !/\b(?:cart|basket)\b|कार्ट/i.test(sentence)).join(" ");
  return UNAVAILABLE_RES.some((re) => re.test(value));
}

// A reply that says a person is being connected, or that the request was passed to the store team, while no such request was
// made this turn is a false promise: nobody was told. Wording in English, Hinglish and Devanagari Hindi. Offers ("I can pass this
// to the team", "kya main team ko bata doon?") are not claims.
const OFFER_RE = /\?|\b(?:would you like|do you want|shall i|should i|can i|if you (?:want|like|wish)|let me know|kya (?:main|aap)|chahenge|chahoge|chahte|chahiye)\b|चाहेंगे|चाहते/i;
const CONNECT_CLAIM_RES = [
  /\b(?:trying|try)\s+to\s+(?:connect|reach|get)\b[^.\n!?]{0,40}\b(?:representative|agent|person|human|support|team)\b/i,
  /\bconnecting\s+you\b/i,
  /\b(?:representative|agent|insaan|person|support|team)\b[^.\n!?]{0,40}\bse\b[^.\n!?]{0,25}\bbaat\b[^.\n!?]{0,25}\bkar(?:wa|a)(?:ne|ti|ta)?\b[^.\n!?]{0,25}\b(?:koshish|rahi|raha)\b/i,
  /\bbaat\b[^.\n!?]{0,50}\b(?:representative|agent|insaan|person|support|team)\b[^.\n!?]{0,25}\bkar(?:wa|a)\w*\b[^.\n!?]{0,25}\b(?:koshish|rahi|raha)\b/i,
  /(?:कनेक्ट|जोड़ने)[^.\n!?]{0,30}(?:कोशिश|रही|रहा)/,
];
const PASS_CLAIM_RES = [
  /\b(?:passed|passing|forwarded|forwarding|flagged|flagging|escalated|escalating|informed|alerted|notified)\b[^.\n!?]{0,50}\b(?:team|owner|staff)\b/i,
  /\bpass(?:ing)?\s+(?:this|it|your\s+\w+)\b[^.\n!?]{0,30}\b(?:team|owner|staff)\b/i,
  /\b(?:team|owner|staff)\b[^.\n!?]{0,30}\b(?:ko|tak)\b[^.\n!?]{0,40}\b(?:pass|bhej|pahunch|forward|aage|bata|inform)\w*[^.\n!?]{0,20}\b(?:di|diya|rahi|raha|dungi|dunga|deti|deta)\b/i,
  /टीम[^.\n!?]{0,40}(?:भेज|बता|पहुंचा)[^.\n!?]{0,20}(?:दिया|दी|रही|रहा)/,
];
/** @returns {"connect" | "pass" | ""} what the reply claims it did for the shopper, or "" when it claims nothing. */
export function claimsPersonHandoff(text = "") {
  const sentences = String(text || "").split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    if (OFFER_RE.test(sentence)) continue;
    if (CONNECT_CLAIM_RES.some((re) => re.test(sentence))) return "connect";
    if (PASS_CLAIM_RES.some((re) => re.test(sentence))) return "pass";
  }
  return "";
}

/** What the shopper hears when nobody can join the chat right now but the store team has been told. */
export function teamToldReply(replyLanguage = "en") {
  return replyLanguage === "hi"
    ? "अभी कोई व्यक्ति चैट में जुड़ नहीं सकता, लेकिन मैंने स्टोर टीम को आपकी बात बता दी है। वे आपसे संपर्क करेंगे।"
    : "Nobody can join this chat right now, but I have told the store team about your request and they will follow up with you.";
}

/** What the shopper hears when this chat can neither connect a person nor alert the team. */
export function noPersonReply(replyLanguage = "en") {
  return replyLanguage === "hi"
    ? "मैं इस चैट से आपको किसी व्यक्ति या स्टोर टीम से नहीं जोड़ सकती। कृपया स्टोर की वेबसाइट पर दिए संपर्क विवरण का उपयोग करें।"
    : "I cannot connect you with a person or the store team from this chat. Please use the contact details on the store's website.";
}

// A reply that says "your order preview is above" while no preview card was made this turn points the shopper at nothing.
// Wording in English, Hinglish and Devanagari Hindi; questions and offers ("shall I show the preview?") are not claims.
const PREVIEW_CLAIM_RES = [
  /\b(?:preview|review)\b[^.\n!?]{0,40}\b(?:above|below|on\s+(?:your\s+)?screen|shown|ready|attached)\b/i,
  /\b(?:preview|review)\b[^.\n!?]{0,30}\b(?:upar|ooper|neeche|niche|dikh|dikha)\w*/i,
  /प्रीव्यू[^.\n!?]{0,30}(?:ऊपर|नीचे|दिख)/,
];
export function claimsPreviewShown(text = "") {
  return String(text || "").split(/(?<=[.!?\n])\s+/).some((sentence) => !OFFER_RE.test(sentence) && PREVIEW_CLAIM_RES.some((re) => re.test(sentence)));
}

// "From now on I will talk in Hinglish": a promise to keep a language. It is only true when the choice was saved
// (the set_reply_language tool). The language is named by the SHOPPER in their message.
const LANGUAGE_PROMISE_RES = [
  /\b(?:from\s+now\s+on|ab\s+se|aage\s+se|going\s+forward|henceforth)\b[^.\n!?]{0,70}\b(?:hindi|english|hinglish)\b/i,
  /\b(?:hindi|english|hinglish)\b[^.\n!?]{0,40}\b(?:mein|me|in)\b[^.\n!?]{0,25}\b(?:hi\s+)?(?:baat|reply|talk|speak|jawab|chat|answer)\w*/i,
  /(?:अब\s+से|आगे\s+से)[^.\n!?]{0,60}(?:हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी)/,
];
export function claimsLanguageSwitch(text = "") {
  return String(text || "").split(/(?<=[.!?\n])\s+/).some((sentence) => !OFFER_RE.test(sentence) && LANGUAGE_PROMISE_RES.some((re) => re.test(sentence)));
}
/** @returns {"hinglish" | "hindi" | "english" | ""} the language the shopper's message asks for by name. */
export function languageAskedFor(message = "") {
  const text = String(message || "");
  if (/\bhinglish\b/i.test(text)) return "hinglish";
  if (/\bhindi\b|हिंदी|हिन्दी/i.test(text)) return "hindi";
  if (/\benglish\b|\bangrezi\b|अंग्रेज़ी|अंग्रेजी/i.test(text)) return "english";
  return "";
}

// A reply that says a call IS booked (or is being booked) while no booking was made this turn promises something that did not
// happen. Offers and questions ("shall I book it?") are not claims.
const CALL_BOOKED_RES = [
  /\b(?:booked|scheduled|confirmed|reserved)\b[^.\n!?]{0,40}\b(?:call|slot|appointment|callback)\b/i,
  /\b(?:call|slot|appointment|callback)\b[^.\n!?]{0,40}\b(?:is|has been|have been|got)\s+(?:booked|scheduled|confirmed|reserved)\b/i,
  /\b(?:booking|scheduling|reserving)\b[^.\n!?]{0,40}\b(?:call|slot|appointment)\b/i,
  /\b(?:call|slot|callback)\b[^.\n!?]{0,50}\b(?:book|schedule)\s+(?:kar\s+(?:rahi|raha|diya|di|dungi|dunga|deti|deta)|ho\s+gaya|ho\s+gayi)\b/i,
  /\b(?:book|schedule)\s+kar\s+(?:rahi|raha|diya|di|dungi|dunga)\b[^.\n!?]{0,40}\b(?:call|slot)\b/i,
];
export function claimsCallBooked(text = "") {
  return String(text || "").split(/(?<=[.!?\n])\s+/).some((sentence) => !OFFER_RE.test(sentence) && CALL_BOOKED_RES.some((re) => re.test(sentence)));
}

/** What the shopper hears when a reply promised a booking that was not made. */
export function callNotBookedReply(replyLanguage = "en") {
  return replyLanguage === "hi"
    ? "मैंने अभी कॉल बुक नहीं की है। कृपया बताइए कि आपको उपलब्ध समयों में से कौन सा समय चाहिए, मैं उसे बुक कर दूँगी।"
    : "I have not booked the call yet. Please tell me which of the available times you would like, and I will book it.";
}

// A reply that is the model thinking aloud ("The customer asks for X. They have a cart but ... the rule says I should ask ...") instead
// of talking to the shopper. Two or more such sentences make the whole reply unusable; it is written again.
const THINKING_ALOUD_RES = [
  /\b(?:the\s+)?(?:rule|rules|instruction|instructions|prompt|system\s+prompt)\s+(?:says?|state|states|tell|tells)\b/i,
  /\baccording\s+to\s+(?:the\s+)?(?:rules?|instructions?|prompt)\b/i,
  /\bI\s+(?:should|need\s+to|must|have\s+to)\s+(?:show|ask|call|use|check|answer|reply|respond)\b/i,
  /\b(?:the\s+)?(?:customer|user|shopper)\s+(?:asks|asked|wants|wrote|is\s+asking|said|says)\b/i,
  /\b(?:most\s+likely|probably)\s+means\b/i,
  /\b(?:is|are)\s+ambiguous\b/i,
  /\bthey\s+have\s+a\s+cart\b/i,
  /\bno\s+(?:checkout|order)\s+(?:is\s+)?(?:started|in\s+progress)\b/i,
];
export function looksLikeThinkingAloud(text = "") {
  const sentences = String(text || "").split(/(?<=[.!?\n])\s+/);
  return sentences.filter((sentence) => THINKING_ALOUD_RES.some((re) => re.test(sentence))).length >= 2;
}

// The shopper ASKS for a language to talk in ("talk to me in Hindi", "Hinglish mein reply do"). The request is in their own message.
const LANGUAGE_REQUEST_RES = [
  /\b(?:talk|speak|reply|respond|answer|chat|write|continue|switch)\b[^.\n!?]{0,40}\b(hindi|english|hinglish)\b/i,
  /\b(hindi|english|hinglish)\b[^.\n!?]{0,25}\b(?:mein|me|main)\b[^.\n!?]{0,25}\b(?:baat|reply|jawab|bolo|likho|chat|answer|do|karo|kijiye|kariye|bol)\b/i,
  /(?:हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी)\s*(?:में|मे)\s*(?:बात|जवाब|बोलो|लिखो)/,
];
/** @returns {"hinglish" | "hindi" | "english" | ""} the language the shopper asks to talk in, or "" when they only mention one. */
export function languageRequestedBy(message = "") {
  const text = String(message || "");
  if (!LANGUAGE_REQUEST_RES.some((re) => re.test(text))) return "";
  return languageAskedFor(text);
}

// A reply that says something HAS BEEN DONE for the shopper (an order placed, an order cancelled, a refund issued, a complaint
// raised, an e-mail sent) is only true when the backend confirmed it. The kinds below are checked against the tools' own results
// (`doneEvidence`); offers, questions and future wording ("will be refunded", "I can cancel it") are never claims. English,
// Hinglish and Devanagari Hindi.
const DONE_CLAIMS = {
  order_placed: [
    /\b(?:i(?:'ve|\s+have)?\s+)?(?:placed|confirmed)\s+(?:your|the)\s+order\b/i,
    /\b(?:your|the)\s+order\b[^.\n!?]{0,30}\b(?:has\s+been|is\s+now|was|got)\s+(?:successfully\s+)?(?:placed|confirmed)\b/i,
    /\border\b[^.\n!?]{0,30}\b(?:place|confirm)\s+ho\s+(?:gaya|gayi)\b/i,
    /ऑर्डर[^.\n!?]{0,30}(?:प्लेस|कन्फर्म)\s+हो\s+(?:गया|गई)/,
  ],
  order_cancelled: [
    /\b(?:i(?:'ve|\s+have)?\s+)?cancel(?:l)?ed\s+(?:your|the)\s+order\b/i,
    /\b(?:your|the)\s+order\b[^.\n!?]{0,30}\b(?:has\s+been|is\s+now|was|got)\s+(?:successfully\s+)?cancel(?:l)?ed\b/i,
    /\border\b[^.\n!?]{0,30}\bcancel\s+ho\s+(?:gaya|gayi)\b/i,
    /ऑर्डर[^.\n!?]{0,30}कैंसिल\s+हो\s+(?:गया|गई)/,
    // wordings seen on a real store that named no "order" or put it far from the verb: "yeh cancel ho gaya hai", "cancel karne ki request process ho gayi", "has been cancelled"
    /\bcancel\s+(?:ho\s+gaya|ho\s+gayi|ho\s+chuka|kar\s+diya|kar\s+di)\b/i,
    /\bcancel(?:l)?(?:ation)?\b[^.\n!?]{0,40}\b(?:process(?:ed)?\s+ho\s+(?:gaya|gayi)|(?:has|have)\s+been\s+(?:processed|completed|done))\b/i,
    /\b(?:has|have)\s+been\s+(?:successfully\s+)?cancel(?:l)?ed\b/i,
    /कैंसिल\s+हो\s+(?:गया|गई)/,
    /\b(?:processed|completed|handled|done)\s+(?:the|your|this)\s+cancel(?:l)?ation\b/i,
    /\balready\s+(?:been\s+)?cancel(?:l)?ed\b/i,
    /\bcancel\s+(?:kiya\s+ja\s+chuka|kar\s+diya\s+gaya|ho\s+chuka)\b/i,
  ],
  refund_issued: [
    /\b(?:i(?:'ve|\s+have)?\s+)?(?:issued|processed|initiated|started|sent)\s+(?:your|the|a)\s+(?:full\s+)?refund\b/i,
    /\brefund\b[^.\n!?]{0,30}\b(?:has\s+been|is\s+now|was|got)\s+(?:successfully\s+)?(?:issued|processed|initiated|completed|sent)\b/i,
    /\brefund\b[^.\n!?]{0,30}\b(?:ho\s+gaya|ho\s+gayi|kar\s+diya|process\s+ho\s+gaya)\b/i,
  ],
  complaint_raised: [
    /\b(?:i(?:'ve|\s+have)?\s+)?(?:raised|filed|logged|registered|submitted)\s+(?:a\s+|your\s+|the\s+)?(?:complaint|ticket)\b/i,
    /\b(?:your|the)\s+(?:complaint|ticket)\b[^.\n!?]{0,30}\b(?:has\s+been|is\s+now|was)\s+(?:successfully\s+)?(?:raised|filed|logged|registered|submitted)\b/i,
    /\bcomplaint\b[^.\n!?]{0,30}\b(?:register|raise|darj)\s+(?:ho\s+gayi|kar\s+di|ho\s+gaya)\b/i,
  ],
  email_sent: [
    /\b(?:i(?:'ve|\s+have)?\s+)?(?:e-?mailed|sent)\s+(?:you\s+)?(?:an?\s+|the\s+|your\s+|that\s+|this\s+|our\s+|my\s+|another\s+)?(?:e-?mail|mail|copy|confirmation|code|otp)\b/i,
    /\be-?mailed\s+you\b/i,
    /\b(?:an?\s+|the\s+|your\s+)?(?:e-?mail|mail|copy|confirmation|code|otp)\b[^.\n!?]{0,30}\b(?:has\s+been|was|is\s+on\s+its\s+way|have\s+been)\s+sent\b/i,
    /\b(?:e-?mail|mail|otp|code)\b[^.\n!?]{0,30}\b(?:bhej\s+diya|bhej\s+di|send\s+ho\s+gaya|bhej\s+diye)\b/i,
    /(?:ईमेल|मेल|कोड)[^.\n!?]{0,30}(?:भेज\s+दिया|भेज\s+दी|भेजा\s+गया)/,
  ],
};

// "If it has been cancelled you will be refunded", "Agar cancel ho gaya to...": a condition, not a claim. "I am not able to say it was cancelled": no claim either.
const CONDITIONAL_START_RE = /^\s*(?:and\s+|but\s+|so\s+)?(?:if|agar|once|jab|in\s+case|unless|whether)\b/i;
const CANNOT_CONFIRM_RE = /\b(?:not\s+able\s+to|unable\s+to|cannot|can't|could\s+not|couldn't)\s+(?:say|confirm|tell|verify)\b/i;

/** @returns {string[]} the kinds of "done" this reply claims (order_placed, order_cancelled, refund_issued, complaint_raised, email_sent). */
export function claimsDone(text = "") {
  const kinds = new Set();
  for (const sentence of String(text || "").split(/(?<=[.!?\n])\s+/)) {
    if (OFFER_RE.test(sentence) || CONDITIONAL_START_RE.test(sentence) || CANNOT_CONFIRM_RE.test(sentence)) continue;
    for (const [kind, res] of Object.entries(DONE_CLAIMS)) if (res.some((re) => re.test(sentence))) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * What the backend confirmed this turn, from the actions the session produced and the tools' own results.
 * A refund is only ever confirmed by Shopify's cancellation (the assistant has no refund tool), so it needs a finished cancellation.
 * @returns {Set<string>} the confirmed kinds, named like claimsDone's
 */
export function doneEvidence({ actions = [], toolLog = [] } = {}) {
  const done = new Set();
  const types = new Set((actions || []).map((a) => a?.type));
  if (types.has("order_placed")) done.add("order_placed");
  if (types.has("complaint_raised")) done.add("complaint_raised");
  for (const t of toolLog || []) {
    const status = String(t?.result?.status || "");
    // the order really is cancelled (Shopify says so through a lookup or the cancellation request): saying so is true
    if (t?.name === "request_order_cancellation" && t?.result?.reason === "already_cancelled") done.add("order_cancelled");
    if (t?.name === "get_order_details" && t?.result?.details?.cancelled) done.add("order_cancelled");
    if (t?.name === "cancel_order" && status === "cancelled") { done.add("order_cancelled"); if (t.result.refundWillBeIssued) done.add("refund_issued"); }
    if (t?.name === "raise_complaint" && ["email_sent", "already_raised"].includes(status)) done.add("complaint_raised");
    if (t?.name === "raise_complaint" && status === "email_sent") done.add("email_sent");
    // "otp_sent" is what send_order_otp really returns when the code went out ("cooldown": one went out a moment ago). Only "ok"/"sent"
    // were counted, so a code that WAS emailed was reported as unconfirmed (live 2026-11-23, order #1045).
    if (t?.name === "send_order_otp" && ["ok", "sent", "otp_sent", "cooldown"].includes(status)) done.add("email_sent");
    if (t?.name === "place_order" && t?.result?.emailSent === true) done.add("email_sent");
  }
  if ((actions || []).some((a) => a?.type === "order_placed" && a.emailSent === true)) done.add("email_sent");
  return done;
}

/** What the shopper hears when a reply claimed something the backend did not confirm and could not be written again. */
export function notConfirmedReply(replyLanguage = "en") {
  if (replyLanguage === "hi") return "मैं अभी इसकी पुष्टि नहीं कर सकती कि यह हो गया है। कृपया स्टोर की वेबसाइट पर या स्टोर से संपर्क करके स्थिति देख लें।";
  if (replyLanguage === "hinglish") return "Main abhi pakka nahi bata sakti ki ye ho gaya hai. Store se contact karke ek baar status check kar lijiye.";
  return "I cannot confirm that this has been done. Please check with the store directly for its current status.";
}

// "Billing address bhi set kar diya", "I've set your billing address": a checkout step stated as done. Questions and offers are not claims.
export function claimsBillingSet(text = "") {
  return String(text || "").split(/(?<=[.!?\n])\s+/).some((sentence) =>
    !/\?\s*$/.test(sentence) &&
    (/\bbilling\b[^.!?\n]{0,80}\b(?:set|save|saved|update|updated|confirm|confirmed)\b[^.!?\n]{0,20}\b(?:kar\s*di(?:ya|i|e)?|kr\s*di(?:ya|i)?|ho\s*gay[aie]|done|hai)\b/i.test(sentence) ||
     /\b(?:i'?ve|i\s+have|has\s+been|is\s+now)\s+(?:set|saved|updated|confirmed)\b[^.!?\n]{0,40}\bbilling\b|\bbilling\b[^.!?\n]{0,40}\b(?:has\s+been|is\s+now)\s+(?:set|saved|updated)\b/i.test(sentence) ||
     /बिलिंग[^।.!?\n]{0,60}(?:सेट|सेव)[^।.!?\n]{0,20}(?:कर\s*दिया|हो\s*गया)/.test(sentence)));
}
