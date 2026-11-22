// Replies may not invent product specs ("42 hours"), and a product whose options cost different amounts
// must say so instead of giving one flat price.
import test from "node:test";
import assert from "node:assert/strict";
import { extractSpecClaims, verifyReplyFacts } from "../src/agent/factGuard.js";
import { compactProduct } from "../src/tools/shopifyService.js";

test("a spec that is not in the store's data is flagged, one that is there is not", () => {
  const data = ["Anker PowerCore 20000mAh Power Bank, 6.1 inch, 128GB"];
  const verdict = verifyReplyFacts("Up to 42 hours of playback. It has 20000 mAh and a 6.1-inch screen, 128GB.", data);
  assert.deepEqual(verdict.unknownSpecs, ["42 hours"]);
});

test("the shopper's own numbers and plain counts are not specs", () => {
  assert.deepEqual(verifyReplyFacts("Yes, the 2 sizes are in stock, 12 left", ["size 2"]).unknownSpecs, []);
  assert.deepEqual(extractSpecClaims("sizes 2-3Y and 8-9Y, 3 colours"), []);
  assert.deepEqual(verifyReplyFacts("You asked for 30 hours, we have it", ["I need 30 hours battery"]).unknownSpecs, []);
});

const product = (variants) => ({
  title: "boAt Airdopes 141", price: String(Math.min(...variants.map((v) => v.price))), currency: "USD", description: "earbuds",
  variants: variants.map((v, i) => ({ id: String(i), title: v.title, price: String(v.price), sellable: v.sellable ?? true })),
});

test("options at different prices are marked, equal prices are not", () => {
  const mixed = compactProduct(product([{ title: "Bold Black", price: 25 }, { title: "Cool Grey", price: 19 }]));
  assert.equal(mixed.priceVaries, true);
  assert.match(mixed.priceRangeText, /\$19\.00 to \$25\.00/);
  const same = compactProduct(product([{ title: "Black", price: 19 }, { title: "Grey", price: 19 }]));
  assert.equal(same.priceVaries, undefined);
  // a sold-out option does not stretch the range
  const soldOut = compactProduct(product([{ title: "Black", price: 19 }, { title: "Grey", price: 99, sellable: false }]));
  assert.equal(soldOut.priceVaries, undefined);
});

import { filterProductsByVariantHints } from "../src/tools/shopify/words.js";

test("a named storage size picks that option, and the card's variant is the one the reply prices", () => {
  const phone = {
    title: "Apple iPhone 15", price: "799.00", variantId: "1",
    variants: [
      { id: "1", title: "Blue / 128GB", price: "799.00", sellable: true, selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Storage", value: "128GB" }] },
      { id: "2", title: "Blue / 256GB", price: "899.00", sellable: true, selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Storage", value: "256GB" }] },
    ],
  };
  const [hit] = filterProductsByVariantHints([phone], "iphone 15 256gb blue");
  assert.equal(hit.variantId, "2");
  assert.equal(hit.price, "899.00");
  assert.deepEqual(hit.variants.map((v) => v.id), ["2"]);
  // a size nobody has does not empty the answer
  const [loose] = filterProductsByVariantHints([phone], "iphone 15 512gb blue");
  assert.equal(loose.variantId, "1");
});

import { narrowVariantsByStorage } from "../src/tools/shopify/words.js";

test("narrowVariantsByStorage keeps only the named size, and leaves a product without it alone", () => {
  const phone = { title: "Phone", price: "799.00", variantId: "1", variants: [
    { id: "1", title: "Blue / 128GB", price: "799.00", sellable: true },
    { id: "2", title: "Blue / 256 GB", price: "899.00", sellable: true },
  ] };
  const narrowed = narrowVariantsByStorage(phone, "i want the 256gb one");
  assert.equal(narrowed.variantId, "2");
  assert.equal(narrowed.variants.length, 1);
  assert.equal(narrowVariantsByStorage(phone, "512gb"), phone);
  assert.equal(narrowVariantsByStorage(phone, "just show me phones"), phone);
});
