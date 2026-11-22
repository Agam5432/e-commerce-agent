export function confirmsOrder(text, step = "cart") {
  const value = String(text || "").trim().replace(/[\u2018\u2019]/g, "'");
  if (!value) return false;
  if (/\b(?:cod|cash\s+on\s+delivery)\b.*\b(?:or|ya|vs|versus)\b.*\b(?:prepaid|online|upi|card)\b|\b(?:prepaid|online|upi|card)\b.*\b(?:or|ya|vs|versus)\b.*\b(?:cod|cash\s+on\s+delivery)\b/i.test(value)) return false;
  if (/\b(?:no|nope|nah)\b/i.test(value)) return false;
  if (/[?]|\b(?:can|could|should)\s+(?:i|you|we)\b|\b(?:kya|whether|maybe|later|not yet)\b/i.test(value)) return false;
  if (/\b(?:dont|don't|do not|cancel|mat|nahi|nahin|nhi)\b|मत|नहीं/i.test(value)) return false;
  if (/\b(?:what|how|when|why|difference|explain|available)\b/i.test(value)) return false;
  if (/\b(?:place|confirm|submit|complete|book|final|finalize|lock)\s+(?:(?:my|the|this|a)\s+)?order\b/i.test(value)) return true;
  if (/\border\s+(?:place\s+|confirm\s+|final\s+|lock\s+|done\s+)?(?:kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|kar\s*de|karde|krde|krr\s*de)\b|ऑर्डर.*कर\s*दो/i.test(value)) return true;
  if (/\b(?:check\s*out|checkout)\s+(?:kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|kar\s*de|karde|krde)\b/i.test(value)) return true;
  if (/\b(?:final|done|lock|confirm)\s+(?:kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|kar\s*de|karde|krde)\b/i.test(value)) return true;
  if (paymentChoice(value)) return true;
  return ["ready", "review"].includes(step) && /^(?:(?:yes|yeah|yep|yup|sure|confirm|confirmed|final|done|haan|han|ha|haa|ji|haan\s+ji|ok|okay|theek\s+hai|thik\s+hai|bilkul|kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|हाँ|हां|जी|पक्का|ठीक\s+है|कर\s*दो)(?:\s+(?:please|ji|yaar|bhai|dost|abhi|final\s+kar\s*do|kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro))?)[.!\s]*$/i.test(value);
}

export function paymentChoice(text = "") {
  const value = String(text).trim().replace(/[\u2018\u2019]/g, "'");
  if (!value) return "";
  if (/[?]|\b(?:what|how|when|why|difference|explain|available|kya|dont|don't|do not|cancel|nahi|nahin|nhi|mat|maybe|later|not|no|nope)\b|\b(?:can|could|should)\s+(?:i|you|we)\b/i.test(value)) return "";
  if (/\b(?:cod|cash\s+on\s+delivery)\b.*\b(?:or|ya|vs|versus)\b.*\b(?:prepaid|online|upi|card)\b|\b(?:prepaid|online|upi|card)\b.*\b(?:or|ya|vs|versus)\b.*\b(?:cod|cash\s+on\s+delivery)\b/i.test(value)) return "";
  const methods = [...value.matchAll(/\b(?:cod|cash\s+on\s+delivery|prepaid|online(?:\s+payment)?|upi|card)\b/gi)];
  const selected = [...new Set(methods.map(match => /cod|cash/i.test(match[0]) ? "cod" : "prepaid"))];
  if (selected.length !== 1) return "";
  if (/\b(?:place|confirm|submit|complete|book|final|finalize|lock)\s+(?:(?:my|the|this|a)\s+)?order\b|\border\s+(?:place\s+|confirm\s+|final\s+)?(?:kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|kar\s*de|karde|krde)\b/i.test(value)) return selected[0];
  if (/\b(?:check\s*out|checkout|proceed|order|pay|payment|select|choose|prefer|use|lock|confirm|final|done|go\s+(?:with|for)|going\s+(?:with|for)|opt(?:\s+for)?|take|pick|let'?s\s+(?:go|do)|kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|kar\s*de|karde|krde|chahiye|chaiye|rakh|rakho)\b/i.test(value)) return selected[0];
  const choice = value.match(/^(?:(?:yes|yeah|yep|please|haan|han|ha|ji|ok|okay|sure|bilkul)[,\s]+)?(?:(?:(?:i(?:'ll| will| would| prefer| want| choose| select)|i'd|main|mai|hum|mujhe|muje)\s+(?:(?:prefer|like|choose|select|use|pay|to|with|by|on|par|pe|se|mein)\s+)*|(?:confirm|use|choose|select|pay\s+(?:by|with|on))\s+))?(cod|cash\s+on\s+delivery|prepaid|online(?:\s+payment)?|upi|card)(?:\s+(?:please|kar\s*do|kardo|krdo|krr\s*do|kr\s*do|karo|kro|hi|se|pe|par|mein|karna|krna|hai|h|wala|option))*[.!\s]*$/i);
  return choice ? (/cod|cash/i.test(choice[1]) ? "cod" : "prepaid") : "";
}

export function billingRelationshipIntent(text = "", lastAssistant = "") {
  const value = String(text).trim().replace(/[\u2018\u2019]/g, "'");
  if (!value) return "";
  const mentionsBilling = /\bbilling\b/i.test(value) || /\b(?:both|dono)\b.*\b(?:same|different|alag)\b/i.test(value);
  // The assistant's last message was a billing question (any wording), so a short reply answers it.
  const askedBilling = /\bbilling\b/i.test(lastAssistant) && /[?]|\b(?:kya|chahiye|would you|do you)\b/i.test(lastAssistant);
  if (!mentionsBilling && !askedBilling) return "";
  // Without the word "billing" only a short yes/no/same/different style reply counts
  // ("yes", "yes it is same", "haan same hai", "no, different").
  const SHORT_REPLY = /^(?:(?:yes|yeah|yep|yup|ya|haan|han|ha|ji|ok|okay|sure|correct|right|bilkul|no|nope|nahi|nahin|nhi|same|different|alag|it'?s|it|is|are|they|the|addresses?|both|hai|hain|bhi|please|that|this|one|only|use|to|as|delivery|shipping|dono|ek|hi)(?:[\s,.!]+|$))+$/i;
  if (!mentionsBilling && !SHORT_REPLY.test(value)) return "";
  if (/[?]|^(?:is|are|was|were|why|how|what|can|could|should|kya)\b/i.test(value)) return "question";
  if (/\b(?:different|alag)\b|\b(?:not|isn't|aren't|nahi|nahin)\b.*\bsame\b|\bsame\b.*\b(?:nahi|nahin)\b/i.test(value)) return "different";
  if (/^(?:no|nope|nahi|nahin|nhi)[.!\s]*$/i.test(value) && askedBilling) return "different";
  if (/\b(?:don't|dont|do not|never|mat|nahi|nahin|not)\b/i.test(value)) return "";
  if (/\b(?:same|wahi|vahi|yahi|wohi|wohee)\b|वही|यही|सेम/i.test(value)) return "same";
  // "billing address bhi delivery wala hi rakho", "billing shipping jaisa", "billing as the delivery address"
  if (mentionsBilling && /\b(?:delivery|shipping)\b(?:\s+address)?\s+(?:wala|wali|wale|vala|vali|jaisa|jaisi|hi)\b|\bas\s+(?:the\s+)?(?:delivery|shipping)\b|डिलीवरी\s*(?:वाला|जैसा)/i.test(value)) return "same";
  if (/^(?:yes|yeah|yep|yup|ya|haan|han|ji|okay|ok|sure|bilkul)[.!\s]*$/i.test(value) && askedBilling) {
    // A bare "yes" to "same, or a different one?" does not say which one; ask again instead of guessing.
    if (/\bsame\b/i.test(lastAssistant) && /\b(?:different|alag|another|separate)\b/i.test(lastAssistant) && /\bor\b|\bya\b/i.test(lastAssistant)) return "";
    return "same";
  }
  return "";
}

// True when the shopper wants to SEE the order review again: an explicit "show/review/preview
// my order" or a plain "yes/please" to the assistant's own offer to bring it up.
export function wantsOrderPreview(text = "", lastAssistant = "") {
  const v = String(text || "").trim();
  if (!v) return false;
  if (/\b(?:show|see|view|display|open|bring\s*up|dikha(?:o|na|iye)?|dekh(?:na|o)?)\b.*\b(?:preview|review|summary|recap|order|total|amounts?)\b/i.test(v)) return true;
  if (/\b(?:order\s+(?:preview|review|summary)|(?:preview|review|recap)\s+(?:of\s+)?(?:my|the|this)?\s*order)\b/i.test(v) && !/\b(?:place|confirm)\b/i.test(v)) return true;
  const offered = /\b(?:order\s+(?:review|preview)|preview|review)\b/i.test(lastAssistant) && /\b(?:show|bring\s*up|let\s+me|dikha|open|display)\b/i.test(lastAssistant);
  return offered && /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|please|haan|han|ji|go\s+ahead|do\s+it)[\s,.!]*)+$/i.test(v);
}

export function safeToolBatch(calls = []) {
  const hasOrder = calls.some(call => call.name === "place_order");
  const cartChanges = calls.some(call => ["add_to_cart", "update_cart_item"].includes(call.name));
  return {
    checkoutDeferred: hasOrder && cartChanges,
    calls: calls.filter(
      call =>
        !(hasOrder && (call.name === "clear_cart" || call.name === "get_cart")) &&
        !(hasOrder && cartChanges && call.name === "place_order")
    ),
  };
}