// The store's own refund, shipping and privacy policies, and warranty answers from them.
// Part of shopifyService.js (which re-exports all of it); moved here unchanged.
import { POLICY_CACHE_TTL_MS, policyCaches } from "./caches.js";
import { getStoreCredentials, shopifyGraphQL } from "./client.js";
import { truncate } from "./products.js";
import { searchShopifyProducts } from "./search.js";

function htmlToText(html = "", max = 1800) {
  const text = String(html || "")
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

/** The store's own published legal policies (refund, shipping, terms...) from Shopify. */
export async function getStorePolicies(storeDomain, { throwOnError = false } = {}) {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const cached = policyCaches.get(domain);
  if (cached && Date.now() - cached.at < POLICY_CACHE_TTL_MS) return cached.policies;
  let policies = [];
  try {
    const credentials = await getStoreCredentials(domain);
    const data = await shopifyGraphQL(credentials, `query StorePolicies { shop { shopPolicies { type title body url } } }`);
    policies = (data?.shop?.shopPolicies || [])
      .map((p) => ({ type: String(p.type || ""), title: String(p.title || ""), url: p.url || null, text: htmlToText(p.body) }))
      .filter((p) => p.text);
  } catch (error) {
    // Usually the app lacks the read_legal_policies scope. Never fill the gap with invented policy.
    console.warn("[policy] could not read Shopify shop policies:", String(error?.message || error).slice(0, 160));
    // A failed read is NOT "the store has no policy": the caller must be able to say "I can't load it right now" instead
    // (a real run told a shopper "the store has not published a return policy" while Shopify was refusing the token).
    if (throwOnError) throw error;
    return [];
  }
  policyCaches.set(domain, { at: Date.now(), policies });
  return policies;
}

/**
 * Warranty / return / replacement questions are answered ONLY from what the merchant published in
 * Shopify: the store's policies and the product's own description. Nothing is assumed per category.
 */
const POLICY_TOPICS = {
  returns: /REFUND/, shipping: /SHIPPING/, privacy: /PRIVACY/, terms: /TERMS|LEGAL/, subscription: /SUBSCRIPTION/, contact: /CONTACT/,
};

export async function getProductWarrantyAndPolicy(storeDomain, productName = "", topic = "") {
  const domain = String(storeDomain || "").trim().toLowerCase();
  const term = String(productName || "").trim();
  const wanted = POLICY_TOPICS[String(topic || "").trim().toLowerCase()];
  let targetProduct = null;
  if (term) {
    const products = await searchShopifyProducts(domain, term);
    if (products.length > 0) targetProduct = products[0];
  }
  let allPolicies;
  try {
    allPolicies = await getStorePolicies(domain, { throwOnError: true });
  } catch {
    return {
      status: "error",
      topic: wanted ? String(topic).trim().toLowerCase() : null,
      policies: [],
      instruction_for_ai: "The store's policies could not be loaded right now (a temporary problem, NOT a missing policy). Never say the store has no policy or has not published one. Say in one short line that you cannot open the store's policy at the moment, and offer the store's contact details or to try again in a moment.",
    };
  }
  // A named topic narrows the answer to that policy; if the store has no policy of that type, say so rather than dumping unrelated ones.
  const policies = wanted ? allPolicies.filter((p) => wanted.test(p.type)) : allPolicies;
  const productDescription = targetProduct ? truncate(targetProduct.description || "", 900) : "";
  const hasInfo = policies.length > 0 || Boolean(productDescription);
  return {
    status: hasInfo ? "ok" : "not_published",
    topic: wanted ? String(topic).trim().toLowerCase() : null,
    otherPoliciesAvailable: wanted ? allPolicies.filter((p) => !wanted.test(p.type)).map((p) => p.title) : [],
    productTitle: targetProduct?.title || null,
    productDescription: productDescription || null,
    policies,
    instruction_for_ai: hasInfo
      ? "Answer the warranty / return / shipping / policy question ONLY from these store policies and the product description, in simple friendly words. Quote periods and conditions exactly as written. If they do not cover what was asked, say the store has not published that detail and offer the policy link or store contact. Never invent a warranty, period, free pickup or guarantee."
      : String(topic).trim().toLowerCase() === "shipping"
        ? "The store has not published shipping times or costs. Say so in one short line, then be useful: shipping cost is worked out from the delivery address, so offer to show the exact options as soon as they share their address (or to add the item they want to the cart first). The store does not publish delivery dates, so for a date the store team is the one to ask (offer the contact details from get_store_info). Never invent a fee, a number of days or a date."
        : "This store has not published that policy in Shopify and the product description does not mention one. Say so honestly in one short line, then offer the store's contact details (get_store_info), or offer to pass their request to the team (flag_for_owner) if they want to start a return or exchange. Never invent a warranty, return window or guarantee.",
  };
}

export { htmlToText, POLICY_TOPICS };
