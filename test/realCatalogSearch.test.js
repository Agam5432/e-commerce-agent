// Searches against the recorded catalog of a real store (124 products: phones, bags, clothing, watches ...).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { realCatalogNodes } from "./helpers/realCatalog.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
const nodes = realCatalogNodes();
const typeOf = new Map(nodes.map((n) => [n.title, n.productType]));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const store = { loadCheckout: async () => null, saveCheckout: async () => null };
let no = 0;
async function find(term) {
  const shop = `real${++no}.myshopify.com`;
  const session = ecommerce.createSession(shop, { llmMode: true, clientId: `c${no}`, userMessage: term, replyLanguage: "en" }, store);
  const out = await session.handlers.search_products({ searchTerm: term });
  return { out, types: [...new Set((out.products || []).map((p) => typeOf.get(p.title)))] };
}
const only = (types, ...allowed) => types.length > 0 && types.every((t) => allowed.includes(t));

test("bag finds every bag type even though the one-item Bags type is sold out", async () => {
  const { out, types } = await find("bag");
  assert.equal(out.status, "ok");
  assert.ok(only(types, "Laptop Bags", "School Bags", "Bags"), types.join());
  assert.ok(out.products.length >= 4);
});

test("a one-letter slip is not turned into another real word (band is not brand, tracker is not trucker)", async () => {
  for (const term of ["fitness band", "gym tracker"]) {
    const { out } = await find(term);
    assert.ok(out.status !== "ok", `${term} gave ${JSON.stringify((out.products || []).map((p) => p.title))}`);
  }
});

test("a real keyboard slip is still corrected", async () => {
  assert.ok(only((await find("wach")).types, "Watches"));
  assert.ok(only((await find("iphne")).types, "Smartphones", "Phone Covers"));
});

test("words spelled apart or together differently from the store are matched", async () => {
  assert.ok(only((await find("powerbank")).types, "Power Banks"));
  assert.ok(only((await find("wristwatch")).types, "Watches"));
});

test("cell phone and samsung phone mean the phones, not the phone covers or chargers", async () => {
  assert.ok(only((await find("cell phone")).types, "Smartphones"));
  const samsung = await find("samsung phone");
  assert.deepEqual(samsung.out.products.map((p) => p.title), ["Samsung Galaxy A55 5G"]);
});

test("phone case stays the phone covers", async () => {
  assert.ok(only((await find("phone case")).types, "Phone Covers"));
});

test("items the store does not sell give no match, not look-alikes", async () => {
  for (const term of ["PlayStation 5", "tv", "washing machine"]) assert.equal((await find(term)).out.status, "no_match", term);
});

test("everyday terms find their own type", async () => {
  const cases = { laptop: ["Laptops"], earbuds: ["Bluetooth Earbuds"], "power bank": ["Power Banks"], watch: ["Watches"], shoes: ["Shoes"], belt: ["Belts"], mouse: ["Mouse"], saree: ["Saree"], sunglasses: ["Eyewear"], "bluetooth speaker": ["Speakers"], "school bag": ["School Bags"] };
  for (const [term, allowed] of Object.entries(cases)) assert.ok(only((await find(term)).types, ...allowed), `${term}: ${(await find(term)).types.join()}`);
});

test("a describing word the store uses in its own names narrows the result (maternity dress is the two maternity dresses)", async () => {
  const { out, types } = await find("maternity dress");
  assert.deepEqual([...out.products.map((p) => p.title)].sort(), ["Savannah Maxi Dress", "Twilight Plum Ribbon Dress"]);
  assert.ok(only(types, "Maternity Clothing"));
});

test("a describing word the store never uses does not hide the plain item", async () => {
  const { out, types } = await find("pregnant shirt");
  assert.ok(out.products.length > 0 && types.length > 0);
});

test("a brand narrows the result to that brand (dell laptop is the Dell laptop)", async () => {
  assert.deepEqual((await find("dell laptop")).out.products.map((p) => p.title), ["Dell Inspiron 15 Laptop"]);
});

test("a sold-out item is reported as sold out (gift card), not as one the store lacks", async () => {
  const { out } = await find("gift card");
  assert.ok(out.status === "no_match" && out.soldOutMatches?.[0]?.title === "Gift Card", JSON.stringify(out).slice(0, 300));
  assert.match(out.reason, /SOLD OUT/);
});

test("a qualifier the store does not use (portable, baby) makes the result the nearest, not the exact answer", async () => {
  assert.equal((await find("portable charger")).out.status, "closest_alternatives");
  assert.equal((await find("baby clothes")).out.status, "closest_alternatives");
});

test("bag is the store's bag types even though the one 'Bags' item is sold out (no empty 'closest' answer)", async () => {
  const { out, types } = await find("bag");
  assert.equal(out.status, "ok");
  assert.ok(out.products.length >= 4 && only(types, "Laptop Bags", "School Bags", "Bags"));
});

test("typos: keyboard and sound slips are fixed, a different real word is not (printer is not printed)", async () => {
  assert.ok(only((await find("labtop")).types, "Laptops"));
  assert.equal((await find("printer")).out.status, "no_match");
  assert.equal((await find("band")).out.status, "no_match");
});

test("a word found only in a description is the nearest, never the exact answer (tablet)", async () => {
  assert.equal((await find("tablet")).out.status, "closest_alternatives");
});
