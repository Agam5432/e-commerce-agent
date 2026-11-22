import "dotenv/config";
import mongoose from "mongoose";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { adminGraphql } from "../src/services/shopifyAdminService.js";
import { CHECKOUT_ACCESS_QUERY } from "../src/services/shopifyOrderService.js";

// Read-only diagnostic: no order, customer, inventory or email mutations.
try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME, serverSelectionTimeoutMS: 5000 });
  const shops = await StoreIntegration.find({ platform: "shopify", status: "active" }).select("storeDomain").lean();
  if (!shops.length) throw new Error("No active Shopify integration. Install the app through /api/shopify/oauth/install?shop=YOUR-STORE.myshopify.com");
  for (const { storeDomain: shop } of shops) {
    console.log(`Checking ${shop}`);
    const data = await adminGraphql(shop, `query AgentAccessScopes {
      currentAppInstallation { accessScopes { handle } }
      shop { currencyCode }
    }`);
    const scopes = new Set(data.currentAppInstallation.accessScopes.map(s => s.handle));
    const required = ["write_draft_orders", "read_orders", "write_customers", "read_products", "read_inventory"];
    const missing = required.filter(scope => !scopes.has(scope) && !scopes.has(scope.replace(/^read_/, "write_")));
    console.log(`Currency: ${data.shop.currencyCode}`);
    if (missing.length) {
      console.error(`Missing scopes: ${missing.join(", ")}. Reauthorize at /api/shopify/oauth/install?shop=${shop}`);
      process.exitCode = 1;
    } else console.log("Order/customer API scopes: OK");
    try {
      await adminGraphql(shop, CHECKOUT_ACCESS_QUERY);
      await adminGraphql(shop, `query AgentCustomerAccess { customers(first: 1) { nodes { id } } }`);
      console.log("Protected customer/order data access: OK");
    } catch (error) {
      console.error(error.message);
      console.error("Shopify setup: Partner Dashboard > Apps > your app > API access requests > Protected customer data access. Select Protected customer data and the required name, address, email and phone fields, then save.");
      console.error("https://shopify.dev/docs/apps/launch/protected-customer-data");
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
