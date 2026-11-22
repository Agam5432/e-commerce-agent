import "dotenv/config";
import mongoose from "mongoose";
import { revenueReport } from "../src/admin/revenueCheck.js";

// Read-only. Shows, order by order, where a store's revenue ("Spent", "Sales") comes from and what looks wrong.
// Usage: node scripts/check-revenue.mjs your-store.myshopify.com [--all]   (--all prints every order, not only flagged ones)
const shop = String(process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  console.error("Usage: node scripts/check-revenue.mjs your-store.myshopify.com [--all]");
  process.exit(1);
}
await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || undefined });
try {
  const report = await revenueReport(shop);
  console.log(`${report.orders} order event(s). Totals by currency:`, report.byCurrency, "Usual order:", report.typicalOrder);
  const list = process.argv.includes("--all") ? report.rows : report.flagged;
  console.log(`${process.argv.includes("--all") ? "All" : "Flagged"} (${list.length}):`);
  for (const r of list) {
    console.log(`- ${new Date(r.at).toISOString().slice(0, 10)} ${r.order || "(no number)"}: counted ${r.counted} ${r.currency || "?"} | Shopify ${r.shopify ? `${r.shopify.amount} ${r.shopify.currency}` : "-"} | chat ${r.chat ? `${r.chat.amount} ${r.chat.currency}` : "-"} | ${r.source}${r.flags.length ? ` | ${r.flags.join("; ")}` : ""}`);
  }
} finally {
  await mongoose.disconnect();
}
