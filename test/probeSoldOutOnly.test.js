// "wireless earbuds": the quick pre-search found only the sold-out "Wireless Bluetooth Earbuds", and the model said it was the store's only one
// while four Bluetooth earbuds were in stock (real storefront, 2026-11-17).
import test from "node:test";
import assert from "node:assert/strict";
import { buildProbeBlock } from "../src/industries/ecommerce/systemPrompt.js";

const product = (title, sellable) => ({ id: title, title, handle: "h", price: "1299.00", currency: "USD", variants: [{ id: "1", title: "Black", price: "1299.00", sellable, inventoryQuantity: sellable ? 5 : 0 }] });

test("sold-out-only quick matches carry a warning not to call them the only option", () => {
  const block = buildProbeBlock({ probeRan: true, probeProducts: [product("Wireless Bluetooth Earbuds", false)] });
  assert.match(block, /Every match above is SOLD OUT/);
  assert.match(block, /call search_products/);
});

test("in-stock matches carry no such warning", () => {
  const block = buildProbeBlock({ probeRan: true, probeProducts: [product("boAt Airdopes 141 Earbuds", true)] });
  assert.doesNotMatch(block, /Every match above is SOLD OUT/);
});

import { readFileSync } from "node:fs";
test("the prompt tells the model to answer feature questions (yes or no) only from the product's data", () => {
  const src = readFileSync(new URL("../src/industries/ecommerce/systemPrompt.js", import.meta.url), "utf8");
  assert.match(src, /FEATURE QUESTIONS/);
  assert.match(src, /a NO \(.it does not have X.\) needs the data to say so too/);
});
