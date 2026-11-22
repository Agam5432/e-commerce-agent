// A shopper who asks for a whole kind of product ("smartphones", "earbuds") sees every in-stock item of that kind, not only the
// one whose text happens to contain their word. Fixture = TechStore's real products and descriptions (read from the live store
// on 2026-11-16); Shopify itself is scripted here, so this is a MOCK/AUTOMATED test.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import StoreIntegration from "../src/models/StoreIntegration.js";
import { encryptToken } from "../src/utils/tokenEncryption.js";
import { searchShopifyProducts } from "../src/tools/shopifyService.js";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const originalFind = StoreIntegration.findOne;
const originalFetch = globalThis.fetch;
StoreIntegration.findOne = () => ({ select: async () => ({ accessTokenEncrypted: encryptToken("test-token"), accessTokenExpiresAt: new Date(Date.now() + 3600000) }) });

let n = 0;
const item = (title, { type, vendor, tags = [], description = "", qty = 5, price = "100.00" }) => ({
  id: `gid://shopify/Product/${++n}`, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description, status: "ACTIVE", productType: type, vendor, tags,
  publishedAt: "2026-10-26T00:00:00Z", featuredImage: { url: "https://cdn.example.com/x.jpg", altText: title },
  priceRangeV2: { minVariantPrice: { amount: price, currencyCode: "USD" } },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${++n}`, title: "Default Title", selectedOptions: [], image: null, price, compareAtPrice: null, inventoryQuantity: qty, inventoryPolicy: "DENY", inventoryItem: { tracked: true } } }] },
});
const fixtures = [
  item("Samsung Galaxy A55 5G", { type: "Smartphones", vendor: "Samsung", tags: ["samsung", "smartphones"], description: "6.6-inch AMOLED display, 5G connectivity, a multi-lens camera and all-day battery life. Sample product for demo store." }),
  item("Apple iPhone 15", { type: "Smartphones", vendor: "Apple", tags: ["apple", "smartphones"], description: "Dynamic Island, a 48MP main camera, USB-C and a durable glass and aluminum design." }),
  item("OnePlus Nord CE4", { type: "Smartphones", vendor: "OnePlus", tags: ["oneplus", "smartphones"], description: "Smooth AMOLED display, fast charging and clean software for a quick, reliable phone." }),
  item("Xiaomi Redmi Note 13", { type: "Smartphones", vendor: "Xiaomi", tags: ["xiaomi", "smartphones"], description: "Large bright display, 108MP main camera and fast charging at a friendly price. Sample product for demo store." }),
  item("Phone Case Clear", { type: "Phone Covers", vendor: "Acme", tags: ["phone covers"], description: "Clear case for your phone." }),
  item("JBL Wave Beam Earbuds", { type: "Bluetooth Earbuds", vendor: "JBL", tags: ["bluetooth earbuds", "jbl"], description: "True wireless earbuds with deep bass sound, a crisp mic and a water-resistant body." }),
  item("Samsung Galaxy Buds FE", { type: "Bluetooth Earbuds", vendor: "Samsung", tags: ["bluetooth earbuds", "samsung"], description: "Comfortable wireless earbuds with active noise cancelling and a secure fit." }),
  item("Noise Buds VS104 Earbuds", { type: "Bluetooth Earbuds", vendor: "Noise", tags: ["bluetooth earbuds", "noise"], description: "Wireless earbuds with a clear call microphone, touch controls and quick pairing." }),
  item("boAt Airdopes 141 Earbuds", { type: "Bluetooth Earbuds", vendor: "boAt", tags: ["bluetooth earbuds", "boat"], description: "True wireless earbuds with deep bass, low-latency mode and a long playtime case." }),
  item("Wireless Bluetooth Earbuds", { type: "Electronics", vendor: "Dev Test Brand", tags: ["audio", "bluetooth", "earbuds", "wireless"], description: "True wireless earbuds with 30-hour battery, deep bass, touch controls and IPX4 rating.", qty: 0 }),
  item("Ambrane 10000mAh Power Bank", { type: "Power Banks", vendor: "Ambrane", tags: ["power banks"], description: "Slim 10000mAh power bank." }),
  item("Anker PowerCore 20000mAh Power Bank", { type: "Power Banks", vendor: "Anker", tags: ["power banks"], description: "Large 20000mAh power bank that can charge a phone several times over." }),
  item("Mi Power Bank 3i 10000mAh", { type: "Power Banks", vendor: "Xiaomi", tags: ["power banks"], description: "10000mAh power bank with fast charging support and dual output ports." }),
];
// the real store has 324 products: past 250 the search stops holding the whole catalogue in memory and asks Shopify's own text search
// Shopify lists newest-updated first: 260 newer gifts push the real products past the first 250, as on the real store (74 products past it)
fixtures.unshift(...Array.from({ length: 260 }, (_, i) => item("Gift Item " + i, { type: "Gift", vendor: "Acme", tags: ["gift"], description: "A gift." })));
// Shopify's product search for the clauses this code builds: field:value is a whole-word hit on that field (tag and type are the whole value)
const words = (t) => String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const clause = (node, c) => {
  const [field, ...rest] = c.split(":"); const v = rest.join(":").toLowerCase();
  if (field === "title") return words(node.title).includes(v);
  if (field === "tag") return node.tags.map((t) => t.toLowerCase()).includes(v);
  if (field === "product_type") return String(node.productType).toLowerCase() === v;
  if (field === "vendor") return words(node.vendor).includes(v);
  if (field === "variant_title") return false;
  return false;
};
const matchesQuery = (node, q) => {
  const body = String(q).replace(/^status:actives*/, "").trim();
  if (!body) return true;
  return body.split(" AND ").every((g) => g.replace(/^(|)$/g, "").split(" OR ").some((c) => clause(node, c.trim())));
};
globalThis.fetch = async (url, options) => {
  const { query, variables } = JSON.parse(options.body);
  const q = variables?.query;
  const nodes = q && !/ListProducts/.test(query) ? fixtures.filter((f) => matchesQuery(f, q)) : fixtures;
  const first = variables?.first || 250;
  const after = variables?.after ? Number(variables.after) : 0;
  const page = nodes.slice(after, after + first);
  const more = after + first < nodes.length;
  return { ok: true, status: 200, json: async () => ({ data: { products: { edges: page.map((node) => ({ node })), pageInfo: { hasNextPage: more, endCursor: more ? String(after + first) : null } } } }) };
};
after(() => { StoreIntegration.findOne = originalFind; globalThis.fetch = originalFetch; });

const SHOP = "techstore-test.myshopify.com";
const titles = async (q, first = 12) => { const r = await searchShopifyProducts(SHOP, q, { first }); return (r.products || r).map((p) => p.title); };
const SMART = ["Samsung Galaxy A55 5G", "Apple iPhone 15", "OnePlus Nord CE4", "Xiaomi Redmi Note 13"];

for (const q of ["smartphones", "phones", "smartphone", "mobile phones"]) {
  test(`"${q}" lists every in-stock smartphone`, async () => {
    const found = await titles(q);
    for (const t of SMART) assert.ok(found.includes(t), `${t} missing from ${JSON.stringify(found)}`);
    assert.ok(!found.includes("Phone Case Clear"), "accessories are not smartphones");
  });
}
test("a brand narrows the kind: 'samsung phone' is still only the Samsung phone", async () => {
  const found = await titles("samsung phone");
  assert.ok(found.includes("Samsung Galaxy A55 5G"));
  assert.ok(!found.includes("Apple iPhone 15") && !found.includes("OnePlus Nord CE4"), JSON.stringify(found));
});
test("'power banks' lists all three", async () => {
  const found = await titles("power banks");
  assert.equal(found.length, 3, JSON.stringify(found));
});
test("'wireless earbuds': the in-stock earbuds are offered, the sold-out one is not hidden as the only answer", async () => {
  const found = await titles("wireless earbuds");
  assert.ok(found.some((t) => /JBL|Buds FE|Noise|boAt/.test(t)), `no in-stock earbuds in ${JSON.stringify(found)}`);
});
test("asking for the sold-out earbuds by name still reports that exact product", async () => {
  const found = await titles("Wireless Bluetooth Earbuds");
  assert.ok(found.includes("Wireless Bluetooth Earbuds"), JSON.stringify(found));
});
