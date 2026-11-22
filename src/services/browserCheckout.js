import { dataText } from "../agent/untrusted.js";
// The browser sends back the checkout state it was last shown. That copy is UNTRUSTED: anyone can
// edit it in DevTools. Only the shopper's own entries (address, contact, choices) are accepted from
// it. Everything that decides money or identity (shipping rate and fee, discounts, Shopify quotes,
// order results, login state, customer id, idempotency keys) is read only from the server's own
// checkout session.

const ADDRESS_FIELDS = ["name", "firstName", "lastName", "email", "phone", "address1", "address2", "city", "province", "provinceCode", "zip", "country", "countryCode", "company"];

function cleanAddress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of ADDRESS_FIELDS) {
    if (typeof value[key] === "string") out[key] = value[key].slice(0, 255);
  }
  return Object.keys(out).length ? out : null;
}

const BOOLEAN_FIELDS = [
  "billingSameAsShipping",
  "shippingConfirmed",
  "billingConfirmed",
  "shippingNeedsUpdate",
  "billingNeedsUpdate",
  // these two only ever make the session forget more, never grant anything
  "guestDetailsClearedAfterOrder",
  "discountClearedAfterOrder",
];

const STEPS = new Set(["cart", "login", "address", "ask_billing", "billing_inquiry", "review", "ready"]);

export function sanitizeBrowserCheckout(checkout) {
  if (!checkout || typeof checkout !== "object" || Array.isArray(checkout)) return null;
  const out = {};
  const shipping = cleanAddress(checkout.shipping);
  const billing = cleanAddress(checkout.billing);
  if (shipping) out.shipping = shipping;
  if (billing) out.billing = billing;
  for (const key of BOOLEAN_FIELDS) {
    if (typeof checkout[key] === "boolean") out[key] = checkout[key];
  }
  if (checkout.billingSameAsShipping === null) out.billingSameAsShipping = null;
  if (typeof checkout.step === "string" && STEPS.has(checkout.step)) out.step = checkout.step;
  if (["cod", "prepaid"].includes(checkout.selectedPaymentMethod)) out.selectedPaymentMethod = checkout.selectedPaymentMethod;
  if (typeof checkout.shippingSource === "string") out.shippingSource = checkout.shippingSource.slice(0, 40);
  if (checkout.profile && typeof checkout.profile === "object" && !Array.isArray(checkout.profile)) {
    out.profile = Object.fromEntries(
      Object.entries(checkout.profile)
        .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
        .slice(0, 20)
        // keys are plain names; values one short line (they are read into the AI's prompt)
        .filter(([k]) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k))
        .map(([k, v]) => [k, typeof v === "string" ? dataText(v, 120) : v])
    );
  }
  return out;
}