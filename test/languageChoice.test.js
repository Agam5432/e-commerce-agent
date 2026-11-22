// The shopper picks English or Hindi in the widget. The agent keeps to it, and when the shopper starts
// talking in the other language it first asks whether to switch; on "yes" it switches and answers the
// question the shopper asked before the language question.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ecommerce from "../src/industries/ecommerce.js";
import CheckoutSession from "../src/models/CheckoutSession.js";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { resolveTurnLanguage } from "../src/services/language.js";

process.env.LLM_PRIMARY = "gemini";
const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");

const prompt = (replyLanguage, languageLocked) =>
  ecommerce.buildSystemPrompt("lang.myshopify.com", { catalogProductCount: 3, storeProfile: { storeName: "T" }, probeRan: true, probeProducts: [], profile: {}, replyLanguage, languageLocked, cart: { items: [], currency: "USD" } });

test("a chosen language is kept, and a switch is asked about first", () => {
  const en = prompt("en", true);
  assert.match(en, /the customer chose English/);
  assert.match(en, /do NOT answer it yet: ask one short, friendly question IN THAT NEW LANGUAGE/);
  assert.match(en, /call set_reply_language with the new language and answer the question they asked just before your language question/);
  assert.match(prompt("hi", true), /the customer chose Hindi \(Devanagari script\)/);
});

test("without a choice the agent simply mirrors the shopper (no switching question)", () => {
  const auto = prompt("en", false);
  assert.doesNotMatch(auto, /do NOT answer it yet/);
  assert.match(auto, /reply in the language and script of the customer's LATEST message/);
});

test("a Devanagari message gets a Devanagari reply even without a chosen language", () => {
  assert.match(prompt("hi", false), /written in Devanagari, so write the whole reply in Hindi in Devanagari script/);
  assert.doesNotMatch(prompt("en", false), /written in Devanagari/);
});

test("the widget's choice is enforced; 'auto' mirrors the message", () => {
  assert.deepEqual(resolveTurnLanguage({ message: "mujhe tv chahiye", languageChoice: "en" }), { replyLanguage: "en", languageLocked: true });
  assert.deepEqual(resolveTurnLanguage({ message: "मुझे टीवी चाहिए", languageChoice: "" }), { replyLanguage: "hi", languageLocked: false });
});

test("on 'haan' the agent saves Hindi and the new choice goes back to the widget", async () => {
  const original = { summary: ecommerce.getCachedCatalogSummary, find: CheckoutSession.findOne, integration: StoreIntegration.findOne, fetch: globalThis.fetch };
  const calls = [];
  const gemini = {
    models: {
      generateContent: async (req) => {
        calls.push(req);
        if (calls.length === 1) return { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_reply_language", args: { language: "hindi" } } }] } }] };
        return { candidates: [{ content: { role: "model", parts: [{ text: "ज़रूर! हमारे पास 55 इंच के स्मार्ट टीवी हैं।" }] } }] };
      },
    },
  };
  try {
    globalThis.fetch = async () => { throw new Error("Network disabled for this test"); };
    CheckoutSession.findOne = () => ({ lean: async () => null });
    StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
    ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD", storeName: "T" });
    __setLLMClientsForTest({ gemini });
    const history = [
      { role: "user", content: "mujhe 55 inch ka smart tv chahiye" },
      { role: "assistant", content: "Kya hum Hindi mein baat karein?" },
    ];
    const result = await runAgent("haan", "lang.myshopify.com", history, "ecommerce", {
      clientId: `l-${crypto.randomUUID()}`, cart: { currency: "USD", items: [] }, ...resolveTurnLanguage({ message: "haan", languageChoice: "en" }),
    });
    assert.equal(result.languageChoice, "hi");
    assert.match(result.answer, /टीवी/);
    // the model saw the earlier question, so it can answer it now
    assert.match(JSON.stringify(calls[0].contents), /55 inch ka smart tv/);
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.getCachedCatalogSummary = original.summary;
    CheckoutSession.findOne = original.find; StoreIntegration.findOne = original.integration; globalThis.fetch = original.fetch;
  }
});

test("a reply in Devanagari to a message typed in Roman letters is caught; the right script is not", async () => {
  const { wrongScriptReply } = await import("../src/services/language.js");
  assert.equal(wrongScriptReply({ message: "kya aapke paas Samsung Galaxy Buds hai", reply: "हाँ, उपलब्ध हैं", replyLanguage: "en" }), true);
  assert.equal(wrongScriptReply({ message: "क्या आपके पास बड्स हैं", reply: "हाँ, उपलब्ध हैं", replyLanguage: "hi" }), false);
  assert.equal(wrongScriptReply({ message: "do you have a PS5?", reply: "No, we do not.", replyLanguage: "en" }), false);
  assert.equal(wrongScriptReply({ message: "hi", reply: "हाँ", replyLanguage: "hinglish", locked: true }), true);
  assert.equal(wrongScriptReply({ message: "hi", reply: "हाँ", replyLanguage: "hi", locked: true }), false);
  assert.equal(wrongScriptReply({ message: "வணக்கம்", reply: "हाँ", replyLanguage: "en" }), false);
});
