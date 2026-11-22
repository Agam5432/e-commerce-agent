// Registers the order webhooks through the Admin API for ONE store (the app's own supported API, like APP_UNINSTALLED).
// Idempotent: lists the store's API subscriptions first and creates only what is missing for the callback URL.
// Usage: node scripts/register-order-webhooks.mjs <shop.myshopify.com> [--delete]   (APP_URL must be the https tunnel/production URL)
// NOTE: a TOML-declared subscription for the same topic would deliver a second copy; the handlers are idempotent (see docs/WEBHOOK_DEPLOYMENT_PLAN.md).
import "dotenv/config";
import mongoose from "mongoose";
import { adminGraphql } from "../src/services/shopifyAdminService.js";

const TOPICS = [["ORDERS_CANCELLED", "/api/shopify/webhooks/orders-cancelled"], ["REFUNDS_CREATE", "/api/shopify/webhooks/refunds-create"]];
const shop = process.argv[2];
const remove = process.argv.includes("--delete");
const base = String(process.env.APP_URL || "").replace(/\/$/, "");
if (!shop || !/^https:\/\//.test(base)) { console.error("need a shop and an https APP_URL"); process.exit(1); }
await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME, serverSelectionTimeoutMS: 8000 });
try {
  const listed = await adminGraphql(shop, `{ webhookSubscriptions(first: 50) { nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  const have = listed.webhookSubscriptions.nodes;
  for (const [topic, path] of TOPICS) {
    const url = base + path;
    const existing = have.filter((n) => n.topic === topic && n.endpoint?.callbackUrl === url);
    if (remove) { for (const n of existing) { await adminGraphql(shop, `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }`, { id: n.id }); console.log("deleted", topic, n.id); } continue; }
    if (existing.length) { console.log("already registered", topic); continue; }
    const r = await adminGraphql(shop, `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id topic } userErrors { field message } } }`, { topic, sub: { callbackUrl: url, format: "JSON" } });
    console.log(topic, JSON.stringify(r.webhookSubscriptionCreate));
  }
} finally { await mongoose.disconnect(); }
