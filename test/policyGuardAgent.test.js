// H1 and H3 through the REAL agent loop with a scripted model: the guards must stop an invented store policy, invented support hours and
// mixed-option discount figures from reaching the shopper, and must leave honest and well-backed replies untouched.
// The model is scripted and Shopify answers from a recording or a fixture: MOCK TESTED. The real-store re-run is a separate browser check.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");
const { clearStoreProductCache } = await import("../src/tools/shopifyService.js");
const { policyCaches } = await import("../src/tools/shopify/caches.js");

const store = installRealStore();
const recorded = globalThis.fetch;
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => {
  __resetProviderBlocksForTest();
  globalThis.fetch = recorded;
  // the shop's search, catalog and policy caches would otherwise hold the previous test's data
  clearStoreProductCache("guard.myshopify.com");
  policyCaches.clear();
});

let scripted;
const ask = (steps, message) => {
  scripted = scriptedGemini(steps);
  __setLLMClientsForTest({ gemini: scripted });
  return runAgent(message, "guard.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } });
};

const INVENTED = "According to our policy, if you receive a damaged item, please contact our support team with your order details and a photo of the damage so we can assist you with a return or replacement.";

test("H1: the invented damaged-item policy never reaches the shopper; the rewrite says the store has not published it", async () => {
  const out = await ask([() => INVENTED, () => "The store has not published a policy for damaged items. I can share the store's contact details or pass your request to the team if you'd like."], "just tell me what the store policy says about damaged items");
  assert.doesNotMatch(out.answer, /According to our policy|photo of the damage/i, out.answer);
  assert.match(out.answer, /not published/i);
});

test("H1: if the rewrite repeats the invention, the plain 'not published' line is sent instead", async () => {
  const out = await ask([() => INVENTED, () => INVENTED], "what is your policy for damaged phones");
  assert.match(out.answer, /hasn't published that information/i, out.answer);
  assert.doesNotMatch(out.answer, /photo of the damage/i);
});

test("H1: invented support hours are caught too", async () => {
  const out = await ask([() => "Our support team is available from 9:00 AM to 6:00 PM, Monday through Friday.", () => "The store hasn't published support hours. I can share its contact details if you like."], "what are your customer support hours");
  assert.doesNotMatch(out.answer, /9:00 AM to 6:00 PM/i, out.answer);
  assert.match(out.answer, /hasn't published/i);
});

test("H1: an honest 'not published' reply passes untouched and costs no extra model call", async () => {
  const honest = "The store hasn't published a return policy yet. I can share its contact details if you'd like.";
  const out = await ask([() => honest], "what is your return policy");
  assert.equal(out.answer.trim(), honest);
  assert.equal(scripted.main.length, 1, "no rewrite was needed");
});

test("H1: a policy the merchant really published is passed through, but only with its real period", async () => {
  globalThis.fetch = async (url, init) => {
    const body = String(init?.body || "");
    if (/shopPolicies/.test(body)) return { ok: true, status: 200, json: async () => ({ data: { shop: { shopPolicies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>You can return unused items within 7 days of delivery for a full refund.</p>", url: "https://example.com/policies/refund" }] } } }) };
    return recorded(url, init);
  };
  const kept = await ask([() => "You can return unused items within 7 days of delivery for a full refund."], "what is your return policy");
  assert.match(kept.answer, /within 7 days/);
  const wrong = await ask([() => "You can return unused items within 30 days of delivery for a full refund.", () => "Per the store's refund policy, unused items can be returned within 7 days of delivery."], "what is your return policy");
  assert.doesNotMatch(wrong.answer, /30 days/, wrong.answer);
  assert.match(wrong.answer, /7 days/);
});

// ---------------------------------------------------------------- H3 through the agent: TechStore's real Xiaomi numbers
function xiaomiShopify() {
  let n = 500;
  const v = (title, price, compareAtPrice) => ({ node: { id: `gid://shopify/ProductVariant/${++n}`, title, selectedOptions: [], image: null, price, compareAtPrice, inventoryQuantity: 10, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } });
  const node = {
    id: "gid://shopify/Product/500", title: "Xiaomi Redmi Note 13", handle: "xiaomi-redmi-note-13", description: "Large bright display and 108MP main camera.", status: "ACTIVE", productType: "Smartphones", vendor: "Xiaomi", tags: ["smartphones"],
    publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: "x" }, priceRangeV2: { minVariantPrice: { amount: "229.00", currencyCode: "USD" } },
    variants: { edges: [v("Ocean Teal / 128GB", "229.00", "269.00"), v("Ocean Teal / 256GB", "269.00", "309.00")] },
  };
  globalThis.fetch = async (url, init) => {
    if (!/myshopify.com|shopify/i.test(String(url?.url || url))) return recorded(url, init);
    return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null } }, product: node } }) };
  };
}
const CALL = { call: [{ name: "get_discounts_and_offers", args: { productName: "Xiaomi Redmi Note 13", variantName: "256GB" } }] };
const MIXED = "The Xiaomi Redmi Note 13 is currently on a 26% direct sale, which brings the price down from $309.00 to $229.00, saving you $80.00.";

test("H3: a draft that pairs the 256GB's original price with the 128GB's sale price is rewritten from the real per-option figures", async () => {
  xiaomiShopify();
  const out = await ask([() => CALL, () => MIXED, () => "The 256GB option is $269.00, down from $309.00: 13% off, saving you $40.00."], "is there any discount on the xiaomi 256gb");
  assert.doesNotMatch(out.answer, /26%|\$80|309\.00 to \$229/, out.answer);
  assert.match(out.answer, /13% off/);
});

test("H3: if the rewrite still mixes options, the reply is the verified per-option figures themselves", async () => {
  xiaomiShopify();
  const out = await ask([() => CALL, () => MIXED, () => MIXED], "is there any discount on the xiaomi 256gb");
  assert.doesNotMatch(out.answer, /26%|\$80/, out.answer);
  assert.match(out.answer, /\$269\.00 → \$229\.00 \(15% off, saves \$40\.00\)/);
  assert.match(out.answer, /\$309\.00 → \$269\.00 \(13% off, saves \$40\.00\)/);
});

test("H3: correct single-option figures pass untouched", async () => {
  xiaomiShopify();
  const good = "The 128GB option is $229.00, down from $269.00: 15% off, saving you $40.00.";
  const out = await ask([() => CALL, () => good], "is there any discount on the xiaomi");
  assert.equal(out.answer.trim(), good);
});
