import { normalizeAddressForShopify } from "./shopifyAddress.js";
import { validatePhone, contactProblems } from "./contactValidation.js";

const clean = value => String(value || "").trim();
const compact = value => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const digits = value => clean(value).replace(/\D/g, "");

const ORDER_RESET_HISTORY_RE =
  /Order\s+ID:\s*\*\*#TS-|order\s+(?:has\s+been\s+placed|is\s+confirmed|placed\s+successfully)|order\s+.*\b(?:place|confirm)\s+ho\s+gaya|Shopify\s+mein\s+place\s+ho\s+gaya|confirmed\s+in\s+Shopify|cleared\s+out\s+all\s+items|cart\s+is\s+now\s+empty|cart\s+bilkul\s+khali|cart\s+ab\s+khali|खाली\s+हो\s+गया/i;

export function sliceHistoryAfterLastOrder(history = []) {
  if (!Array.isArray(history) || history.length === 0) return [];
  let startIdx = 0;
  for (let i = 0; i < history.length; i++) {
    const content = String(history[i]?.content || "");
    if (history[i]?.role === "assistant" && ORDER_RESET_HISTORY_RE.test(content)) {
      startIdx = i + 1;
    }
  }
  return history.slice(startIdx);
}

export function deduplicateAddress(address = {}) {
  const out = { ...address };
  if (compact(out.address2) && compact(out.address1).includes(compact(out.address2))) out.address2 = "";
  return out;
}

export function validContactPhone(phone, country) {
  if (!phone) return true;
  return validatePhone(phone, country).ok;
}

// The locality the shopper wrote between the street and the city ("12 MG Road, Andheri West, Mumbai") when the model left it out of both
// address lines: a real order lost "Andheri West" that way (2026-11-21). Only the shopper's own words are used, never a guess.
function between(message, address1, city) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const a = clean(address1).toLowerCase();
  const c = clean(city).toLowerCase();
  if (!a || !c) return "";
  const start = lower.indexOf(a);
  if (start < 0) return "";
  const from = start + a.length;
  const end = lower.indexOf(c, from);
  if (end < 0) return "";
  const part = text.slice(from, end).replace(/^[\s,;-]+|[\s,;-]+$/g, "").trim();
  if (part.length < 2 || part.length > 80 || /@|\d{6,}/.test(part)) return "";
  return part;
}

export function mergeShippingAddress(current = {}, args = {}, { message = "", history = [], customer = {} } = {}) {
  const address = { ...current };
  const activeHistory = sliceHistoryAfterLastOrder(history);
  const userTexts = [...activeHistory.filter(t => t.role === "user").map(t => t.content), message].join("\n");
  const explicitPhone = message.match(/\b(?:phone(?:\s+number)?|mobile(?:\s+number)?|contact(?:\s+number)?)(?:\s+is|\s*:)?\s*([+\d][\d\s().-]{5,24})/i)?.[1]?.trim().replace(/[.\s]+$/, "");
  // Speech-to-text often splits a spoken email ("agam tyagi 2001@gmail.com"). When the
  // local part is only digits and words precede it, glue the words back on.
  const spokenEmail = message.match(/\b((?:[a-z]+\s+){1,3})(\d{2,}@[a-z0-9.-]+\.[a-z]{2,})/i);
  const explicitEmail = spokenEmail
    ? spokenEmail[1].replace(/\b(?:and|is|my|email|e-mail|mail|address|id|the|its|it's|so|also|hai|mera|meri)\b/gi, "").replace(/\s+/g, "") + spokenEmail[2]
    : message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const explicitName = message.match(/\b(?:my\s+(?:full\s+)?name\s+is|mera\s+naam|call\s+me)\s+([\p{L}]+(?:\s+[\p{L}]+){0,3})/iu)?.[1]?.replace(/\b(?:and|phone|number|email|address|hai)\b.*$/i, "").trim();
  const addressTurn = (/\b(?:street|delivery|shipping|address|colony|road|lane|apartment|flat|house)\b|\d+\s*\/\s*\d+/i.test(message) || (/^\s*(?:\d+|[a-z]-?\d+)\b/i.test(message) && /[a-z]{2}/i.test(message))) && !/\b(?:what|show|tell|know)\b.*\baddress\b/i.test(message);
  const supports = value => compact(value) && compact(userTexts).includes(compact(value));
  const inCurrent = value => compact(value) && compact(message).includes(compact(value));
  if (explicitName) address.name = explicitName;
  else if (!address.name && supports(args.name)) address.name = clean(args.name);
  address.name ||= customer.name || customer.displayName || "";
  if (explicitEmail) address.email = explicitEmail.toLowerCase();
  else address.email ||= customer.email || (supports(args.email) ? clean(args.email) : "");
  // Never let the model append a guessed digit or alter a phone during a ZIP-only reply.
  const phoneOnly = /^[+\d\s().-]+$/.test(clean(message)) && digits(message).length >= 9 ? digits(message) : "";
  if (explicitPhone || phoneOnly) address.phone = digits(explicitPhone || phoneOnly);
  else if (!address.phone && args.phone && supports(digits(args.phone))) address.phone = clean(args.phone);
  address.phone ||= customer.phone || "";
  if (addressTurn && clean(args.address1) && inCurrent(args.address1)) {
    address.address1 = clean(args.address1);
    address.address2 = supports(args.address2) ? clean(args.address2) : between(message, args.address1, args.city);
  }
  for (const field of ["city", "province", "zip"]) {
    if (clean(args[field]) && inCurrent(args[field])) address[field] = clean(args[field]);
  }
  const postalOnly = clean(message).match(/^(\d{5,6}(?:-\d{4})?)[.!\s]*$/);
  if (postalOnly) address.zip = postalOnly[1];
  if (clean(args.country) && addressTurn && inCurrent(args.country)) {
    address.country = clean(args.country);
    delete address.countryCode;
    delete address.provinceCode;
  }
  const normalized = normalizeAddressForShopify(address);
  const merged = deduplicateAddress({ ...address,
    phone: validContactPhone(address.phone, normalized.countryCode) ? normalized.phone : address.phone,
    province: normalized.province, provinceCode: normalized.provinceCode,
    country: normalized.country || address.country || "", countryCode: normalized.countryCode,
  });
  const missing = ["name", "address1", "city", "province", "zip", "country", "email"].filter(field => !clean(merged[field]));
  if (!merged.phone || !validContactPhone(merged.phone, merged.countryCode)) missing.push("phone");
  // Entered-but-wrong values: reported separately so the agent can say "not valid".
  const invalid = contactProblems({ email: merged.email, phone: merged.phone, country: merged.countryCode || merged.country })
    .filter((p) => p.reason === "invalid");
  return { address: merged, missing, invalid };
}