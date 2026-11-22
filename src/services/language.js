// Language handling without word lists. The AI reads and mirrors the customer's language itself
// (LANGUAGE rule in the system prompt). Only two things are decided outside the model:
//  1. the customer's explicit choice, which the MODEL records with the set_reply_language tool
//     and the client sends back on every turn ("languageChoice"); and
//  2. the writing script (Devanagari or not), used only when no AI provider is reachable and for
//     choosing a speaking voice. Script is a fact of the text, not a guess about intent.

export const LANGUAGE_CODES = ["en", "hi", "hinglish"];

/**
 * The writing systems each reply language is written in (Unicode script names). A voice transcript
 * written mostly in some other script cannot be a shopper speaking a language this assistant serves.
 * VOICE_EXTRA_SCRIPTS (comma separated, e.g. "Arabic,Tamil") adds scripts for a store whose shoppers use them.
 */
export const LANGUAGE_SCRIPTS = { en: ["Latin"], hi: ["Devanagari"], hinglish: ["Latin", "Devanagari"] };

const isScriptName = (name) => {
  try {
    new RegExp(`\\p{Script=${name}}`, "u");
    return true;
  } catch {
    return false;
  }
};

export function supportedScripts(env = process.env) {
  const extra = String(env.VOICE_EXTRA_SCRIPTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...LANGUAGE_CODES.flatMap((code) => LANGUAGE_SCRIPTS[code] || []), ...extra])].filter(isScriptName);
}

export function isLanguageCode(value) {
  return LANGUAGE_CODES.includes(value);
}

/** "hi" when the text is written in Devanagari, otherwise "" (unknown: the AI mirrors it). */
export function scriptLanguage(text) {
  return /[ऀ-ॿ]/.test(String(text || "")) ? "hi" : "";
}

/**
 * Backwards-compatible name. Returns "hi" for Devanagari text and "en" otherwise; no keyword
 * guessing (Hinglish vs English is left to the AI, which sees the actual message).
 */
export function detectReplyLanguage(text) {
  return scriptLanguage(text) || "en";
}

const NOT_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * True when a reply is written in the wrong SCRIPT: Devanagari letters in a reply to a message typed in Roman letters
 * (Hinglish or English), or in a reply the customer asked to be in Hinglish or English. Only the writing system is
 * checked, never the words, so it needs no word lists.
 */
export function wrongScriptReply({ message = "", reply = "", replyLanguage = "en", locked = false } = {}) {
  if (!scriptLanguage(reply)) return false;
  if (locked && isLanguageCode(replyLanguage)) return replyLanguage !== "hi";
  return !NOT_LATIN.test(String(message || ""));
}

/**
 * True when the shopper wrote in Devanagari (and chose no other language) but the reply has no Devanagari at all:
 * a Hindi message answered in Roman letters. Script only, no word lists.
 */
export function missedDevanagariReply({ message = "", reply = "", replyLanguage = "en", locked = false } = {}) {
  if (!String(reply || "").trim() || scriptLanguage(reply)) return false;
  if (locked && isLanguageCode(replyLanguage)) return replyLanguage === "hi";
  return Boolean(scriptLanguage(message));
}

/**
 * The language settings for one turn.
 *  - languageChoice: what the customer explicitly chose earlier (recorded by the AI), or "".
 *  - message: the customer's message (only its script is used).
 * Returns { replyLanguage, languageLocked }.
 */
export function resolveTurnLanguage({ message = "", languageChoice = "" } = {}) {
  if (isLanguageCode(languageChoice)) return { replyLanguage: languageChoice, languageLocked: true };
  return { replyLanguage: scriptLanguage(message) || "en", languageLocked: false };
}
// Hinglish and English are both written in Roman letters, so the script cannot tell them apart. The AI mirrors the shopper itself;
// this guess is only for the few replies written outside the AI (a verified checkout line, a guard's own wording) and for the
// language note of a message that carries no language at all ("qa@example.com", "123456", an address): a real Hinglish chat got its
// billing question, its "added to cart" line and its e-mail code messages in English (2026-11-21).
const HINGLISH_MARKERS = /\b(?:hai|hain|hoon|hu|kya|kyu|kyun|kaise|kaisa|kitna|kitne|kab|kahan|mujhe|muje|mera|meri|mere|tera|tumhara|aapka|aapki|chahiye|chahie|chaiye|karo|karna|karni|kar\s+do|kardo|dikhao|dikha|batao|bata|nahi|nahin|nhi|haan|han|ji|yaar|yar|bhai|accha|acha|achha|theek|thik|wala|wali|wale|liye|lena|leni|lelo|daal|dal\s+do|hata|hatao|abhi|bhi|aur|toh|matlab|sabse|sasta|sasti|mehnga|kaunsa|konsa|kaun\s+sa|mein|mai|hum|humko|apna|apni|bas|chalo|ruko|wahi|vahi|pehle|baad)\b/gi;
const ENGLISH_MARKERS = /\b(?:the|is|are|am|was|i|you|my|your|please|want|need|show|what|which|how|can|could|would|it|this|that|and|with|for|have|has|do|does|of|to|me|price|cheaper|best|buy|add|remove|cart|order)\b/gi;

/** "hinglish" | "en" | "" for a Roman-letter text ("" = the text shows no language: a name, a number, an e-mail, an address). */
export function romanLanguage(text = "") {
  const value = String(text || "").replace(/\S+@\S+/g, " ").replace(/[\d+()#.,:/-]+/g, " ");
  const hing = (value.match(HINGLISH_MARKERS) || []).length;
  const eng = (value.match(ENGLISH_MARKERS) || []).length;
  if (hing === 0 && eng === 0) return "";
  return hing >= eng || hing >= 2 ? "hinglish" : "en";
}

/** A Roman-letter reply that is plainly English: several English words and not one Hinglish one (product names aside). */
export function plainlyEnglish(text = "") {
  const value = String(text || "").replace(/\S+@\S+/g, " ").replace(/[\d+()#.,:/-]+/g, " ");
  return (value.match(HINGLISH_MARKERS) || []).length === 0 && (value.match(ENGLISH_MARKERS) || []).length >= 3;
}

/**
 * True only when a reply is beyond doubt in the wanted language (en, hi or hinglish), so no AI check is needed: Hindi is mostly
 * Devanagari letters, English has several English words and no Hinglish one, Hinglish has no Devanagari and clearly more Hinglish
 * words than English ones. Anything less clear returns false and is left to the AI check.
 */
export function replyPlainlyIn(reply = "", wanted = "", { short = false } = {}) {
  const text = String(reply || "");
  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (text.replace(/\S+@\S+/g, " ").match(/[A-Za-z]/g) || []).length;
  if (wanted === "hi") return devanagari > 0 && devanagari >= latin * 2;
  if (devanagari > 0) return false;
  const value = text.replace(/\S+@\S+/g, " ").replace(/[\d+()#.,:/-]+/g, " ");
  const hing = (value.match(HINGLISH_MARKERS) || []).length;
  const eng = (value.match(ENGLISH_MARKERS) || []).length;
  if (wanted === "en") return hing === 0 && eng >= (short ? 2 : 3);
  // a shopper's own short message ("Dell wala black mein add kar do") mixes English words more freely than a reply
  if (wanted === "hinglish") return short ? hing >= 2 && hing > eng : hing >= 3 && hing >= eng * 2;
  return false;
}

/**
 * The language of this turn when the shopper chose none: Devanagari -> "hi"; otherwise this message's own language, and for a message
 * with no language of its own, the language of the shopper's recent messages.
 */
export function conversationLanguage(message = "", history = []) {
  if (scriptLanguage(message)) return "hi";
  const own = romanLanguage(message);
  if (own) return own;
  const recent = [...(history || [])].filter((h) => h?.role === "user").slice(-4).reverse();
  for (const turn of recent) {
    if (scriptLanguage(turn.content)) return "hi";
    const lang = romanLanguage(turn.content);
    if (lang) return lang;
  }
  return "en";
}

// Letters of a script the shopper did not use and no reply language uses (a Hindi reply with an Urdu word "شاندار" in it, real run
// 2026-11-21). Product names and prices are Latin/Devanagari/Common, so only stray words are caught.
const FOREIGN_SCRIPT = /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Gurmukhi}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}]/u;
export function foreignScriptInReply({ message = "", reply = "" } = {}) {
  const r = String(reply || "");
  if (!FOREIGN_SCRIPT.test(r)) return false;
  return !FOREIGN_SCRIPT.test(String(message || ""));
}
/** The reply without words written in a script the shopper did not use (the last resort when a rewrite still has them). */
export function stripForeignScriptWords(reply = "") {
  return String(reply || "").replace(/\S*[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Gurmukhi}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}]+\S*\s?/gu, "").replace(/[ \t]{2,}/g, " ").trim();
}
