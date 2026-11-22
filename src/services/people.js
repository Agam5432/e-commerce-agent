// Who is behind a chat. A person is one of: a signed-in Shopify customer, a guest who gave an email
// at checkout, or just an anonymous visitor (one browser). The key is stable and carries no personal
// data: the email is hashed, and the visitor reference is the same non-reversible one the chat uses.
import crypto from "node:crypto";

const secret = () => process.env.ANALYTICS_HMAC_SECRET || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "development-only-secret";
export const PERSON_KEY = /^[cev][A-Za-z0-9_-]{1,64}$/;

/** @returns {string} c<shopify id> | e<hash of email> | v<visitor ref> */
export function personKeyFor(shop, { customerRef, email, chatRef } = {}) {
  if (customerRef) return `c${String(customerRef).replace(/\D/g, "")}`;
  const mail = cleanEmail(email);
  if (mail) return `e${crypto.createHmac("sha256", secret()).update(`person:${String(shop).toLowerCase()}:${mail}`).digest("base64url").slice(0, 22)}`;
  return `v${chatRef}`;
}

export function cleanEmail(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(text) && text.length <= 254 ? text : "";
}

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** What we may keep about a contact: a name, an email and a phone number, nothing else. Empty parts are left out. */
export function cleanContact(raw = {}) {
  const name = clean(raw.name || [raw.firstName, raw.lastName].filter(Boolean).join(" "), 80);
  const email = cleanEmail(raw.email);
  const phone = clean(raw.phone, 24).replace(/[^\d+()\-\s]/g, "");
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone.replace(/\D/g, "").length >= 6 ? { phone } : {}) };
}

/** The Mongo filter for all chats of one person key (older chats saved before keys existed are matched too). */
export function personFilter(shop, key) {
  if (!PERSON_KEY.test(String(key))) return null;
  const rest = key.slice(1);
  if (key[0] === "c") return { shop, $or: [{ personKey: key }, { customerRef: rest }] };
  if (key[0] === "v") return { shop, $or: [{ personKey: key }, { personKey: null, chatRef: rest, customerRef: null }] };
  return { shop, personKey: key };
}

/** The same key worked out inside an aggregation, for chats saved before keys existed. */
export const PERSON_KEY_EXPR = {
  $ifNull: ["$personKey", { $cond: [{ $ne: [{ $ifNull: ["$customerRef", null] }, null] }, { $concat: ["c", "$customerRef"] }, { $concat: ["v", "$chatRef"] }] }],
};