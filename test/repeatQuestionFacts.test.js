// The same question asked again is often answered without a new search, from what the chat already showed. That reply used to
// come with no product cards and with features the listing never had ("triple camera", "50 megapixel Sony camera", real
// storefront 2026-11-21). Now it is checked against the shown products' own data and their cards come back.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_PRIMARY = "gemini";
process.env.LLM_SECONDARY = "claude";
const { runAgent, __setLLMClientsForTest, __resetProviderBlocksForTest } = await import("../src/agent/agent.js");
const { installRealStore, scriptedGemini, freshClientId } = await import("./helpers/agentHarness.js");
const { writeCheckoutMemory } = await import("../src/industries/ecommerce/pricing.js");

const store = installRealStore();
after(() => { __setLLMClientsForTest(null); store.restore(); });
beforeEach(() => __resetProviderBlocksForTest());

const SHOP = "repeat.myshopify.com";
const remembered = [
  { id: "gid://shopify/Product/1", title: "Samsung Galaxy A55 5G", price: "40400.00", currency: "INR", description: "6.6-inch AMOLED display, 5G connectivity, a multi-lens camera and all-day battery life.", variants: [{ id: "11", title: "Awesome Navy / 128GB", price: "40400.00", sellable: true }] },
  { id: "gid://shopify/Product/2", title: "OnePlus Nord CE4", price: "26300.00", currency: "INR", description: "Smooth AMOLED display, fast charging and clean software for a quick, reliable phone.", variants: [{ id: "21", title: "Dark Chrome / 128GB", price: "26300.00", sellable: true }] },
];

async function ask(steps, message) {
  const clientId = freshClientId();
  writeCheckoutMemory(SHOP, clientId, { lastShownProducts: remembered });
  const scripted = scriptedGemini(steps);
  __setLLMClientsForTest({ gemini: scripted });
  const out = await runAgent(message, SHOP, [{ role: "user", content: "phone under 45000 with good camera" }, { role: "assistant", content: "Samsung Galaxy A55 5G (₹40,400) and OnePlus Nord CE4 (₹26,300)." }], "ecommerce", { clientId, cart: { currency: "INR", items: [] } });
  return { out, scripted };
}

test("a repeat answer with invented features is rewritten, and the named products come back as cards", async () => {
  const invented = "Samsung Galaxy A55 5G (₹40,400): triple camera setup aur in-display fingerprint sensor. OnePlus Nord CE4 (₹26,300): 50 megapixel ka Sony camera.";
  const honest = "Samsung Galaxy A55 5G (₹40,400): multi-lens camera aur AMOLED display. OnePlus Nord CE4 (₹26,300): smooth AMOLED display aur fast charging.";
  const { out } = await ask([() => invented, () => honest], "45k tak ka best camera phone kaunsa hai?");
  assert.doesNotMatch(out.answer, /triple|fingerprint|sony|50 megapixel/i, out.answer);
  assert.deepEqual(out.products.map((p) => p.title).sort(), ["OnePlus Nord CE4", "Samsung Galaxy A55 5G"]);
});

test("when the rewrite still invents, only the invented sentences are dropped", async () => {
  const invented = "Samsung Galaxy A55 5G (₹40,400) is a great pick. It has a triple camera. OnePlus Nord CE4 (₹26,300) is cheaper.";
  const { out } = await ask([() => invented], "camera wala phone 45 hazar");
  assert.doesNotMatch(out.answer, /triple/i);
  assert.match(out.answer, /Galaxy A55 5G \(₹40,400\)/);
  assert.match(out.answer, /Nord CE4/);
});
