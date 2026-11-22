// READ-ONLY checks against the REAL TechStore dev store. Rules this script enforces on itself:
//  - only GraphQL *queries* (a request whose text starts with "mutation" is refused before it is sent);
//  - it reads only the encrypted ACCESS token from the database and never touches the refresh token, so it cannot rotate it;
//  - if the access token has expired it stops (the live app refreshes it itself on the next real use);
//  - it prints counts and prices only: no customer or order data is read, printed or saved.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("D:/mini-agent/package.json");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const env = dotenv.parse(fs.readFileSync("D:/mini-agent/.env"));
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
const { decryptToken } = await import("file:///D:/mini-agent/src/utils/tokenEncryption.js");
const SHOP = "techstore-3qkasoly.myshopify.com";
const out = { checkedAt: new Date().toISOString(), shop: SHOP, status: "", notes: [], checks: [] };
await mongoose.connect(env.MONGODB_URI, { dbName: env.DB_NAME, serverSelectionTimeoutMS: 5000 });
const doc = await mongoose.connection.db.collection("store_integrations").findOne({ storeDomain: SHOP }, { projection: { accessTokenEncrypted: 1, accessTokenExpiresAt: 1, status: 1 } });
await mongoose.disconnect();
const expires = new Date(doc.accessTokenExpiresAt);
if (!(expires > new Date(Date.now() + 90_000))) {
  out.status = "BLOCKED";
  out.notes.push(`The stored access token expired at ${expires.toISOString()}. It is refreshed by the live app on its next real use (for example opening the dashboard inside Shopify admin, or one message through the widget on the dev server). Run this script again right after that.`);
  fs.writeFileSync("D:/mini-agent/audit/live-results.json", JSON.stringify(out, null, 1));
  console.log(out.status, out.notes[0]);
  process.exit(0);
}
const token = decryptToken(doc.accessTokenEncrypted);
async function gql(query, variables = {}) {
  if (/^\s*mutation\b/.test(query)) throw new Error("refused: this script never sends a mutation");
  const res = await fetch(`https://${SHOP}/admin/api/${env.SHOPIFY_API_VERSION || "2026-10"}/graphql.json`, { method: "POST", headers: { "content-type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`HTTP ${res.status} ${JSON.stringify(body.errors || "").slice(0, 160)}`);
  return body.data;
}
const add = (name, ok, note) => { out.checks.push({ name, ok, note }); console.log(ok ? "PASS" : "FAIL", name, "::", note); };
try {
  const shop = (await gql(`{ shop { name currencyCode ianaTimezone } }`)).shop;
  add("L01 shop identity and currency", true, `${shop.name}, currency ${shop.currencyCode}, timezone ${shop.ianaTimezone}`);
  const recorded = JSON.parse(fs.readFileSync("D:/mini-agent/test/fixtures/techstoreCatalog.json", "utf8"));
  const live = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const d = (await gql(`query($after: String) { products(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { title handle productType vendor tags description status variants(first: 20) { nodes { title price inventoryQuantity } } } } }`, { after })).products;
    live.push(...d.nodes);
    if (!d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  const active = live.filter((p) => p.status === "ACTIVE");
  fs.writeFileSync("D:/mini-agent/audit/live-catalog.json", JSON.stringify(active.map((p) => ({ title: p.title, type: p.productType, tags: p.tags, description: p.description, vendor: p.vendor, variants: p.variants.nodes.map((v) => ({ title: v.title, price: v.price, available: Number(v.inventoryQuantity) > 0 })) }))));
  add("L02 live catalog size", true, `${live.length} products (${active.length} active) live vs ${recorded.length} in the recording`);
  const liveByTitle = new Map(live.map((p) => [p.title, p]));
  const missing = recorded.filter((r) => !liveByTitle.has(r.title)).map((r) => r.title);
  const priceDiffs = [];
  for (const r of recorded) {
    const l = liveByTitle.get(r.title); if (!l) continue;
    const lp = Math.min(...l.variants.nodes.map((v) => Number(v.price))), rp = Math.min(...r.variants.map((v) => Number(v.price)));
    if (Math.abs(lp - rp) > 0.005) priceDiffs.push(`${r.title}: live ${lp} vs recorded ${rp}`);
  }
  add("L03 prices: live vs the recording used by the tests", priceDiffs.length === 0, priceDiffs.length ? `${priceDiffs.length} differ, e.g. ${priceDiffs.slice(0, 3).join("; ")}` : `all ${recorded.length - missing.length} matching products have identical prices`);
  add("L04 recorded products that no longer exist live", missing.length === 0, missing.length ? `${missing.length} missing: ${missing.slice(0, 5).join("; ")}` : "none missing");
  const sample = ["Apple iPhone 15", "Samsung Galaxy A55 5G", "Ambrane 10000mAh Power Bank"].map((t) => liveByTitle.get(t)).filter(Boolean).map((p) => `${p.title} = ${Math.min(...p.variants.nodes.map((v) => Number(v.price)))} ${shop.currencyCode}`);
  out.notes.push(`sample live prices: ${sample.join(" | ")}`);
  const counts = await gql(`{ ordersCount { count } customersCount { count } }`).catch((e) => ({ err: String(e.message).slice(0, 100) }));
  add("L05 are there real customers/orders in the store (counts only)", !counts.err, counts.err ? `not readable: ${counts.err}` : `orders: ${counts.ordersCount.count}, customers: ${counts.customersCount.count}`);
  out.status = "DONE";
} catch (error) {
  out.status = "BLOCKED"; out.notes.push(String(error.message).slice(0, 200)); console.log("BLOCKED", error.message);
}
fs.writeFileSync("D:/mini-agent/audit/live-results.json", JSON.stringify(out, null, 1));
