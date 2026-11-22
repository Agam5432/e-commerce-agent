import test from "node:test";
import assert from "node:assert/strict";
import { mergeShippingAddress, deduplicateAddress } from "../src/services/shippingAddressService.js";

const saved = { name: "Test Buyer", phone: "9876543210", email: "buyer@example.com", address1: "10 Old Road", address2: "", city: "Delhi", province: "Delhi", zip: "110001", country: "India" };
test("address2 is removed when the same locality is already in the street", () => {
  assert.equal(deduplicateAddress({ address1: "10/2 Friends Colony", address2: "Friends colony" }).address2, "");
});
test("a model cannot pad an incomplete phone number with an invented digit", () => {
  const result = mergeShippingAddress(saved, { phone: "9123456780", address1: "20 New Road", city: "Delhi" }, { message: "My phone number is 912345678 and street address is 20 New Road, Delhi" });
  assert.equal(result.address.phone, "912345678");
  assert.ok(result.missing.includes("phone"));
  assert.equal(result.address.address1, "20 New Road");
});
test("a postal-only reply cannot mutate the phone or reintroduce a duplicate locality", () => {
  const result = mergeShippingAddress({ ...saved, address1: "10/2 Friends Colony", address2: "Friends Colony" }, { phone: "9876543212", address2: "Friends Colony", zip: "251001" }, { message: "251001." });
  assert.equal(result.address.phone, "+919876543210");
  assert.equal(result.address.address2, "");
  assert.equal(result.address.zip, "251001");
});
test("travel destination cannot become the delivery country on an unrelated partial reply", () => {
  const result = mergeShippingAddress(saved, { country: "US", zip: "110001" }, { message: "110001", history: [{ role: "user", content: "I am travelling from India to US" }] });
  assert.equal(result.address.countryCode, "IN");
});
test("a bare complete phone number can correct a previously incomplete number", () => {
  const result = mergeShippingAddress({ ...saved, phone: "912345678" }, { phone: "9123456780" }, { message: "9123456780" });
  assert.equal(result.address.phone, "+919123456780");
  assert.equal(result.missing.includes("phone"), false);
});
