// Audit batch 1: a late "app uninstalled" webhook must not switch off a store that was installed again afterwards,
// and the voice socket must not take a malformed browser id.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { startTempMongo } from "./helpers/tempMongo.js";

process.env.SHOPIFY_CLIENT_SECRET = "test-secret";
process.env.SHOPIFY_API_SECRET = "test-secret";
const { handleAppUninstalledWebhook } = await import("../src/routes/shopifyOAuthRoutes.js");
const { default: StoreIntegration } = await import("../src/models/StoreIntegration.js");
const { nextClientId } = await import("../src/services/customerContext.js");

const SHOP = "late-webhook.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine";
test.after(async () => { await mongo.stop?.(); });

function uninstallWebhook({ triggeredAt } = {}) {
  const body = { myshopify_domain: SHOP };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = {
    "x-shopify-hmac-sha256": crypto.createHmac("sha256", "test-secret").update(raw).digest("base64"),
    "x-shopify-shop-domain": SHOP,
    ...(triggeredAt ? { "x-shopify-triggered-at": triggeredAt } : {}),
  };
  const req = { rawBody: raw, body, headers, get: (name) => headers[name.toLowerCase()] };
  const out = { status: 0, body: null };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  return handleAppUninstalledWebhook(req, res).then(() => out);
}

async function installedStore(installedAt) {
  await StoreIntegration.collection.deleteMany({});
  await StoreIntegration.collection.insertOne({ platform: "shopify", storeDomain: SHOP, status: "active", installedAt, accessTokenEncrypted: "sealed-token" });
}
const store = () => StoreIntegration.collection.findOne({ storeDomain: SHOP });

test("an uninstall webhook from before the store was installed again is ignored (the store stays active with its token)", { skip }, async () => {
  await installedStore(new Date("2026-11-10T12:00:00Z"));
  const out = await uninstallWebhook({ triggeredAt: "2026-11-10T09:00:00.000Z" });
  assert.equal(out.status, 200, "Shopify must not retry it");
  const row = await store();
  assert.equal(row.status, "active");
  assert.equal(row.accessTokenEncrypted, "sealed-token");
});

test("an uninstall webhook from after the install switches the store off and removes its tokens", { skip }, async () => {
  await installedStore(new Date("2026-11-10T12:00:00Z"));
  const out = await uninstallWebhook({ triggeredAt: "2026-11-11T09:00:00.000Z" });
  assert.equal(out.status, 200);
  const row = await store();
  assert.equal(row.status, "uninstalled");
  assert.equal(row.accessTokenEncrypted, null);
});

test("an uninstall webhook without a readable time still switches the store off (as before)", { skip }, async () => {
  await installedStore(new Date("2026-11-10T12:00:00Z"));
  await uninstallWebhook();
  assert.equal((await store()).status, "uninstalled");
  await installedStore(new Date("2026-11-10T12:00:00Z"));
  await uninstallWebhook({ triggeredAt: "not a date" });
  assert.equal((await store()).status, "uninstalled");
  assert.ok(mongoose.connection.readyState === 1);
});

// ---- the browser id on the voice socket ---------------------------------------------------------
test("the voice socket keeps its browser id unless the new one has the right shape", () => {
  const good = "AbCdEfGhIjKlMnOpQrSt12";
  assert.equal(nextClientId("current-id-0123456789", good), good);
  for (const bad of ["short", "has spaces in it 0123456789", "a".repeat(80), "../../etc/passwd-0123456789", "", null, 42, { $ne: "" }]) {
    assert.equal(nextClientId("current-id-0123456789", bad), "current-id-0123456789", `refused: ${JSON.stringify(bad)}`);
  }
});
