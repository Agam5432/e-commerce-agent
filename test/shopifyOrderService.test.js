import test from "node:test";
import assert from "node:assert/strict";
import { createOrderService, normalizeOrderItems, checkoutRequestTag } from "../src/services/shopifyOrderService.js";
import { ShopifyRequestError } from "../src/services/shopifyAdminService.js";
import { normalizeAddressForShopify } from "../src/services/shopifyAddress.js";

const address = { name: "Test Buyer", address1: "10 Main Street", city: "Delhi", province: "Delhi", country: "India", zip: "110001", phone: "9876543210" };
const input = () => ({ items: [{ variant_id: "123", quantity: 1, price: 799 }], shipping: address, email: "buyer@example.com", paymentMethod: "cod", shippingMethod: "standard", finalTotal: 7.99, currency: "USD", clientId: "browser-123" });
function draft(overrides = {}) {
  return { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://test.myshopify.com/invoice/abc", totalPrice: "7.99", totalTax: "0.00", subtotalPrice: "7.99", totalShippingPrice: "0.00", totalDiscountsSet: { shopMoney: { amount: "0.00" } }, currencyCode: "USD", status: "OPEN", order: null, ...overrides };
}
function memory(requestId = "request-1") {
  const rows = new Map();
  return {
    rows,
    async claim(shop, key) {
      const existing = rows.get(key);
      if (existing) {
        if (existing.status === "failed") { existing.status = "processing"; return { owned: true, record: { ...existing } }; }
        return { owned: false, record: { ...existing } };
      }
      const record = { shop, key, requestId, status: "processing", updatedAt: new Date() };
      rows.set(key, record); return { owned: true, record: { ...record } };
    },
    async save(shop, key, patch) { Object.assign(rows.get(key), patch, { updatedAt: new Date() }); },
    async claimReview(shop, key) { if (rows.get(key).status !== "review") return false; rows.get(key).status = "processing"; return true; },
  };
}
function setup({ quote = draft(), failures = {}, existingCustomer = true, variantOverrides = {}, loseCompleteResponse = false, missingDraftOnLookup = false, requestId } = {}) {
  const calls = [];
  const submissions = memory(requestId);
  let current = quote;
  const graphql = async (shop, query, variables) => {
    const name = query.match(/(?:query|mutation)\s+(\w+)/)[1];
    calls.push({ name, variables });
    if (failures[name]) throw failures[name];
    if (name === "CheckoutVariants") return { shop: { currencyCode: "USD" }, nodes: [{ id: "gid://shopify/ProductVariant/123", price: "7.99", inventoryQuantity: 10, inventoryPolicy: "DENY", inventoryItem: { tracked: true }, product: { status: "ACTIVE", publishedAt: "2026-01-01" }, ...variantOverrides }] };
    if (name === "CheckoutAccess") return { orders: { nodes: [] } };
    if (name === "OrderCustomer") return { customers: { nodes: existingCustomer ? [{ id: "gid://shopify/Customer/5", email: "buyer@example.com" }] : [] } };
    if (name === "OrderCustomerCreate") return { customerCreate: { customer: { id: "gid://shopify/Customer/6" }, userErrors: [] } };
    if (name === "AgentDraftCreate") return { draftOrderCreate: { draftOrder: current, userErrors: [] } };
    if (name === "AgentDraftComplete") {
      current = { ...current, status: "COMPLETED", order: { id: "gid://shopify/Order/42", name: "#1042", displayFinancialStatus: "PENDING", customer: { id: "gid://shopify/Customer/5" }, totalPriceSet: { shopMoney: { amount: current.totalPrice, currencyCode: "USD" } } } };
      if (loseCompleteResponse) throw new ShopifyRequestError("lost completion response", { uncertain: true });
      return { draftOrderComplete: { draftOrder: current, userErrors: [] } };
    }
    if (name === "AgentDraftById") return { draftOrder: current };
    if (name === "AgentDraftLookup") return { draftOrders: { nodes: missingDraftOnLookup ? [] : [current] } };
    throw new Error(`Unexpected operation: ${name}`);
  };
  return { calls, submissions, run: createOrderService({ graphql, submissions }) };
}

test("COD creates a real pending order linked to the customer's existing account", async () => {
  const { run, calls } = setup();
  const result = await run("test.myshopify.com", input());
  assert.equal(result.orderName, "#1042");
  assert.equal(result.shopifyOrderCreated, true);
  assert.equal(result.financialStatus, "PENDING");
  const payload = calls.find(c => c.name === "AgentDraftCreate").variables.input;
  assert.equal(payload.purchasingEntity.customerId, "gid://shopify/Customer/5");
  assert.deepEqual(payload.lineItems, [{ variantId: "gid://shopify/ProductVariant/123", quantity: 1 }]);
  assert.equal(payload.shippingAddress.phone, "+919876543210");
});
test("guest checkout creates a Shopify customer when the email is new", async () => {
  const { run, calls } = setup({ existingCustomer: false });
  await run("test.myshopify.com", input());
  assert.equal(calls.find(c => c.name === "AgentDraftCreate").variables.input.purchasingEntity.customerId, "gid://shopify/Customer/6");
});
test("signed storefront customer ID is preserved even with a different contact email", async () => {
  const { run, calls } = setup();
  await run("test.myshopify.com", { ...input(), customerId: "gid://shopify/Customer/99" });
  assert.equal(calls.some(c => c.name === "OrderCustomer"), false);
  assert.equal(calls.find(c => c.name === "AgentDraftCreate").variables.input.purchasingEntity.customerId, "gid://shopify/Customer/99");
});
test("online payment returns a hosted invoice and never creates a paid order", async () => {
  const { run, calls } = setup();
  const result = await run("test.myshopify.com", { ...input(), paymentMethod: "prepaid" });
  assert.equal(result.status, "payment_required");
  assert.match(result.checkoutUrl, /^https:/);
  assert.equal(result.shopifyOrderCreated, false);
  assert.equal(calls.some(c => c.name === "AgentDraftComplete"), false);
});
test("repeated confirmations return the same Shopify order without submitting twice", async () => {
  const { run, calls } = setup();
  const first = await run("test.myshopify.com", input());
  const second = await run("test.myshopify.com", input());
  assert.equal(first.shopifyOrderId, second.shopifyOrderId);
  assert.equal(second.replayed, true);
  assert.equal(calls.filter(c => c.name === "AgentDraftCreate").length, 1);
  assert.equal(calls.filter(c => c.name === "AgentDraftComplete").length, 1);
});
test("changed tax/discount total requires explicit acceptance before creating an order", async () => {
  const { run, calls } = setup({ quote: draft({ totalPrice: "8.79", totalTax: "0.80" }) });
  const review = await run("test.myshopify.com", input());
  assert.equal(review.status, "review_required");
  assert.equal(calls.some(c => c.name === "AgentDraftComplete"), false);
  const repeated = await run("test.myshopify.com", input());
  assert.equal(repeated.status, "review_required");
  const accepted = await run("test.myshopify.com", { ...input(), acceptedQuoteKey: review.quoteKey });
  assert.equal(accepted.total, 8.79);
  assert.equal(calls.filter(c => c.name === "AgentDraftCreate").length, 1);
});
test("timeout after draft creation is reconciled rather than creating a second draft", async () => {
  const { run, calls } = setup({ failures: { AgentDraftCreate: new ShopifyRequestError("timeout", { uncertain: true }) } });
  await assert.rejects(run("test.myshopify.com", input()), /timeout/);
  const recovered = await run("test.myshopify.com", input());
  assert.equal(recovered.shopifyOrderCreated, true);
  assert.equal(calls.filter(c => c.name === "AgentDraftCreate").length, 1);
});
test("Shopify permissions are checked before any customer or draft mutation", async () => {
  const { run, calls } = setup({ failures: { CheckoutAccess: new ShopifyRequestError("Protected customer data access required") } });
  await assert.rejects(run("test.myshopify.com", input()), /Protected/);
  assert.equal(calls.some(c => ["AgentDraftCreate", "OrderCustomerCreate", "AgentDraftComplete"].includes(c.name)), false);
});
test("stale prices and insufficient inventory prevent draft/order creation", async () => {
  for (const variantOverrides of [{ price: "8.99" }, { inventoryQuantity: 0 }]) {
    const { run, calls } = setup({ variantOverrides });
    await assert.rejects(run("test.myshopify.com", input()), /changed|stock/);
    assert.equal(calls.some(c => c.name === "AgentDraftCreate"), false);
  }
});
test("concurrent requests claim only one checkout submission", async () => {
  const { run, calls } = setup();
  const results = await Promise.all([run("test.myshopify.com", input()), run("test.myshopify.com", input())]);
  assert.equal(results.filter(r => r.status === "ok").length, 1);
  assert.equal(results.filter(r => r.status === "processing").length, 1);
  assert.equal(calls.filter(c => c.name === "AgentDraftCreate").length, 1);
});
test("a lost order completion response recovers the existing order without resubmitting", async () => {
  const { run, calls } = setup({ loseCompleteResponse: true });
  await assert.rejects(run("test.myshopify.com", input()), /lost completion/);
  const recovered = await run("test.myshopify.com", input());
  assert.equal(recovered.orderName, "#1042");
  assert.equal(recovered.replayed, true);
  assert.equal(calls.filter(c => c.name === "AgentDraftComplete").length, 1);
});
test("an unresolved timeout never falls back to another create operation", async () => {
  const { run, calls } = setup({ failures: { AgentDraftCreate: new ShopifyRequestError("timeout", { uncertain: true }) }, missingDraftOnLookup: true });
  await assert.rejects(run("test.myshopify.com", input()), /timeout/);
  assert.equal((await run("test.myshopify.com", input())).status, "unknown");
  assert.equal(calls.filter(c => c.name === "AgentDraftCreate").length, 1);
});
test("unrecognized, custom, fractional and excessive cart lines are rejected", () => {
  for (const item of [{ id: "bad", price: 799, quantity: 1 }, { variant_id: "123", price: 799, quantity: 1.5 }, { variant_id: "123", price: 799, quantity: 51 }]) {
    assert.throws(() => normalizeOrderItems([item]));
  }
  assert.equal(normalizeOrderItems([{ variant_id: "9007199254740993", price: 799, quantity: 1 }])[0].id, "gid://shopify/ProductVariant/9007199254740993");
  assert.equal(normalizeOrderItems([{ variant_id: "123", price: 799, quantity: 1 }])[0].price, 799);
});
test("explicit country is never overwritten based on a conflicting postal code", () => {
  assert.equal(normalizeAddressForShopify({ ...address, country: "United States", province: "CA", zip: "110001" }).countryCode, "US");
  assert.equal(normalizeAddressForShopify({}).address1, "");
  assert.equal(normalizeAddressForShopify({ ...address, country: "Canada", province: "ON", zip: "M5V 1A1" }).countryCode, "CA");
});


test("UUID tracking tags fit Shopify's 40-character limit and reconcile the original draft after a timeout", async () => {
  const requestId = "9b9954d6-20df-4c7a-b3e2-7c19b74689f3";
  const failures = { AgentDraftCreate: new ShopifyRequestError("lost draft response", { uncertain: true }) };
  const { run, calls } = setup({ requestId, failures });
  await assert.rejects(run("test.myshopify.com", input()), /lost draft response/);
  const tags = calls.find(call => call.name === "AgentDraftCreate").variables.input.tags;
  assert.ok(tags.every(tag => tag.length <= 40));
  assert.ok(tags.includes(checkoutRequestTag(requestId)));
  assert.notEqual(checkoutRequestTag(requestId), checkoutRequestTag(crypto.randomUUID()));
  delete failures.AgentDraftCreate;
  const recovered = await run("test.myshopify.com", input());
  const lookup = calls.find(call => call.name === "AgentDraftLookup").variables.query;
  assert.ok(lookup.includes(`tag:${checkoutRequestTag(requestId)}`));
  assert.ok(lookup.includes(`tag:orbi-request-${requestId}`));
  assert.equal(recovered.shopifyOrderCreated, true);
  assert.equal(calls.filter(call => call.name === "AgentDraftCreate").length, 1);
});
test("the draft order carries the chat reference so the dashboard can attribute the order", async () => {
  const { run, calls } = setup();
  await run("test.myshopify.com", { ...input(), chatRef: "AbCdEf123456_-xyz0123" });
  const payload = calls.find(c => c.name === "AgentDraftCreate").variables.input;
  assert.deepEqual(payload.customAttributes, [{ key: "ai_chat_ref", value: "AbCdEf123456_-xyz0123" }]);
  assert.ok(payload.tags.includes("Orbi-AI-Order"));
});
test("without a chat reference the draft order has no attribute", async () => {
  const { run, calls } = setup();
  await run("test.myshopify.com", input());
  assert.equal(calls.find(c => c.name === "AgentDraftCreate").variables.input.customAttributes, undefined);
});

// ---- online payment follow-up (mocked Shopify responses only: no real store was contacted) ------------------
const variantReplies = async (shop, query) => {
  const name = query.match(/(?:query|mutation)\s+(\w+)/)[1];
  if (name === "CheckoutVariants") return { shop: { currencyCode: "USD" }, nodes: [{ id: "gid://shopify/ProductVariant/123", price: "7.99", inventoryQuantity: 10, inventoryPolicy: "DENY", inventoryItem: { tracked: true }, product: { status: "ACTIVE", publishedAt: "2026-01-01" } }] };
  if (name === "CheckoutAccess") return { orders: { nodes: [] } };
  if (name === "AgentOrderByTag") return { orders: { nodes: orderByTag } };
  if (name === "OrderCustomer") return { customers: { nodes: [{ id: "gid://shopify/Customer/5", email: "buyer@example.com" }] } };
  throw new Error(`Unexpected operation: ${name}`);
};
let orderByTag = [];
function prepaidSetup() {
  const calls = [];
  const submissions = memory();
  let remote = draft();
  const graphql = async (shop, query, variables) => {
    const name = query.match(/(?:query|mutation)\s+(\w+)/)[1];
    calls.push(name);
    if (name === "AgentDraftById") return { draftOrder: remote };
    if (name === "AgentDraftCreate") return { draftOrderCreate: { draftOrder: draft({ id: "gid://shopify/DraftOrder/2", invoiceUrl: "https://test.myshopify.com/invoice/new" }), userErrors: [] } };
    return variantReplies(shop, query);
  };
  const first = createOrderService({ graphql: async (s, q, v) => (/AgentDraftCreate/.test(q) ? { draftOrderCreate: { draftOrder: remote, userErrors: [] } } : graphql(s, q, v)), submissions });
  return { calls, submissions, setRemote: (value) => { remote = value; }, first, run: createOrderService({ graphql, submissions }) };
}
const prepaid = () => ({ ...input(), paymentMethod: "prepaid" });

test("after the shopper pays the invoice, repeating the request returns the real Shopify order (never before)", async () => {
  const t = prepaidSetup();
  assert.equal((await t.first("test.myshopify.com", prepaid())).status, "payment_required");
  // not paid yet: the same payment link comes back and no order is claimed
  const again = await t.run("test.myshopify.com", prepaid());
  assert.equal(again.status, "payment_required");
  assert.equal(again.shopifyOrderCreated, false);
  t.setRemote(draft({ status: "COMPLETED", order: { id: "gid://shopify/Order/77", name: "#1077", displayFinancialStatus: "PAID", customer: { id: "gid://shopify/Customer/5" }, totalPriceSet: { shopMoney: { amount: "7.99", currencyCode: "USD" } } } }));
  const paid = await t.run("test.myshopify.com", prepaid());
  assert.equal(paid.shopifyOrderCreated, true);
  assert.equal(paid.orderName, "#1077");
  assert.equal(paid.financialStatus, "PAID");
});

test("a payment draft the merchant deleted in Shopify gets a fresh payment link, not the dead one", async () => {
  const t = prepaidSetup();
  await t.first("test.myshopify.com", prepaid());
  t.setRemote(null);
  const result = await t.run("test.myshopify.com", prepaid());
  assert.equal(result.status, "payment_required");
  assert.equal(result.checkoutUrl, "https://test.myshopify.com/invoice/new");
  assert.equal(t.calls.filter((c) => c === "AgentDraftCreate").length, 1);
});

// ---- the Shopify HTTP client: real database and token lookup, only Shopify's HTTP answers are scripted ---------
import crypto from "node:crypto";
import { startTempMongo } from "./helpers/tempMongo.js";

test("adminGraphql: each store uses its own token, throttled reads and writes are asked again, an unconfirmed write never is", async (t) => {
  const mongo = await startTempMongo();
  if (!mongo.available) return t.skip("no mongod on this machine (set MONGOD_PATH to run this)");
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  const { encryptToken } = await import("../src/utils/tokenEncryption.js");
  const { default: StoreIntegration } = await import("../src/models/StoreIntegration.js");
  const { adminGraphql } = await import("../src/services/shopifyAdminService.js");
  await StoreIntegration.init();
  for (const [domain, token] of [["alpha.myshopify.com", "shpat_alpha"], ["beta.myshopify.com", "shpat_beta"]]) {
    await StoreIntegration.create({ storeDomain: domain, status: "active", accessTokenEncrypted: encryptToken(token) });
  }
  const realFetch = globalThis.fetch;
  const seen = [];
  let script = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), token: init.headers["X-Shopify-Access-Token"] });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status < 400, headers: { get: () => null }, json: async () => next.body };
  };
  try {
    // 1. store isolation: the request for a store carries that store's own token and domain
    script = [{ status: 200, body: { data: { a: 1 } } }, { status: 200, body: { data: { b: 2 } } }];
    await adminGraphql("alpha.myshopify.com", "query Q { shop { name } }");
    await adminGraphql("beta.myshopify.com", "query Q { shop { name } }");
    assert.deepEqual(seen.map((s) => [new URL(s.url).host, s.token]), [["alpha.myshopify.com", "shpat_alpha"], ["beta.myshopify.com", "shpat_beta"]]);
    assert.match(seen[0].url, /\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
    await assert.rejects(adminGraphql("evil.example.com", "query Q { shop { name } }"), /Invalid shop domain/);

    // 2. a throttled read, and a 503 on a read, are asked again
    seen.length = 0;
    script = [{ status: 200, body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }, { status: 503, body: {} }, { status: 200, body: { data: { ok: true } } }];
    assert.deepEqual(await adminGraphql("alpha.myshopify.com", "query Q { shop { name } }"), { ok: true });
    assert.equal(seen.length, 3);

    // 3. a throttled WRITE did not run, so asking again is safe
    seen.length = 0;
    script = [{ status: 429, body: {} }, { status: 200, body: { data: { done: true } } }];
    assert.deepEqual(await adminGraphql("alpha.myshopify.com", "mutation M { x }"), { done: true });
    assert.equal(seen.length, 2);

    // 4. a write that may have run (5xx, or a timeout) is NEVER repeated and is reported as unconfirmed
    seen.length = 0;
    script = [{ status: 502, body: {} }];
    await assert.rejects(adminGraphql("alpha.myshopify.com", "mutation M { x }"), (e) => e.uncertain === true);
    assert.equal(seen.length, 1);
    seen.length = 0;
    script = [new Error("timeout")];
    await assert.rejects(adminGraphql("alpha.myshopify.com", "mutation M { x }"), (e) => e.uncertain === true);
    assert.equal(seen.length, 1);

    // 5. a read that keeps failing gives up after three tries with a plain error
    seen.length = 0;
    script = [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }];
    await assert.rejects(adminGraphql("alpha.myshopify.com", "query Q { shop { name } }"), (e) => e.uncertain === false);
    assert.equal(seen.length, 3);
  } finally {
    globalThis.fetch = realFetch;
    await mongo.stop();
  }
});

import { checkoutFailureReason } from "../src/services/checkoutMessages.js";
test("every refusal the order service can raise is explained to the shopper with the right reason", async () => {
  const reasonOf = async (opts, overrides = {}) => {
    const { run } = setup(overrides);
    try { await run("test.myshopify.com", opts); } catch (error) { return checkoutFailureReason(error); }
    return "no error";
  };
  assert.equal(await reasonOf({ ...input(), currency: "INR" }), "cart_prices_changed"); // cart in another currency, no country known
  assert.equal(await reasonOf({ ...input(), items: [{ variant_id: "123", quantity: 1, price: 100 }] }), "cart_prices_changed"); // price moved since the search
  assert.equal(await reasonOf({ ...input(), items: [{ variant_id: "123", quantity: 51, price: 799 }] }), "cart_needs_changes");
  assert.equal(await reasonOf({ ...input(), items: [] }), "cart_needs_changes"); // empty cart
  assert.equal(await reasonOf(input(), { variantOverrides: { inventoryQuantity: 0 } }), "item_unavailable"); // sold out meanwhile
  assert.equal(await reasonOf(input(), { variantOverrides: { product: { status: "ARCHIVED", publishedAt: null } } }), "item_unavailable"); // deleted/unpublished
  assert.equal(await reasonOf({ ...input(), email: "nope" }), "checkout_details_missing");
});

test("a payment draft that cannot be read but whose order exists returns that order, never a second payment link", async () => {
  const t = prepaidSetup();
  await t.first("test.myshopify.com", prepaid());
  t.setRemote(null);
  orderByTag = [{ id: "gid://shopify/Order/88", name: "#1088", displayFinancialStatus: "PAID", customer: { id: "gid://shopify/Customer/5" }, totalPriceSet: { shopMoney: { amount: "7.99", currencyCode: "USD" } }, subtotalPriceSet: { shopMoney: { amount: "7.99" } }, totalTaxSet: { shopMoney: { amount: "0.00" } } }];
  try {
    const result = await t.run("test.myshopify.com", prepaid());
    assert.equal(result.orderName, "#1088");
    assert.equal(result.shopifyOrderCreated, true);
    assert.equal(t.calls.filter((c) => c === "AgentDraftCreate").length, 0, "no new draft was created on the retry");
  } finally { orderByTag = []; }
});

import { assertDiscountCurrency } from "../src/services/shopifyOrderService.js";
test("a fixed discount amount is never applied to a cart in another currency; percentages and same-currency amounts are", () => {
  const fixed = { valueType: "FIXED_AMOUNT", value: 10 };
  assert.throws(() => assertDiscountCurrency(fixed, "INR", "USD"), (e) => checkoutFailureReason(e) === "cart_prices_changed");
  assert.doesNotThrow(() => assertDiscountCurrency(fixed, "usd", "USD"));
  assert.doesNotThrow(() => assertDiscountCurrency({ valueType: "PERCENTAGE", value: 10 }, "INR", "USD"));
  assert.doesNotThrow(() => assertDiscountCurrency(null, "INR", "USD"));
  assert.doesNotThrow(() => assertDiscountCurrency(fixed, "", "USD")); // unknown cart currency: nothing to compare, the order path refuses it elsewhere
});
