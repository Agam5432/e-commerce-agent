// READ-ONLY, no AI: how many products does the agent's own search tool return for a plain request, compared with how many
// matching products the LIVE TechStore actually has? Only `products(...)` GraphQL queries are sent to the real store; nothing else.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("D:/mini-agent/package.json");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const real = dotenv.parse(fs.readFileSync("D:/mini-agent/.env"));
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = real.SHOPIFY_TOKEN_ENCRYPTION_KEY;
process.env.SHOPIFY_API_VERSION = real.SHOPIFY_API_VERSION || "2026-10";
const SHOP = "techstore-3qkasoly.myshopify.com";
const { decryptToken, encryptToken } = await import("file:///D:/mini-agent/src/utils/tokenEncryption.js");
await mongoose.connect(real.MONGODB_URI, { dbName: real.DB_NAME, serverSelectionTimeoutMS: 5000 });
const doc = await mongoose.connection.db.collection("store_integrations").findOne({ storeDomain: SHOP }, { projection: { accessTokenEncrypted: 1, accessTokenExpiresAt: 1 } });
await mongoose.disconnect(); // the search code below must not touch the real database
if (!(new Date(doc.accessTokenExpiresAt) > new Date(Date.now() + 120000))) { console.log("BLOCKED: the stored access token has expired (the live app refreshes it on its next real use)."); process.exit(0); }
const token = decryptToken(doc.accessTokenEncrypted);
const { default: StoreIntegration } = await import("file:///D:/mini-agent/src/models/StoreIntegration.js");
const sealed = encryptToken(token);
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: sealed, accessTokenExpiresAt: new Date(Date.now() + 3600e3) }), lean: async () => null });
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes(SHOP) || !/graphql\.json/.test(u)) throw new Error("blocked: " + u.slice(0, 60));
  const q = JSON.parse(init.body || "{}").query || "";
  if (/^\s*mutation\b/.test(q) || !/\bproducts\s*\(/.test(q)) throw new Error("SAFETY STOP: only product read queries are allowed here");
  calls += 1;
  return realFetch(url, init);
};
const { searchShopifyProducts } = await import("file:///D:/mini-agent/src/tools/shopify/search.js");
const LIVE = JSON.parse(fs.readFileSync("D:/mini-agent/audit/live-catalog.json", "utf8"));
const truth = (re, typeRe) => LIVE.filter((p) => re.test(p.title) || (typeRe && typeRe.test(p.type || ""))).filter((p) => p.variants.some((v) => v.available));
const tests = [
  ["jeans", truth(/jean/i)], ["ek jeans", truth(/jean/i)], ["show me jeans", truth(/jean/i)], ["smartphone", truth(/smartphone|iphone|galaxy|nord|redmi/i, /^Smartphones$/)], ["phone", truth(/iphone|galaxy|nord|redmi/i, /^Smartphones$/)],
  ["smartwatch", truth(/watch/i)], ["watch", truth(/watch/i)], ["laptop", truth(/laptop/i, /^Laptops$/)], ["power bank", truth(/power ?bank/i)], ["earbuds", truth(/earbuds|buds/i)], ["shirt", truth(/shirt/i)], ["shoes", truth(/shoe|sneaker/i, /^Shoes$/)], ["backpack", truth(/backpack/i)],
];
console.log("search term".padEnd(16), "returned".padStart(9), "live in-stock matches".padStart(22), " verdict");
const rows = [];
for (const [term, expected] of tests) {
  let got = [];
  try { got = await searchShopifyProducts(SHOP, term); } catch (e) { console.log(term.padEnd(16), "ERROR", String(e.message).slice(0, 80)); continue; }
  const n = got.length, e = expected.length;
  const recall = e ? n / e : 1;
  rows.push({ term, returned: n, expected: e, recall: Number(recall.toFixed(2)), titles: got.map((p) => p.title).slice(0, 6) });
  console.log(term.padEnd(16), String(n).padStart(9), String(e).padStart(22), " ", recall >= 0.8 ? "ok" : `LOW (${Math.round(recall * 100)}%)`, n ? "| " + got.map((p) => p.title).slice(0, 3).join(" ; ").slice(0, 90) : "");
}
fs.writeFileSync("D:/mini-agent/audit/search-recall.json", JSON.stringify({ at: new Date().toISOString(), shop: SHOP, shopifyReadQueries: calls, rows }, null, 1));
console.log(`\nread-only product queries sent to the real store: ${calls}; nothing else was sent.`);
process.exit(0);
