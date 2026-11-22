// Claims about what the STORE has promised (a return window, a replacement, a warranty, support hours) and about discount figures are
// checked against what the store's own data returned THIS turn. Pure functions: no I/O, so they are cheap to test.
//
// Why this exists (real store, 2026-11-16): asked "what does the store policy say about damaged items", the assistant answered
// "According to our policy, if you receive a damaged item, contact support with a photo for a return or replacement", while the store
// has published no such policy (the tool had said so, or was never called). It also said "26% off, $309 to $229, save $80" by pairing one
// option's original price with another option's sale price. The existing guards only checked claims of ACTIONS (placed, cancelled, emailed).

const OFFER_RE = /\b(?:would you like|do you want|shall i|can i|may i|let me know|if you (?:like|want|prefer)|i can (?:share|show|pass|connect|help|note|check)|i could)\b|\?\s*$/i;
const CONDITIONAL_START_RE = /^\s*(?:and\s+|but\s+|so\s+)?(?:if|agar|once|jab|in\s+case|unless|whether)\b/i;
// "The store has not published a return policy" is the HONEST answer: it must never be flagged.
const NOT_PUBLISHED_RE = /\b(?:has(?:n'?t| not)|have(?:n'?t| not)|had not|did(?:n'?t| not)|do(?:es)?(?:n'?t| not)|is(?:n'?t| not)|are(?:n'?t| not)|cannot|can'?t|could(?:n'?t| not)|unable to)\b[^.!?\n]{0,50}\b(?:publish(?:ed)?|list(?:ed)?|state|stated|specif(?:y|ied)|share(?:d)?|provide(?:d)?|have|offer|mention(?:ed)?|confirm|promise|available|set)\b|\bno\s+(?:published|specific|official|set)\b|\bnot\s+(?:been\s+)?(?:published|listed|stated)\b|\bnahi\b/i;

// A sentence that asserts a store policy, a period or a promise. Each is a CLAIM about the store, not a fact the shopper gave.
const POLICY_CLAIM_RES = [
  { kind: "policy", re: /\b(?:according to|as per|under|per|based on)\s+(?:our|the|this)\s+(?:store'?s?\s+)?(?:\w+\s+){0,2}?polic(?:y|ies)\b/i },
  { kind: "policy", re: /\b(?:our|the store'?s?|this store'?s?)\s+(?:\w+\s+){0,2}?(?:return|refund|replacement|exchange|warranty|guarantee|shipping|delivery|damage|cancellation|support)\s+(?:policy|policies|terms|window|period)\b/i },
  { kind: "policy", re: /\b(?:you\s+(?:can|may|are\s+able\s+to)|we\s+(?:offer|provide|allow|accept|give|have|guarantee))\b[^.!?\n]{0,60}\b(?:return|refund|replace(?:ment)?|exchange|warranty|guarantee)\b[^.!?\n]{0,60}\b(?:within|in|for|up\s+to|of)\s+\d+\s*(?:days?|weeks?|months?|years?|hours?)\b/i },
  { kind: "policy", re: /\b\d+[-\s]?(?:day|week|month|year)s?[-\s]+(?:return|refund|replacement|exchange|warranty|guarantee)\b/i },
  { kind: "policy", re: /\bif you (?:receive|get|got|received)\b[^.!?\n]{0,60}\b(?:damaged|defective|broken|faulty|wrong)\b[^.!?\n]{0,160}\b(?:return|replacement|replace|refund|exchange)\b/i },
  { kind: "policy", re: /\bhamari\s+(?:\w+\s+){0,2}?polic(?:y|ies)\b|polic(?:y|ies)\s+ke\s+(?:anusar|hisaab|mutabik)/i },
  { kind: "policy", re: /\b(?:free|full|instant)\s+(?:return|refund|replacement|exchange)s?\b/i },
  // support / opening hours stated as fact
  { kind: "hours", re: /\b(?:support|customer\s+(?:care|service)|our\s+team|the\s+team|we(?:'re| are)?|store)\b[^.!?\n]{0,50}\b(?:available|open|operat\w+|working|hours?|reachable)\b[^.!?\n]{0,60}\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^.!?\n]{0,14}\b(?:to|-|–|until|till)\b[^.!?\n]{0,14}\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i },
];

const sentences = (text) => String(text || "").split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);

/** The sentences of a reply that state a store policy / promise / support hours (honest "not published" lines and offers excluded). */
export function storePolicyClaims(text = "") {
  const out = [];
  for (const sentence of sentences(text)) {
    if (OFFER_RE.test(sentence) || NOT_PUBLISHED_RE.test(sentence)) continue;
    const hit = POLICY_CLAIM_RES.find((c) => c.re.test(sentence));
    if (!hit) continue;
    // "If it has been cancelled you get a refund" is a condition, not a promise, except the "if you receive a damaged item ... replacement"
    // shape, which IS how an invented policy is worded.
    if (CONDITIONAL_START_RE.test(sentence) && hit !== POLICY_CLAIM_RES[4]) continue;
    out.push({ kind: hit.kind, sentence });
  }
  return out;
}

const POLICY_TOOLS = new Set(["get_warranty_and_policy"]);
const INFO_TOOLS = new Set(["get_store_info", "get_call_slots", "get_shipping_options", "get_warranty_and_policy"]);

/** What the store's own data said this turn: policy bodies, and the info tools' raw results (hours, contact, slots). */
export function storeEvidence(toolLog = []) {
  let policyText = "";
  let anyPolicy = false;
  let info = "";
  for (const t of toolLog || []) {
    if (!t?.result) continue;
    if (POLICY_TOOLS.has(t.name) && t.result.status === "ok") {
      const bodies = (t.result.policies || []).map((p) => `${p.title || ""} ${p.text || ""}`).join(" ");
      if (bodies.trim()) { anyPolicy = true; policyText += ` ${bodies}`; }
      if (t.result.productDescription) policyText += ` ${t.result.productDescription}`;
    }
    if (INFO_TOOLS.has(t.name)) { try { info += ` ${JSON.stringify(t.result)}`; } catch { /* ignore */ } }
  }
  return { policyText: policyText.toLowerCase(), anyPolicy, info: info.toLowerCase() };
}

const numbersIn = (s) => [...String(s).matchAll(/\d+(?::\d{2})?/g)].map((m) => m[0]);

/** Claims the data of this turn does NOT back. A policy claim needs a published policy that covers it; a number in a claim must appear in the data. */
export function unsupportedStoreClaims(text = "", toolLog = []) {
  const claims = storePolicyClaims(text);
  if (!claims.length) return [];
  const ev = storeEvidence(toolLog);
  const haystack = `${ev.policyText} ${ev.info}`;
  return claims.filter(({ kind, sentence }) => {
    if (kind === "hours") return !numbersIn(sentence).every((n) => ev.info.includes(n.toLowerCase()) || ev.policyText.includes(n.toLowerCase()));
    if (!ev.anyPolicy) return true; // no published policy came back: nothing can back a policy claim
    const nums = numbersIn(sentence);
    if (nums.length && !nums.every((n) => haystack.includes(n))) return true;
    // the policy must at least be about what the claim talks about
    const topics = (sentence.toLowerCase().match(/damag|defect|broken|faulty|return|refund|replace|exchange|warrant|guarant|shipping|deliver|cancel/g) || []).map((w) => w.slice(0, 5));
    return topics.length > 0 && !topics.some((w) => ev.policyText.includes(w));
  });
}

/** What the shopper hears when the store has published nothing that covers what the draft claimed. */
export function policyNotPublishedReply(replyLanguage = "en") {
  return replyLanguage === "hi"
    ? "इस स्टोर ने यह जानकारी (रिटर्न, रिप्लेसमेंट, वारंटी या सपोर्ट के समय) प्रकाशित नहीं की है, इसलिए मैं इसे पक्का नहीं बता सकती। चाहें तो मैं स्टोर का संपर्क बता दूँ या आपका अनुरोध टीम तक पहुँचा दूँ।"
    : "The store hasn't published that information (returns, replacements, warranty or support hours), so I can't state it. I can share the store's contact details or pass your request to the team if you'd like.";
}

// ---------------------------------------------------------------------------------------------------- discount figures

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (s) => Number(String(s).replace(/,/g, ""));

/** Every (original -> sale) pair the data of this turn really has, each belonging to ONE option. */
export function salePairs(toolLog = []) {
  const pairs = [];
  const seen = new Set();
  const add = (name, was, now) => {
    const w = Number(was), n = Number(now);
    if (!(w > n) || !(n > 0)) return;
    const key = `${w}|${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ name: name || "", was: round2(w), now: round2(n), amount: round2(w - n), percent: Math.round(((w - n) / w) * 100) });
  };
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (value.compareAtPrice != null && value.price != null) add(value.name || value.title || value.variant || "", value.compareAtPrice, value.price);
    if (value.originalPrice != null && value.salePrice != null) add(value.optionName || "", value.originalPrice, value.salePrice);
    for (const v of Object.values(value)) walk(v, depth + 1);
  };
  for (const t of toolLog || []) walk(t?.result);
  return pairs;
}

/** Figures in a reply that no single option's real (original, sale) pair backs: "from $309 to $229", "26% off", "save $80". */
export function discountClaimProblems(text = "", toolLog = []) {
  const pairs = salePairs(toolLog);
  if (!pairs.length) return [];
  const raw = (() => { try { return JSON.stringify((toolLog || []).map((t) => t?.result ?? null)); } catch { return ""; } })();
  const couponPercents = new Set([...raw.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1])));
  const issues = [];
  const t = String(text || "");
  for (const m of t.matchAll(/(?:from|was|originally|mrp|regular price|down from)\s*\*{0,2}\$?\s?([0-9][0-9,]*(?:\.\d+)?)\*{0,2}\s*(?:to|now|→|->|down to|at)\s*\*{0,2}\$?\s?([0-9][0-9,]*(?:\.\d+)?)/gi)) {
    const a = num(m[1]), b = num(m[2]);
    if (!(a > b)) continue;
    if (!pairs.some((p) => Math.abs(p.was - a) < 0.011 && Math.abs(p.now - b) < 0.011)) issues.push(`"${m[0].trim()}" pairs prices of different options (real pairs: ${pairs.map((p) => `${p.was}->${p.now}`).join(", ")})`);
  }
  for (const m of t.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%\s*(?:off|discount|sale|direct|saving)/gi)) {
    const p = Number(m[1]);
    if (!pairs.some((x) => Math.abs(x.percent - p) <= 1) && !couponPercents.has(p)) issues.push(`${p}% matches no option's real discount (real: ${[...new Set(pairs.map((x) => x.percent))].join("%, ")}%)`);
  }
  for (const m of t.matchAll(/sav(?:e|es|ing|ings|ed)(?:\s+you)?\s*\*{0,2}\$\s?([0-9][0-9,]*(?:\.\d+)?)/gi)) {
    const a = num(m[1]);
    if (!pairs.some((x) => Math.abs(x.amount - a) < 0.011)) issues.push(`saving $${a} matches no option's real saving (real: ${[...new Set(pairs.map((x) => x.amount))].join(", ")})`);
  }
  return issues;
}

/** One verified line per option: used to rewrite a reply, or as the reply itself. */
export function saleFactsLine(pairs = [], currencySign = "$") {
  return pairs.slice(0, 6).map((p) => `${p.name ? `${p.name}: ` : ""}${currencySign}${p.was.toFixed(2)} → ${currencySign}${p.now.toFixed(2)} (${p.percent}% off, saves ${currencySign}${p.amount.toFixed(2)})`).join("; ");
}
