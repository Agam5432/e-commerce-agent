// More claims a reply must not make without the store's data behind them. Pure functions (no I/O).
//
// Found by a QA pass on the released widget (real store, 2026-11-16):
//   M3  "You are absolutely right, my previous message had the prices mixed up" after the shopper stated a wrong price (nothing was mixed up);
//       "I told you earlier I wanted an iPhone" accepted although they never said so.
//   M4  "iPhone 15 stands out for sheer performance and smooth gaming": the product data says nothing about gaming.
//   M5  "we accept major debit and credit cards": nothing in the store's data says which cards are taken.
//   M9  "I am raising a formal complaint now" before the shopper had chosen how (email or a person) and before any tool ran.

const sentences = (text) => String(text || "").split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
const SKIP_KEYS = /^(?:query|searchTerm|term|args|userMessage|note|instruction|instruction_for_ai|fallbackSpeech)$/i;

/** All text the store's data returned this turn (product titles, descriptions, features, tags, variants...), lower-cased, WITHOUT echoes of the shopper's own words. */
export function evidenceText(toolLog = []) {
  const parts = [];
  const walk = (value, depth = 0) => {
    if (value == null || depth > 8) return;
    if (typeof value === "string") { parts.push(value); return; }
    if (typeof value !== "object") { parts.push(String(value)); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    for (const [k, v] of Object.entries(value)) { if (!SKIP_KEYS.test(k)) walk(v, depth + 1); }
  };
  for (const t of toolLog || []) walk(t?.result);
  return parts.join(" ").toLowerCase();
}

// ---------------------------------------------------------------------------------------------------- M4: performance claims

const PERF_NOUNS = [
  { re: /\bgam(?:e|es|ing|er|ers)\b/i, stem: "gam" },
  { re: /\bperformance\b/i, stem: "perform" },
  { re: /\b(?:speed|fast|faster|fastest|quick|quicker|snappy|lag[- ]?free|responsive)\b/i, stem: "" , any: ["fast", "speed", "quick", "snappy", "responsive", "lag"] },
  { re: /\b(?:smooth|smoother|smoothest|fluid)\b/i, stem: "smooth", any: ["smooth", "fluid"] },
  { re: /\b(?:battery|battery life)\b/i, stem: "batter" },
  { re: /\bmultitask\w*/i, stem: "multitask" },
  { re: /\b(?:processor|chipset|chip)\b/i, stem: "", any: ["processor", "chip", "cpu", "snapdragon", "bionic", "dimensity", "helio"] },
  { re: /\b(?:camera|photo|photography|low[- ]light)\b/i, stem: "", any: ["camera", "photo", "mp", "megapixel", "lens"] },
  { re: /\b(?:display|screen)\b/i, stem: "", any: ["display", "screen", "amoled", "oled", "lcd", "hz", "inch"] },
];
// an evaluation or comparison ("best", "better", "stands out", "excellent for", "handles X well"), not a listed fact
const JUDGEMENT_RE = /\b(?:best|better|good|great|excellent|superb|superior|outstanding|unmatched|top[- ]?(?:tier|notch)|flagship|stands? out|outperform\w*|beats?|powerful|most\s+powerful|ideal|perfect|handles?|delivers?|offers?\s+(?:great|excellent|superior|better)|sheer|blazing|buttery|lag[- ]?free|fastest|smoothest|faster|smoother|badhiya|badiya|shaandar|shandaar|zabardast|behtareen|behtarin|kamaal|mast|ho\s+sakt[aie]|kar\s+sakt[aie]|chal\s+jaye?ga|chalega|kaam\s+aaye?ga)\b/i;

/** Sentences that judge a product's performance (gaming, speed, battery, camera...) which none of the product data this turn mentions. */
// A word inside the sentence that is written like a product or brand name: "iPhone", "OnePlus", "Galaxy A55", "Redmi Note 13".
const NAMED_THING_RE = /(?:^|\s)(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b|\b[A-Za-z]{2,}\s\d{1,4}\b|[a-z,;:]\s+[A-Z][a-z][a-zA-Z0-9]*(?:\s+[A-Z0-9][A-Za-z0-9]*)?/;

export function unsupportedPerformanceClaims(text = "", toolLog = []) {
  const ev = evidenceText(toolLog);
  // General teaching ("a faster processor matters most for gaming") is knowledge, not a claim about a store product: it is only checked when
  // the store's products were looked at this turn or the sentence names a specific product.
  const productsLooked = (toolLog || []).some((t) => t?.result && (Array.isArray(t.result.products) ? t.result.products.length > 0 : Boolean(t.result.product)));
  const out = [];
  for (const sentence of sentences(text)) {
    if (!productsLooked && !NAMED_THING_RE.test(sentence)) continue;
    if (/\?\s*$/.test(sentence)) continue;
    if (/\b(?:doesn'?t|does not|don'?t|do not|isn'?t|not)\b[^.!?\n]{0,40}\b(?:say|mention|list|state|specif|provide|publish)/i.test(sentence)) continue;
    if (!JUDGEMENT_RE.test(sentence)) continue;
    const unsupported = PERF_NOUNS.filter((n) => n.re.test(sentence) && !(n.any ? n.any.some((w) => ev.includes(w)) : ev.includes(n.stem)));
    if (unsupported.length) out.push({ sentence, topics: unsupported.map((n) => n.stem || n.any[0]) });
  }
  return out;
}

export const performanceFallback = (sentencesToDrop = [], text = "") => {
  let kept = String(text || "");
  for (const s of sentencesToDrop) kept = kept.replace(s, "");
  return kept.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
};

// ---------------------------------------------------------------------------------------------------- M5: payment and store facts

const CARD_WORDS = "(?:debit|credit|visa|mastercard|master card|amex|american express|upi|net\\s?banking|netbanking|paypal|apple pay|google pay|gpay|paytm|phonepe|wallets?|emi|bank transfer|bnpl|klarna|afterpay|cards?)";
const PAYMENT_CLAIM_RES = [
  new RegExp(`\\b(?:we|the store|this store|our store)\\s+(?:also\\s+)?(?:accept|take|support|allow|offer)s?\\b[^.!?\\n]{0,60}\\b${CARD_WORDS}\\b`, "i"),
  new RegExp(`\\b(?:accepted|available)\\s+payment\\s+(?:methods?|options?)\\b[^.!?\\n]{0,80}\\b${CARD_WORDS}\\b`, "i"),
  new RegExp(`\\bpayment\\s+(?:methods?|options?)\\s+(?:include|are|is)\\b[^.!?\\n]{0,80}\\b${CARD_WORDS}\\b`, "i"),
  new RegExp(`\\byou\\s+can\\s+pay\\s+(?:by|with|using|via|through)\\b[^.!?\\n]{0,60}\\b${CARD_WORDS}\\b`, "i"),
  /\bmajor\s+(?:debit|credit)\s+cards?\b/i,
];
const STORE_FACT_RES = [
  /\b(?:we(?:'re| are)|the store is|our store is)\s+open\s+(?:24\/7|24 hours|every day|daily|round the clock)\b/i,
  /\b(?:we(?:'re| are)|the store is)\s+(?:located|based|situated|headquartered)\s+in\b/i,
  /\b(?:we|the store)\s+ships?\s+(?:worldwide|internationally|globally|to\s+(?:all|every)\s+countries)\b/i,
  /\bfree\s+(?:shipping|delivery)\s+(?:on|for)\s+(?:all\s+)?orders?\s+(?:over|above|of|worth)\b/i,
  /\b(?:delivery|delivered|shipping|arrives?)\s+(?:takes?\s+)?(?:within|in|takes)\s+\d+\s*(?:-|to)?\s*\d*\s*(?:business\s+)?(?:days?|hours?)\b/i,
];

/** Sentences stating accepted payment methods or other store facts that the store's data of this turn does not contain. */
export function unsupportedPaymentAndStoreFacts(text = "", toolLog = []) {
  const ev = evidenceText(toolLog);
  const out = [];
  for (const sentence of sentences(text)) {
    if (/\?\s*$/.test(sentence)) continue;
    if (/\b(?:hasn'?t|has not|haven'?t|have not|not published|doesn'?t|does not|cannot|can'?t|don'?t have|do not have|unable)\b/i.test(sentence)) continue;
    const pay = PAYMENT_CLAIM_RES.find((r) => r.test(sentence));
    if (pay) {
      const words = [...sentence.toLowerCase().matchAll(new RegExp(CARD_WORDS, "gi"))].map((m) => m[0].replace(/s$/, ""));
      const backed = words.length > 0 && words.every((w) => ev.includes(w.replace(/\s+/g, " ")));
      if (!backed) out.push({ kind: "payment", sentence });
      continue;
    }
    const fact = STORE_FACT_RES.find((r) => r.test(sentence));
    if (fact) {
      const nums = (sentence.match(/\d+/g) || []);
      const key = (sentence.toLowerCase().match(/worldwide|internationally|globally|24\/7|located|based|situated|free (?:shipping|delivery)|within|business/g) || [])[0] || "";
      const backed = (nums.length ? nums.every((n) => ev.includes(n)) : true) && (key ? ev.includes(key.split(" ")[0]) : false);
      if (!backed) out.push({ kind: "store_fact", sentence });
    }
  }
  return out;
}

export const paymentNotPublishedReply = (replyLanguage = "en") =>
  replyLanguage === "hi"
    ? "मेरे पास इस स्टोर के भुगतान विकल्पों की पक्की जानकारी नहीं है, इसलिए मैं अंदाज़ा नहीं लगाऊँगी। चेकआउट पर जो विकल्प दिखते हैं वही मान्य हैं।"
    : "I don't have a confirmed list of this store's payment methods, so I won't guess. The options shown at checkout are the ones available.";

// ---------------------------------------------------------------------------------------------------- M3: false agreement

const AGREE_RE = /^\W*(?:i(?:'m| am)\s+(?:so\s+|very\s+|really\s+|terribly\s+|truly\s+)?sorry\s+(?:for|about)\s+the\s+(?:confusion|mix[- ]?up|mistake|oversight|error)|i\s+must\s+have\s+(?:missed|forgotten|overlooked)|(?:i\s+)?missed\s+that|(?:oh\s+|ah\s+|yes,?\s+|yes!\s+)?you(?:'re| are)\s+(?:absolutely\s+|completely\s+|totally\s+|quite\s+|entirely\s+)?(?:right|correct)|(?:that(?:'s| is)|you(?:'re| are))\s+(?:absolutely\s+|completely\s+)?(?:right|correct)|(?:i\s+)?(?:sincerely\s+|deeply\s+)?apologi[sz]e\s+for\s+the\s+(?:confusion|mix[- ]?up|error|mistake)|my\s+(?:mistake|apologies|bad|error)|sorry\s+for\s+the\s+(?:confusion|mix[- ]?up|mistake)|aap\s+bilkul\s+(?:sahi|theek)|आप\s+बिल्कुल\s+सही)/i;
const SELF_BLAME_RE = /\b(?:my|the)\s+(?:previous|earlier|last)\s+(?:message|reply|answer|response)\s+(?:had|was|contained|made)[^.!?\n]{0,60}\b(?:mix(?:ed)?[- ]?up|mistake|wrong|incorrect|error|confus)/i;
const CLAIM_RE = /\b(?:you\s+(?:said|told|mentioned|showed|promised)|i\s+(?:told|said|asked|wanted|mentioned)|earlier\s+i|i\s+already\s+(?:told|said)|as\s+i\s+(?:said|told)|isn'?t\s+it|right\?)\b/i;

/** The amounts a shopper's message states ("$269", "269 dollars", "₹1,999"). */
const amountsIn = (text) => [...String(text || "").matchAll(/(?:[$€£₹]\s?|\b(?:rs\.?|inr|usd)\s?)(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:dollars?|rupees?|usd|inr|bucks)\b/gi)].map((m) => Number((m[1] || m[2]).replace(/,/g, ""))).filter((n) => n > 0);

/** Every option the data of this turn has: {title, price}. */
export function variantPrices(toolLog = []) {
  const out = [];
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    for (const key of ["variants", "options", "allVariants"]) {
      if (!Array.isArray(value[key])) continue;
      for (const v of value[key]) {
        if (v && typeof v === "object" && v.price != null && (v.title != null || v.name != null)) out.push({ product: value.title || value.name || "", option: String(v.title ?? v.name), price: Number(v.price) });
      }
    }
    for (const v of Object.values(value)) walk(v, depth + 1);
  };
  for (const t of toolLog || []) walk(t?.result);
  return out.filter((v) => Number.isFinite(v.price));
}

/**
 * Does the reply agree with / apologise for something the shopper claimed, although the data shows the claim is wrong or unverifiable?
 * Returns {problem, truth} or null. `truth` is a plain sentence the rewrite is given.
 */
export function falseAgreement({ userMessage = "", history = [], text = "", toolLog = [] } = {}) {
  const t = String(text || "");
  const head = t.slice(0, 160);
  const agrees = AGREE_RE.test(head) || SELF_BLAME_RE.test(t.slice(0, 400));
  if (!agrees) return null;
  const msg = String(userMessage || "");
  // 1) an option/price claim the data contradicts
  const claimed = amountsIn(msg);
  if (claimed.length) {
    const options = variantPrices(toolLog);
    for (const opt of options) {
      const label = opt.option.toLowerCase();
      const tokens = (label.match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !/^(?:default|title|black|white|blue|red|green|silver|gold|grey|gray|midnight|ocean|teal)$/.test(w));
      if (!tokens.length) continue;
      const mentioned = tokens.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(msg));
      if (mentioned && !claimed.some((a) => Math.abs(a - opt.price) < 0.011)) {
        const all = options.filter((o) => o.product === opt.product).map((o) => `${o.option} ${o.price}`).join(", ");
        return { problem: "the shopper's price for that option is not what the store data says", truth: `${opt.product ? opt.product + ": " : ""}${all}` };
      }
    }
  }
  // 2) "I told you earlier ..." about something never said
  const earlier = msg.match(/\b(?:i\s+(?:told|said|mentioned|asked|wanted)|earlier\s+i|as\s+i\s+(?:said|told))\b[^.!?\n]{0,80}?\b(?:wanted|want|asked for|looking for|need(?:ed)?|prefer(?:red)?|said|told you)\s+(?:a|an|the|for|that|to buy|to see)?\s*([a-z0-9][a-z0-9+\- ]{2,30})/i);
  if (earlier) {
    const words = earlier[1].toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !/^(?:the|and|for|you|that|this|some|any|buy|see|get|one|phone|phones|product|products|item|items)$/.test(w));
    const said = (history || []).filter((h) => h?.role === "user").map((h) => String(h.content || "").toLowerCase()).join(" \n ");
    if (words.length && !words.some((w) => said.includes(w))) return { problem: "the shopper says they said something earlier that is not in the conversation", truth: `their earlier messages never mention "${words.join(" ")}"` };
  }
  // 3) any other assertion the shopper makes that the assistant apologises for with no data to check it against
  if (CLAIM_RE.test(msg) && SELF_BLAME_RE.test(t.slice(0, 400))) return { problem: "the reply admits a mistake it cannot show", truth: "no earlier message of this chat is shown to contain the mistake the shopper describes" };
  return null;
}

// ---------------------------------------------------------------------------------------------------- M9: premature escalation

const ESCALATION_NOW_RES = [
  /\bi(?:'m| am| will|'ll)\s+(?:now\s+)?(?:going to\s+)?(?:raising|raise|filing|file|logging|log|registering|register|submitting|submit|escalating|escalate|opening|open|lodging|lodge)\b[^.!?\n]{0,30}\b(?:formal\s+|official\s+)?(?:complaint|ticket|case|escalation)\b/i,
  /\b(?:let me|allow me to)\s+(?:raise|file|log|register|submit|escalate|lodge)\b[^.!?\n]{0,30}\b(?:complaint|ticket|case)\b/i,
  /\bi(?:'m| am|'ll| will)\s+(?:now\s+)?escalat(?:e|ing)\s+(?:this|it|your)\b/i,
  /\b(?:mai|main)\s+(?:abhi\s+)?(?:aapki\s+)?(?:complaint|shikayat)\s+(?:darj|register|raise)\s+kar\w*/i,
];

/** The reply says a complaint is being raised/escalated NOW (as if it were happening), without any complaint tool having run. */
export function claimsEscalationNow(text = "") {
  return sentences(text).filter((s) => !/\?\s*$/.test(s) && !/\b(?:if|would you like|do you want|shall i|can i|may i|should i)\b/i.test(s) && ESCALATION_NOW_RES.some((r) => r.test(s)));
}

// ---------------------------------------------------------------------------------------------------- low: meaningless messages

/** A message with no letter or digit in any script ("." , "...", "?!", "👍") carries nothing to answer. */
export function isMeaninglessMessage(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;
  return !/[\p{L}\p{N}]/u.test(t) && !/\p{Extended_Pictographic}/u.test(t);
}
