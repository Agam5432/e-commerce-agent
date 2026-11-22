// Data isolation: a shopper can never act as another customer, reach another store, change prices
// or fees, discover private discount codes, or read the merchant's admin data.
import test from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import ecommerce from "../src/industries/ecommerce.js";
import { runAgent, __setLLMClientsForTest } from "../src/agent/agent.js";
import { sanitizeBrowserCheckout } from "../src/services/browserCheckout.js";
import { resolveClientId } from "../src/services/customerContext.js";
import { discountCodeIsPublic, visibleStockCount } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= Buffer.alloc(32, 3).toString("base64");

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function withServer(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const originalExists = StoreIntegration.exists;
  const originalFind = StoreIntegration.findOne;
  Object.assign(process.env, env);
  StoreIntegration.exists = async (q) => (["a.myshopify.com", "b.myshopify.com"].includes(q?.storeDomain) ? { _id: "1" } : null);
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null, then: (r) => r(null) });
  const { app } = await import("../server.js");
  const srv = await listen(app);
  try {
    await fn(srv.url);
  } finally {
    await srv.close();
    StoreIntegration.exists = originalExists;
    StoreIntegration.findOne = originalFind;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const postJson = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- identity comes only from Shopify

test("there is no way in except the signed Shopify App Proxy: the old direct chat and token routes are gone", async () => {
  for (const env of [{ ENABLE_DEV_ROUTES: "1", NODE_ENV: "development" }, { ENABLE_DEV_ROUTES: "", NODE_ENV: "production" }]) {
    await withServer(env, async (url) => {
      for (const path of ["/api/shopify-chat", "/api/voice/token", "/api/voice/dev-token", "/api/voice"]) {
        assert.equal((await postJson(`${url}${path}`, { storeDomain: "a.myshopify.com", shop: "a.myshopify.com", message: "hi" })).status, 404, path);
      }
      assert.equal((await postJson(`${url}/proxy/chat`, { message: "hi" })).status, 401); // unsigned
    });
  }
});

test("client ids must be long random values; short or guessable ones are replaced", () => {
  assert.equal(resolveClientId({ clientId: "c_0f3a9b2c7d1e4f5a6b7c8d9e" }), "c_0f3a9b2c7d1e4f5a6b7c8d9e");
  for (const weak of ["1", "c_1730000000000", "victim", "../../etc", "anon"]) {
    assert.notEqual(resolveClientId({ clientId: weak }), weak);
  }
});

// ---------------------------------------------------------------- the browser cannot set prices/fees

test("the browser's checkout copy keeps the shopper's entries and drops money and identity fields", () => {
  const forged = sanitizeBrowserCheckout({
    shipping: { name: "Me", address1: "1 Road", city: "Delhi", zip: "110001", country: "India", evil: { $ne: 1 } },
    billingSameAsShipping: true,
    step: "ready",
    selectedPaymentMethod: "cod",
    shippingRate: { handle: "free", title: "Express", price: 0 },
    shippingRates: [{ handle: "free", price: 0 }],
    shippingRatesKey: "x",
    shippingCost: 0,
    appliedDiscount: { code: "STAFF100", amount: 9999 },
    orderQuote: { status: "preview", total: 1 },
    lastOrderResult: { orderName: "#1001" },
    checkoutAttemptId: "someone-elses",
    customer: { id: "gid://shopify/Customer/1" },
    loggedIn: true,
    loginMethod: "shopify_customer",
  });
  assert.deepEqual(Object.keys(forged).sort(), ["billingSameAsShipping", "selectedPaymentMethod", "shipping", "step"]);
  assert.equal(forged.shipping.evil, undefined);
  assert.equal(sanitizeBrowserCheckout("x"), null);
});

test("a forged free shipping rate in the browser state never reaches the Shopify order", async () => {
  const original = { create: ecommerce.createSession, summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  const stored = { step: "ready", selectedPaymentMethod: "cod", billingSameAsShipping: true, billingConfirmed: true,
    shipping: { name: "Test Buyer", email: "buyer@example.com", address1: "10 Main Road", city: "Delhi", country: "India", countryCode: "IN", zip: "110001", phone: "+919876543210" } };
  const submitted = [];
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => structuredClone(stored) });
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD" });
    ecommerce.createSession = (shop, context) => original.create(shop, context, {
      loadCheckout: async () => structuredClone(stored),
      saveCheckout: async (s, c, patch) => { Object.assign(stored, structuredClone(patch)); },
      prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
      shippingRates: async () => [{ handle: "exp", title: "Express", price: 15, currency: "USD" }],
      quoteOrder: async () => { throw new Error("offline"); },
      submitOrder: async (s, options) => { submitted.push(options); return { shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/7", orderName: "#1007", total: 22.99, currency: "USD", discountAmount: 0 }; },
    });
    const gemini = { models: { generateContent: async (req) => ({ candidates: [{ content: { role: "model", parts: req.config?.toolConfig?.functionCallingConfig?.mode === "AUTO" && !JSON.stringify(req.contents).includes("functionResponse")
      ? [{ functionCall: { name: "place_order", args: { paymentMethod: "cod", customerConfirmed: true } } }]
      : [{ text: "Order #1007 placed, total $22.99." }] } }] }) } };
    __setLLMClientsForTest({ gemini });
    await runAgent("haan place karo", "test.myshopify.com", [], "ecommerce", {
      clientId: `iso-${crypto.randomUUID()}`,
      cart: { currency: "USD", items: [{ variant_id: "123", title: "Tee", price: 799, quantity: 1 }] },
      checkout: { ...stored, shippingRate: { handle: "free", title: "Express", price: 0, currency: "USD" }, shippingRates: [{ handle: "free", title: "Express", price: 0 }], appliedDiscount: { code: "STAFF100" } },
    });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].shippingRate?.handle, "exp");
    assert.equal(submitted[0].shippingRate?.price, 15);
    assert.ok(!submitted[0].appliedDiscount?.code, "a discount from the browser state is never applied");
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.createSession = original.create;
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find;
    StoreIntegration.findOne = original.integration;
    globalThis.fetch = original.fetch;
  }
});

// ---------------------------------------------------------------- merchant (admin) data stays private

test("only public discount codes may be mentioned (every buyer, unlimited uses)", () => {
  const publicCode = { context: { __typename: "DiscountBuyerSelectionAll" }, usageLimit: null };
  assert.equal(discountCodeIsPublic(publicCode), true);
  assert.equal(discountCodeIsPublic({ context: { __typename: "DiscountCustomers" }, usageLimit: null }), false);
  assert.equal(discountCodeIsPublic({ context: { __typename: "DiscountCustomerSegments" }, usageLimit: null }), false);
  assert.equal(discountCodeIsPublic({ context: { __typename: "DiscountBuyerSelectionAll" }, usageLimit: 1 }), false);
  assert.equal(discountCodeIsPublic({}), false); // unknown eligibility: fail closed
  assert.equal(discountCodeIsPublic(publicCode, "none"), false);
  assert.equal(discountCodeIsPublic({}, "all"), true);
});

test("a private discount cannot be found by guessing its name; an exact code still works", async () => {
  const discounts = [
    { id: "1", shareable: false, title: "Staff discount", code: "STAFF50", summary: "50% off", type: "percentage", percentage: 50, isAutomatic: false },
    { id: "2", shareable: true, title: "Diwali sale", code: "DIWALI10", summary: "10% off", type: "percentage", percentage: 10, isAutomatic: false },
  ];
  const make = () => ecommerce.createSession("x.myshopify.com", { llmMode: true, clientId: `d-${crypto.randomUUID()}`, userMessage: "", replyLanguage: "en",
    cart: { currency: "USD", total_price: 10000, items: [{ variant_id: "1", title: "Tee", price: 10000, quantity: 1 }] } }, {
    loadCheckout: async () => ({}), saveCheckout: async () => {}, loadDiscounts: async () => discounts,
    prepaidOffer: async () => ({ hasDiscount: false }),
  });
  const guess = await make().handlers.apply_discount_or_offer({ offerTitle: "staff" });
  assert.doesNotMatch(JSON.stringify(guess), /STAFF50/);
  const partial = await make().handlers.apply_discount_or_offer({ offerTitle: "STAFF" });
  assert.doesNotMatch(JSON.stringify(partial), /STAFF50/);
  const exact = await make().handlers.apply_discount_or_offer({ discountCode: "STAFF50" });
  assert.match(JSON.stringify(exact), /STAFF50/);
});

test("exact stock counts leave the server only when stock is low", () => {
  assert.equal(visibleStockCount(3), 3);
  assert.equal(visibleStockCount(5), 5);
  assert.equal(visibleStockCount(347), null);
  assert.equal(visibleStockCount(0), null);
});

test("unpublished product titles are not put in the AI's context unless the merchant allows it", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/tools/shopify/catalog.js", import.meta.url), "utf8"));
  assert.match(src, /unpublishedTitles: process\.env\.SHARE_UNPUBLISHED_TITLES === "1"/);
});

test("store address: only local-pickup locations are shared, never warehouses or the billing address", async () => {
  const { getStoreInfo } = await import("../src/tools/shopifyService.js");
  const { encryptToken } = await import("../src/utils/tokenEncryption.js");
  const originalFind = StoreIntegration.findOne;
  const originalFetch = globalThis.fetch;
  const queries = [];
  StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
  globalThis.fetch = async (url, options) => {
    const { query } = JSON.parse(options.body);
    queries.push(query);
    return { ok: true, status: 200, json: async () => ({ data: {
      shop: { name: "Desi Threads", currencyCode: "INR", billingAddress: { formatted: ["Owner's home, Meerut"] } },
      locations: { edges: [
        { node: { name: "Shop", isActive: true, localPickupSettingsV2: { pickupTime: "ONE_HOUR" }, address: { formatted: ["MG Road", "Delhi"], phone: "+911100000000" } } },
        { node: { name: "Warehouse", isActive: true, localPickupSettingsV2: null, address: { formatted: ["Godown 7", "Noida"], phone: null } } },
      ] },
    } }) };
  };
  try {
    const info = await getStoreInfo(`addr-${Date.now()}.myshopify.com`);
    assert.deepEqual(info.locations.map((l) => l.name), ["Shop"]);
    assert.doesNotMatch(JSON.stringify(info), /Godown|Owner's home/);
    assert.ok(queries.every((q) => !/billingAddress/.test(q)));
  } finally {
    StoreIntegration.findOne = originalFind;
    globalThis.fetch = originalFetch;
  }
});
