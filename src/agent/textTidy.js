// A reply whose list lines were cut out (for example products over the shopper's budget) can be left with an introduction to a list that is no
// longer there ("we have these other items in stock: Would you like ..."). The introduction goes with the list.
export function dropDanglingListIntro(text) {
  const source = String(text || "");
  // an introduction ending with ":" that is followed directly by another sentence (a question) instead of a list item
  // (also when the question starts on the next line: "options:\nKya aap ...?")
  const cleaned = source.replace(/(^|[.!?]\s+|\n)([^.!?:\n]{0,220}:)\s+(?=[A-Z][^:\n]*[?])/g, "$1");
  return cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || source;
}

// "₹56,858.3" / "$12.5": an amount with one decimal digit is written with two ("₹56,858.30"), the way the cards and the email show it.
export function fixOneDecimalAmounts(text) {
  return String(text ?? "").replace(/((?:[₹$€£]|\b(?:Rs\.?|INR|USD)\s?)\s?\d{1,3}(?:,\d{2,3})*|(?:[₹$€£]|\b(?:Rs\.?|INR|USD)\s?)\s?\d+)\.(\d)(?![\d,])/g, "$1.$20");
}

// The shopper is addressed with a feminine verb ("kaun sa lena chahengi?") only when she said she is a woman. Otherwise the usual
// respectful form is used ("chahenge"): a real run asked Rahul, who had said "main ladka hoon", "aap kaun sa lena chahengi?" because the
// product was a girls' gift set (2026-11-21). Only verbs addressed to the shopper are changed (they end in -engi/-ogi after aap/tum or
// as a question); the assistant's own "karungi" and a product's "mil jayegi" are never touched.
const TO_SHOPPER_FEMININE = /\b(chah|le|kar|dekh|kharid|bata|rakh|pasand\s+kar|order\s+kar|try\s+kar)(engi|ogi)\b/gi;
export function neutralShopperVerbs(text, shopperGender = "") {
  if (/^(?:women|female|woman|f)$/i.test(String(shopperGender || ""))) return String(text ?? "");
  return String(text ?? "").replace(TO_SHOPPER_FEMININE, (_m, stem, end) => `${stem}${end.toLowerCase() === "engi" ? "enge" : "oge"}`);
}

// The assistant speaks of herself in the feminine (the persona in the system prompt); a reply that slips into "kar raha hoon" /
// "karunga" next to "kar rahi hoon" elsewhere sounds like two people. Only first-person forms ("... hoon", "-unga") are changed.
export function consistentAssistantVoice(text) {
  return String(text ?? "")
    .replace(/\b(raha|rha)\s+(hoon|hu|hun|hoo)\b/gi, (_m, _r, h) => `rahi ${h}`)
    .replace(/\b(sakta|skta)\s+(hoon|hu|hun|hoo)\b/gi, (_m, _s, h) => `sakti ${h}`)
    // "Samajh gaya" / "Main samajh gaya": the assistant understanding (never said of the shopper, who is "tum/aap samjhe")
    .replace(/\b(samajh|samjh)\s+gaya\b/gi, (_m, w) => `${w} gayi`)
    .replace(/\b(kar|de|bhej|bata|dikha|dekh|check\s+kar|add\s+kar|laga|rakh|bhool)(unga|oonga)\b/gi, (_m, stem) => `${stem}ungi`)
    .replace(/\b(d|l)(unga|oonga)\b/gi, (_m, stem) => `${stem}ungi`)
    .replace(/(करता|रहा|सकता)\s+हूँ/g, (_m, w) => `${w === "करता" ? "करती" : w === "रहा" ? "रही" : "सकती"} हूँ`)
    .replace(/(बताऊँ|करूँ|दूँ|भेजूँ|देखूँ)गा(?![\u0900-\u097F])/g, "$1गी");
}

// A code written letter by letter with dots ("F.A.K.E.50", "C.H.A.T.20") is how it might be read aloud, not how it is typed: the shopper must be
// able to copy it, so the dots go. Only letter runs that end in digits (codes) are joined; "U.S.A." stays as it is.
export function joinDottedCodes(text) {
  return String(text ?? "").replace(/\b(?:[A-Za-z]\.){2,}(?:[A-Za-z]\.?)*\d+\b/g, (m) => m.replace(/\./g, ""));
}

// The customer is "aap" (the persona in the system prompt): a reply that slips into "tera" or "tumhare cart" with a customer who
// never wrote like that sounds rude, not friendly (live TechStore, 2026-11-22: "Tere liye ... tera budget", "tumhare cart mein").
// Friendly words like "yaar" and "dost" stay: they are warmth, not disrespect. When the customer themselves wrote "tu" or "tum",
// the reply may answer in kind and nothing is changed.
const INFORMAL_CUSTOMER = /\b(?:tu|tum|tumhe|tumko|tumhara|tumhari|tumhare|tera|teri|tere|tujhe|tujhko)\b/i;
const RESPECTFUL = [
  [/\btumhar(a|i|e)\b/gi, (m, v) => `aapk${v}`],
  [/\bter(a|i|e)\b/gi, (m, v) => `aapk${v}`],
  [/\b(?:tumhein|tumhe|tumko|tujhe|tujhko)\b/gi, () => "aapko"],
];
export function respectfulAddress(text, customerWords = "") {
  let out = String(text || "");
  const said = String(customerWords || "");
  if (!INFORMAL_CUSTOMER.test(said)) {
    for (const [pattern, to] of RESPECTFUL) out = out.replace(pattern, (m, ...rest) => keepCase(m, to(m, ...rest)));
    // "jo tum dekh sakte ho" -> "jo aap dekh sakte hain", "dekhna chahoge" -> "dekhna chahenge": only in a sentence that says "tum"
    out = out.split(/(?<=[.!?\n])/).map((sentence) => {
      if (!/\btum(?:ne|se)?\b/i.test(sentence)) return sentence;
      return sentence
        .replace(/\btum(ne|se)?\b/gi, (m, end) => keepCase(m, `aap${end || ""}`))
        .replace(/\b(sakte|rahe|chahte|karte|lete|dekhte|jaante|jante|paate|pate)\s+ho\b/gi, "$1 hain")
        .replace(/\b(\w{2,})oge\b/gi, "$1enge");
    }).join("");
    // "dekhna chahoge?", "checkout karoge?" are "tum" forms even when the word "tum" is left out
    out = out.replace(/\b(\w{2,})oge\b/gi, "$1enge");
  }
  return out;
}
function keepCase(from, to) {
  return from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
}
