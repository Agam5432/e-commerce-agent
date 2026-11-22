// "Who is it for?" is asked only for categories this store's own products label by men/women/kids.
// (This replaced a reference to a removed fixed list, which threw whenever a shopper named a category.)
import test from "node:test";
import assert from "node:assert/strict";
import { isCategoryGendered, __cachesForTest } from "../src/tools/shopifyService.js";

const SHOP = "gender-test.myshopify.com";
const put = (products) => __cachesForTest.catalogSummaryCaches.set(SHOP, { at: Date.now(), summary: { allProducts: products } });

test("a category counts as gendered only from the store's own product labels", () => {
  put([
    { title: "Men's Oxford Shirt", category: "shirts" },
    { title: "Women's Linen Shirt", category: "shirts" },
    { title: "Classic Shirt", category: "shirts" },
    { title: "Steel Bottle", category: "bottles" },
    { title: "Insulated Bottle", category: "bottles" },
    { title: "Men's Watch", category: "watches" },
  ]);
  assert.equal(isCategoryGendered(SHOP, "shirts"), true, "2 of 3 shirts are labelled");
  assert.equal(isCategoryGendered(SHOP, "bottles"), false);
  assert.equal(isCategoryGendered(SHOP, "watches"), false, "one product is not enough to decide");
  assert.equal(isCategoryGendered(SHOP, ""), false);
  assert.equal(isCategoryGendered("other.myshopify.com", "shirts"), false, "no catalog, no guess");
  __cachesForTest.catalogSummaryCaches.delete(SHOP);
});

test("the shopping flow no longer refers to a fixed category list", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/industries/ecommerce.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /GENDER_SENSITIVE_APPAREL_CATS/);
  assert.match(source, /isCategoryGendered\?\.\(storeId, c\)/);
});
