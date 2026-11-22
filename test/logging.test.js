// Logs never carry what a shopper said or their personal details: transcripts are logged as a length,
// tool arguments with personal fields masked, and a process-wide net redacts emails and phone numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerText, maskPersonal, installConsoleRedaction, redact } from "../src/utils/logger.js";

test("a shopper's words are logged only as their length", () => {
  assert.equal(customerText("mera naam Asha hai, phone 9876543210", { env: {} }), "<36 chars>");
  assert.equal(customerText(undefined, { env: {} }), "<0 chars>");
});

test("LOG_CUSTOMER_TEXT=1 shows redacted text locally, never in production", () => {
  assert.equal(customerText("mail me at asha@example.com", { env: { LOG_CUSTOMER_TEXT: "1" } }), JSON.stringify("mail me at a***@example.com"));
  assert.equal(customerText("hello", { env: { LOG_CUSTOMER_TEXT: "1", NODE_ENV: "production" } }), "<5 chars>");
  assert.equal(JSON.parse(customerText("x".repeat(500), { env: { LOG_CUSTOMER_TEXT: "1" } })).length, 160);
});

test("tool arguments keep what helps tracing and mask the person", () => {
  const out = maskPersonal({
    query: "red shirt",
    variantId: "gid://shopify/ProductVariant/42",
    quantity: 2,
    email: "asha@example.com",
    customerName: "Asha",
    shipping: { name: "Asha", address1: "12 MG Road", city: "Pune", zip: "411001", phone: "+91 98765 43210" },
    otp: "123456",
    note: "deliver after 6, call 9876543210",
  });
  assert.deepEqual(out, {
    query: "red shirt",
    variantId: "gid://shopify/ProductVariant/42",
    quantity: 2,
    email: "***",
    customerName: "***",
    shipping: { name: "***", address1: "***", city: "***", zip: "***", phone: "***" },
    otp: "***",
    note: "deliver after 6, call ***10",
  });
  assert.equal(maskPersonal({ email: "" }).email, "", "an empty field stays empty, so the log shows it was missing");
});

test("ids and timestamps are not mistaken for phone numbers", () => {
  const out = redact("order gid://shopify/Order/5551234567890 #10012345 at=1700000000000 call +91 98765 43210");
  assert.match(out, /Order\/5551234567890/);
  assert.match(out, /#10012345/);
  assert.match(out, /at=1700000000000/);
  assert.doesNotMatch(out, /98765/);
});

test("the console safety net redacts every call, including errors and objects", () => {
  const lines = [];
  const fake = { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) };
  installConsoleRedaction(fake);
  installConsoleRedaction(fake); // installing twice does not wrap twice
  fake.log("sent to asha@example.com", { phone: "9876543210", shop: "a.myshopify.com" });
  fake.error(new Error("customer asha@example.com not found"));
  assert.equal(lines[0][0], "sent to a***@example.com");
  assert.deepEqual(lines[0][1], { phone: "***", shop: "a.myshopify.com" });
  assert.match(lines[1][0].message, /a\*\*\*@example\.com/);
  assert.doesNotMatch(lines[1][0].stack, /asha@/);
});

test("the voice server and transcription never print a transcript as is", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const live = readFileSync(new URL("../src/voice/liveTranscriptionService.js", import.meta.url), "utf8");
  for (const source of [server, live]) {
    const raw = source.match(/console\.(?:log|warn|error)\([^;]*\b(?:question|transcript|clean|contClean|transcript\.trim\(\))\)\s*;/g) || [];
    assert.deepEqual(raw.filter((line) => !/customerText\(/.test(line)), []);
  }
  assert.match(server, /installConsoleRedaction\(\);/);
});
