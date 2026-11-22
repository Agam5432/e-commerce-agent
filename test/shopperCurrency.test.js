import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts, withShopperPricing, compactProduct } from "../src/tools/shopifyService.js";
import { createOrderService, createOrderQuoteService, presentmentInput } from "../src/services/shopifyOrderService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const VARIANT = "gid://shopify/ProductVariant/501";
const catalogNode = { id: "gid://shopify/Product/5", title: "Smart TV 55", handle: "smart-tv", description: "4K TV", productType: "Electronics", tags: [], status: "ACTIVE", publishedAt: "2026-01-01T00:00:00Z", featuredImage: null, priceRangeV2: { minVariantPrice: { amount: "500.00", currencyCode: "USD" } }, variants: { edges: [{ node: { id: VARIANT, title: "Default Title", selectedOptions: [], price: "500.00", inventoryQuantity: 4, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] } };
let priceQueries = 0;
globalThis.fetch = async (url, options) => {
  const { query, variables } = JSON.parse(options.body);
  if (/ShopperPrices/.test(query)) {
    priceQueries++;
    assert.equal(variables.country, "DE");
    return { ok: true, status: 200, json: async () => ({ data: { nodes: [{ id: VARIANT, contextualPricing: { price: { amount: "459.00", currencyCode: "EUR" }, compareAtPrice: null } }] } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node: catalogNode }] } } }) };
};

test("products are shown in the shopper's currency using Shopify's own price for their country", async () => {
  const eu = await withShopperPricing({ country: "de", currency: "eur" }, () => searchShopifyProducts("fx.myshopify.com", "smart tv"));
  assert.equal(eu[0].currency, "EUR");
  assert.equal(eu[0].price, "459");
  assert.equal(eu[0].variants[0].price, "459.00");
  assert.match(compactProduct(eu[0]).formattedPrice, /459/);
  assert.match(compactProduct(eu[0]).formattedPrice, /€/);
  await withShopperPricing({ country: "DE", currency: "EUR" }, () => searchShopifyProducts("fx.myshopify.com", "smart tv"));
  assert.equal(priceQueries, 1, "contextual prices are cached");
  // no shopper context, or the store's own currency: untouched base price and label
  const base = await searchShopifyProducts("fx.myshopify.com", "smart tv");
  assert.equal(base[0].currency, "USD"); assert.equal(base[0].price, "500.00");
  const same = await withShopperPricing({ country: "US", currency: "USD" }, () => searchShopifyProducts("fx.myshopify.com", "smart tv"));
  assert.equal(same[0].currency, "USD");
});

test("when Shopify cannot price the shopper's market, the base price keeps its base currency label", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const { query } = JSON.parse(options.body);
    if (/ShopperPrices/.test(query)) return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
    return saved(url, options);
  };
  try {
    const out = await withShopperPricing({ country: "FR", currency: "EUR" }, () => searchShopifyProducts("fx.myshopify.com", "smart tv"));
    assert.equal(out[0].currency, "USD");
    assert.equal(out[0].price, "500.00");
  } finally { globalThis.fetch = saved; }
});

const items = [{ variant_id: "501", price: 45900, original_price: 45900, quantity: 1 }];
const address = { name: "Hans Mueller", address1: "Hauptstr 1", city: "Berlin", zip: "10115", country: "Germany", countryCode: "DE", email: "h@example.com", phone: "+4915112345678" };
function fakeGraphql(log, { shopCurrency = "USD", contextual = { amount: "459.00", currencyCode: "EUR" } } = {}) {
  return async (shop, query, vars) => {
    log.push({ query, vars });
    if (/CheckoutVariants/.test(query)) return { shop: { currencyCode: shopCurrency }, nodes: [{ id: "gid://shopify/ProductVariant/501", price: "500.00", inventoryQuantity: 5, inventoryPolicy: "DENY", inventoryItem: { tracked: true }, product: { status: "ACTIVE", publishedAt: "x" }, ...(vars.shopper ? { contextualPricing: { price: contextual } } : {}) }] };
    if (/CheckoutAccess/.test(query)) return { orders: { nodes: [] } };
    if (/OrderCustomer\b/.test(query)) return { customers: { nodes: [{ id: "gid://shopify/Customer/1", email: "h@example.com" }] } };
    if (/AgentDraftCreate/.test(query)) return { draftOrderCreate: { userErrors: [], draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://pay/1", taxesIncluded: false, currencyCode: "USD", taxLines: [],
      totalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "USD" }, presentmentMoney: { amount: "546.21", currencyCode: "EUR" } },
      subtotalPriceSet: { shopMoney: { amount: "500.00" }, presentmentMoney: { amount: "459.00", currencyCode: "EUR" } },
      totalTaxSet: { shopMoney: { amount: "95.00" }, presentmentMoney: { amount: "87.21", currencyCode: "EUR" } },
      totalShippingPriceSet: { shopMoney: { amount: "0" }, presentmentMoney: { amount: "0", currencyCode: "EUR" } } } } };
    if (/AgentDraftCalculate/.test(query)) return { draftOrderCalculate: { userErrors: [], calculatedDraftOrder: { currencyCode: "USD", taxesIncluded: false, taxLines: [],
      totalPriceSet: { shopMoney: { amount: "595.00", currencyCode: "USD" }, presentmentMoney: { amount: "546.21", currencyCode: "EUR" } },
      subtotalPriceSet: { shopMoney: { amount: "500.00" }, presentmentMoney: { amount: "459.00" } },
      totalTaxSet: { shopMoney: { amount: "95.00" }, presentmentMoney: { amount: "87.21" } },
      totalShippingPriceSet: { shopMoney: { amount: "0" }, presentmentMoney: { amount: "0" } } } } };
    throw new Error("unexpected query " + query.slice(0, 40));
  };
}
const memory = () => ({ claim: async () => ({ owned: true, record: { requestId: "r1", status: "processing" } }), save: async () => {}, claimReview: async () => true });

test("an EUR cart on a USD store is quoted and ordered in EUR for the shopper's market", async () => {
  const log = [];
  const quote = await createOrderQuoteService({ graphql: fakeGraphql(log) })("fx.myshopify.com", { items, shipping: address, billingSameAsShipping: true, email: "h@example.com", currency: "EUR", countryCode: "DE", shopCurrency: "USD", shippingMethod: "standard" });
  assert.equal(quote.currency, "EUR");
  assert.equal(quote.total, 546.21);
  assert.equal(quote.subtotal, 459);
  assert.equal(quote.tax, 87.21);
  const calc = log.find(l => /AgentDraftCalculate/.test(l.query));
  assert.equal(calc.vars.input.presentmentCurrencyCode, "EUR");
  assert.equal(calc.vars.input.marketRegionCountryCode, "DE");

  const log2 = [];
  const order = await createOrderService({ graphql: fakeGraphql(log2), submissions: memory() })("fx.myshopify.com", { items, shipping: address, billingSameAsShipping: true, email: "h@example.com", paymentMethod: "prepaid", clientId: "client-1", currency: "EUR", countryCode: "DE", shippingMethod: "standard" });
  assert.equal(order.status, "payment_required");
  assert.equal(order.currency, "EUR");
  assert.equal(order.total, 546.21);
  const create = log2.find(l => /AgentDraftCreate/.test(l.query));
  assert.equal(create.vars.input.presentmentCurrencyCode, "EUR");
  assert.equal(create.vars.input.marketRegionCountryCode, "DE");
});

test("currency guards: no country, a different price for the market, or a currency the market does not use are refused", async () => {
  const base = { items, shipping: address, billingSameAsShipping: true, email: "h@example.com", paymentMethod: "prepaid", clientId: "client-2", currency: "EUR", shippingMethod: "standard" };
  await assert.rejects(createOrderService({ graphql: fakeGraphql([]), submissions: memory() })("fx.myshopify.com", base), /different currency/);
  await assert.rejects(createOrderService({ graphql: fakeGraphql([], { contextual: { amount: "480.00", currencyCode: "EUR" } }), submissions: memory() })("fx.myshopify.com", { ...base, countryCode: "DE" }), /price has changed/);
  await assert.rejects(createOrderService({ graphql: fakeGraphql([], { contextual: { amount: "459.00", currencyCode: "GBP" } }), submissions: memory() })("fx.myshopify.com", { ...base, countryCode: "DE" }), /price has changed/);
});

test("single-currency stores are unchanged: no presentment fields are sent", () => {
  assert.deepEqual(presentmentInput({ currency: "USD", countryCode: "US" }, "USD"), { presentmentCurrencyCode: "USD" });
  // a store-currency cart delivered to another country stays in the store currency
  assert.deepEqual(presentmentInput({ currency: "USD", countryCode: "IN" }, "USD"), { presentmentCurrencyCode: "USD" });
  assert.deepEqual(presentmentInput({ currency: "EUR", countryCode: "DE" }, "USD"), { presentmentCurrencyCode: "EUR", marketRegionCountryCode: "DE" });
});

test("the store's price range stays in the store's currency; it is hidden from a market-priced shopper only when market pricing is on", async () => {
  const { default: ecommerce } = await import("../src/industries/ecommerce.js");
  const storeProfile = { storeName: "Shop", priceRange: { min: 9, max: 2500 } };
  // market pricing switched OFF (STORE_PRICES_FOLLOW_MARKET=0): every price is in the store's own currency, so a visitor whose cart is in rupees is not told otherwise
  process.env.STORE_PRICES_FOLLOW_MARKET = "0";
  const inr = ecommerce.buildSystemPrompt("x.myshopify.com", { storeCurrency: "USD", cart: { items: [], currency: "INR" }, storeProfile, profile: {} });
  assert.doesNotMatch(inr, /CUSTOMER'S CURRENCY/);
  assert.match(inr, /PRICE RANGE \(store's base currency\): 9 to 2500 USD/);
  const usd = ecommerce.buildSystemPrompt("x.myshopify.com", { storeCurrency: "USD", cart: { items: [], currency: "USD" }, storeProfile, profile: {} });
  assert.match(usd, /PRICE RANGE \(store's base currency\): 9 to 2500 USD/);
  // market pricing on: the shopper's currency rule is given and the base-currency range is withheld (9 USD must not become ₹9)
  process.env.STORE_PRICES_FOLLOW_MARKET = "1";
  try {
    const market = ecommerce.buildSystemPrompt("x.myshopify.com", { storeCurrency: "USD", cart: { items: [], currency: "INR" }, storeProfile, profile: {} });
    assert.doesNotMatch(market, /PRICE RANGE/, "9 USD must not become ₹9");
    assert.match(market, /CUSTOMER'S CURRENCY: INR/);
  } finally {
    delete process.env.STORE_PRICES_FOLLOW_MARKET;
  }
});

// ---- the currency sign is the store's own: found on the real TechStore (USD), where "$429" was once written as "₹429" ----------
import { dataCurrency, repairCurrencyMarks, findWrongCurrency, verifyReplyFacts } from "../src/agent/factGuard.js";
import { currencyMark, formatMoney } from "../src/utils/money.js";
import ecommerce from "../src/industries/ecommerce.js";

test("the currency sign comes from the currency code, for any store currency", () => {
  assert.equal(currencyMark("USD"), "$");
  assert.equal(currencyMark("INR"), "₹");
  assert.equal(currencyMark("EUR"), "€");
  assert.equal(currencyMark("GBP"), "£");
  assert.equal(currencyMark(""), "", "an unknown currency has no sign");
  assert.equal(formatMoney(429, "USD"), "$429.00");
  assert.equal(formatMoney(429, "INR"), "₹429");
  assert.equal(formatMoney(429, "EUR"), "€429.00");
  assert.equal(formatMoney(429.5, "GBP"), "£429.50");
  assert.equal(formatMoney(429, ""), "429.00", "no currency known: the number alone, never a guessed sign");
});

test("a reply that writes a USD store's amount with the rupee sign gets the store's sign back; the amount is untouched", () => {
  const tools = [{ products: [{ title: "Samsung Galaxy A55 5G", price: "429.00", currency: "USD" }] }];
  assert.equal(dataCurrency([tools]), "USD");
  const hindi = "हमारे पास ₹429.00 की कीमत में फ़ोन है। **Samsung Galaxy A55 5G** (₹429.00)";
  assert.equal(findWrongCurrency(hindi, "USD").length, 2);
  const fixed = repairCurrencyMarks(hindi, "USD");
  assert.equal(fixed.text, "हमारे पास $429.00 की कीमत में फ़ोन है। **Samsung Galaxy A55 5G** ($429.00)");
  assert.equal(findWrongCurrency(fixed.text, "USD").length, 0);
  assert.equal(repairCurrencyMarks("Price: 429 INR or Rs. 429 or €429", "USD").text, "Price: 429 USD or $429 or $429");
  assert.equal(repairCurrencyMarks("It costs $69.00", "USD").repaired.length, 0, "a right sign is left alone");
});

test("each store currency keeps its own sign (INR store: rupee, EUR store: euro, GBP store: pound)", () => {
  for (const [code, sign] of [["INR", "₹"], ["EUR", "€"], ["GBP", "£"], ["USD", "$"]]) {
    const wrong = code === "USD" ? "₹429" : "$429";
    assert.equal(repairCurrencyMarks(`only ${wrong} today`, code).text, `only ${sign}429 today`, code);
  }
});

test("nothing is guessed when the verified data names no currency or several", () => {
  assert.equal(dataCurrency([{ products: [{ price: "5" }] }]), "");
  assert.equal(dataCurrency([{ a: "USD" }, { b: "INR" }]), "");
  assert.deepEqual(repairCurrencyMarks("₹429", ""), { text: "₹429", repaired: [] });
  assert.equal(verifyReplyFacts("₹429", [{ price: "429", currency: "USD" }], { currency: "" }).wrongCurrency.length, 0);
});

test("the guard now rejects a wrong sign even when the number is right", () => {
  const sources = [{ products: [{ price: "429.00", currency: "USD" }] }];
  assert.equal(verifyReplyFacts("It is ₹429.00", sources, { currency: "USD" }).ok, false);
  assert.equal(verifyReplyFacts("It is $429.00", sources, { currency: "USD" }).ok, true);
});

test("the system prompt never claims a currency it does not know, and never shows a rupee example to a USD store", () => {
  process.env.STORE_PRICES_FOLLOW_MARKET = "0";
  try {
    systemPromptNeverClaimsUnknownCurrency();
  } finally {
    delete process.env.STORE_PRICES_FOLLOW_MARKET;
  }
});
function systemPromptNeverClaimsUnknownCurrency() {
  const usd = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {}, storeCurrency: "USD", cart: { currency: "INR", items: [], item_count: 0 } });
  assert.ok(!/₹/.test(usd), "no rupee sign anywhere for a USD store");
  assert.ok(!/CUSTOMER'S CURRENCY/.test(usd), "the visitor's cart currency is not announced when prices do not follow the market");
  assert.match(usd, /\(currency USD\)/);
  assert.match(usd, /\(\$1,500\.00\)/);
  const unknown = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {}, cart: { currency: "INR", items: [], item_count: 0 } });
  assert.ok(!/\(currency /.test(unknown), "no currency is named when the store's is not known");
  assert.ok(!/₹/.test(unknown));
  const inr = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {}, storeCurrency: "INR" });
  assert.match(inr, /₹1,500/, "an INR store's example uses its own sign");
}

test("with market pricing switched on the customer's currency rule is still given", () => {
  process.env.STORE_PRICES_FOLLOW_MARKET = "1";
  try {
    const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {}, storeCurrency: "USD", cart: { currency: "EUR", items: [], item_count: 0 } });
    assert.match(prompt, /CUSTOMER'S CURRENCY: EUR/);
  } finally {
    delete process.env.STORE_PRICES_FOLLOW_MARKET;
  }
});
