import test from "node:test";
import assert from "node:assert/strict";
import { camelCaseArgs } from "../src/agent/toolSchema.js";

test("a snake_case argument also arrives under the schema's camelCase name", () => {
  assert.deepEqual(camelCaseArgs({ shipping_rate: "Express" }), { shipping_rate: "Express", shippingRate: "Express" });
});

test("a camelCase argument already present is never overwritten, and plain names are untouched", () => {
  assert.deepEqual(camelCaseArgs({ shippingRate: "Standard", shipping_rate: "Express" }), { shippingRate: "Standard", shipping_rate: "Express" });
  assert.deepEqual(camelCaseArgs({ productName: "x", quantity: 2 }), { productName: "x", quantity: 2 });
  assert.deepEqual(camelCaseArgs(null), {});
});
