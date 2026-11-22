// "Asked for, not found" on the Catalog insights screen: a search the store could not answer is recorded, once per
// chat turn, and counted by the overview's top list.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import ecommerce from "../src/industries/ecommerce.js";
import { analytics } from "../src/industries/ecommerce/analytics.js";
import { realCatalogNodes } from "./helpers/realCatalog.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("t"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });
const nodes = realCatalogNodes();
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { products: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } }) });
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const store = { loadCheckout: async () => null, saveCheckout: async () => null };

test("a search that finds nothing is kept as a miss and becomes a search_no_match event", async () => {
  const s = ecommerce.createSession("insights1.myshopify.com", { llmMode: true, clientId: "ins1", userMessage: "silver pooja thali", replyLanguage: "en" }, store);
  const out = await s.handlers.search_products({ searchTerm: "silver pooja thali" });
  assert.equal(out.status, "no_match");
  const result = s.result();
  assert.deepEqual(result.missed.map((m) => m.term), ["silver pooja thali"]);
  const events = analytics.eventsFromResult(result);
  assert.deepEqual(events.filter((e) => e.type === "search_no_match").map((e) => e.props.term), ["silver pooja thali"]);
});

test("a search that finds products records no miss", async () => {
  const s = ecommerce.createSession("insights2.myshopify.com", { llmMode: true, clientId: "ins2", userMessage: "watch", replyLanguage: "en" }, store);
  const out = await s.handlers.search_products({ searchTerm: "watch" });
  assert.equal(out.status, "ok");
  assert.deepEqual(s.result().missed, []);
  assert.equal(analytics.eventsFromResult(s.result()).filter((e) => e.type === "search_no_match").length, 0);
});

test("the overview counts the misses as a top list", () => {
  assert.ok(analytics.rankings.some((r) => r.key === "searchedNotFound" && r.event === "search_no_match" && r.field === "props.term"));
});
