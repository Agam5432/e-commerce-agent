// Pass 3: nothing customer-facing is a fixed sentence while the AI is reachable, language is the
// AI's call, the reply round shares round 1's prompt prefix (cache), the probe never blocks the
// turn, and the server voice returns a playable WAV.
import test from "node:test";
import assert from "node:assert/strict";
import {
  runAgent,
  __setLLMClientsForTest,
  withinBudget,
  prefetchTurnData,
  buildGreetingPrompt,
  generateGreeting,
} from "../src/agent/agent.js";
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { resolveTurnLanguage, scriptLanguage, detectReplyLanguage } from "../src/services/language.js";
import { checkoutFailureReason, checkoutFailureFacts } from "../src/services/checkoutMessages.js";
import { createOrderLookupAuth } from "../src/services/orderLookupAuth.js";
import { isLanguageCheck } from "./helpers/languageCheck.js";

function fakeGemini(script) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (req) => {
        if (isLanguageCheck(req)) return { candidates: [{ content: { role: "model", parts: [{ text: "SAME" }] } }] };
        calls.push(req);
        const step = script[calls.length - 1] || script[script.length - 1];
        return { candidates: [{ content: { role: "model", parts: step(req) } }] };
      },
    },
  };
}

async function withAgentHarness(fn) {
  const original = { create: ecommerce.createSession, summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  let stored = { step: "ready", selectedPaymentMethod: "cod", billingSameAsShipping: true,
    shipping: { name: "Test Buyer", email: "buyer@example.com", address1: "10 Main Road", city: "Delhi", country: "India", countryCode: "IN", zip: "110001", phone: "+919876543210" } };
  const submitted = [];
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => structuredClone(stored) });
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD", storeName: "Test Store" });
    ecommerce.createSession = (shop, context) => original.create(shop, context, {
      loadCheckout: async () => structuredClone(stored),
      saveCheckout: async (s, c, patch) => { stored = { ...stored, ...patch }; },
      prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
      shippingRates: async () => [{ handle: "std", title: "Standard", price: 0, currency: "USD" }],
      quoteOrder: async () => { throw new Error("Shopify quote unavailable in tests"); },
      submitOrder: async (s, options) => {
        submitted.push(options);
        return { shopifyOrderCreated: true, shopifyOrderId: "gid://shopify/Order/42", orderName: "#1042", total: 7.99, currency: "USD", discountAmount: 0 };
      },
    });
    const options = { clientId: `p3-${crypto.randomUUID()}`, cart: { currency: "USD", items: [{ variant_id: "123", title: "Test T-Shirt", price: 799, quantity: 1 }] } };
    await fn({ options, submitted });
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.createSession = original.create;
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find;
    StoreIntegration.findOne = original.integration;
    globalThis.fetch = original.fetch;
  }
}

const placeOrder = () => [{ functionCall: { name: "place_order", args: { paymentMethod: "cod", customerConfirmed: true } } }];
const text = (t) => () => [{ text: t }];

// ---------------------------------------------------------------- AI rewrites instead of templates

test("a reply with an invented amount is rewritten by the AI, not replaced by a stored sentence", async () => {
  await withAgentHarness(async ({ options }) => {
    const good = "Order #1042 ho gaya dost, total $7.99, Cash on Delivery. Jaldi milte hain!";
    const gemini = fakeGemini([placeOrder, text("Done! Order #1042, total $9.99."), text(good)]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("haan kar do", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, good);
    assert.equal(gemini.calls.length, 3);
    // the rewrite request tells the model exactly what was wrong
    assert.match(JSON.stringify(gemini.calls[2].contents), /9\.99/);
    assert.match(JSON.stringify(gemini.calls[2].contents), /rejected/);
  });
});

test("an empty model reply is written again by the AI", async () => {
  await withAgentHarness(async ({ options }) => {
    const good = "Order #1042 place ho gaya, total $7.99.";
    const gemini = fakeGemini([placeOrder, () => [], text(good)]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("confirm", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.answer, good);
  });
});

test("the reply round keeps round 1's tools with calling switched off (same cacheable prefix)", async () => {
  await withAgentHarness(async ({ options }) => {
    const gemini = fakeGemini([placeOrder, text("Order #1042 confirmed, total $7.99.")]);
    __setLLMClientsForTest({ gemini });
    await runAgent("place it", "test.myshopify.com", [], "ecommerce", options);
    const [first, second] = gemini.calls;
    assert.equal(first.config.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.equal(second.config.toolConfig.functionCallingConfig.mode, "NONE");
    assert.deepEqual(second.config.tools, first.config.tools);
    assert.equal(second.config.systemInstruction, first.config.systemInstruction);
  });
});

// ---------------------------------------------------------------- language is the AI's decision

test("language: only the script is read from the text; Hinglish vs English is left to the AI", () => {
  assert.equal(scriptLanguage("मुझे कुर्ता चाहिए"), "hi");
  assert.equal(scriptLanguage("mujhe kurta dikhao"), "");
  assert.equal(detectReplyLanguage("bhai kya haal hai"), "en");
  assert.deepEqual(resolveTurnLanguage({ message: "mujhe kurta dikhao" }), { replyLanguage: "en", languageLocked: false });
  assert.deepEqual(resolveTurnLanguage({ message: "hello", languageChoice: "hinglish" }), { replyLanguage: "hinglish", languageLocked: true });
  assert.deepEqual(resolveTurnLanguage({ message: "hello", languageChoice: "klingon" }), { replyLanguage: "en", languageLocked: false });
});

test("the AI records an explicit language request with set_reply_language and it comes back to the client", async () => {
  await withAgentHarness(async ({ options }) => {
    const gemini = fakeGemini([
      () => [{ functionCall: { name: "set_reply_language", args: { language: "hindi" } } }],
      text("ज़रूर दोस्त, अब हम हिंदी में बात करेंगे।"),
    ]);
    __setLLMClientsForTest({ gemini });
    const result = await runAgent("Hindi me baat karo", "test.myshopify.com", [], "ecommerce", options);
    assert.equal(result.languageChoice, "hi");
    const def = ecommerce.toolDefinitions.find((t) => t.function.name === "set_reply_language");
    assert.deepEqual(def.function.parameters.properties.language.enum, ["english", "hindi", "hinglish", "auto"]);
  });
});

test("'auto' clears the choice; a turn without the tool leaves the choice unchanged", async () => {
  const s = ecommerce.createSession("x.myshopify.com", { llmMode: true, clientId: "lang-1", userMessage: "", cart: null }, {
    loadCheckout: async () => ({}), saveCheckout: async () => {},
  });
  assert.equal("languageChoice" in s.result(), false);
  await s.handlers.set_reply_language({ language: "auto" });
  assert.equal(s.result().languageChoice, "");
  const bad = await s.handlers.set_reply_language({ language: "french" });
  assert.equal(bad.status, "error");
});

test("the prompt tells the model to record language requests itself", () => {
  const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {} });
  assert.match(prompt, /set_reply_language/);
  const locked = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "hi", languageLocked: true, profile: {} });
  assert.match(locked, /customer chose Hindi/);
});

// ---------------------------------------------------------------- order failure = facts for the AI

test("a failed order gives the AI a reason and facts, never a ready-made sentence as the note", async () => {
  assert.equal(checkoutFailureReason({ uncertain: true }), "order_status_unknown");
  assert.equal(checkoutFailureReason(new Error("Insufficient stock for item")), "item_unavailable");
  assert.equal(checkoutFailureReason(new Error("boom")), "store_could_not_confirm");
  assert.match(checkoutFailureFacts("item_unavailable"), /no longer available/);

  let stored = { step: "ready", selectedPaymentMethod: "cod", billingSameAsShipping: true, billingConfirmed: true,
    shipping: { name: "T B", email: "b@example.com", phone: "+919876543210", address1: "1 Rd", city: "Delhi", province: "Delhi", country: "India", countryCode: "IN", zip: "110001" } };
  const s = ecommerce.createSession("test.myshopify.com", { llmMode: true, clientId: `f-${crypto.randomUUID()}`, userMessage: "haan", replyLanguage: "en",
    cart: { currency: "USD", total_price: 799, items: [{ variant_id: "123", title: "Tee", price: 799, original_price: 799, quantity: 1 }] }, checkout: structuredClone(stored) }, {
    loadCheckout: async () => structuredClone(stored), saveCheckout: async (a, b, p) => { stored = { ...stored, ...p }; },
    prepaidOffer: async () => ({ hasDiscount: false }), sendConfirmation: async () => ({ ok: true }),
    shippingRates: async () => [{ handle: "std", title: "Standard", price: 0, currency: "USD" }],
    quoteOrder: async () => { throw new Error("offline"); },
    submitOrder: async () => { throw new Error("Insufficient stock for item"); },
  });
  const r = await s.handlers.place_order({ paymentMethod: "cod", customerConfirmed: true });
  assert.equal(r.status, "error");
  assert.equal(r.reason, "item_unavailable");
  assert.equal(r.note, undefined);
  assert.match(r.instruction_for_ai, /NOT placed/);
});

// ---------------------------------------------------------------- latency: probe budget, one DB read

test("the live catalog probe never holds the turn longer than its budget", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve(["late"]), 500));
  const t0 = Date.now();
  assert.equal(await withinBudget(slow, 30, null), null);
  assert.ok(Date.now() - t0 < 300);
  assert.deepEqual(await withinBudget(Promise.resolve([1]), 30, null), [1]);
  assert.equal(await withinBudget(Promise.reject(new Error("x")), 30, "fb"), "fb");
});

test("prefetch reads the shopper's order/OTP state once and runs everything in parallel", async () => {
  const config = { getCachedCatalogSummary: () => ({ storeName: "S" }) };
  const original = StoreIntegration.findOne;
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
  try {
    const prep = await prefetchTurnData(config, "x.myshopify.com", "", { clientId: "c" });
    assert.deepEqual(prep.summary, { storeName: "S" });
    assert.equal(prep.probe, null); // empty message: no probe
  } finally {
    StoreIntegration.findOne = original;
  }
});

test("getChatState returns the verified email and last order from a single read", async () => {
  const data = new Map();
  let gets = 0;
  const store = {
    get: async (k) => { gets += 1; return data.get(k) ? structuredClone(data.get(k)) : null; },
    set: async (k, v) => { data.set(k, structuredClone(v)); },
    delete: async (k) => { data.delete(k); },
  };
  const auth = createOrderLookupAuth({ store });
  const who = { shop: "x.myshopify.com", clientId: "c1" };
  await auth.setLastOrder({ ...who, orderNumber: "#1042" });
  gets = 0;
  const state = await auth.getChatState(who);
  assert.equal(gets, 1);
  assert.equal(state.lastOrderNumber, "#1042");
  assert.equal(state.verifiedEmail, "");
});

// ---------------------------------------------------------------- opening message by the AI

test("the greeting prompt uses the store, the customer's first name and their time of day", () => {
  const p = buildGreetingPrompt({ storeName: "Desi Threads", customerName: "Agam Tyagi", localHour: 20 });
  assert.match(p, /Desi Threads/);
  assert.match(p, /Their name is Agam;/);
  assert.match(p, /evening/);
  assert.match(p, /Do not name or invent any product/);
  assert.match(buildGreetingPrompt({}), /do not invent one/);
  assert.match(buildGreetingPrompt({ languageChoice: "hi" }), /Devanagari/);
});

test("the greeting text comes from the AI; with no AI the server returns nothing (merchant text is used)", async () => {
  const original = ecommerce.getCachedCatalogSummary;
  ecommerce.getCachedCatalogSummary = () => ({ storeName: "Desi Threads" });
  try {
    const gemini = fakeGemini([text("Hey Agam! Shaam ki shopping? Batao kya dhoondh rahe ho.")]);
    __setLLMClientsForTest({ gemini });
    const g = await generateGreeting("x.myshopify.com", { customerName: "Agam", localHour: 19 });
    assert.equal(g, "Hey Agam! Shaam ki shopping? Batao kya dhoondh rahe ho.");
    assert.match(gemini.calls[0].contents[0].parts[0].text, /Desi Threads/);

    __setLLMClientsForTest({ gemini: null, groq: null });
    assert.equal(await generateGreeting("x.myshopify.com", {}), "");
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.getCachedCatalogSummary = original;
  }
});

// ---------------------------------------------------------------- server voice

// ---------------------------------------------------------------- proxy routes (signed like Shopify)

test("app proxy: /greeting is served behind the Shopify signature, and there is no server voice route", async () => {
  const { default: express } = await import("express");
  const { createHmac } = await import("node:crypto");
  const { default: router } = await import("../src/routes/shopifyProxyRoutes.js");
  const prevSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const originalExists = StoreIntegration.exists;
  const originalSummary = ecommerce.getCachedCatalogSummary;
  process.env.SHOPIFY_CLIENT_SECRET = "proxy-test-secret";
  StoreIntegration.exists = async () => ({ _id: "1" });
  ecommerce.getCachedCatalogSummary = () => ({ storeName: "Desi Threads" });
  const app = express();
  app.use(express.json());
  app.use("/proxy", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const signed = (path) => {
    const params = { shop: "x.myshopify.com", timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: "/apps/ai-agent" };
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
    const signature = createHmac("sha256", "proxy-test-secret").update(message).digest("hex");
    return `http://127.0.0.1:${server.address().port}/proxy${path}?${new URLSearchParams({ ...params, signature })}`;
  };
  const post = (path, body) => fetch(signed(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    __setLLMClientsForTest({ gemini: fakeGemini([text("Hello! Kya dhoondh rahe ho aaj?")]) });
    const g = await post("/greeting", { localHour: 10 });
    assert.equal(g.status, 200);
    assert.equal((await g.json()).greeting, "Hello! Kya dhoondh rahe ho aaj?");

    const tts = await post("/tts", { text: "hello" });
    assert.equal(tts.status, 404); // replies are spoken by the browser voice only

    const unsigned = await fetch(`http://127.0.0.1:${server.address().port}/proxy/greeting`, { method: "POST" });
    assert.equal(unsigned.status, 401);
  } finally {
    __setLLMClientsForTest(null);
    await new Promise((r) => server.close(r));
    StoreIntegration.exists = originalExists;
    ecommerce.getCachedCatalogSummary = originalSummary;
    if (prevSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = prevSecret;
  }
});

// ---------------------------------------------------------------- voice language + English mirroring

test("an English message gets an English-only reply rule (no yaar/dost), in prompt, wrap-up and turn note", async () => {
  const { withLanguageNote } = await import("../src/agent/agent.js");
  const prompt = ecommerce.buildSystemPrompt("x.myshopify.com", { replyLanguage: "en", profile: {} });
  assert.match(prompt, /every word of your reply is English/);
  assert.match(prompt, /your own earlier messages never decide it/);
  assert.doesNotMatch(prompt, /natural Hindi\/Hinglish\/English exactly as the customer speaks/);
  assert.match(withLanguageNote("I am travelling, need gadgets", "en", false), /reply only in English with no Hindi or Hinglish words/);
  await withAgentHarness(async ({ options }) => {
    const gemini = fakeGemini([() => [{ functionCall: { name: "get_store_info", args: {} } }], text("Safe travels!")]);
    __setLLMClientsForTest({ gemini });
    await runAgent("I am travelling to another city", "test.myshopify.com", [], "ecommerce", options);
    const wrap = JSON.stringify(gemini.calls[1].contents);
    assert.match(wrap, /no Hindi or Hinglish words at all/);
    assert.doesNotMatch(wrap, /dost \+ dukaan-daar/);
  });
});

test("the opening greeting is written in English unless the customer chose another language", () => {
  assert.match(buildGreetingPrompt({}), /English only/);
  assert.doesNotMatch(buildGreetingPrompt({}), /touch of Hinglish/);
});
