// Storefront taxonomy: every product lands in a sensible department; artwork is a valid SVG.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = { window: {} };
vm.runInNewContext(readFileSync("storefront/src/look.js", "utf8"), sandbox);
const { department, art, typeLabel } = sandbox.window.Look;

test("departments", () => {
  const d = (category, title = "x") => department({ category, title });
  assert.equal(d("power_banks"), "Electronics");
  assert.equal(d("t_shirt", "Men's Classic White T-Shirt"), "Men");
  assert.equal(d("jeans", "Women's Wide Leg Denim Jeans - White"), "Women");
  assert.equal(d("jeans", "Girls Skinny Fit Stretch Jeans - Grey"), "Kids");
  assert.equal(d("school_bags", "Skybags Brat School Backpack 32L"), "Kids");
  assert.equal(d("laptop_bags", "Samsonite Laptop Backpack"), "Bags & Accessories");
  assert.equal(d("gift", "Women's Perfume Gift Set"), "Home & Gifts");
  assert.equal(d("snowboard"), "Sports");
  assert.equal(d("abayas"), "Modest Wear");
  assert.equal(d("hijabs_and_scarves"), "Modest Wear");
  assert.equal(d("perfumes"), "Fragrance");
  assert.equal(d("kurti", "Women's Teal Printed Cotton Kurti"), "Women");
});

test("type labels and art", () => {
  assert.equal(typeLabel("t_shirt"), "T-Shirts");
  assert.equal(typeLabel("some_new_type"), "Some New Type");
  const uri = art({ id: "1", title: "Girls Fleece Zip Hoodie - Lilac", category: "hoodie" });
  assert.ok(uri.startsWith("data:image/svg+xml"));
  assert.ok(decodeURIComponent(uri).includes("#c4b5fd"), "lilac colour is used");
});
