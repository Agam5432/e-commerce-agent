// Builds Shopify GraphQL product nodes from the recorded TechStore catalog (test/fixtures/techstoreCatalog.json).
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(new URL("../fixtures/techstoreCatalog.json", import.meta.url), "utf8"));
let n = 0;
export function realCatalogNodes() {
  return rows.map((r) => {
    const prices = r.variants.map((v) => Number(v.price));
    return {
      id: `gid://shopify/Product/${++n}`, title: r.title, handle: r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: r.description, status: "ACTIVE", productType: r.type, vendor: r.vendor, tags: r.tags,
      publishedAt: "2026-10-26T00:00:00Z", onlineStoreUrl: null,
      featuredImage: { url: "https://cdn.example.com/x.jpg", altText: r.title },
      priceRangeV2: { minVariantPrice: { amount: String(Math.min(...prices)), currencyCode: "INR" } },
      variants: { edges: r.variants.map((v) => ({ node: { id: `gid://shopify/ProductVariant/${++n}`, title: v.title, selectedOptions: [], image: null, price: v.price, compareAtPrice: null, inventoryQuantity: v.available ? 5 : 0, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } })) },
    };
  });
}
