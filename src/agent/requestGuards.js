// The SHOPPER's own words (not the AI's reply). Two requests must never end without an action: asking for a person,
// and telling the assistant to put a product in the cart. The AI almost always acts, but when a model has an off turn
// and only chats, the caller makes the request itself (see finalize in agent.js). Wording in English, Hinglish and
// Devanagari Hindi; a plain question about a product never matches.

const PERSON_WORD = "(?:human|person|people|someone|somebody|representative|rep|agent|executive|owner|manager|staff|team|customer\\s*(?:care|support|service)|support|insaan|insan|banda|aadmi)";
const TALK_WORD = "(?:talk|speak|chat|connect|transfer|call|baat|bat|milao|milana|milwa|bula)";

const PERSON_ASK_RES = [
  new RegExp(`\\b${TALK_WORD}\\w*\\b[^.!?\\n]{0,40}\\b${PERSON_WORD}\\b`, "i"),
  new RegExp(`\\b${PERSON_WORD}\\b[^.!?\\n]{0,40}\\b(?:${TALK_WORD}\\w*|se\\s+baat|chahiye|chaiye)\\b`, "i"),
  /(?:बात|कनेक्ट|कॉल)[^.!?\n]{0,30}(?:इंसान|इन्सान|किसी|कस्टमर|सपोर्ट|टीम|मालिक)|(?:इंसान|इन्सान|कस्टमर\s*(?:केयर|सपोर्ट)|सपोर्ट|टीम|मालिक)[^.!?\n]{0,30}(?:बात|कनेक्ट|कॉल)/,
];

/** True when the shopper asks to talk to a person ("customer care se baat karni hai", "connect me to a human"). */
export function asksForPerson(text = "") {
  const value = String(text || "");
  if (!value.trim() || value.length > 400) return false;
  // a product that merely has "support" or "team" in its name is not a request for a person
  if (/\b(?:support\s+(?:bra|belt|band|stand)|team\s+(?:jersey|shirt)|stand\b.*\bsupport)\b/i.test(value)) return false;
  return PERSON_ASK_RES.some((re) => re.test(value));
}

const CART_WORD = "(?:cart|bag|basket|trolley)";
const ADD_WORD = "(?:add|put|place|drop|daal|dal|daalo|dalo|rakh|rakho|le\\s*lo|jodo)";

/** True when the shopper tells the assistant to put something in the cart ("add the black one to cart", "cart me daal do"). */
export function asksToAddToCart(text = "") {
  const value = String(text || "").trim();
  if (!value || value.length > 300 || /\?$/.test(value)) return false;
  return (
    new RegExp(`\\b${ADD_WORD}\\b[^.!?\\n]{0,80}\\b${CART_WORD}\\b|\\b${CART_WORD}\\b[^.!?\\n]{0,30}\\b${ADD_WORD}\\b`, "i").test(value) ||
    /कार्ट[^.!?\n]{0,30}(?:जोड़|डाल|रख)|(?:जोड़|डाल|रख)[^.!?\n]{0,30}कार्ट/.test(value)
  );
}

/** The one line said when a person is being connected (the chat window then shows the real state). */
export function connectingReply(replyLanguage = "en") {
  if (replyLanguage === "hi") return "मैं अभी आपको एक सपोर्ट प्रतिनिधि से जोड़ने की कोशिश कर रही हूँ।";
  if (replyLanguage === "hinglish") return "Main abhi aapko ek support representative se connect karne ki koshish kar rahi hoon.";
  return "I'm trying to connect you with a support representative now.";
}
