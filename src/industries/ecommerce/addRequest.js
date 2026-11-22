// Did the shopper ask for something to go into the cart? Yes when this message says so ("add", "I'll take", "chahiye", "cart"...) or answers an
// offer to add made in the previous reply ("yes", "black", "the second one"). A message that only narrows a search ("black one", "size L" after
// a list) is not a purchase.
const WANTS_ADD = /\b(?:add|adding|buy|purchase|order|take|get|want|need|cart|bag|basket|checkout|check\s*out|put|include|lelo|le\s*lo|lena|leni|chahiye|chahie|chaiye|kharid\w*|daal|dal\s*do|rakh|mangwa\w*|dedo|de\s*do|yes|yeah|yep|sure|ok|okay|haan|han|ji|please|done|this|that|these|those|first|second|third|last)\b/i;
const WANTS_ADD_DEVANAGARI = /(?:जोड़|जोड|चाहिए|चाहिये|खरीद|कार्ट|डाल|लेना|ले\s*लो|दे\s*दो|हाँ|हां|ठीक)/;
// words that only mean "put it in the cart" (not "this", "ok"...)
const WANTS_ADD_STRONG = /\b(?:add|adding|buy|purchase|order|take|cart|bag|basket|lelo|le\s*lo|lena|leni|chahiye|chahie|chaiye|kharid\w*|daal|dal\s*do|mangwa\w*)\b/i;
const OFFER = /\b(?:add|adding|cart|bag|basket|checkout|order|buy|take)\b/i;
const OFFER_DEVANAGARI = /(?:कार्ट|जोड़|ऑर्डर)/;

export function addRequested(userMessage, history = []) {
  const said = String(userMessage || "");
  if (WANTS_ADD.test(said) || WANTS_ADD_DEVANAGARI.test(said)) return true;
  const list = [...(history || [])];
  const prevIndex = list.map((h) => h?.role).lastIndexOf("assistant");
  const prev = prevIndex >= 0 ? list[prevIndex] : null;
  if (!prev?.content) return false;
  const text = String(prev.content);
  if (!/\?/.test(text)) return false;
  if (OFFER.test(text) || OFFER_DEVANAGARI.test(text)) return true;
  // The shopper asked to add ("pink wala gift set add kar do") and the reply only asked which option ("kaun sa colour?"):
  // the answer ("pink wala") completes that add (a real run lost it and then said it was added, 2026-11-21).
  const askedBefore = list.slice(0, prevIndex).reverse().find((h) => h?.role === "user" && h?.content);
  return Boolean(askedBefore && (WANTS_ADD_STRONG.test(String(askedBefore.content)) || WANTS_ADD_DEVANAGARI.test(String(askedBefore.content))));
}

const AFFIRM = /^\s*(?:yes|yeah|yep|sure|ok|okay|haan|han|ha|ji|haan\s*ji|ji\s*haan|theek|thik|done|please|हाँ|हां|जी|ठीक)\b/i;
/**
 * A clear instruction to put something in the cart, strict enough to act on when the AI did not: the message itself says to add
 * ("black wala add kar do", "le lo", "daal do"), or it says yes to the previous reply's offer to add ("Kya aap ise cart mein add
 * karna chahenge?" -> "haan black wala"). A bare "ok" with no offer before it, or "this one" while browsing, is not enough.
 */
export function explicitAddRequest(userMessage, history = []) {
  const said = String(userMessage || "").trim();
  if (!said || /\?\s*$/.test(said)) return false;
  if (WANTS_ADD_STRONG.test(said) || /(?:जोड़|डाल|ले\s*लो|खरीद)/.test(said)) return true;
  if (!AFFIRM.test(said)) return false;
  const prev = [...(history || [])].reverse().find((h) => h?.role === "assistant" && h?.content);
  const text = String(prev?.content || "");
  return /\?/.test(text) && (/\b(?:add|cart|bag|basket)\b/i.test(text) || /(?:कार्ट|जोड़)/.test(text));
}
