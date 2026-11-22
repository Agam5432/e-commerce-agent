import { getCheckoutSession, upsertCheckoutSession } from "./checkoutSessionService.js";

// The shopper's gender is never guessed from their voice: only what they say in the chat counts.
// Older saved profiles may still carry a voice guess; it is dropped whenever the profile is read.
const VOICE_GUESS_FIELDS = ["voiceGender", "voicePitchHz"];
export function withoutVoiceGuess(profile = {}) {
  const clean = { ...(profile || {}) };
  for (const field of VOICE_GUESS_FIELDS) delete clean[field];
  return clean;
}

export function personalGender(text = "") {
  const value = String(text).toLowerCase().replace(/['’]/g, " ");
  if (/\b(?:i am|i m|main|mai|mein)\s+(?:(?:a|an|ek)\s+)?(?:guy|man|male|boy|gent|gents|ladka)\b/.test(value)) return "men";
  if (/\b(?:i am|i m|main|mai|mein)\s+(?:(?:a|an|ek)\s+)?(?:woman|female|girl|lady|ladies|ladki)\b/.test(value)) return "women";
  if (/\b(?:ladka|boy|male|man|guy)\s+h(?:ai|u|oon|un)\b/.test(value) && !/\b(?:kya|kaise|kse|pta|pata|ya)\b/.test(value)) return "men";
  if (/\b(?:ladki|girl|female|woman|lady)\s+h(?:ai|u|oon|un)\b/.test(value) && !/\b(?:kya|kaise|kse|pta|pata|ya)\b/.test(value)) return "women";
  // Natural Hindi/Hinglish first-person verb inflection ("main apne liye dekh raha hu" vs "dekh rahi hu")
  if (/\b(?:main|mai|mein|mujhe|muje|apne\s+liye|mere\s+liye)\b[^.!?]*\b(?:dekh|kar|kr|soch|dhundh|dhoondh|le|mang|maang|bol)\s+r(?:a)?ha\b/.test(value)) return "men";
  if (/\b(?:main|mai|mein|mujhe|muje|apne\s+liye|mere\s+liye)\b[^.!?]*\b(?:dekh|kar|kr|soch|dhundh|dhoondh|le|mang|maang|bol)\s+r(?:a)?hi\b/.test(value)) return "women";
  if (/\b(?:dekh|kar|kr|soch|dhundh|dhoondh|le|bol)\s+r(?:a)?ha\s+h(?:ai|u|oon|un)\b/.test(value)) return "men";
  if (/\b(?:dekh|kar|kr|soch|dhundh|dhoondh|le|bol)\s+r(?:a)?hi\s+h(?:ai|u|oon|un)\b/.test(value)) return "women";
  return "";
}

export function extractSpokenCustomerName(text = "") {
  const m = String(text || "").match(/\b(?:my\s+(?:full\s+)?name\s+is|call\s+me|mera\s+naam)\s+([A-Za-z]{2,20})(?:\s+([A-Za-z]{2,20}))?(?:\s+(?:hai|h|hoon|hu))?\b/i);
  if (!m) return "";
  const stop = new Set(["looking", "searching", "shopping", "asking", "fine", "good", "okay", "ok", "guy", "man", "male", "boy", "woman", "female", "girl", "lady", "here", "from", "going", "travelling", "traveling", "pregnant", "happy", "angry", "upset", "ready", "comfortable", "interested", "in", "on", "at", "for", "to", "a", "an", "the", "ek", "ladka", "ladki", "apne", "mere"]);
  const first = (m[1] || "").toLowerCase();
  if (!first || stop.has(first)) return "";
  const second = m[2] && !stop.has(m[2].toLowerCase()) ? ` ${m[2]}` : "";
  return `${m[1]}${second}`.trim();
}

export function requestedGender(text = "") {
  const value = String(text).toLowerCase().replace(/['’]s\b/g, "s");
  const self = personalGender(value);
  if (self) return self;
  // Corrections can contain "why" and still explicitly request men's or women's items.
  const corrections = [...value.matchAll(/\b(?:suggest|show|recommend|want|need|prefer|dikhao|dikhaiye|chahiye)\s+(?:me\s+|mujhe\s+)?(?:some\s+|only\s+|kuch\s+)?(mens?|womens?|gents?|ladies|male|female|boys?|girls?|ladk(?:a|e|o|on)|ladki(?:yan|yon)?)\b/g)];
  for (const correction of corrections.reverse()) {
    const before = value.slice(0, correction.index);
    if (/\b(?:dont|don't|do not|never|stop|not|didnt|didn't|nahi|nahin|nhi|mat)\s+(?:\w+\s+){0,2}$/.test(before)) continue;
    return /^(?:men|male|gent|boy|ladk(?:a|e|o|on))/.test(correction[1]) ? "men" : "women";
  }
  // A complaint about wrong recommendations is not a request for that gender.
  if (
    /\b(?:why|kyon|kyu|kyun|kse|kaise|never|dont|don't|not|stop|didnt|didn't|nahi|nahin|nhi|mat)\b.*\b(?:women|womens|men|mens|girls?|boys?|ladies|gents|ladka|ladki)\b/.test(value) ||
    /\b(?:women|womens|men|mens|girls?|boys?|ladies|gents|ladka|ladki)\b.*\b(?:kyon|kyu|kyun|why|kse|kaise)\b/.test(value)
  ) {
    return "";
  }
  if (/\b(?:for\s+)?(?:my\s+|mere\s+|meri\s+|apni\s+)?(?:wife|girlfriend|gf|mother|mom|mummy|sister|didi|bhabhi|beti|daughter|biwi)\b/.test(value)) return "women";
  if (/\b(?:for\s+)?(?:my\s+|mere\s+|apne\s+)?(?:husband|boyfriend|bf|father|dad|papa|brother|bhaiya|bhai|beta|son|pati)\b/.test(value)) return "men";
  if (/\b(?:kids|children|child|baby|toddler|bacha|bachche|bache)\b/.test(value)) return "kids";
  if (/\b(?:women|womens|woman|ladies|lady|female|females|girls|girl|ladki|ladkiyon|ladkiyan)\b/.test(value)) return "women";
  if (/\b(?:men|mens|man|gents|gent|male|males|boys|boy|ladka|ladke|ladko|ladkon)\b/.test(value)) return "men";
  return "";
}

export function detectRecipientIntent(message = "") {
  const text = String(message || "");
  const giftRelation = /\b(?:for\s+my\s+|my\s+|mere\s+|meri\s+|apni\s+|apne\s+)(?:wife|girlfriend|gf|mother|mom|mummy|sister|didi|bhabhi|beti|daughter|biwi|husband|boyfriend|bf|father|dad|papa|brother|bhaiya|bhai|beta|son|pati|friend|dost|family|cousin|colleague|partner)\b/i.test(text);
  const genericOther = /\b(?:kisi\s+(?:aur|or)(?:\s+k(?:e)?\s+liye)?|someone\s+else|for\s+others?|for\s+a\s+friend|dost\s+k(?:e)?\s+liye|family\s+k(?:e)?\s+liye|gift\s+(?:lena|dena|chahiye|dikhao|k\s+liye|ke\s+liye)|as\s+a\s+gift|for\s+gifting|dusre\s+k(?:e)?\s+liye|doosre\s+k(?:e)?\s+liye|unke\s+liye|uske\s+liye)\b/i.test(text);
  const gift = giftRelation || genericOther;
  const forSelf = /\b(?:for\s+myself|for\s+me|myself|my\s+trip|my\s+travel|i(?:'m| am)\s+travell?ing|i(?:'m| am)\s+going\s+(?:on|to)|mere\s+liye|mere\s+lie|mere\s+k\s+liye|mere\s+ke\s+liye|apne\s+liye|apne\s+lie|khud\s+k(?:e)?\s+liye|for\s+my\s*self|mujhe\s+apne\s+liye|muje\s+apne\s+liye|main\s+apne\s+liye)\b/i.test(text) && !gift;
  if (gift) return "gift";
  if (forSelf) return "self";
  return "";
}

export function updateProfile(previous = {}, message = "") {
  const profile = { ...previous };
  const spokenName = extractSpokenCustomerName(message);
  if (spokenName && !profile.customerName) {
    profile.customerName = spokenName;
  }
  const self = personalGender(message);
  const target = requestedGender(message);
  const recipientIntent = detectRecipientIntent(message);
  const gift = recipientIntent === "gift";
  const forSelf = recipientIntent === "self";

  if (self) {
    profile.gender = self;
    profile.ownShoppingGender = self;
  }
  if (target) {
    profile.shoppingGender = target;
    if (gift) {
      profile.recipient = "gift";
    } else if (forSelf || !profile.recipient) {
      profile.recipient = "self";
      profile.ownShoppingGender = target;
    } else if (profile.recipient === "gift") {
      profile.shoppingGender = target;
    } else {
      profile.ownShoppingGender = target;
    }
  } else if (gift) {
    profile.recipient = "gift";
    profile.shoppingGender = "";
  }
  if (forSelf && !gift) {
    profile.recipient = "self";
    profile.shoppingGender =
      target ||
      profile.ownShoppingGender ||
      profile.gender ||
      "";
  }
  if (/\b(?:travel(?:ling|ing)?|trip|journey|vacation|flight)\b/i.test(message)) profile.useCase = "travel";
  return profile;
}

export function resolveShoppingGender(message, history = [], profile = {}) {
  const current = requestedGender(message);
  if (current) return current;
  let baseProfile = { ...profile };
  if (!Object.hasOwn(baseProfile, "shoppingGender") && !baseProfile.recipient && Array.isArray(history) && history.length > 0) {
    let fromHist = { ...baseProfile };
    for (const turn of history) {
      if (turn?.role === "user" && turn.content) {
        fromHist = updateProfile(fromHist, turn.content);
      }
    }
    baseProfile = { ...fromHist, ...baseProfile };
  }
  const currentProfile = updateProfile(baseProfile, message);
  if (Object.hasOwn(currentProfile, "shoppingGender")) {
    return currentProfile.shoppingGender || "";
  }
  if (currentProfile.gender) return currentProfile.gender;
  for (const turn of [...history].reverse()) {
    if (turn.role !== "user") continue;
    const gender = requestedGender(turn.content);
    if (gender) return gender;
  }
  return "";
}

export function wantsTravelRecommendations(message = "", history = [], profile = {}) {
  const text = String(message);
  const travel = /\b(?:travel(?:ling|ing)?|trip|journey|vacation|flight|tour)\b/i.test(text);
  const broad = /\b(?:products|essentials|things|useful|recommend|suggest|whole|complete)\b/i.test(text);
  if (travel && broad && !/\b(?:only|just)\s+(?:a|one|the)?\s*(?:bottle|bag|shirt|jacket|charger)/i.test(text)) return true;
  const followsTravel = profile.useCase === "travel" || history.some(t => t.role === "user" && /\b(?:trip|travell?ing|journey|flight)\b/i.test(t.content));
  return followsTravel && /\b(?:products\s*,?\s*not\s+(?:a\s+)?specific|not\s+(?:a\s+)?(?:single|specific)\s+product|more\s+(?:useful\s+)?(?:products|options|essentials)|whole\s+trip)\b/i.test(text);
}

export function travelReason(product) {
  const text = `${product.title || ""} ${product.category || ""}`.toLowerCase();
  if (/backpack|rucksack|bag/.test(text)) return "Carry your documents, tech and daily essentials together.";
  if (/power.?bank|charg|adapter/.test(text)) return "Keep your phone and travel devices charged on the go.";
  if (/bottle|flask/.test(text)) return "Stay hydrated during the journey and day trips.";
  if (/earbud|headphone|earphone|audio/.test(text)) return "Listen to music or calls during the journey.";
  if (/jacket|hoodie/.test(text)) return "Add a layer for flights and cooler weather.";
  if (/shoe|sneaker/.test(text)) return "Comfortable footwear for walking and sightseeing.";
  return "A comfortable clothing option for your trip.";
}

import { sliceHistoryAfterLastOrder } from "./shippingAddressService.js";

export async function prepareConversation(shop, clientId, message, history, browserCheckout, { load = getCheckoutSession, save = upsertCheckoutSession, customerName = "" } = {}) {
  let stored = null;
  try { stored = await load(shop, clientId); } catch { /* Existing session memory can still answer a read request. */ }
  const guestWasReset = Boolean(
    !stored?.loggedIn &&
    (stored?.guestDetailsClearedAfterOrder || browserCheckout?.guestDetailsClearedAfterOrder)
  );
  const seedMeta = {
    ...(customerName && !guestWasReset ? { customerName } : {}),
  };
  let fromHistory = { ...seedMeta };
  const activeHistory = guestWasReset ? sliceHistoryAfterLastOrder(history) : (history || []);
  for (const turn of activeHistory) if (turn.role === "user") fromHistory = updateProfile(fromHistory, turn.content);
  let profile = withoutVoiceGuess({ ...fromHistory, ...(stored?.profile || {}), ...seedMeta });
  if (guestWasReset && !extractSpokenCustomerName(message) && !activeHistory.some(t => t.role === "user" && extractSpokenCustomerName(t.content))) {
    delete profile.customerName;
  }
  profile = updateProfile(profile, message);
  // The time of the previous message comes from the server's own record (a browser clock can be wrong).
  const previousActivityAt = stored?.lastActivityAt || null;
  const patch = { lastActivityAt: new Date() };
  if (JSON.stringify(profile) !== JSON.stringify(stored?.profile || {}) && Object.keys(profile).length) patch.profile = profile;
  if (patch.profile) {
    try { await save(shop, clientId, patch); } catch { /* Do not invent a profile if persistence is unavailable. */ }
  } else {
    // only the activity time changed: never make the customer wait for this write
    Promise.resolve().then(() => save(shop, clientId, patch)).catch(() => {});
  }
  const merged = { ...(browserCheckout || {}), ...(stored || {}), profile, previousActivityAt };
  if (stored?.discountClearedAfterOrder || browserCheckout?.discountClearedAfterOrder) {
    merged.appliedDiscount = stored?.appliedDiscount || null;
    merged.shippingMethod = stored?.shippingMethod || "standard";
    merged.shippingCost = stored?.shippingCost ?? 0;
  }
  if (guestWasReset && !stored?.shipping?.address1) {
    merged.shipping = null;
    merged.billing = null;
    merged.billingSameAsShipping = null;
    merged.customer = null;
  }
  return merged;
}