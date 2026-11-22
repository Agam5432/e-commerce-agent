import crypto from "node:crypto";

// Browser-provided contact details are useful for guest checkout, but they are
// not proof of a Shopify login and must never select another customer's ID.
export function guestCustomer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(["name", "email", "phone"].filter(key => typeof value[key] === "string").map(key => [key, value[key].slice(0, 254)]));
}

export function verifiedCustomerGid(numericId) {
  return /^\d+$/.test(String(numericId || "")) ? `gid://shopify/Customer/${numericId}` : null;
}

// The client id is the key to a shopper's checkout session and email-verification state, so it
// must be unguessable: short or odd-looking ids are replaced by a fresh random one.
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The id a long-lived connection keeps using: a new one from the browser replaces it only when it has the right shape. */
export function nextClientId(current, provided) {
  return typeof provided === "string" && CLIENT_ID_PATTERN.test(provided) ? provided : current;
}

export function resolveClientId({ clientId, shop, cartToken, customerId } = {}) {
  const provided = typeof clientId === "string" ? clientId.trim() : "";
  if (CLIENT_ID_PATTERN.test(provided)) return provided;
  const identity = cartToken || customerId;
  // S3: this id unlocks the shopper's email-verified order lookup, so it is keyed with the app secret. A plain
  // sha256(shop:customer gid) could be worked out by anyone who knows the store and a customer number, then sent as
  // "clientId" to read that customer's orders. Without a secret (tests, local) there is no derived id at all.
  const secret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "";
  if (typeof identity === "string" && identity && secret) {
    return crypto.createHmac("sha256", secret).update(`client-id:${shop}:${identity}`).digest("hex");
  }
  return crypto.randomUUID();
}