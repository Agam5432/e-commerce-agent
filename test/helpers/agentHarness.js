// Runs the real agent loop (runAgent) against the recorded TechStore catalog with a scripted fake Gemini,
// so a whole turn (tool calls, guards, cards) can be tested offline, in the same way the live widget uses it.
import crypto from "node:crypto";
import StoreIntegration from "../../src/models/StoreIntegration.js";
import CheckoutSession from "../../src/models/CheckoutSession.js";
import { encryptToken } from "../../src/utils/tokenEncryption.js";
import ecommerce from "../../src/industries/ecommerce.js";
import { realCatalogNodes } from "./realCatalog.js";
import { slugProductType } from "../../src/tools/shopify/products.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

const original = {
  find: StoreIntegration.findOne,
  checkout: CheckoutSession.findOne,
  summary: ecommerce.getCachedCatalogSummary,
  fetch: globalThis.fetch,
};

/**
 * Points the shop's Shopify calls at the recorded catalog. Returns the product types and a restore function.
 * `fullSummary` adds what the live catalog summary also carries (product counts per type, totals, sample titles), so the
 * system prompt reads like production (the evaluation uses it; the unit tests keep the small summary).
 */
export function installRealStore({ fullSummary = false } = {}) {
  const nodes = realCatalogNodes();
  const types = [...new Set(nodes.map((n) => n.productType).filter(Boolean))];
  StoreIntegration.findOne = () => ({
    select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }),
    lean: async () => null,
  });
  CheckoutSession.findOne = () => ({ lean: async () => null });
  const categoryMap = {};
  for (const n of nodes) (categoryMap[slugProductType(n.productType)] ||= []).push(n.title);
  const counts = new Map();
  for (const n of nodes) if (n.productType) counts.set(n.productType, (counts.get(n.productType) || 0) + 1);
  const extra = fullSummary
    ? { categoryCounts: [...counts].map(([label, count]) => ({ label, count })), totalActive: nodes.length, totalProducts: nodes.length, sampleTitles: nodes.slice(0, 25).map((n) => n.title) }
    : {};
  ecommerce.getCachedCatalogSummary = () => ({ categories: types, categoryMap, currency: "INR", storeName: "TechStore", ...extra });
  // Only the shop's own Shopify calls are answered from the recording; anything else (a live AI provider) goes out normally.
  globalThis.fetch = async (url, init) => {
    if (!/myshopify.com|shopify/i.test(String(url?.url || url))) return original.fetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }),
    };
  };
  return {
    nodes,
    types,
    restore() {
      StoreIntegration.findOne = original.find;
      CheckoutSession.findOne = original.checkout;
      ecommerce.getCachedCatalogSummary = original.summary;
      globalThis.fetch = original.fetch;
    },
  };
}

/**
 * A fake Gemini client. `steps` are the model's answers to the main (system-prompt) calls, in order: each is a function
 * (request, callNumber) returning either a string (the reply) or { call: [{ name, args }] } (tool calls). The last step
 * repeats. Side calls (no system prompt: meaning match, suggestions) go to `side`, default "[]".
 */
export function scriptedGemini(steps, { side = async () => "[]" } = {}) {
  const main = [];
  const sideCalls = [];
  return {
    main,
    sideCalls,
    models: {
      async generateContent(req) {
        if (!req.config?.systemInstruction) {
          sideCalls.push(req);
          const text = await side(req, sideCalls.length);
          return { candidates: [{ content: { role: "model", parts: [{ text }] } }], usageMetadata: {} };
        }
        main.push(req);
        const step = steps[Math.min(main.length - 1, steps.length - 1)];
        const out = await step(req, main.length);
        const parts = typeof out === "string"
          ? [{ text: out }]
          : out.call.map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }));
        return { candidates: [{ content: { role: "model", parts } }], usageMetadata: {} };
      },
    },
  };
}

export const freshClientId = () => `c-${crypto.randomUUID()}`;
