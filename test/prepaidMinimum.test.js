// Real TechStore (2026-11-17): choosing "online payment" on a $15 cart applied the 50% prepaid discount although its Shopify rule is
// "minimum purchase $20,000" (the code PREPAID50 itself was refused below that, the automatic prepaid offer was not).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { getPrepaidDiscountOffer } from "../src/tools/shopifyService.js";
import { catalogSummaryCaches, discountCaches } from "../src/tools/shopify/caches.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const discount = (min) => ({ __typename: "DiscountCodeBasic", title: "PREPAID50", status: "ACTIVE", summary: "50% off entire order", codes: { nodes: [{ code: "PREPAID50" }] }, customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.5 } }, minimumRequirement: min });
const mock = (d) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { discountNodes: { edges: [{ node: { id: "1", discount: d } }] } } }) }); };
const MIN = { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "20000.0", currencyCode: "USD" } };

test("a prepaid discount with a minimum spend is not offered below it, and is offered at or above it", async () => {
  const shop = "pm1.myshopify.com";
  catalogSummaryCaches.set(shop, { at: Date.now(), summary: { currency: "USD" } });
  mock(discount(MIN));
  const low = await getPrepaidDiscountOffer(shop, 15);
  assert.equal(low.hasDiscount, false);
  assert.equal(low.source, "minimum_not_met");
  assert.equal(low.minimumSubtotal, 20000);
  discountCaches.delete(shop);
  mock(discount(MIN));
  const high = await getPrepaidDiscountOffer(shop, 25000);
  assert.equal(high.hasDiscount, true);
  assert.equal(high.discountAmount, 12500);
});

test("a prepaid discount without a minimum is offered on any total", async () => {
  const shop = "pm2.myshopify.com";
  catalogSummaryCaches.set(shop, { at: Date.now(), summary: { currency: "USD" } });
  mock(discount(null));
  const r = await getPrepaidDiscountOffer(shop, 15);
  assert.equal(r.hasDiscount, true);
  assert.equal(r.discountAmount, 7.5);
});
