import "dotenv/config";
import mongoose from "mongoose";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { adminGraphql } from "../src/services/shopifyAdminService.js";

// Read-only diagnostic. Shows, per store, exactly why a product is or is not visible to the agent.
// Usage: node scripts/check-store.mjs [your-store.myshopify.com]
const only = String(process.argv[2] || "").trim().toLowerCase();

const QUERY = `query CheckProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
    edges { node {
      title status productType publishedAt
      variants(first: 25) { edges { node { inventoryQuantity inventoryPolicy inventoryItem { tracked } } } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const sellable = (v) => {
  const tracked = v.inventoryItem?.tracked ?? true;
  return !tracked || v.inventoryPolicy === "CONTINUE" || (v.inventoryQuantity ?? 0) > 0;
};

try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME, serverSelectionTimeoutMS: 5000 });
  const filter = { platform: "shopify", status: "active", ...(only ? { storeDomain: only } : {}) };
  const shops = await StoreIntegration.find(filter).select("storeDomain").lean();
  if (!shops.length) throw new Error("No matching active store in the DB. Install the app first.");

  for (const { storeDomain: shop } of shops) {
    console.log(`\n=== ${shop} ===`);
    let after = null;
    const all = [];
    try {
      for (let i = 0; i < 6; i++) {
        const data = await adminGraphql(shop, QUERY, { first: 100, after });
        all.push(...data.products.edges.map((e) => e.node));
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }
    } catch (error) {
      console.error(`Could not read products: ${error.message}`);
      console.error("-> token / scope / reinstall problem. Reinstall: /api/shopify/oauth/install?shop=" + shop);
      process.exitCode = 1;
      continue;
    }

    const rows = all.map((p) => {
      const variants = p.variants.edges.map((e) => e.node);
      const reasons = [];
      if (p.status !== "ACTIVE") reasons.push(`status=${p.status} (set it to Active)`);
      if (!p.publishedAt) reasons.push("not published to Online Store (Publishing > Online Store)");
      if (!variants.some(sellable)) reasons.push("out of stock (agent will say sold out, not 'not available')");
      return { title: p.title, type: p.productType || "-", visible: reasons.length === 0, reasons };
    });

    console.log(`Total products: ${rows.length}, fully visible to agent: ${rows.filter((r) => r.visible).length}`);
    for (const r of rows) {
      console.log(` ${r.visible ? "OK  " : "HIDE"} ${r.title} [${r.type}]${r.reasons.length ? "  <- " + r.reasons.join("; ") : ""}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
