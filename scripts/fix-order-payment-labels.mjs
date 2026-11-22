// One-off: orders recorded before the webhook used the order's COD / Online-Payment tag carry Shopify's gateway name
// ("manual", "bogus") as their payment method, which the dashboard shows as "Manual". This reads each such order's tags
// from Shopify and fixes the recorded method. Safe to run again. Usage: node scripts/fix-order-payment-labels.mjs [--dry-run]
import "dotenv/config";
import mongoose from "mongoose";
import Event from "../src/models/Event.js";
import { adminGraphql } from "../src/services/shopifyAdminService.js";

const dry = process.argv.includes("--dry-run");
try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME, serverSelectionTimeoutMS: 5000 });
  const rows = await Event.find({ type: "order_placed", "props.paymentMethod": { $nin: ["cod", "online", "prepaid", "payment_link", "paid", ""] } }).lean();
  let fixed = 0;
  for (const row of rows) {
    const name = String(row.props?.orderName || "").replace(/^#/, "");
    if (!name) continue;
    const data = await adminGraphql(row.shop, `query($q: String!) { orders(first: 1, query: $q) { edges { node { name tags } } } }`, { q: `name:#${name}` });
    const node = (data?.orders || data?.data?.orders)?.edges?.[0]?.node;
    const tags = (node?.tags || []).map((t) => String(t).toLowerCase());
    const method = tags.includes("cod") ? "cod" : tags.includes("online-payment") ? "online" : "";
    if (!method) continue;
    console.log(`${row.shop} #${name}: ${row.props.paymentMethod} -> ${method}${dry ? " (dry run)" : ""}`);
    if (!dry) await Event.updateOne({ _id: row._id }, { $set: { "props.paymentMethod": method } });
    fixed++;
  }
  console.log(`${rows.length} order(s) had a gateway name; ${fixed} ${dry ? "would be " : ""}fixed.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
